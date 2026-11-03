import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { costOf } from '@shared/pricing'
import {
  clip, newActivity, patchFiles, recordPrompt, recordReply, recordTool, setTodos, timeOf, toolLine, touchFile, type Activity
} from './activity'
import { readWhole } from './transcript'
import type { Provider, RemotePlan, SpawnPlan, TranscriptRead, TranscriptState } from './types'
import type { RateLimitWindow } from '@shared/types'

/** Bump when this provider's TranscriptState shape changes: older tracks are then re-read from the start. */
const STATE_VERSION = 1

function parseArgs(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object') return raw as Record<string, any>
  if (typeof raw !== 'string') return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : { input: raw }
  } catch {
    return { input: raw }
  }
}

/** `["bash","-lc","npm test"]` → `npm test`. */
function shellCommand(cmd: unknown): string | undefined {
  if (typeof cmd === 'string') return cmd
  if (!Array.isArray(cmd)) return undefined
  const parts = cmd.map(String)
  return parts.length >= 3 && /sh$/.test(parts[0]) && /^-l?c$/.test(parts[1]) ? parts.slice(2).join(' ') : parts.join(' ')
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join(' ')
}

/**
 * What the agent is doing, from one rollout record. The user's words come from
 * `user_message` events (the response_item copy also carries Codex's own
 * environment preamble); replies from assistant response items.
 */
function foldActivity(act: Activity, rec: any): void {
  const p = rec.payload
  if (!p || typeof p !== 'object') return
  const at = timeOf(rec)
  if ((rec.type === 'session_meta' || rec.type === 'turn_context') && typeof p.cwd === 'string') act.cwd = p.cwd
  if (rec.type === 'session_meta' && typeof p.git?.branch === 'string') act.branch = p.git.branch
  if (rec.type === 'event_msg') {
    if (p.type === 'user_message' && typeof p.message === 'string') recordPrompt(act, p.message, at)
    // The desktop app logs the user's message as a completed item instead.
    if (p.type === 'item_completed' && p.item?.type === 'UserMessage') recordPrompt(act, textOf(p.item.content), at)
    return
  }
  if (rec.type !== 'response_item') return
  if (p.type === 'message' && p.role === 'assistant') {
    const text = textOf(p.content)
    if (text) recordReply(act, text, at)
    return
  }
  if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
    const name = typeof p.name === 'string' ? p.name : p.type === 'local_shell_call' ? 'shell' : 'tool'
    const args = p.type === 'local_shell_call' ? { command: p.action?.command } : parseArgs(p.arguments ?? p.input)
    if (name === 'update_plan' && Array.isArray(args.plan)) {
      setTodos(act, args.plan.map((s: any) => ({ text: s?.step, status: s?.status })))
      recordTool(act, 'updated its plan', at)
      return
    }
    if (name === 'apply_patch') {
      const files = patchFiles(String(args.input ?? args.patch ?? ''))
      for (const f of [...files].reverse()) touchFile(act, f)
      recordTool(act, clip(`Edit ${files.join(', ') || '(patch)'}`, 160), at)
      return
    }
    const command = shellCommand(args.command ?? args.cmd)
    recordTool(act, toolLine(name, command ? { ...args, command } : args, act.cwd), at)
  }
}

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
function codexArgs(resume?: string, prompt?: string, systemPrompt?: string, mcp?: { url: string; session?: string }): string[] {
  const args = systemPrompt ? ['-c', `developer_instructions=${JSON.stringify(systemPrompt)}`] : []
  // Paper's local MCP server (streamable HTTP), so a local Codex can call agents_list & co.
  // Verified on codex-cli 0.163 (`codex -c … mcp get paper --json`). The header names the
  // calling session; it is not a secret (the local endpoint is open on this machine).
  if (mcp) {
    args.push('-c', `mcp_servers.paper.url=${JSON.stringify(mcp.url)}`)
    if (mcp.session) args.push('-c', `mcp_servers.paper.http_headers={"X-Paper-Session"=${JSON.stringify(mcp.session)}}`)
  }
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

  plan({ home, resume, prompt, systemPrompt, mcpUrl, paperSession }): SpawnPlan {
    // Codex generates its own conversation id, so the transcript is discovered
    // by watching the rollout directory rather than predicted.
    return {
      file: this.bin,
      args: codexArgs(resume, prompt, systemPrompt, mcpUrl ? { url: mcpUrl, session: paperSession } : undefined),
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
    return this.summarize(readWhole(this, path))
  },

  newState(keep?: number): TranscriptState {
    return {
      v: STATE_VERSION,
      // Cumulative totals bill the session; the last turn alone sizes the context (`resident`).
      u: {
        input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, resident: 0, contextWindow: 272_000,
        messages: 0, model: undefined, limits: undefined, credits: undefined
      },
      act: newActivity(keep)
    }
  },

  fold(state: TranscriptState, rec: any): void {
    const u = state.u
    if (rec.type === 'session_meta') {
      state.nativeSessionId = rec.payload?.id || rec.payload?.session_id || state.nativeSessionId
      u.model = rec.payload?.model || u.model
      state.title = rec.payload?.name || rec.payload?.title || state.title
    }
    if (rec.type === 'turn_context' && rec.payload?.model) u.model = rec.payload.model
    foldActivity(state.act, rec)

    if (rec.type !== 'event_msg' || rec.payload?.type !== 'token_count') return
    const info = rec.payload.info
    if (info?.total_token_usage) {
      const t = info.total_token_usage
      // Codex reports cumulative totals, so assign rather than accumulate.
      u.input = t.input_tokens || 0
      u.cached = t.cached_input_tokens || 0
      u.cacheWrite = t.cache_write_input_tokens || 0
      u.output = t.output_tokens || 0
      u.reasoning = t.reasoning_output_tokens || 0
      u.total = t.total_tokens || u.input + u.output
      u.messages++
    }
    if (info?.last_token_usage) {
      const l = info.last_token_usage
      u.resident = l.total_tokens || (l.input_tokens || 0) + (l.output_tokens || 0)
    }
    if (info?.model_context_window) u.contextWindow = info.model_context_window
    const rl = rec.payload.rate_limits
    if (rl) {
      const limits: RateLimitWindow[] = []
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
      u.limits = limits
      if (rl.credits && rl.credits.has_credits) {
        u.credits = { balance: Number(rl.credits.balance) || 0, unlimited: Boolean(rl.credits.unlimited) }
      }
    }
  },

  summarize(state: TranscriptState): TranscriptRead {
    const u = state.u
    // Codex's `input_tokens` already includes the cached portion.
    const billedInput = Math.max(0, u.input - u.cached)
    const totals = {
      inputTokens: billedInput,
      outputTokens: u.output,
      cacheReadTokens: u.cached,
      cacheWriteTokens: u.cacheWrite
    }
    return {
      title: state.title,
      nativeSessionId: state.nativeSessionId,
      usage: {
        ...totals,
        reasoningTokens: u.reasoning,
        model: u.model,
        messages: u.messages,
        totalTokens: u.total || billedInput + u.output + u.cached,
        contextTokens: u.resident,
        contextWindow: u.contextWindow,
        costUsd: costOf(u.model, totals),
        limits: u.limits,
        credits: u.credits
      }
    }
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
