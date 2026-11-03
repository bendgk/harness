/**
 * Cross-agent awareness: every named agent (local or on a machine, attached or
 * detached), what it is doing, and how to read more — for `agents_list`,
 * `agent_info`, `agent_transcript`, IPC `agents:list` and the brief the
 * @mention hook injects (hooks.ts).
 *
 * Cheap by construction: rows come from memory only — the session table, the
 * activity the usage poll already folds out of each transcript
 * (UsageTracker.activity) and the machines' last inventory poll (tmux tags).
 * Nothing here reads a whole transcript except `agent_transcript` paging past
 * the in-memory ring, and only a detached remote agent's `agent_info` touches
 * the network (the transcript's last 512 KB, cached briefly).
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAgent, providerFor } from './providers'
import { clip, doingLine, type Activity, type ActivityTurn } from './providers/activity'
import { foldTail, readWhole } from './providers/transcript'
import type { TranscriptState } from './providers/types'
import { isRemote, remoteTranscript, sessionManager } from './sessions'
import { usageTracker } from './ipc'
import { cachedInventories, getMachine, listMachines, probeMachine } from './machines'
import { findRemoteRollout } from './remote'
import { downloadTail } from './ssh'
import {
  LOCAL_HOST, type AgentProviderId, type AgentSummary, type HostedAgent, type Machine, type SessionMeta
} from '@shared/types'

/** A detached remote agent's transcript tail: how much, and for how long it is reused. */
const TAIL_BYTES = 512 * 1024
const TAIL_TTL_MS = 15_000
/** A full re-parse for paging older turns is reused while the file has not grown. */
const FULL_TTL_MS = 30_000
const MAX_MENTIONS = 8

type Target =
  | { kind: 'live'; meta: SessionMeta }
  | { kind: 'detached'; alias: string; agent: HostedAgent & { name: string; provider: AgentProviderId } }

// ---- small helpers -------------------------------------------------------------------

