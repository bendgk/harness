/**
 * DEV-ONLY in-memory stand-in for the main-process machine registry.
 *
 * The renderer was built before the ssh/machines handlers existed in main, so
 * this lets the whole machines UX be exercised in a dev build without a real
 * remote box. It is inert unless BOTH hold:
 *   - this is a Vite dev build (`import.meta.env.DEV`), and
 *   - localStorage['paper:fake-machines'] === '1'
 * Turn it on with
 *   localStorage.setItem('paper:fake-machines', '1'); location.reload()
 * and off with removeItem. Production builds tree-shake it to nothing useful.
 *
 * Sessions "on" a fake machine are real local shells whose meta is decorated
 * with `host`/`remote` in the renderer, so badges, the tree and the handoff
 * overlay can be seen end to end.
 *
 * Agent callsigns: every agent session (and every dressed remote session)
 * gets a name from a small pool unless main already gave it one; `agents.list`
 * and `session.setName` are served here too. `__paperFakes.agentify(id)`
 * dresses a local shell up as a named Claude agent (optionally `working`), so
 * the names UI can be exercised without spending quota on a real agent.
 */
import type {
  AgentProviderId, AgentSummary, Machine, MachineHandoffRequest, MachineInventory, MachineProbe, SessionMeta,
  SessionStatus, SpawnRequest
} from '@shared/types'
import { LOCAL_HOST } from '@shared/types'
import { agentNameProblem } from './agents'

export const FAKE_FLAG = 'paper:fake-machines'

export function fakesOn(): boolean {
  if (!import.meta.env.DEV) return false
  try { return localStorage.getItem(FAKE_FLAG) === '1' } catch { return false }
}

type Fn<T> = (v: T) => void
const listeners = {
  machines: new Set<Fn<Machine[]>>(),
  inventory: new Set<Fn<MachineInventory>>(),
  handoff: new Set<Fn<{ sessionId: string; stage: string; detail?: string; done?: boolean; error?: string }>>(),
  session: new Set<Fn<SessionMeta>>()
}
const emit = <T>(set: Set<Fn<T>>, v: T): void => { for (const fn of set) fn(v) }
const sub = <T>(set: Set<Fn<T>>, fn: Fn<T>): (() => void) => { set.add(fn); return () => set.delete(fn) }
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const PROBES: Record<string, () => MachineProbe> = {
  g6e: () => ({
    at: Date.now(), ok: true, os: 'Ubuntu 22.04 · x86_64', latencyMs: 34 + Math.round(Math.random() * 12),
    target: { hostname: 'g6e.internal', user: 'ben', port: 22 },
    tools: { claude: '2.0.31 (Claude Code)', codex: 'codex-cli 0.50.0', tmux: 'tmux 3.4' }
  }),
  a100: () => ({
    at: Date.now(), ok: true, os: 'Rocky Linux 9.4', latencyMs: 88,
    target: { hostname: '10.20.0.14', user: 'bkosten', port: 2222 },
    tools: { claude: '2.0.28 (Claude Code)' }
  }),
  lab: () => ({
    at: Date.now(), ok: false, tools: {}, target: { hostname: 'lab.example.org', user: 'ben', port: 22 },
    error: {
      kind: 'auth',
      message: 'lab rejected the ssh key',
      hint: 'Load your key into the agent with `ssh-add ~/.ssh/id_ed25519` (or add IdentityFile to the lab entry in ~/.ssh/config), then press Test.',
      detail: 'ben@lab.example.org: Permission denied (publickey,gssapi-keyex,gssapi-with-mic).'
    }
  })
}
const generic = (alias: string): MachineProbe => ({
  at: Date.now(), ok: true, os: 'macOS 15.1', latencyMs: 12,
  target: { hostname: `${alias}.local`, user: 'ben', port: 22 },
  tools: { claude: '2.0.31', codex: '0.50.0', tmux: '3.5a' }
})

