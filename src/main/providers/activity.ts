/**
 * What an agent is doing, distilled from its transcript while the usage poll
 * reads it anyway — one pass, no model call, small enough to keep in memory
 * for every session. Providers fold records into an `Activity`; agents.ts
 * turns it into `agents_list` rows, `agent_info` and the `@name` brief.
 *
 * Pure: no electron, no fs. Text is clipped on the way in, so nothing here can
 * grow with the transcript except the bounded ring of condensed turns.
 */

/** One condensed step of a conversation. `seq` counts every turn ever seen, so pages stay stable as the ring rolls. */
export interface ActivityTurn {
  seq: number
  /** `paper` = a prompt Paper itself typed (restart nudge, handoff continue), not the user. */
  kind: 'user' | 'assistant' | 'tool' | 'paper'
  text: string
  at?: number
}

export interface ActivityTodo {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Claude Task tools address items by id. */
  id?: string
  /** Present-tense form of an in-progress item ("Running tests"). */
  active?: string
}

export interface Activity {
  lastPrompt?: string
  lastPromptAt?: number
  lastReply?: string
  lastReplyAt?: number
  lastTool?: string
  lastToolAt?: number
  /** Timestamp of the newest user/assistant record. */
  lastActiveAt?: number
  todos: ActivityTodo[]
  /** Files the agent edited or wrote, most recent first. */
  files: string[]
  cwd?: string
  branch?: string
  turns: ActivityTurn[]
  /** Total turns pushed (the next turn's seq). */
  seq: number
  /** Ring size for `turns`. */
  keep: number
}

export const TURNS_KEPT = 240
const FILES_KEPT = 12
const TODOS_KEPT = 40

export function newActivity(keep = TURNS_KEPT): Activity {
  return { todos: [], files: [], turns: [], seq: 0, keep }
}