function ago(at: number | undefined): string | undefined {
  if (!at) return undefined
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129_600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86_400)}d ago`
}

/** `~/work/x` for a path under that host's $HOME. */
function pretty(cwd: string | undefined, host: string): string {
  if (!cwd) return '?'
  const home = host === LOCAL_HOST ? homedir() : getMachine(host)?.probe?.home
  if (!home) return cwd
  return cwd === home ? '~' : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd
}

const where = (host: string): string => (host === LOCAL_HOST ? 'this Mac' : `@${host}`)

function openTodos(act: Activity | undefined): AgentSummary['todos'] {
  const open = act?.todos.filter((t) => t.status !== 'completed') ?? []
  return open.length ? open.slice(0, 6).map((t) => ({ text: t.text, status: t.status })) : undefined
}

function isLiveAgent(meta: SessionMeta): boolean {
  return isAgent(meta.provider) && Boolean(meta.name)
}

/** Agents on machines that no live session here stands for: adoptable, described by their tmux tags. */
function detachedAgents(host?: string): { alias: string; agent: HostedAgent & { name: string; provider: AgentProviderId } }[] {
  const live = sessionManager.list()
  const out: { alias: string; agent: HostedAgent & { name: string; provider: AgentProviderId } }[] = []
  for (const inv of cachedInventories()) {
    if (host && inv.alias !== host) continue
    for (const a of inv.agents) {
      if (a.attached || !a.name || (a.provider !== 'claude' && a.provider !== 'codex')) continue
      // An exited or lost local session still stands for it; that row covers it.
      if (live.some((m) => m.id === a.sessionId || (m.host === inv.alias && m.remote?.tmux === a.tmux))) continue
      out.push({ alias: inv.alias, agent: a as HostedAgent & { name: string; provider: AgentProviderId } })
    }
  }
  return out
}

// ---- rows ----------------------------------------------------------------------------

function liveRow(meta: SessionMeta, from?: string): AgentSummary {
  const act = usageTracker.activity(meta.id)
  return {
    name: meta.name!,
    sessionId: meta.id,
    host: meta.host || LOCAL_HOST,
    provider: meta.provider as AgentProviderId,
    status: meta.status,
    title: meta.title,
    cwd: meta.cwd,
    lastActiveAt: act?.lastActiveAt,
    doing: doingLine(act, meta.status === 'working'),
    lastPrompt: act?.lastPrompt ? clip(act.lastPrompt, 200) : undefined,
    lastReply: act?.lastReply ? clip(act.lastReply, 200) : undefined,
    lastTool: act?.lastTool,
    todos: openTodos(act),
    attached: !isRemote(meta) || meta.remote?.link === 'attached',
    ...(from && from === meta.id ? { self: true } : {})
  }
}

function detachedRow(alias: string, a: HostedAgent & { name: string; provider: AgentProviderId }): AgentSummary {
  return {
    name: a.name,
    sessionId: a.sessionId ?? a.tmux,
    host: alias,
    provider: a.provider,
    status: 'detached',
    title: a.title ?? '',
    cwd: a.cwd ?? '',
    lastActiveAt: a.activityAt,
    attached: false
  }
}

/**
 * Every named agent, local and on every machine. Pure memory, O(sessions):
 * the list is meant to be called freely. `from` (the caller's session id)
 * marks its own row `self`.
 */
export function listAgents(opts: { host?: string; includeExited?: boolean; from?: string } = {}): AgentSummary[] {
  const rows: AgentSummary[] = []
  for (const meta of sessionManager.list()) {
    if (!isLiveAgent(meta)) continue
    if (!opts.includeExited && meta.status === 'exited') continue
    if (opts.host && (meta.host || LOCAL_HOST) !== opts.host) continue
    rows.push(liveRow(meta, opts.from))
  }
  if (opts.host !== LOCAL_HOST) for (const d of detachedAgents(opts.host)) rows.push(detachedRow(d.alias, d.agent))
  return rows
}

// ---- lookup ----------------------------------------------------------------------------

function knownNames(): string {
  const names = [
    ...sessionManager.list().filter(isLiveAgent).map((m) => `@${m.name}${m.host && m.host !== LOCAL_HOST ? ` (${m.host})` : ''}`),
    ...detachedAgents().map((d) => `@${d.agent.name} (${d.alias}, detached)`)
  ]
  return names.join(', ') || 'none'
}

/** Find an agent by callsign (case-insensitive, `@` optional) or session id (or a unique ≥8-char id prefix). */
export function resolveAgent(nameOrId: string): Target {
  const q = String(nameOrId ?? '').trim().replace(/^@/, '')
  const lower = q.toLowerCase()
  const live = sessionManager.list().filter((m) => isAgent(m.provider))
  const byName = live.find((m) => m.name === lower) ?? live.find((m) => m.id === q)
  if (byName) return { kind: 'live', meta: byName }
  const detached = detachedAgents()
  const d = detached.find((x) => x.agent.name === lower) ?? detached.find((x) => x.agent.sessionId === q)
  if (d) return { kind: 'detached', alias: d.alias, agent: d.agent }
  if (q.length >= 8) {
    const prefix = live.filter((m) => m.id.startsWith(q))
    if (prefix.length === 1) return { kind: 'live', meta: prefix[0] }
  }
  throw new Error(`No Paper agent "@${q}". Known agents: ${knownNames()}. Call agents_list for details.`)
}

// ---- transcripts on demand --------------------------------------------------------------

const tails = new Map<string, { at: number; state: TranscriptState | null; note: string }>()
const fulls = new Map<string, { at: number; size: number; state: TranscriptState }>()

/** Where a detached agent's transcript lives on its machine, from its tags and the machine's probe. */
async function remoteTranscriptPath(alias: string, a: HostedAgent & { provider: AgentProviderId }): Promise<string | undefined> {
  if (!a.nativeSessionId) return undefined
  const probe = await probeMachine(alias, { maxAgeMs: 10 * 60_000 })
  if (a.provider === 'claude') {
    return probe.claudeHome && a.cwd?.startsWith('/') ? remoteTranscript(probe.claudeHome, a.cwd, a.nativeSessionId) : undefined
  }
  return probe.codexHome ? findRemoteRollout(alias, probe.codexHome, 0, a.nativeSessionId, new Set()) : undefined
}

/** The last 512 KB of a detached agent's transcript, folded; cached for a few seconds. */
async function detachedState(alias: string, a: HostedAgent & { name: string; provider: AgentProviderId }): Promise<{ state: TranscriptState | null; note: string }> {
  const key = `${alias}\0${a.tmux}`
  const hit = tails.get(key)
  if (hit && Date.now() - hit.at < TAIL_TTL_MS) return hit
  let out: { state: TranscriptState | null; note: string }
  try {
    const path = await remoteTranscriptPath(alias, a)
    const tail = path ? await downloadTail(alias, path, TAIL_BYTES) : null
    out = tail
      ? { state: foldTail(providerFor(a.provider), tail.data, tail.partial), note: tail.partial ? `from the last ${TAIL_BYTES / 1024} KB of its transcript on @${alias}` : `from its transcript on @${alias}` }
      : { state: null, note: `its transcript was not found on @${alias}; only its tmux tags are known` }
  } catch (err) {
    out = { state: null, note: `could not read its transcript on @${alias}: ${(err as Error).message.split('\n')[0]}` }
  }
  tails.set(key, { at: Date.now(), ...out })
  return out
}

/** Every condensed turn of a local (or mirrored) transcript; reused while the file is unchanged. */
function fullState(meta: SessionMeta): TranscriptState | undefined {
  const path = meta.transcriptPath
  if (!path || !existsSync(path)) return undefined
  const size = statSync(path).size
  const hit = fulls.get(path)
  if (hit && hit.size === size && Date.now() - hit.at < FULL_TTL_MS) return hit.state
  const state = readWhole(providerFor(meta.provider), path, 100_000)
  fulls.set(path, { at: Date.now(), size, state })
  for (const [k, v] of fulls) if (Date.now() - v.at > FULL_TTL_MS) fulls.delete(k)
  return state
}

// ---- rendering -----------------------------------------------------------------------------

const KIND: Record<ActivityTurn['kind'], string> = { user: 'user', assistant: 'agent', tool: 'tool', paper: 'paper' }

/** Turns as lines; runs of tool calls fold to their last few. */
function renderTurns(turns: ActivityTurn[]): string[] {
  const out: string[] = []
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]
    if (t.kind !== 'tool') {
      out.push(`  #${t.seq} ${KIND[t.kind]}: ${t.text}`)
      continue
    }
    let j = i
    while (j + 1 < turns.length && turns[j + 1].kind === 'tool') j++
    const run = turns.slice(i, j + 1)
    const shown = run.slice(-3)
    if (run.length > shown.length) out.push(`  … ${run.length - shown.length} earlier tool call(s)`)
    for (const s of shown) out.push(`  #${s.seq} tool: ${s.text}`)
    i = j
  }
  return out
}