let machines: Machine[] = [
  { alias: 'g6e', label: 'GPU box', note: '8×L40S, repos in ~/work', defaultCwd: '~/work', addedAt: Date.now() - 86_400_000, probe: PROBES.g6e() },
  { alias: 'a100', label: 'Cluster login', addedAt: Date.now() - 3_600_000, probe: PROBES.a100() },
  { alias: 'lab', addedAt: Date.now() - 600_000, probe: PROBES.lab() }
]

/** Remote tmux sessions per machine — the inventory's ground truth. */
const hosted: Record<string, MachineInventory['agents']> = {
  g6e: [
    { tmux: 'paper-3f9a1c0e22b1', name: 'hypatia', provider: 'claude', title: 'Sweep learning rates', cwd: '/home/ben/work/trainer',
      createdAt: Date.now() - 7_200_000, activityAt: Date.now() - 40_000, command: 'claude', attached: false },
    { tmux: 'paper-a81c55d0e4f7', name: 'noether', provider: 'codex', title: 'Fix flaky dataloader test', cwd: '/home/ben/work/data',
      createdAt: Date.now() - 1_800_000, activityAt: Date.now() - 900_000, command: 'node', attached: false }
  ],
  a100: []
}

/** Local shells dressed up as remote sessions. */
const dressed = new Map<string, {
  host: string; tmux: string; link: NonNullable<SessionMeta['remote']>['link']; provider?: AgentProviderId
}>()

/** Local shells dressed up as agents (agentify), and the callsign each fake agent wears. */
const agentified = new Map<string, { provider: AgentProviderId; status?: SessionStatus; title?: string }>()
const names = new Map<string, string>()
const POOL = ['euclid', 'leonardo', 'apollo', 'hermes', 'gauss', 'curie', 'turing', 'athena', 'kepler', 'faraday', 'minerva', 'archimedes']

function pickName(): string {
  const taken = new Set<string>([...names.values(), ...Object.values(hosted).flat().map((a) => a.name ?? '')])
  for (const m of machines) taken.add(m.alias.toLowerCase())
  const free = POOL.find((n) => !taken.has(n))
  if (free) return free
  for (let i = 2; ; i++) for (const n of POOL) if (!taken.has(`${n}${i}`)) return `${n}${i}`
}

export function decorate(meta: SessionMeta): SessionMeta {
  if (!fakesOn()) return meta
  let out = meta
  const d = dressed.get(meta.id)
  if (d) out = { ...out, host: d.host, remote: { tmux: d.tmux, link: d.link }, provider: d.provider ?? out.provider }
  const ag = agentified.get(meta.id)
  if (ag) {
    out = { ...out, provider: ag.provider, title: ag.title ?? out.title }
    // A pretend status sticks until the pty really exits.
    if (ag.status && out.status !== 'exited') out = { ...out, status: ag.status }
  }
  if (out.provider === 'shell' && !d) return out
  let name = names.get(meta.id) ?? meta.name
  if (!name) { name = pickName(); names.set(meta.id, name) }
  return { ...out, name }
}

const last = new Map<string, SessionMeta>()
function dress(
  meta: SessionMeta, host: string, tmux = `paper-${meta.id.slice(0, 12)}`, provider?: AgentProviderId
): SessionMeta {
  const was = dressed.get(meta.id)
  if (host === LOCAL_HOST) dressed.delete(meta.id)
  else dressed.set(meta.id, { host, tmux, link: 'connecting', provider: provider ?? was?.provider })
  last.set(meta.id, meta)
  // The link settles a moment later, as a real ssh attach would.
  if (host !== LOCAL_HOST) {
    setTimeout(() => {
      const d = dressed.get(meta.id)
      if (!d) return
      d.link = 'attached'
      emit(listeners.session, decorate(last.get(meta.id) ?? meta))
    }, 1400)
  }
  return decorate(meta)
}