/** One line, at most `max` chars. */
export function clip(s: unknown, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export function timeOf(rec: { timestamp?: unknown }): number | undefined {
  if (typeof rec.timestamp !== 'string') return undefined
  const t = Date.parse(rec.timestamp)
  return Number.isFinite(t) ? t : undefined
}

export function pushTurn(act: Activity, kind: ActivityTurn['kind'], text: string, at?: number): void {
  if (!text) return
  act.turns.push({ seq: act.seq++, kind, text, at })
  if (act.turns.length > act.keep) act.turns.splice(0, act.turns.length - act.keep)
  if (at && (!act.lastActiveAt || at > act.lastActiveAt)) act.lastActiveAt = at
}

/**
 * Prompts Paper types into agents itself. They are kept in the turn list
 * (marked `paper`) but are never "what the user last asked".
 */
const PAPER_PROMPTS = [
  'Paper restarted while you were working.',
  'You have been handed off to ',
  'You are taking over an in-progress session from another coding agent.'
]

/** Not a person typing: CLI-internal wrappers and reminders. */
const NOT_A_PROMPT = /^(<command-|<local-command-|<system-reminder>|<environment_context>|<user_instructions>|<user_shell_command>|<turn_aborted>|<app-context>|<bash-stdout>|<bash-stderr>|Caveat: |\[Request interrupted)/

export function promptKind(text: string): 'user' | 'paper' | null {
  const t = text.trim()
  if (!t || NOT_A_PROMPT.test(t)) return null
  return PAPER_PROMPTS.some((p) => t.startsWith(p)) ? 'paper' : 'user'
}

export function recordPrompt(act: Activity, raw: string, at?: number): void {
  // `!cmd` typed into Claude Code is logged as <bash-input>cmd</bash-input>.
  const bang = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/.exec(raw)
  const text = bang ? `! ${bang[1]}` : raw
  const kind = promptKind(text)
  if (!kind) return
  const line = clip(text, 400)
  // Some CLIs log one message twice (an event and an item); keep one.
  const prev = act.turns[act.turns.length - 1]
  if (prev && prev.kind === kind && prev.text === line && Math.abs((prev.at ?? 0) - (at ?? 0)) < 5000) return
  pushTurn(act, kind, line, at)
  if (kind === 'user') {
    act.lastPrompt = clip(text, 400)
    act.lastPromptAt = at
  }
}

export function recordReply(act: Activity, text: string, at?: number): void {
  const t = clip(text, 600)
  if (!t) return
  pushTurn(act, 'assistant', clip(t, 400), at)
  act.lastReply = t
  act.lastReplyAt = at
}

export function recordTool(act: Activity, line: string, at?: number): void {
  if (!line) return
  pushTurn(act, 'tool', line, at)
  act.lastTool = line
  act.lastToolAt = at
}

export function touchFile(act: Activity, path: unknown): void {
  if (typeof path !== 'string' || !path) return
  const p = clip(path, 300)
  const i = act.files.indexOf(p)
  if (i >= 0) act.files.splice(i, 1)
  act.files.unshift(p)
  if (act.files.length > FILES_KEPT) act.files.length = FILES_KEPT
}

function status(s: unknown): ActivityTodo['status'] {
  return s === 'in_progress' || s === 'completed' ? s : 'pending'
}

/** A whole new list (Claude TodoWrite, Codex update_plan). */
export function setTodos(act: Activity, items: { text: unknown; status: unknown; active?: unknown }[]): void {
  act.todos = items
    .filter((t) => typeof t.text === 'string' && t.text)
    .slice(0, TODOS_KEPT)
    .map((t) => ({ text: clip(t.text, 160), status: status(t.status), active: t.active ? clip(t.active, 160) : undefined }))
}

/** Claude's Task tools: TaskCreate's result carries the id; TaskUpdate changes one item. */
export function upsertTask(act: Activity, id: string, patch: { text?: unknown; status?: unknown; active?: unknown }): void {
  if (patch.status === 'deleted') {
    act.todos = act.todos.filter((t) => t.id !== id)
    return
  }
  let item = act.todos.find((t) => t.id === id)
  if (!item) {
    if (typeof patch.text !== 'string') return
    if (act.todos.length >= TODOS_KEPT) return
    item = { id, text: '', status: 'pending' }
    act.todos.push(item)
  }
  if (typeof patch.text === 'string' && patch.text) item.text = clip(patch.text, 160)
  if (patch.status !== undefined) item.status = status(patch.status)
  if (typeof patch.active === 'string' && patch.active) item.active = clip(patch.active, 160)
}

/** `src/x.ts` instead of `/Users/me/work/repo/src/x.ts` when it is under the agent's cwd. */
export function shortPath(p: string, cwd?: string): string {
  if (cwd && p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1)
  return p
}

/** First non-empty string field among `keys`. */
function pick(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input?.[k]
    if (typeof v === 'string' && v.trim()) return v
    if (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length) return v.join(' ')
  }
  return undefined
}

/** A tool call as one line: `Bash: npm test`, `Edit src/x.ts`, `mcp paper.sessions_list`. */
export function toolLine(name: string, input: Record<string, unknown>, cwd?: string): string {
  const file = pick(input, ['file_path', 'notebook_path', 'path'])
  switch (name) {
    case 'Bash':
    case 'shell':
    case 'exec_command':
    case 'local_shell':
      return clip(`Bash: ${pick(input, ['command', 'cmd']) ?? ''}`, 160)
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'Read':
      return clip(`${name} ${file ? shortPath(file, cwd) : ''}`, 160)
    case 'Grep':
    case 'Glob':
      return clip(`${name} ${pick(input, ['pattern']) ?? ''}${input.path ? ` in ${shortPath(String(input.path), cwd)}` : ''}`, 160)
    case 'WebFetch':
      return clip(`WebFetch ${pick(input, ['url']) ?? ''}`, 160)
    case 'WebSearch':
      return clip(`WebSearch ${pick(input, ['query']) ?? ''}`, 160)
    case 'Task':
    case 'Agent':
      return clip(`Agent: ${pick(input, ['description', 'prompt']) ?? ''}`, 160)
    case 'TodoWrite':
    case 'update_plan':
      return 'updated its todo list'
    case 'TaskCreate':
      return clip(`TaskCreate: ${pick(input, ['subject']) ?? ''}`, 160)
    case 'TaskUpdate':
      return clip(`TaskUpdate #${String(input.taskId ?? '')} ${String(input.status ?? '')}`, 160)
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return clip(`mcp ${mcp[1]}.${mcp[2]}`, 160)
  const arg = file ? shortPath(file, cwd) : pick(input, ['command', 'query', 'pattern', 'url', 'description', 'prompt', 'name'])
  return clip(arg ? `${name}: ${arg}` : name, 160)
}

/** Files named in an apply_patch body. */
export function patchFiles(patch: string): string[] {
  const out: string[] = []
  const re = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm
  for (let m = re.exec(patch); m; m = re.exec(patch)) out.push(m[1].trim())
  return out
}

/** One line on what the agent is doing now: its in-progress todo, else its last tool call, else its last ask. */
export function doingLine(act: Activity | undefined, working: boolean): string | undefined {
  if (!act) return undefined
  const current = act.todos.find((t) => t.status === 'in_progress')
  if (current) return clip(current.active || current.text, 160)
  // A tool call after the last reply is the step in flight; a reply after it means the step is over.
  if (act.lastTool && (act.lastToolAt ?? 0) >= (act.lastReplyAt ?? 0) && (working || (act.lastToolAt ?? 0) >= (act.lastPromptAt ?? 0))) {
    return act.lastTool
  }
  return act.lastPrompt ? clip(act.lastPrompt, 160) : undefined
}