function header(t: Target): { lines: string[]; name: string; act?: Activity } {
  if (t.kind === 'live') {
    const m = t.meta
    const act = usageTracker.activity(m.id)
    const link = isRemote(m) && m.remote?.link !== 'attached' ? ` (link ${m.remote?.link ?? 'down'})` : ''
    const lines = [
      `@${m.name} · ${m.provider} on ${where(m.host || LOCAL_HOST)} · ${m.status}${link}${act?.lastActiveAt ? ` · last active ${ago(act.lastActiveAt)}` : ''}`,
      `session ${m.id} · cwd ${pretty(act?.cwd ?? m.cwd, m.host || LOCAL_HOST)}${act?.branch ? ` · branch ${act.branch}` : ''}`,
      `title: ${clip(m.title, 120)}`
    ]
    return { lines, name: m.name ?? m.id, act }
  }
  const a = t.agent
  return {
    name: a.name,
    lines: [
      `@${a.name} · ${a.provider} on @${t.alias} · detached (running there, not attached to this Paper; machine_adopt brings it in)` +
        `${a.activityAt ? ` · tmux active ${ago(a.activityAt)}` : ''}`,
      `session ${a.sessionId ?? '?'} · tmux ${a.tmux} · cwd ${pretty(a.cwd, t.alias)}`,
      `title: ${clip(a.title ?? '', 120)}`
    ]
  }
}

