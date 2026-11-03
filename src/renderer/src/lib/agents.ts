/**
 * Agent callsigns in the renderer: validation, the merged list of agents the
 * UI knows about, and @-mention ranking shared by the terminal and Paper's
 * own inputs.
 *
 * Names arrive on SessionMeta.name (session:update) and HostedAgent.name (the
 * machine inventory); the richer AgentSummary list (`agents.list()`) adds what
 * each agent is doing. `agentSummaries` merges all three, so the UI works
 * before main serves `agents:list` and stays correct between polls (a rename
 * shows up the moment its session:update arrives).
 */
import { LOCAL_HOST, type AgentSummary, type Machine, type MachineInventory, type SessionMeta } from '@shared/types'
import { rankMachines } from './machines'

/** Mirrors isValidAgentName in src/main/names.ts (renderer must not import main code). */
export const AGENT_NAME_RE = /^[a-z][a-z0-9]{1,15}$/

export const isValidAgentName = (n: string): boolean => AGENT_NAME_RE.test(n) && n !== LOCAL_HOST

/** What the user typed ("  @Euclid ") as a candidate name: trimmed, no @, lowercase. */
export const normaliseAgentName = (input: string): string => input.trim().replace(/^@/, '').toLowerCase()

/**
 * Why `draft` cannot be this agent's name, or null when it can. Names may not
 * shadow another agent or a machine alias, because both answer to `@`.
 */
export function agentNameProblem(
  draft: string,
  ctx: { current?: string; names: Iterable<string>; aliases: Iterable<string> }
): string | null {
  const n = normaliseAgentName(draft)
  if (!n) return 'Type a name'
  if (n === ctx.current) return null
  if (n === LOCAL_HOST) return '"local" is reserved for this Mac'
  if (!/^[a-z]/.test(n)) return 'Start with a letter'
  if (!/^[a-z0-9]*$/.test(n)) return 'Letters and digits only'
  if (n.length < 2) return 'At least 2 characters'
  if (n.length > 16) return 'At most 16 characters'
  for (const a of ctx.aliases) if (a.toLowerCase() === n) return `@${n} is a machine`
  for (const x of ctx.names) if (x === n) return `@${n} is taken by another agent`
  return null
}

interface AgentSources {
  sessions: Record<string, SessionMeta>
  agents: AgentSummary[]
  inventory: Record<string, MachineInventory>
  lastActivity: Record<string, number>
}

/**
 * Every named agent the UI knows about, one per name. Live sessions win for
 * name/status/title (they update instantly); the summaries cache adds
 * `doing`, prompts and todos; the inventory adds detached remote agents.
 */
export function agentSummaries(s: AgentSources): AgentSummary[] {
  const byId = new Map<string, AgentSummary>()
  for (const a of s.agents) byId.set(a.sessionId, a)
  const out = new Map<string, AgentSummary>()
  for (const m of Object.values(s.sessions)) {
    if (!m.name || m.provider === 'shell') continue
    const cached = byId.get(m.id)
    out.set(m.name, {
      ...cached,
      name: m.name,
      sessionId: m.id,
      host: m.host ?? LOCAL_HOST,
      provider: m.provider,
      status: m.status,
      title: m.title,
      cwd: m.cwd,
      lastActiveAt: Math.max(s.lastActivity[m.id] ?? 0, cached?.lastActiveAt ?? 0) || undefined,
      attached: true
    })
  }
  for (const a of s.agents) {
    if (out.has(a.name)) continue
    // A summary whose session is live under another name is stale (just renamed).
    if (s.sessions[a.sessionId]) continue
    out.set(a.name, a)
  }
  for (const inv of Object.values(s.inventory)) {
    for (const h of inv.agents) {
      if (!h.name || out.has(h.name)) continue
      if (h.sessionId && s.sessions[h.sessionId]) continue
      out.set(h.name, {
        name: h.name,
        sessionId: h.sessionId ?? `${inv.alias}:${h.tmux}`,
        host: inv.alias,
        provider: h.provider === 'codex' ? 'codex' : 'claude',
        status: 'detached',
        title: h.title || h.command || h.tmux,
        cwd: h.cwd ?? '',
        lastActiveAt: h.activityAt,
        attached: false
      })
    }
  }
  return [...out.values()]
}

/** Every agent name in use — for painting tags and for uniqueness checks. */
export function knownAgentNames(s: AgentSources): string[] {
  const names = new Set<string>()
  for (const m of Object.values(s.sessions)) if (m.name && m.provider !== 'shell') names.add(m.name)
  for (const a of s.agents) if (!s.sessions[a.sessionId]) names.add(a.name)
  // A live session's own name wins over its machine tag, which lags a rename by one poll.
  for (const inv of Object.values(s.inventory)) {
    for (const h of inv.agents) if (h.name && !(h.sessionId && s.sessions[h.sessionId])) names.add(h.name)
  }
  return [...names].sort()
}

const STATUS_RANK: Record<AgentSummary['status'], number> = {
  working: 0, starting: 1, handoff: 1, idle: 2, detached: 3, exited: 4
}

/**
 * Rank agents for an @-query: name prefix, then substring (title too once the
 * query is ≥2 chars); within each, working before idle before detached, then
 * most recently active. `exclude` is the asking pane's own agent.
 */
export function rankAgents(query: string, agents: AgentSummary[], exclude?: string): AgentSummary[] {
  const q = query.toLowerCase()
  const scored: { a: AgentSummary; s: number }[] = []
  for (const a of agents) {
    if (exclude && a.sessionId === exclude) continue
    const s = !q || a.name.startsWith(q) ? 0 : a.name.includes(q) ? 1 : q.length >= 2 && a.title.toLowerCase().includes(q) ? 2 : -1
    if (s >= 0) scored.push({ a, s })
  }
  return scored
    .sort((x, y) => x.s - y.s ||
      STATUS_RANK[x.a.status] - STATUS_RANK[y.a.status] ||
      (y.a.lastActiveAt ?? 0) - (x.a.lastActiveAt ?? 0) ||
      x.a.name.localeCompare(y.a.name))
    .map((x) => x.a)
}

/** Most agents one dropdown lists; the rest are a keystroke away. */
export const MENU_AGENTS = 6

/**
 * The completion keys a dropdown offers, agents first: `matches` holds the
 * names then the aliases, `agents` how many of them are agent names.
 */
export function mentionTargets(
  query: string,
  s: AgentSources & { machines: Machine[] },
  exclude?: string
): { matches: string[]; agents: number } {
  const agents = rankAgents(query, agentSummaries(s), exclude).slice(0, MENU_AGENTS).map((a) => a.name)
  const machines = rankMachines(query, s.machines).map((m) => m.alias)
  return { matches: [...agents, ...machines], agents: agents.length }
}

export const isLive = (a: AgentSummary): boolean => a.status !== 'detached' && a.status !== 'exited'