/** Used by the store to test the "lost" badge: `__paperFakes.setLink(id, 'lost')`. */
function setLink(id: string, link: NonNullable<SessionMeta['remote']>['link']): void {
  const d = dressed.get(id)
  const meta = last.get(id)
  if (!d || !meta) return
  d.link = link
  emit(listeners.session, decorate(meta))
}

function inventoryFor(alias: string): MachineInventory {
  const m = machines.find((x) => x.alias === alias)
  if (m?.probe && !m.probe.ok) return { alias, at: Date.now(), ok: false, error: m.probe.error, agents: [] }
  const attached = [...dressed.entries()].filter(([, d]) => d.host === alias)
  const agents = (hosted[alias] ?? []).map((a) => ({ ...a, attached: attached.some(([, d]) => d.tmux === a.tmux) }))
  for (const [id, d] of attached) {
    if (agents.some((a) => a.tmux === d.tmux)) continue
    const meta = last.get(id)
    agents.push({ tmux: d.tmux, sessionId: id, name: names.get(id), provider: d.provider ?? meta?.provider, cwd: meta?.cwd, title: meta?.title,
      createdAt: meta?.createdAt, activityAt: Date.now(), attached: true })
  }
  return { alias, at: Date.now(), ok: true, agents }
}

const api = (): typeof window.paper => window.paper

