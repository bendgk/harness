import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { contextWindowFor, costOf } from '@shared/pricing'
import { kernel } from '../kernel'
import type { Provider, SpawnPlan, TranscriptRead } from './types'

/** Claude Code encodes the cwd into the project folder name. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function projectDir(home: string, cwd: string): string {
  return join(home, 'projects', projectSlug(cwd))
}

export const claudeProvider: Provider = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  homeEnv: 'CLAUDE_CONFIG_DIR',
  interruptSequence: '\x1b', // ESC cancels the turn but keeps the REPL alive

  plan({ home, cwd, resume, prompt }): SpawnPlan {
    // Pinning the session id up front makes the transcript path deterministic,
    // so usage tracking starts with the very first token instead of racing a watcher.
    const id = resume || randomUUID()
    const args = resume ? ['--resume', id] : ['--session-id', id]
    // Every Claude session in Paper gets Paper's own MCP server, so an agent
    // can inspect and drive the harness it is running in. PAPER_MCP=0 opts out.
    const mcpConfig = kernel().mcp.configPath
    if (process.env.PAPER_MCP !== '0' && kernel().mcp.url && existsSync(mcpConfig)) {
      args.push('--mcp-config', mcpConfig)
    }
    if (prompt) args.push(prompt)
    return {
      file: this.bin,
      args,
      env: { CLAUDE_CONFIG_DIR: home },
      nativeSessionId: id,
      transcriptPath: join(projectDir(home, cwd), `${id}.jsonl`)
    }
  },

  findTranscript({ home, cwd, since, nativeSessionId, exclude }): string | undefined {
    // A pinned id names the file exactly. Claude only writes it after the first
    // prompt, so until then the answer is "not yet" — never the newest file in
    // the folder, which belongs to whichever neighbour happens to be busy.
    if (nativeSessionId) {
      const direct = join(projectDir(home, cwd), `${nativeSessionId}.jsonl`)
      return existsSync(direct) ? direct : undefined
    }
    const dir = projectDir(home, cwd)
    if (!existsSync(dir)) return undefined
    const candidates = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dir, f))
      .filter((p) => !exclude?.has(p))
      .filter((p) => statSync(p).mtimeMs >= since - 5_000)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    return candidates[0]
  },

  readTranscript(path: string): TranscriptRead {
    const out: TranscriptRead = { usage: {} }
    if (!existsSync(path)) return out
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0, messages = 0
    let model: string | undefined
    let contextTokens = 0
    let title: string | undefined
    let nativeSessionId: string | undefined

    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue
      let rec: any
      try { rec = JSON.parse(line) } catch { continue }
      if (rec.sessionId && !nativeSessionId) nativeSessionId = rec.sessionId
      if (rec.type === 'ai-title' && rec.aiTitle) title = rec.aiTitle
      if (rec.type !== 'assistant') continue
      const u = rec.message?.usage
      if (!u) continue
      messages++
      model = rec.message?.model || model
      input += u.input_tokens || 0
      output += u.output_tokens || 0
      cacheRead += u.cache_read_input_tokens || 0
      cacheWrite += u.cache_creation_input_tokens || 0
      reasoning += u.output_tokens_details?.thinking_tokens || 0
      // The live context footprint is the newest turn's resident tokens.
      contextTokens =
        (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    }

    const totals = { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
    out.title = title
    out.nativeSessionId = nativeSessionId
    out.usage = {
      ...totals,
      reasoningTokens: reasoning,
      model,
      messages,
      totalTokens: input + output + cacheRead + cacheWrite,
      contextTokens,
      contextWindow: contextWindowFor(model),
      costUsd: costOf(model, totals)
    }
    return out
  },

  transplant({ fromPath, toHome, cwd, nativeSessionId }): string {
    const destDir = projectDir(toHome, cwd)
    mkdirSync(destDir, { recursive: true })
    const dest = join(destDir, `${nativeSessionId}.jsonl`)
    copyFileSync(fromPath, dest)
    return dest
  },

  oneShot({ home, cwd, prompt }): SpawnPlan {
    return {
      file: this.bin,
      args: ['-p', prompt, '--model', 'claude-haiku-4-5-20251001'],
      env: { CLAUDE_CONFIG_DIR: home }
    }
  }
}