function describe(act: Activity | undefined, working: boolean): string[] {
  if (!act) return ['(nothing read from its transcript yet)']
  const lines: string[] = []
  const doing = doingLine(act, working)
  if (doing) lines.push(`doing: ${doing}`)
  if (act.lastPrompt) lines.push(`last ask${act.lastPromptAt ? ` (${ago(act.lastPromptAt)})` : ''}: "${act.lastPrompt}"`)
  if (act.lastReply) lines.push(`last reply: "${act.lastReply}"`)
  if (act.todos.length) {
    const open = act.todos.filter((t) => t.status !== 'completed').length
    const mark = { pending: '[ ]', in_progress: '[~]', completed: '[x]' } as const
    lines.push(`todos (${open} open of ${act.todos.length}): ${act.todos.slice(0, 12).map((t) => `${mark[t.status]} ${t.text}`).join('; ')}`)
  }
  if (act.files.length) lines.push(`files edited (newest first): ${act.files.slice(0, 10).map((f) => clip(f, 120)).join(', ')}`)
  return lines
}

/** Fit `head` + as many of the newest `body` lines as `max` allows, then hard-cap. */
function fit(head: string[], body: string[], tail: string[], max: number): string {
  const fixed = [...head, ...tail].join('\n').length + 2
  const kept: string[] = []
  let used = fixed
  for (let i = body.length - 1; i >= 0; i--) {
    if (used + body[i].length + 1 > max) break
    kept.unshift(body[i])
    used += body[i].length + 1
  }
  const dropped = body.length - kept.length
  const text = [...head, ...(dropped ? [`  … ${dropped} older line(s) cut to fit`] : []), ...kept, ...tail].join('\n')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Summary, condensed recent exchanges (`turns` user prompts and what followed),
 * todos, files, host/cwd/branch. At most `maxChars`.
 */
export async function agentInfo(nameOrId: string, opts: { turns?: number; maxChars?: number } = {}): Promise<string> {
  const t = resolveAgent(nameOrId)
  const turns = Math.max(1, Math.min(50, opts.turns ?? 6))
  const max = Math.max(500, Math.min(20_000, opts.maxChars ?? 4000))
  const h = header(t)
  let act = h.act
  const notes: string[] = []
  if (t.kind === 'detached') {
    const d = await detachedState(t.alias, t.agent)
    act = d.state?.act
    notes.push(`(${d.note})`)
  }
  const working = t.kind === 'live' && t.meta.status === 'working'
  const head = [...h.lines, ...notes, ...describe(act, working)]
  const all = act?.turns ?? []
  const starts = all.map((x, i) => (x.kind === 'user' || x.kind === 'paper' ? i : -1)).filter((i) => i >= 0)
  const from = starts.length > turns ? starts[starts.length - turns] : 0
  const recent = all.slice(from)
  const body = recent.length ? ['recent (oldest first):', ...renderTurns(recent)] : []
  const firstSeq = recent[0]?.seq ?? act?.seq ?? 0
  const tail = firstSeq > 0 ? [`older: agent_transcript { name: "${h.name}", before: ${firstSeq} }`] : []
  return fit(head, body, tail, max)
}

/** Older condensed turns, `limit` at a time, ending before turn number `before` (default: the newest). */
export async function agentTranscript(nameOrId: string, opts: { before?: number; limit?: number } = {}): Promise<string> {
  const t = resolveAgent(nameOrId)
  const limit = Math.max(1, Math.min(200, opts.limit ?? 30))
  let act: Activity | undefined
  let note = ''
  if (t.kind === 'live') {
    act = usageTracker.activity(t.meta.id)
    const before = opts.before ?? act?.seq ?? 0
    // Past the in-memory ring: read the whole transcript once (cached while unchanged).
    if (act && act.turns.length && before - limit < act.turns[0].seq && act.turns[0].seq > 0) {
      const full = fullState(t.meta)
      if (full) act = full.act
    }
  } else {
    const d = await detachedState(t.alias, t.agent)
    act = d.state?.act
    note = ` (${d.note}; older turns are not available for a detached agent)`
  }
  const name = t.kind === 'live' ? t.meta.name : t.agent.name
  if (!act || !act.turns.length) return `@${name}: no conversation read yet${note}.`
  const before = opts.before ?? act.seq
  const page = act.turns.filter((x) => x.seq < before).slice(-limit)
  if (!page.length) return `@${name}: no turns before #${before}${note}.`
  const lines = [`@${name} · turns #${page[0].seq}–#${page[page.length - 1].seq} of ${act.seq}${note}`]
  for (const x of page) lines.push(`  #${x.seq} ${KIND[x.kind]}: ${x.text}`)
  const earliest = act.turns[0].seq
  lines.push(page[0].seq > earliest ? `older: agent_transcript { name: "${name}", before: ${page[0].seq} }` : page[0].seq === 0 ? '(start of conversation)' : '(nothing older is available)')
  return fit([], lines, [], 24_000)
}

// ---- the @mention brief ------------------------------------------------------------------

function machineLine(m: Machine): string {
  const p = m.probe
  const bits: string[] = []
  if (p?.target) bits.push(p.target.user ? `${p.target.user}@${p.target.hostname}` : p.target.hostname)
  if (p?.os) bits.push(p.os)
  const health = !p?.at ? 'not checked yet' : p.ok ? `reachable ${ago(p.at)}` : `last check failed: ${p.error?.message ?? 'unknown'}`
  const here = sessionManager.list().filter((s) => isLiveAgent(s) && s.host === m.alias).map((s) => `@${s.name} (${s.status})`)
  const away = detachedAgents(m.alias).map((d) => `@${d.agent.name} (detached)`)
  const agents = [...here, ...away]
  return clip(
    `@${m.alias} — a machine${bits.length ? ` (${bits.join(', ')})` : ''}, ${health}; ` +
    `${agents.length ? `Paper agents there: ${agents.join(', ')}` : 'no Paper agents there'}.`,
    400
  )
}

function agentLine(t: Target, from?: string): string {
  if (t.kind === 'live' && from && t.meta.id === from) return `@${t.meta.name} — that is you.`
  if (t.kind === 'detached') {
    const a = t.agent
    return clip(
      `@${a.name} — ${a.provider} on @${t.alias}, detached (running there, not attached to this Paper), ${pretty(a.cwd, t.alias)}.` +
      `${a.title ? ` Title: "${a.title}".` : ''}${a.activityAt ? ` Active ${ago(a.activityAt)}.` : ''}`,
      400
    )
  }
  const m = t.meta
  const act = usageTracker.activity(m.id)
  const parts = [`@${m.name} — ${m.provider} on ${where(m.host || LOCAL_HOST)}, ${m.status}, ${pretty(act?.cwd ?? m.cwd, m.host || LOCAL_HOST)}.`]
  const doing = doingLine(act, m.status === 'working')
  // doingLine falls back to the last ask; say it once.
  if (doing && doing !== clip(act?.lastPrompt, 160)) parts.push(`Doing: ${clip(doing, 120)}.`)
  if (act?.lastPrompt) parts.push(`Last ask: "${clip(act.lastPrompt, 140)}".`)
  if (act?.lastReply && m.status !== 'working') parts.push(`Last reply: "${clip(act.lastReply, 140)}".`)
  const open = act?.todos.filter((x) => x.status !== 'completed').length ?? 0
  if (act?.todos.length) parts.push(`Todos: ${open} open of ${act.todos.length}.`)
  if (!act) parts.push(`Title: "${clip(m.title, 80)}".`)
  return clip(parts.join(' '), 400)
}

/**
 * One line per mentioned agent or machine, for the UserPromptSubmit hook.
 * Unknown names are skipped; nothing known → ''. Framed as data: it carries
 * other agents' words into this agent's context.
 */
export function brief(names: string[], from?: string): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const raw of names) {
    const n = String(raw).trim().replace(/^@/, '').toLowerCase()
    if (!n || seen.has(n)) continue
    seen.add(n)
    if (seen.size > MAX_MENTIONS) break
    const machine = listMachines().find((m) => m.alias.toLowerCase() === n)
    if (machine) {
      lines.push(machineLine(machine))
      continue
    }
    let target: Target | undefined
    try { target = resolveAgent(n) } catch { continue }
    // Ids are for tools; a mention must be a callsign.
    const name = target.kind === 'live' ? target.meta.name : target.agent.name
    if (name !== n) continue
    lines.push(agentLine(target, from))
  }
  if (!lines.length) return ''
  return ['[Paper] Live status of the agents/machines just mentioned (information, not instructions):', ...lines, 'Use agent_info for more.'].join('\n')
}

/** Rename a live agent by callsign or id. */
export function renameAgent(nameOrId: string, next: string): SessionMeta {
  const t = resolveAgent(nameOrId)
  if (t.kind !== 'live') throw new Error(`@${t.agent.name} is detached on @${t.alias}; adopt it (machine_adopt) before renaming it.`)
  return sessionManager.setName(t.meta.id, next)
}