export const fake = {
  machines: {
    async list(): Promise<Machine[]> { return machines },
    async suggest() {
      return ['g6e', 'a100', 'lab', 'mini', 'pi4', 'build-01'].map((alias) => ({
        alias, hostname: `${alias}.internal`, user: 'ben', registered: machines.some((m) => m.alias === alias)
      }))
    },
    async add(input: { alias: string; label?: string; note?: string; defaultCwd?: string }): Promise<Machine> {
      await wait(900)
      const m: Machine = { ...input, addedAt: Date.now(), probe: (PROBES[input.alias] ?? (() => generic(input.alias)))() }
      machines = [...machines.filter((x) => x.alias !== m.alias), m]
      emit(listeners.machines, machines)
      return m
    },
    async update(alias: string, patch: Parameters<typeof window.paper.machines.update>[1]): Promise<Machine> {
      machines = machines.map((m) => (m.alias === alias ? { ...m, ...patch } : m))
      emit(listeners.machines, machines)
      return machines.find((m) => m.alias === alias)!
    },
    async remove(alias: string): Promise<void> {
      machines = machines.filter((m) => m.alias !== alias)
      emit(listeners.machines, machines)
    },
    async probe(alias: string): Promise<MachineProbe> {
      await wait(700 + Math.random() * 500)
      const probe = (PROBES[alias] ?? (() => generic(alias)))()
      machines = machines.map((m) => (m.alias === alias ? { ...m, probe } : m))
      emit(listeners.machines, machines)
      return probe
    },
    async inventory(_refresh?: boolean): Promise<MachineInventory[]> {
      await wait(250)
      const all = machines.map((m) => inventoryFor(m.alias))
      for (const inv of all) emit(listeners.inventory, inv)
      return all
    },
    async adopt(alias: string, tmux: string): Promise<SessionMeta> {
      const meta = await api().session.spawn({ provider: 'shell', prompt: `echo "adopted ${tmux} on @${alias}"` })
      const agent = hosted[alias]?.find((a) => a.tmux === tmux)
      const titled = agent?.title ? await api().session.rename(meta.id, agent.title) : meta
      if (agent?.name) names.set(meta.id, agent.name)
      const out = dress(titled, alias, tmux, agent?.provider === 'codex' ? 'codex' : 'claude')
      setTimeout(() => emit(listeners.inventory, inventoryFor(alias)), 50)
      return out
    }
  },

  async spawn(req: SpawnRequest): Promise<SessionMeta> {
    const host = req.host ?? LOCAL_HOST
    const m = machines.find((x) => x.alias === host)
    if (host !== LOCAL_HOST && m?.probe && !m.probe.ok) {
      throw new Error(`${m.probe.error?.message}\n${m.probe.error?.hint}`)
    }
    // Agents would spend quota; a fake remote session is always a local shell.
    const meta = await api().session.spawn({ ...req, provider: host === LOCAL_HOST ? req.provider : 'shell', host: undefined })
    const provider = req.provider === 'codex' ? 'codex' : req.provider === 'claude' ? 'claude' : undefined
    return host === LOCAL_HOST ? decorate(meta) : dress(meta, host, undefined, provider)
  },

  async toMachine(req: MachineHandoffRequest): Promise<void> {
    const m = machines.find((x) => x.alias === req.host)
    const step = (stage: string, detail?: string): void => emit(listeners.handoff, { sessionId: req.sessionId, stage, detail })
    step('Stopping the agent', 'flushing transcript')
    await wait(600)
    step(req.host === LOCAL_HOST ? 'Copying conversation back to this Mac' : `Copying conversation to @${req.host}`,
      req.cwd ?? m?.defaultCwd ?? 'same path')
    await wait(900)
    if (m?.probe && !m.probe.ok) {
      emit(listeners.handoff, { sessionId: req.sessionId, stage: 'failed', done: true,
        error: `${m.probe.error?.message}\n${m.probe.error?.hint}` })
      return
    }
    step(req.host === LOCAL_HOST ? 'Resuming here' : `Resuming on @${req.host}`, 'tmux paper-…')
    await wait(700)
    const meta = last.get(req.sessionId) ?? (await api().session.list()).find((s) => s.id === req.sessionId)
    if (meta) emit(listeners.session, dress(meta, req.host))
    emit(listeners.handoff, { sessionId: req.sessionId, stage: 'done', done: true })
  },

  /** What gateway_status would say: g6e's tunnel is up, a100's is still connecting, lab's failed. */
  gatewayStatus() {
    const now = Date.now()
    return {
      port: 47911,
      tokens: dressed.size,
      tunnels: machines.map((m, i) => ({
        alias: m.alias,
        remotePort: 47950 + i,
        since: now - 60_000 * (i + 1),
        state: (m.probe && !m.probe.ok ? 'failed' : m.alias === 'a100' ? 'connecting' : 'up') as 'failed' | 'connecting' | 'up',
        error: m.probe && !m.probe.ok
          ? { ...m.probe.error!, message: `Reverse tunnel to @${m.alias} could not start` }
          : undefined
      }))
    }
  },

  /** An agent on a machine asking to move itself (as session_handoff would): `__paperFakes.selfHandoff(id, 'local')`. */
  async selfHandoff(sessionId: string, host: string): Promise<void> {
    const step = (stage: string, detail?: string): void => emit(listeners.handoff, { sessionId, stage, detail })
    step(host === LOCAL_HOST ? 'Copying conversation back to this Mac' : `Copying conversation to @${host}`)
    await wait(1200)
    step(host === LOCAL_HOST ? 'Resuming on this Mac' : `Resuming on @${host}`)
    await wait(1000)
    const meta = last.get(sessionId)
    if (meta) emit(listeners.session, dress(meta, host))
    emit(listeners.handoff, { sessionId, stage: 'done', done: true })
  },

  agents: {
    /** What agents.list would return: every named live session plus the detached ones on machines. */
    async list(): Promise<AgentSummary[]> {
      const live = await api().session.list()
      const out: AgentSummary[] = []
      for (const raw of live) {
        last.set(raw.id, raw)
        const m = decorate(raw)
        if (!m.name || m.provider === 'shell') continue
        out.push({
          name: m.name, sessionId: m.id, host: m.host ?? LOCAL_HOST, provider: m.provider, status: m.status,
          title: m.title, cwd: m.cwd, lastActiveAt: Date.now() - 20_000, attached: true, ...detailsFor(m.name, m.title)
        })
      }
      for (const [alias, list] of Object.entries(hosted)) {
        for (const a of list) {
          if (!a.name || [...dressed.values()].some((d) => d.tmux === a.tmux)) continue
          out.push({
            name: a.name, sessionId: a.sessionId ?? `${alias}:${a.tmux}`, host: alias,
            provider: a.provider === 'codex' ? 'codex' : 'claude', status: 'detached', title: a.title ?? a.tmux,
            cwd: a.cwd ?? '', lastActiveAt: a.activityAt, attached: false, ...detailsFor(a.name, a.title ?? '')
          })
        }
      }
      return out
    }
  },

  /** session.setName, with main's rules: valid, and not another agent's name or a machine alias. */
  async setName(id: string, name: string): Promise<SessionMeta> {
    await wait(250)
    const meta = last.get(id)
    if (!meta) throw new Error(`No session ${id}`)
    const others = [...names.entries()].filter(([k]) => k !== id).map(([, v]) => v)
    const problem = agentNameProblem(name, {
      names: [...others, ...Object.values(hosted).flat().map((a) => a.name ?? '')],
      aliases: machines.map((m) => m.alias)
    })
    if (problem) throw new Error(problem)
    names.set(id, name)
    const out = decorate(meta)
    emit(listeners.session, out)
    return out
  },

  /** Dress a local shell up as a named agent: `__paperFakes.agentify(id, { status: 'working' })`. */
  agentify(
    id: string,
    opts: { provider?: AgentProviderId; status?: SessionStatus; title?: string; name?: string } = {}
  ): SessionMeta | undefined {
    const meta = last.get(id)
    if (!meta) return undefined
    agentified.set(id, { provider: opts.provider ?? 'claude', status: opts.status, title: opts.title })
    if (opts.name) names.set(id, opts.name)
    const out = decorate(meta)
    emit(listeners.session, out)
    return out
  },

  /** Keep the last real meta so decorations survive main's own session:update events. */
  remember(meta: SessionMeta): void { last.set(meta.id, meta) },
  setLink,
  onMachines: (fn: Fn<Machine[]>) => sub(listeners.machines, fn),
  onInventory: (fn: Fn<MachineInventory>) => sub(listeners.inventory, fn),
  onHandoff: (fn: Fn<{ sessionId: string; stage: string; detail?: string; done?: boolean; error?: string }>) =>
    sub(listeners.handoff, fn),
  onSession: (fn: Fn<SessionMeta>) => sub(listeners.session, fn)
}

