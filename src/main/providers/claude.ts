import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, copyFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { contextWindowFor, costOf } from '@shared/pricing'
import {
  newActivity, recordPrompt, recordReply, recordTool, setTodos, timeOf, toolLine, touchFile, upsertTask, type Activity
} from './activity'
import { readWhole } from './transcript'
import type { Provider, RemotePlan, SpawnPlan, TranscriptRead, TranscriptState } from './types'

/** Bump when this provider's TranscriptState shape changes: older tracks are then re-read from the start. */
const STATE_VERSION = 1

/** Tools whose `file_path` the agent changed. */
const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/**
 * What the agent is doing, from one user/assistant record. Sidechains are
 * subagents talking among themselves inside this process; Paper names and
 * describes only the root agent.
 */
function foldActivity(act: Activity, rec: any): void {
  if (rec.isSidechain) return
  if (rec.cwd) act.cwd = rec.cwd
  if (rec.gitBranch) act.branch = rec.gitBranch
  const at = timeOf(rec)
  const content = rec.message?.content
  if (rec.type === 'user') {
    if (rec.isMeta || rec.isCompactSummary) return
    // TaskCreate's result carries the new task's id; the call itself did not know it.
    const task = rec.toolUseResult?.task
    if (task && typeof task.id === 'string' && typeof task.subject === 'string') upsertTask(act, task.id, { text: task.subject })
    if (typeof content === 'string') return recordPrompt(act, content, at)
    if (!Array.isArray(content) || content.some((c: any) => c?.type === 'tool_result')) return
    const text = content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' ')
    if (text) recordPrompt(act, text, at)
    return
  }
  if (!Array.isArray(content)) return
  for (const c of content) {
    if (c?.type === 'text' && c.text) recordReply(act, c.text, at)
    if (c?.type !== 'tool_use' || typeof c.name !== 'string') continue
    const input = c.input && typeof c.input === 'object' ? c.input : {}
    recordTool(act, toolLine(c.name, input, act.cwd), at)
    if (EDITS.has(c.name)) touchFile(act, input.file_path ?? input.notebook_path)
    if (c.name === 'TodoWrite' && Array.isArray(input.todos)) {
      setTodos(act, input.todos.map((t: any) => ({ text: t?.content, status: t?.status, active: t?.activeForm })))
    }
    if (c.name === 'TaskUpdate' && input.taskId !== undefined) {
      upsertTask(act, String(input.taskId), { status: input.status, text: input.subject, active: input.activeForm })
    }
  }
}

/** Claude Code encodes the cwd into the project folder name. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Claude slugs the *physical* cwd (`/tmp/x` is `/private/tmp/x` on macOS), so a
 * symlinked directory must be resolved or the transcript is never found.
 */
function projectDir(home: string, cwd: string): string {
  let real = cwd
  try { real = realpathSync(cwd) } catch { /* not here (yet): use it as given */ }
  return join(home, 'projects', projectSlug(real))
}

export const claudeProvider: Provider = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  homeEnv: 'CLAUDE_CONFIG_DIR',
  interruptSequence: '\x1b', // ESC cancels the turn but keeps the REPL alive

  plan({ home, cwd, resume, prompt, systemPrompt, mcpUrl, paperSession, settings }): SpawnPlan {
    // Pinning the session id up front makes the transcript path deterministic,
    // so usage tracking starts with the very first token instead of racing a watcher.
    const id = resume || randomUUID()
    const args: string[] = []
    // Every Claude session in Paper gets Paper's own MCP server, so an agent
    // can inspect and drive the harness it is running in (sessions.ts leaves
    // mcpUrl out when PAPER_MCP=0). Inline JSON rather than ~/.paper/mcp.json so
    // the server can tell which session is calling (X-Paper-Session: not a
    // secret — the local endpoint is open to this machine anyway). The flag is
    // variadic, so it goes first, closed by the next option.
    if (mcpUrl) {
      const headers = paperSession ? { 'X-Paper-Session': paperSession } : undefined
      args.push('--mcp-config', JSON.stringify({ mcpServers: { paper: { type: 'http', url: mcpUrl, headers } } }))
    }
    // Additional settings, merged with the user's own (the @mention hook).
    if (settings) args.push('--settings', settings)
    args.push(...(resume ? ['--resume', id] : ['--session-id', id]))
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt)
    if (prompt) args.push(prompt)
    return {
      file: this.bin,
      args,
      // Claude only uses synchronized output (DEC 2026) once the terminal has
      // answered XTVERSION, which xterm.js never does. Forced on, every frame
      // comes wrapped in BSU/ESU and the pane writes it to xterm whole
      // (renderer lib/sync-output.ts), so a redraw that spans several pty
      // reads never renders half done. Ignored by Claude inside tmux.
      env: { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_FORCE_SYNC_OUTPUT: '1' },
      nativeSessionId: id,
      transcriptPath: join(projectDir(home, cwd), `${id}.jsonl`)
    }
  },

  remotePlan({ resume, prompt, systemPrompt, sessionId, mcpConfig, settings }): RemotePlan {
    // Same pinned id as locally, so the remote transcript path is predictable
    // (<claudeHome>/projects/<slug>/<id>.jsonl) and resume works across hosts.
    const id = resume || sessionId || randomUUID()
    const args: string[] = []
    // The gateway config (a file on the remote holding the session's token —
    // never argv or env). `--mcp-config` is variadic, so it must be followed
    // by another option, not the prompt.
    if (mcpConfig) args.push('--mcp-config', mcpConfig)
    if (settings) args.push('--settings', settings)
    args.push(...(resume ? ['--resume', id] : ['--session-id', id]))
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt)
    if (prompt) args.push(prompt)
    return { bin: this.bin, args, nativeSessionId: id }
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
    return this.summarize(readWhole(this, path))
  },

  newState(keep?: number): TranscriptState {
    return {
      v: STATE_VERSION,
      u: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messages: 0, contextTokens: 0, model: undefined },
      act: newActivity(keep)
    }
  },

  fold(state: TranscriptState, rec: any): void {
    if (rec.sessionId && !state.nativeSessionId) state.nativeSessionId = rec.sessionId
    if (rec.type === 'ai-title' && rec.aiTitle) state.title = rec.aiTitle
    if (rec.type === 'user' || rec.type === 'assistant') foldActivity(state.act, rec)
    if (rec.type !== 'assistant') return
    const usage = rec.message?.usage
    if (!usage) return
    const u = state.u
    u.messages++
    u.model = rec.message?.model || u.model
    u.input += usage.input_tokens || 0
    u.output += usage.output_tokens || 0
    u.cacheRead += usage.cache_read_input_tokens || 0
    u.cacheWrite += usage.cache_creation_input_tokens || 0
    u.reasoning += usage.output_tokens_details?.thinking_tokens || 0
    // The live context footprint is the newest turn's resident tokens.
    u.contextTokens =
      (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
  },

  summarize(state: TranscriptState): TranscriptRead {
    const u = state.u
    const totals = { inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite }
    return {
      title: state.title,
      nativeSessionId: state.nativeSessionId,
      usage: {
        ...totals,
        reasoningTokens: u.reasoning,
        model: u.model,
        messages: u.messages,
        totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
        contextTokens: u.contextTokens,
        contextWindow: contextWindowFor(u.model),
        costUsd: costOf(u.model, totals)
      }
    }
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
