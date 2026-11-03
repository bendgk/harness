import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { costOf } from '@shared/pricing'
import type { Provider, RemotePlan, SpawnPlan, TranscriptRead } from './types'
import type { RateLimitWindow } from '@shared/types'

/** Rollouts live at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl */
function sessionsRoot(home: string): string {
  return join(home, 'sessions')
}

function walkRollouts(home: string, sinceMs: number): string[] {
  const root = sessionsRoot(home)
  if (!existsSync(root)) return []
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries) {
      const p = join(dir, e)
      let st: ReturnType<typeof statSync>
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) {
        if (depth < 3) walk(p, depth + 1)
      } else if (e.endsWith('.jsonl') && st.mtimeMs >= sinceMs) {
        found.push(p)
      }
    }
  }
  // Only descend into the last few day-folders; the archive can be enormous.
  walk(root, 0)
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

/**
 * `-c developer_instructions=…` is Codex's supported way to add instructions
 * for one run (verified on codex-cli 0.144 and 0.163). The value is parsed as
 * TOML; a JSON string literal is a valid TOML basic string, so any text —
 * quotes, newlines — arrives intact. It is a global option, so it goes before
 * the `resume` subcommand.
 */
function codexArgs(resume?: string, prompt?: string, systemPrompt?: string): string[] {
  const args = systemPrompt ? ['-c', `developer_instructions=${JSON.stringify(systemPrompt)}`] : []
  if (resume) args.push('resume', resume)
  if (prompt) args.push(prompt)
  return args
}

export const codexProvider: Provider = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  homeEnv: 'CODEX_HOME',
  interruptSequence: '\x1b',

  plan({ home, resume, prompt, systemPrompt }): SpawnPlan {
    // Codex generates its own conversation id, so the transcript is discovered
    // by watching the rollout directory rather than predicted.
    return {
      file: this.bin,
      args: codexArgs(resume, prompt, systemPrompt),
      env: { CODEX_HOME: home },
      nativeSessionId: resume
    }
  },

  remotePlan({ resume, prompt, systemPrompt }): RemotePlan {
    return { bin: this.bin, args: codexArgs(resume, prompt, systemPrompt), nativeSessionId: resume }
  },

  findTranscript({ home, since, nativeSessionId, exclude }): string | undefined {
    const files = walkRollouts(home, since - 5_000)
    if (nativeSessionId) {
      const match = files.find((f) => f.includes(nativeSessionId))
      if (match) return match
    }
    // Codex names its own file, so the newest rollout is a guess; never guess
    // one another live session already tails.
    return files.find((f) => !exclude?.has(f))
  },

  readTranscript(path: string): TranscriptRead {
    const out: TranscriptRead = { usage: {} }
    if (!existsSync(path)) return out
    let input = 0, cached = 0, cacheWrite = 0, output = 0, reasoning = 0, total = 0
    // Cumulative totals bill the session; the last turn alone sizes the context.
    let resident = 0
    let contextWindow = 272_000
    let messages = 0
    let model: string | undefined
    let limits: RateLimitWindow[] | undefined
    let credits: { balance: number; unlimited: boolean } | undefined
    let nativeSessionId: string | undefined
    let title: string | undefined

    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue
      let rec: any
      try { rec = JSON.parse(line) } catch { continue }

      if (rec.type === 'session_meta') {
        nativeSessionId = rec.payload?.id || rec.payload?.session_id || nativeSessionId
        model = rec.payload?.model || model
        title = rec.payload?.name || rec.payload?.title || title
      }
      if (rec.type === 'turn_context' && rec.payload?.model) model = rec.payload.model

      if (rec.type === 'event_msg' && rec.payload?.type === 'token_count') {
        const info = rec.payload.info
        if (info?.total_token_usage) {
          const t = info.total_token_usage
          // Codex reports cumulative totals, so assign rather than accumulate.
          input = t.input_tokens || 0
          cached = t.cached_input_tokens || 0
          cacheWrite = t.cache_write_input_tokens || 0
          output = t.output_tokens || 0
          reasoning = t.reasoning_output_tokens || 0
          total = t.total_tokens || input + output
          messages++
        }
        if (info?.last_token_usage) {
          const l = info.last_token_usage
          resident = l.total_tokens || (l.input_tokens || 0) + (l.output_tokens || 0)
        }
        if (info?.model_context_window) contextWindow = info.model_context_window
        const rl = rec.payload.rate_limits
        if (rl) {
          limits = []
          for (const [key, label] of [['primary', 'primary'], ['secondary', 'secondary']] as const) {
            const w = rl[key]
            if (w) {
              limits.push({
                name: rl.limit_name || label,
                usedPercent: w.used_percent ?? 0,
                windowMinutes: w.window_minutes ?? 0,
                resetsAt: w.resets_at ? w.resets_at * 1000 : undefined
              })
            }
          }
          if (rl.credits && rl.credits.has_credits) {
            credits = {
              balance: Number(rl.credits.balance) || 0,
              unlimited: Boolean(rl.credits.unlimited)
            }
          }
        }
      }
    }

    // Codex's `input_tokens` already includes the cached portion.
    const billedInput = Math.max(0, input - cached)
    const totals = {
      inputTokens: billedInput,
      outputTokens: output,
      cacheReadTokens: cached,
      cacheWriteTokens: cacheWrite
    }
    out.title = title
    out.nativeSessionId = nativeSessionId
    out.usage = {
      ...totals,
      reasoningTokens: reasoning,
      model,
      messages,
      totalTokens: total || billedInput + output + cached,
      contextTokens: resident,
      contextWindow,
      costUsd: costOf(model, totals),
      limits,
      credits
    }
    return out
  },

  transplant({ fromPath, toHome, nativeSessionId }): string {
    // Preserve the YYYY/MM/DD shape Codex expects when it indexes sessions.
    const d = new Date()
    const destDir = join(
      sessionsRoot(toHome),
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    )
    mkdirSync(destDir, { recursive: true })
    const base = fromPath.split('/').pop() || `rollout-${nativeSessionId}.jsonl`
    const dest = join(destDir, base)
    copyFileSync(fromPath, dest)
    return dest
  },

  oneShot({ home, cwd, prompt }): SpawnPlan {
    return {
      file: this.bin,
      args: ['exec', '--skip-git-repo-check', prompt],
      env: { CODEX_HOME: home }
    }
  }
}