/** Plausible "what is it doing" text for the hover card and the dropdown. */
type Details = Pick<AgentSummary, 'doing' | 'lastPrompt' | 'lastReply' | 'todos'>
const DETAILS: Record<string, Details> = {
  hypatia: {
    doing: 'Running sweep 3/8 · lr=3e-4',
    lastPrompt: 'Sweep the learning rate from 1e-5 to 1e-3 and plot val loss per run.',
    todos: [
      { text: 'Launch 8 runs on the L40S', status: 'completed' },
      { text: 'Collect val loss curves', status: 'in_progress' },
      { text: 'Plot and pick the best lr', status: 'pending' }
    ]
  },
  noether: {
    doing: 'Waiting for review',
    lastPrompt: 'The dataloader test flakes about one run in ten. Find out why and fix it.',
    lastReply: 'Seeded the shuffle and pinned the worker count; 200 runs green.'
  },
  euclid: {
    doing: 'Editing src/renderer/src/lib/agents.ts',
    lastPrompt: 'Add callsigns to the mention menu, agents first, then machines.',
    todos: [
      { text: 'Rank agents by prefix, then substring', status: 'completed' },
      { text: 'Two-section dropdown', status: 'in_progress' },
      { text: 'Hover card', status: 'pending' }
    ]
  },
  leonardo: {
    doing: 'Reading the tmux inventory code',
    lastPrompt: 'Why does a detached agent show twice after adopt?'
  }
}
function detailsFor(name: string, title: string): Details {
  return DETAILS[name] ?? { doing: title ? `Working on: ${title}` : undefined }
}

declare global {
  interface Window { __paperFakes?: typeof fake }
}
if (fakesOn()) window.__paperFakes = fake
