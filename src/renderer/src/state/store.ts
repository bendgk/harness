import { create } from 'zustand'
import {
  LOCAL_HOST,
  type Account, type AgentSummary, type DropZone, type Machine, type MachineError, type MachineHandoffRequest, type MachineInventory, type PaneContent,
  type PaneNode, type PlanUsage, type ProviderId, type SessionMeta, type SpawnRequest, type Tab, type UsageSnapshot, type WidgetPrefs
} from '@shared/types'
import { fake, fakesOn, decorate } from '../lib/dev-fakes'
import { cleanIpcError } from '../lib/machines'
import { agentNameProblem, agentSummaries, knownAgentNames, normaliseAgentName } from '../lib/agents'
import {
  leaf, leafSession, leaves, migrateNode, movePane, neighbourLeaf, patchWidgetProps, removePane,
  resizeSplit, setPaneContent, setPaneSession, splitPane, terminalLeaf, uid
} from './tree'

export type Overlay =
  | null | 'palette' | 'accounts' | 'switch' | 'steer' | 'rename' | 'widgets' | 'panewidgets' | 'cwd'
  | 'machines' | 'move' | 'agentName'

interface HandoffState {
  sessionId: string
  stage: string
  detail?: string
  /** 'machine' handoffs keep a failure on screen, because its hint is something the human must do. */
  kind?: 'account' | 'machine'
  /** Where a machine handoff is going (LOCAL_HOST or an alias). */
  target?: string
  /** 'agent' when the agent moved itself (no one in this window asked). */
  initiator?: 'user' | 'agent'
  error?: string
}

/** The @-mention dropdown, wherever it is open (a terminal pane or one of Paper's own inputs). */
export interface MentionState {
  /** 'term:<sessionId>' or 'input:<name>' — who owns the dropdown. */
  owner: string
  /** What follows the @ so far. */
  query: string
  /** Completions offered, best first: agent names, then machine aliases. */
  matches: string[]
  /** How many leading entries of `matches` are agent names (the Agents section). */
  agents: number
  index: number
}

/** An agent callsign being edited, wherever the editor is (one at a time). */
export interface RenamingState {
  sessionId: string
  /** Which editor: 'tree' (inline row), 'side' (SESSION card) or 'sheet' (palette / header). */
  where: 'tree' | 'side' | 'sheet'
  /** The name before editing. */
  current: string
  draft: string
  /** Live validation, or the message setName threw. */
  error: string | null
  saving: boolean
}

/** The hover card for an agent chip: which agent, and the chip's box to sit beside. */
export interface AgentCardState {
  name: string
  rect: { left: number; top: number; right: number; bottom: number }
  /** Which side of the chip the card opens on. */
  side: 'left' | 'right' | 'below'
}

export type MachinePatch = Parameters<typeof window.paper.machines.update>[1]

/** One machine's reverse tunnel, as `gateway_status` reports it (mirrors TunnelState in main/gateway.ts). */
export interface TunnelState {
  alias: string
  remotePort: number
  state: 'down' | 'connecting' | 'up' | 'failed'
  error?: MachineError
  since: number
}
export interface GatewayStatus { port: number | null; tunnels: TunnelState[]; tokens: number }

/** Machines panel view state, kept in the store so ui_state shows it. */
export interface MachinesPanelState {
  /** Machine scrolled to and highlighted (e.g. after clicking an @alias in a terminal). */
  focus: string | null
  adding: boolean
  editing: string | null
  confirmRemove: string | null
}

interface State {
  ready: boolean
  tabs: Tab[]
  activeTabId: string | null
  sessions: Record<string, SessionMeta>
  usage: Record<string, UsageSnapshot>
  /** Plan limits per account id — what `/usage` shows (main/plan.ts). */
  plan: Record<string, PlanUsage>
  refreshPlan: () => Promise<void>
  accounts: Account[]
  defaults: { provider: ProviderId; cwd: string; accountByProvider: Partial<Record<ProviderId, string>> }
  widgets: WidgetPrefs
  recentDirs: string[]
  overlay: Overlay
  /** Pane currently being dragged, so drop targets can light up. */
  dragging: string | null
  /** Where that pane would land right now, driving the live preview. */
  dragOver: { paneId: string; zone: DropZone } | null
  sidebarOpen: boolean
  zen: boolean
  theme: 'day' | 'night'
  fontSize: number
  handoff: HandoffState | null
  toast: { text: string; tone?: 'ok' | 'warn' } | null

  /** Registered remote computers (ssh aliases). */
  machines: Machine[]
  /** Aliases with an ssh probe (Test, or the probe that follows Add) in flight. */
  probing: Record<string, boolean>
  /** Ground truth per machine: the agents actually running there. */
  inventory: Record<string, MachineInventory>
  inventoryLoading: boolean
  machinesPanel: MachinesPanelState
  /** Host an empty pane will launch on, when it is not this Mac. Keyed by pane id; not persisted. */
  paneHost: Record<string, string>
  mention: MentionState | null
  /** Last time each session printed anything (sampled, not per chunk). */
  lastActivity: Record<string, number>
  /** Tree rows the user folded ('local' or an alias); mirrored to localStorage. */
  treeCollapsed: string[]
  /** True when the dev-only machine fakes are standing in for main (see lib/dev-fakes.ts). */
  devFakes: boolean
  /** Reverse-tunnel gateway (remote agents → Paper tools), from the gateway_status tool; null if not served. */
  gateway: GatewayStatus | null
  /** Last `agents.list()` result (what each named agent is doing). Merge with live sessions via agentSummaries. */
  agents: AgentSummary[]
  agentsAt: number | null
  /** Who answered: main, the dev fake, or nobody yet ('fallback': names come from sessions + inventory only). */
  agentsSource: 'main' | 'fake' | 'fallback'
  renaming: RenamingState | null
  agentCard: AgentCardState | null

  init: () => Promise<void>
  newTab: (req?: Partial<SpawnRequest>) => Promise<void>
  closeTab: (tabId: string) => void
  selectTab: (tabId: string) => void
  cycleTab: (delta: number) => void
  setTabTitle: (tabId: string, title: string) => void

  focusPane: (paneId: string) => void
  split: (dir: 'row' | 'col') => Promise<void>
  closePane: () => void
  killPane: (paneId?: string) => void
  cyclePane: (delta: number) => void
  resize: (splitId: string, sizes: number[]) => void
  attachSession: (paneId: string, sessionId: string) => void
  setContent: (paneId: string, content: PaneContent) => void
  openWidget: (widget: string, paneId?: string) => void
  setWidgetProps: (paneId: string, props: Record<string, unknown>) => void
  setDragging: (paneId: string | null) => void
  setDragOver: (over: { paneId: string; zone: DropZone } | null) => void
  dropPane: (sourceId: string, targetId: string, zone: DropZone) => void

  spawnInFocusedPane: (req?: Partial<SpawnRequest>) => Promise<void>
  activeSession: () => SessionMeta | undefined
  activeTab: () => Tab | undefined

  setOverlay: (o: Overlay) => void
  toggleSidebar: () => void
  toggleZen: () => void
  toggleTheme: () => void
  bumpFont: (delta: number) => void
  setWidgets: (w: WidgetPrefs) => void
  /** Working directory of the focused pane, running or not. */
  paneCwd: () => string
  setPaneCwd: (paneId: string, cwd: string) => void
  retarget: (cwd: string) => Promise<void>
  notify: (text: string, tone?: 'ok' | 'warn', ms?: number) => void
  refreshAccounts: () => Promise<void>
  switchAccount: (accountId: string) => Promise<void>

  refreshMachines: () => Promise<void>
  addMachine: (input: { alias: string; label?: string; note?: string; defaultCwd?: string }) => Promise<Machine | null>
  updateMachine: (alias: string, patch: MachinePatch) => Promise<void>
  removeMachine: (alias: string) => Promise<void>
  probeMachine: (alias: string) => Promise<void>
  /** Open the Machines panel, optionally scrolled to one machine or straight into "add". */
  openMachines: (opts?: { focus?: string; adding?: boolean }) => void
  setMachinesPanel: (patch: Partial<MachinesPanelState>) => void
  setPaneHost: (paneId: string, host: string) => void
  /** Host the given (default: focused) pane runs on, or will launch on. */
  paneHostOf: (paneId?: string) => string
  moveToMachine: (req: Omit<MachineHandoffRequest, 'sessionId'> & { sessionId?: string }) => Promise<void>
  dismissHandoff: () => void
  refreshInventory: (force?: boolean) => Promise<void>
  /** Bring a detached remote agent into Paper and show it in a new tab. */
  adoptAgent: (alias: string, tmux: string) => Promise<void>
  /** Show a live session: switch to the tab that has it, or open a new tab attached to it. */
  revealSession: (sessionId: string) => void
  setMention: (m: MentionState | null) => void
  toggleTreeCollapsed: (key: string) => void
  refreshGateway: () => Promise<void>
  /** Re-read agents.list(); calls within ~1.5 s of the last one are dropped unless forced. */
  refreshAgents: (force?: boolean) => Promise<void>
  /** Show the agent called `name`: its tab, a new tab, or adopt it from its machine first. */
  goToAgent: (name: string) => Promise<void>
  beginRename: (sessionId: string, where: RenamingState['where']) => void
  setRenameDraft: (draft: string) => void
  /** Validate and call session.setName; true when the name was saved. */
  commitRename: () => Promise<boolean>
  cancelRename: () => void
  showAgentCard: (card: AgentCardState) => void
  hideAgentCard: (name?: string) => void
  /** ssh config aliases for the "Add machine" picker. */
  suggestMachines: () => Promise<{ alias: string; hostname?: string; user?: string; registered: boolean }[]>
}

const api = window.paper

function newTabObject(sessionId: string | null): Tab {
  const root = terminalLeaf(sessionId)
  return { id: uid(), title: 'New session', root, focusedPaneId: root.id, createdAt: Date.now() }
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  tabs: [],
  activeTabId: null,
  sessions: {},
  usage: {},
  plan: {},

  async refreshPlan() {
    try {
      const list = await api.usage.plan(true)
      set({ plan: Object.fromEntries(list.map((p) => [p.accountId, p])) })
    } catch { /* main not ready (hot swap) — the next push fills it */ }
  },
  accounts: [],
  defaults: { provider: 'claude', cwd: '~', accountByProvider: {} },
  widgets: { enabled: ['usage', 'context', 'limits', 'burn', 'pet', 'clock'], petName: 'Inky' },
  recentDirs: [],
  overlay: null,
  dragging: null,
  dragOver: null,
  sidebarOpen: true,
  zen: false,
  theme: 'day',
  fontSize: 12.5,
  handoff: null,
  toast: null,
  machines: [],
  probing: {},
  inventory: {},
  inventoryLoading: false,
  machinesPanel: { focus: null, adding: false, editing: null, confirmRemove: null },
  paneHost: {},
  mention: null,
  lastActivity: {},
  treeCollapsed: readCollapsed(),
  devFakes: fakesOn(),
  gateway: null,
  agents: [],
  agentsAt: null,
  agentsSource: 'fallback',
  renaming: null,
  agentCard: null,

  async init() {
    // StrictMode mounts twice in dev, and a hot update re-runs App's effect;
    // neither should boot a second time or double the event listeners.
    if (get().ready) { bind(); return }
    if (booting) return booting
    booting = (async () => {
      const snap = await api.snapshot()
      const sessions: Record<string, SessionMeta> = {}
      for (const s of snap.sessions) { if (fakesOn()) fake.remember(s); sessions[s.id] = decorate(s) }
      // With the dev fakes on, the registry lives in the renderer instead.
      const machines = fakesOn() ? await fake.machines.list() : snap.machines ?? []

      // Panes restored from disk may point at processes that no longer exist
      // (a previous run) or at ones still alive in the main process (a page
      // reload during development). Keep the live ones; empty the rest.
      const live = new Set(snap.sessions.map((s) => s.id))
      const tabs = snap.tabs.map((t) => ({ ...t, root: pruneSessions(migrateNode(t.root), live) }))

      set({
        ready: true,
        accounts: snap.accounts,
        defaults: snap.defaults,
        widgets: snap.widgets,
        recentDirs: snap.recentDirs ?? [],
        machines,
        sessions,
        tabs,
        activeTabId: snap.activeTabId && tabs.some((t) => t.id === snap.activeTabId) ? snap.activeTabId : tabs[0]?.id ?? null
      })
      bind()
      syncTabTitles()
      void get().refreshAgents(true)
      void api.usage.plan().then((list) => set({ plan: Object.fromEntries(list.map((p) => [p.accountId, p])) })).catch(() => undefined)
      if (!tabs.length) await get().newTab()
    })()
    return booting
  },

  async newTab(req) {
    const tab = newTabObject(null)
    if (req?.cwd && tab.root.kind === 'leaf' && tab.root.content.type === 'terminal') {
      tab.root.content.cwd = req.cwd
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
    // A new tab opens empty on purpose: nothing is spawned, and no quota is
    // spent, until you pick a harness. `req` only applies when one is asked for.
    if (req?.provider) await get().spawnInFocusedPane(req)
    persist()
  },

  closeTab(tabId) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (tab) {
      for (const l of leaves(tab.root)) {
        const sid = leafSession(l)
        if (sid) api.session.close(sid)
      }
    }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const activeTabId = s.activeTabId === tabId ? tabs[tabs.length - 1]?.id ?? null : s.activeTabId
      return { tabs, activeTabId }
    })
    if (!get().tabs.length) void get().newTab()
    persist()
  },

  selectTab(tabId) {
    set({ activeTabId: tabId })
    persist()
  },

  cycleTab(delta) {
    const { tabs, activeTabId } = get()
    if (tabs.length < 2) return
    const i = tabs.findIndex((t) => t.id === activeTabId)
    set({ activeTabId: tabs[(i + delta + tabs.length) % tabs.length].id })
  },

  setTabTitle(tabId, title) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title, titleOverride: title } : t)) }))
    persist()
  },

  focusPane(paneId) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, focusedPaneId: paneId } : t))
    }))
  },

  async split(dir) {
    const tab = get().activeTab()
    if (!tab) return
    // A split continues the work of the pane it came from, so the new pane
    // starts in the same directory rather than back at the global default.
    const fresh = leaf({ type: 'terminal', sessionId: null, cwd: get().paneCwd() })
    const root = splitPane(tab.root, tab.focusedPaneId, dir, fresh)
    // …and on the same computer: a split of a pane on @g6e offers @g6e first.
    const host = get().paneHostOf()
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, root, focusedPaneId: fresh.id } : t)),
      paneHost: host !== LOCAL_HOST ? { ...s.paneHost, [fresh.id]: host } : s.paneHost
    }))
    persist()
  },

  closePane() {
    get().killPane(get().activeTab()?.focusedPaneId)
  },

  /**
   * Close a pane. The last pane in a tab is emptied instead of removed, so
   * ending a session leaves you on the chooser rather than closing the tab.
   */
  killPane(paneId) {
    const tab = get().activeTab()
    if (!tab) return
    const target = paneId ?? tab.focusedPaneId
    const panes = leaves(tab.root)
    const pane = panes.find((l) => l.id === target)
    if (!pane) return
    const sid = leafSession(pane)
    if (sid) api.session.close(sid)

    if (panes.length === 1) {
      const root = setPaneContent(tab.root, target, { type: 'terminal', sessionId: null })
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, root, titleOverride: undefined, title: 'New session' } : t))
      }))
      persist()
      return
    }

    const root = removePane(tab.root, target)
    if (!root) return get().closeTab(tab.id)
    const focusedPaneId = leaves(root)[0].id
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, root, focusedPaneId } : t)) }))
    persist()
  },

  cyclePane(delta) {
    const tab = get().activeTab()
    if (!tab) return
    const next = neighbourLeaf(tab.root, tab.focusedPaneId, delta)
    if (next) get().focusPane(next)
  },

  resize(splitId, sizes) {
    const tab = get().activeTab()
    if (!tab) return
    const root = resizeSplit(tab.root, splitId, sizes)
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, root } : t)) }))
    persistSoon()
  },

  attachSession(paneId, sessionId) {
    const tab = get().activeTab()
    if (!tab) return
    const root = setPaneSession(tab.root, paneId, sessionId)
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, root } : t)) }))
    persist()
  },

  setContent(paneId, content) {
    const tab = get().activeTab()
    if (!tab) return
    // Replacing a terminal pane ends its session; nothing else would reach it.
    const previous = leaves(tab.root).find((l) => l.id === paneId)
    const oldSession = previous ? leafSession(previous) : null
    if (oldSession && !(content.type === 'terminal' && content.sessionId === oldSession)) {
      api.session.close(oldSession)
    }
    const root = setPaneContent(tab.root, paneId, content)
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, root } : t)) }))
    persist()
  },

  openWidget(widget, paneId) {
    const tab = get().activeTab()
    if (!tab) return
    const target = paneId ?? tab.focusedPaneId
    get().setContent(target, { type: 'widget', widget })
  },

  setWidgetProps(paneId, props) {
    const tab = get().activeTab()
    if (!tab) return
    const root = patchWidgetProps(tab.root, paneId, props)
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, root } : t)) }))
    persistSoon()
  },

  setDragging(paneId) { set({ dragging: paneId, dragOver: paneId ? get().dragOver : null }) },

  setDragOver(over) {
    // Re-rendering the preview on every dragover event would thrash; only a
    // genuine change of target or edge is worth a new layout.
    const current = get().dragOver
    if (current?.paneId === over?.paneId && current?.zone === over?.zone) return
    set({ dragOver: over })
  },

  dropPane(sourceId, targetId, zone) {
    const tab = get().activeTab()
    if (!tab) return
    const root = movePane(tab.root, sourceId, targetId, zone)
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, root, focusedPaneId: sourceId } : t)),
      dragging: null,
      dragOver: null
    }))
    persist()
  },

  async spawnInFocusedPane(req = {}) {
    const { defaults } = get()
    const tab = get().activeTab()
    if (!tab) return
    const pane = leaves(tab.root).find((l) => l.id === tab.focusedPaneId)
    const paneCwd = pane?.content.type === 'terminal' ? pane.content.cwd : undefined
    const host = req.host ?? get().paneHost[tab.focusedPaneId] ?? LOCAL_HOST
    const machine = get().machines.find((m) => m.alias === host)
    // A local folder means nothing on another computer: a remote launch uses
    // the machine's default directory, or lets main pick (same path → ~-relative).
    const cwd = host === LOCAL_HOST ? req.cwd ?? paneCwd ?? defaults.cwd : req.cwd ?? machine?.defaultCwd
    try {
      const spawnReq: SpawnRequest = {
        provider: req.provider ?? defaults.provider,
        accountId: req.accountId,
        cwd,
        resume: req.resume,
        prompt: req.prompt,
        host
      }
      const meta = fakesOn() ? await fake.spawn(spawnReq) : await api.session.spawn(spawnReq)
      set((s) => ({ sessions: { ...s.sessions, [meta.id]: meta } }))
      get().attachSession(tab.focusedPaneId, meta.id)
      syncTabTitles()
    } catch (err) {
      // Remote failures carry a hint for the human; give it time to be read.
      get().notify(cleanIpcError(err), 'warn', host !== LOCAL_HOST ? 9000 : undefined)
    }
  },

  activeTab() {
    const { tabs, activeTabId } = get()
    return tabs.find((t) => t.id === activeTabId)
  },

  activeSession() {
    const tab = get().activeTab()
    if (!tab) return undefined
    const pane = leaves(tab.root).find((l) => l.id === tab.focusedPaneId)
    const sid = pane ? leafSession(pane) : null
    return sid ? get().sessions[sid] : undefined
  },

  setOverlay(overlay) { set({ overlay }) },

  paneCwd() {
    const session = get().activeSession()
    if (session) return session.cwd
    const tab = get().activeTab()
    const pane = tab ? leaves(tab.root).find((l) => l.id === tab.focusedPaneId) : undefined
    if (pane?.content.type === 'terminal' && pane.content.cwd) return pane.content.cwd
    return get().defaults.cwd
  },

  setPaneCwd(paneId, cwd) {
    const tab = get().activeTab()
    if (!tab) return
    const pane = leaves(tab.root).find((l) => l.id === paneId)
    if (!pane || pane.content.type !== 'terminal') return
    const root = setPaneContent(tab.root, paneId, { ...pane.content, cwd })
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, root } : t)) }))
    persist()
  },

  /**
   * Point the focused pane at a directory. A running session is moved there
   * (keeping its conversation); an empty pane simply remembers it for whatever
   * gets started in it next.
   */
  async retarget(cwd) {
    const session = get().activeSession()
    const tab = get().activeTab()
    set({ recentDirs: [cwd, ...get().recentDirs.filter((d) => d !== cwd)].slice(0, 12) })
    if (!session) {
      if (tab) get().setPaneCwd(tab.focusedPaneId, cwd)
      void api.setDefaults({ cwd })
      void api.dirs.remember(cwd)
      get().notify(`New sessions will open in ${cwd.split('/').pop() || cwd}`)
      return
    }
    try {
      await api.session.retarget(session.id, cwd)
    } catch (err) {
      get().notify((err as Error).message, 'warn')
    }
  },
  toggleSidebar() { set((s) => ({ sidebarOpen: !s.sidebarOpen })) },
  toggleZen() { set((s) => ({ zen: !s.zen })) },
  toggleTheme() {
    const theme = get().theme === 'day' ? 'night' : 'day'
    document.documentElement.dataset.theme = theme === 'night' ? 'night' : ''
    set({ theme })
  },
  bumpFont(delta) {
    const fontSize = Math.min(20, Math.max(9, get().fontSize + delta))
    document.documentElement.style.setProperty('--term-size', `${fontSize}px`)
    set({ fontSize })
  },
  setWidgets(widgets) {
    set({ widgets })
    void api.setWidgets(widgets)
  },
  notify(text, tone, ms = 3200) {
    set({ toast: { text, tone } })
    setTimeout(() => set((s) => (s.toast?.text === text ? { toast: null } : s)), ms)
  },

  async refreshAccounts() {
    set({ accounts: await api.accounts.list() })
  },

  async switchAccount(accountId) {
    const session = get().activeSession()
    if (!session) return
    set({ handoff: { sessionId: session.id, stage: 'Starting handoff', kind: 'account', initiator: 'user' }, overlay: null })
    try {
      await api.handoff.switchAccount(session.id, accountId)
    } catch (err) {
      set({ handoff: null })
      get().notify(cleanIpcError(err), 'warn')
    }
  },

  async refreshMachines() {
    try {
      set({ machines: await machinesApi().list() })
    } catch { /* main without a registry yet: keep the snapshot's list */ }
  },

  async addMachine(input) {
    const alias = input.alias.trim().replace(/^@/, '')
    set((s) => ({ probing: { ...s.probing, [alias]: true } }))
    try {
      const m = await machinesApi().add({ ...input, alias })
      // Upsert now rather than waiting for machines:update, so the row is
      // there the moment the spinner stops.
      set((s) => ({ machines: [...s.machines.filter((x) => x.alias !== m.alias), m] }))
      void get().refreshInventory(true)
      void get().refreshGateway()
      return m
    } catch (err) {
      get().notify(cleanIpcError(err), 'warn', 6000)
      return null
    } finally {
      set((s) => ({ probing: omit(s.probing, alias) }))
    }
  },

  async updateMachine(alias, patch) {
    try {
      const m = await machinesApi().update(alias, patch)
      set((s) => ({ machines: s.machines.map((x) => (x.alias === alias ? m : x)) }))
    } catch (err) {
      get().notify(cleanIpcError(err), 'warn')
    }
  },

  async removeMachine(alias) {
    try {
      await machinesApi().remove(alias)
      set((s) => ({
        machines: s.machines.filter((m) => m.alias !== alias),
        inventory: omit(s.inventory, alias),
        machinesPanel: { ...s.machinesPanel, confirmRemove: null, editing: null }
      }))
      get().notify(`Removed @${alias}`)
    } catch (err) {
      get().notify(cleanIpcError(err), 'warn')
    }
  },

  async probeMachine(alias) {
    set((s) => ({ probing: { ...s.probing, [alias]: true } }))
    try {
      const probe = await machinesApi().probe(alias)
      set((s) => ({ machines: s.machines.map((m) => (m.alias === alias ? { ...m, probe } : m)) }))
    } catch (err) {
      get().notify(cleanIpcError(err), 'warn')
    } finally {
      set((s) => ({ probing: omit(s.probing, alias) }))
    }
  },

  openMachines(opts = {}) {
    set({
      overlay: 'machines',
      machinesPanel: { focus: opts.focus ?? null, adding: !!opts.adding, editing: null, confirmRemove: null }
    })
  },

  setMachinesPanel(patch) {
    set((s) => ({ machinesPanel: { ...s.machinesPanel, ...patch } }))
  },

  setPaneHost(paneId, host) {
    set((s) => ({ paneHost: host === LOCAL_HOST ? omit(s.paneHost, paneId) : { ...s.paneHost, [paneId]: host } }))
  },

  paneHostOf(paneId) {
    const tab = get().activeTab()
    const id = paneId ?? tab?.focusedPaneId
    const pane = tab && id ? leaves(tab.root).find((l) => l.id === id) : undefined
    const sid = pane ? leafSession(pane) : null
    const meta = sid ? get().sessions[sid] : undefined
    return meta?.host ?? (id ? get().paneHost[id] : undefined) ?? LOCAL_HOST
  },

  async moveToMachine(req) {
    const sessionId = req.sessionId ?? get().activeSession()?.id
    if (!sessionId) return
    const full: MachineHandoffRequest = { ...req, sessionId }
    set({
      handoff: {
        sessionId, kind: 'machine', target: req.host, initiator: 'user',
        stage: req.host === LOCAL_HOST ? 'Moving back to this Mac' : `Moving to @${req.host}`
      },
      overlay: null
    })
    try {
      await (fakesOn() ? fake.toMachine(full) : api.handoff.toMachine(full))
    } catch (err) {
      // Main normally reports failure through handoff:progress; a rejected
      // invoke (validation, a missing handler) must not leave the spinner up.
      set((s) => ({
        handoff: {
          sessionId, kind: 'machine', target: req.host, initiator: 'user',
          stage: s.handoff?.stage ?? 'Handoff', error: cleanIpcError(err)
        }
      }))
    }
  },

  dismissHandoff() { set({ handoff: null }) },

  async refreshInventory(force = false) {
    if (!get().machines.length) return
    set({ inventoryLoading: true })
    try {
      const list = await machinesApi().inventory(force)
      set((s) => {
        const inventory = { ...s.inventory }
        for (const inv of list) inventory[inv.alias] = inv
        return { inventory }
      })
    } catch { /* inventory not served yet; the tree falls back to live sessions */ }
    finally { set({ inventoryLoading: false }) }
  },

  async adoptAgent(alias, tmux) {
    try {
      const meta = await machinesApi().adopt(alias, tmux)
      set((s) => ({ sessions: { ...s.sessions, [meta.id]: meta } }))
      get().revealSession(meta.id)
      void get().refreshInventory(true)
    } catch (err) {
      get().notify(cleanIpcError(err), 'warn', 9000)
    }
  },

  revealSession(sessionId) {
    for (const t of get().tabs) {
      const pane = leaves(t.root).find((l) => leafSession(l) === sessionId)
      if (pane) {
        set((s) => ({
          activeTabId: t.id,
          tabs: s.tabs.map((x) => (x.id === t.id ? { ...x, focusedPaneId: pane.id } : x))
        }))
        persist()
        return
      }
    }
    // Not on screen anywhere: a tab of its own, never a split of whatever is focused.
    const tab = newTabObject(sessionId)
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
    syncTabTitles()
    persist()
  },

  setMention(mention) {
    const cur = get().mention
    if (!mention && !cur) return
    if (mention && cur && cur.owner === mention.owner && cur.query === mention.query && cur.index === mention.index &&
      cur.agents === mention.agents && cur.matches.join() === mention.matches.join()) return
    set({ mention })
  },

  async refreshAgents(force = false) {
    const now = Date.now()
    if (!force && now - lastAgentsCall < 1500) return
    lastAgentsCall = now
    try {
      const list = fakesOn() ? await fake.agents.list() : await api.agents.list()
      set({ agents: list, agentsAt: Date.now(), agentsSource: fakesOn() ? 'fake' : 'main' })
    } catch {
      // main without agents:list yet: names still come from sessions and the inventory.
      set({ agentsSource: 'fallback' })
    }
  },

  async goToAgent(name) {
    const s = get()
    const live = Object.values(s.sessions).find((m) => m.name === name)
    if (live) { s.revealSession(live.id); return }
    // Detached on a machine: adopt it (by its tmux session), then it opens in a tab.
    const summary = agentSummaries(s).find((a) => a.name === name)
    for (const inv of Object.values(s.inventory)) {
      const h = inv.agents.find((a) => a.name === name || (summary && a.sessionId === summary.sessionId))
      if (h) { await s.adoptAgent(inv.alias, h.tmux); return }
    }
    if (summary && s.sessions[summary.sessionId]) { s.revealSession(summary.sessionId); return }
    s.notify(`@${name} is not running anywhere Paper can see`, 'warn')
  },

  beginRename(sessionId, where) {
    const meta = get().sessions[sessionId]
    if (!meta?.name || meta.provider === 'shell') return
    set({ renaming: { sessionId, where, current: meta.name, draft: meta.name, error: null, saving: false }, agentCard: null })
    if (where === 'sheet') set({ overlay: 'agentName' })
  },

  setRenameDraft(draft) {
    const r = get().renaming
    if (!r) return
    const s = get()
    const error = agentNameProblem(draft, {
      current: r.current,
      names: knownAgentNames(s).filter((n) => n !== r.current),
      aliases: s.machines.map((m) => m.alias)
    })
    set({ renaming: { ...r, draft, error } })
  },

  async commitRename() {
    const r = get().renaming
    if (!r || r.saving) return false
    const s = get()
    const name = normaliseAgentName(r.draft)
    const error = agentNameProblem(r.draft, {
      current: r.current,
      names: knownAgentNames(s).filter((n) => n !== r.current),
      aliases: s.machines.map((m) => m.alias)
    })
    if (error) { set({ renaming: { ...r, error } }); return false }
    if (name === r.current) { get().cancelRename(); return true }
    set({ renaming: { ...r, saving: true, error: null } })
    try {
      const meta = fakesOn() ? await fake.setName(r.sessionId, name) : await api.session.setName(r.sessionId, name)
      set((x) => ({
        sessions: x.sessions[meta.id] ? { ...x.sessions, [meta.id]: decorate(meta) } : x.sessions,
        agents: x.agents.map((a) => (a.sessionId === meta.id ? { ...a, name } : a)),
        renaming: null,
        overlay: x.overlay === 'agentName' ? null : x.overlay
      }))
      get().notify(`@${r.current} is now @${name}`)
      void get().refreshAgents(true)
      return true
    } catch (err) {
      set((x) => ({ renaming: x.renaming ? { ...x.renaming, saving: false, error: cleanIpcError(err) } : null }))
      return false
    }
  },

  cancelRename() {
    if (!get().renaming) return
    set((x) => ({ renaming: null, overlay: x.overlay === 'agentName' ? null : x.overlay }))
  },

  showAgentCard(card) {
    const cur = get().agentCard
    if (cur && cur.name === card.name && cur.rect.left === card.rect.left && cur.rect.top === card.rect.top) return
    set({ agentCard: card })
    void get().refreshAgents()
  },

  hideAgentCard(name) {
    const cur = get().agentCard
    if (!cur || (name && cur.name !== name)) return
    set({ agentCard: null })
  },

  async suggestMachines() {
    try { return await machinesApi().suggest() } catch { return [] }
  },

  async refreshGateway() {
    if (fakesOn()) { set({ gateway: fake.gatewayStatus() }); return }
    try {
      const res = await api.tools.invoke('gateway_status')
      set({ gateway: res.isError ? null : (res.json as GatewayStatus) })
    } catch { set({ gateway: null }) }
  },

  toggleTreeCollapsed(key) {
    const cur = get().treeCollapsed
    const treeCollapsed = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
    set({ treeCollapsed })
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(treeCollapsed)) } catch { /* private mode: in-memory only */ }
  }
}))

const COLLAPSE_KEY = 'paper:tree-collapsed'
function readCollapsed(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

function omit<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec
  const rest = { ...rec }
  delete rest[key]
  return rest
}

/** The machine registry: main's, or the dev fake when it is switched on. */
function machinesApi(): typeof api.machines {
  return fakesOn() ? fake.machines : api.machines
}

/** Machine for an alias (undefined for LOCAL_HOST or an unknown alias). */
export const machineOf = (alias: string | undefined): Machine | undefined =>
  alias ? useStore.getState().machines.find((m) => m.alias === alias) : undefined

/** Drop session ids that no longer name a live process; keep the ones that do. */
function pruneSessions(node: PaneNode, live: Set<string>): PaneNode {
  if (node.kind === 'leaf') {
    if (node.content.type !== 'terminal') return node
    const sessionId = node.content.sessionId && live.has(node.content.sessionId) ? node.content.sessionId : null
    return { ...node, content: { ...node.content, sessionId } }
  }
  return { ...node, children: node.children.map((c) => pruneSessions(c, live)) }
}

let booting: Promise<void> | null = null
let lastAgentsCall = 0
let unbind: (() => void) | null = null

/** Subscribe to main-process events. Idempotent; the previous subscription is dropped. */
function bind(): void {
  unbind?.()
  const { setState: set, getState: get } = useStore
  const onSession = (raw: SessionMeta): void => {
    if (fakesOn()) fake.remember(raw)
    const meta = decorate(raw)
    set((s) => ({ sessions: { ...s.sessions, [meta.id]: meta } }))
    syncTabTitles()
  }
  const onHandoff = (p: { sessionId: string; stage: string; detail?: string; done?: boolean; error?: string }): void => {
    const cur = get().handoff
    // A handoff this window did not start was asked for by the agent itself
    // (the session_handoff tool). Work out where it is going from the stage
    // text, so the overlay can say so instead of looking like a glitch.
    const mine = cur?.sessionId === p.sessionId ? cur : null
    const text = `${p.stage} ${p.detail ?? ''}`
    const named = get().machines.find((m) => text.includes(`@${m.alias}`))?.alias
    const inferred = named ?? (/this mac|locally|back here/i.test(text) ? LOCAL_HOST : undefined)
    const base: HandoffState = mine ?? {
      sessionId: p.sessionId, stage: p.stage, initiator: 'agent',
      kind: inferred ? 'machine' : 'account', target: inferred
    }
    const target = base.target ?? inferred
    if (p.done && p.error && base.kind === 'machine') {
      // Stays up until dismissed: the hint is an instruction (load a key, install tmux…).
      set({ handoff: { ...base, target, stage: p.stage, detail: undefined, error: p.error } })
    } else if (p.done) {
      set({ handoff: null })
      if (base.kind === 'machine' && target) {
        const title = get().sessions[p.sessionId]?.title ?? 'The agent'
        const where = target === LOCAL_HOST ? 'this Mac' : `@${target}`
        get().notify(base.initiator === 'agent'
          ? `${title} moved itself to ${where}`
          : target === LOCAL_HOST ? 'Back on this Mac, context intact' : `Now running on @${target}, context intact`)
        void get().refreshInventory(true)
      } else {
        get().notify(p.error ? `Handoff failed: ${p.error}` : 'Context handed off', p.error ? 'warn' : 'ok')
      }
    } else {
      set({ handoff: { ...base, target, stage: p.stage, detail: p.detail, error: undefined } })
    }
  }
  const onMachines = (machines: Machine[]): void => set({ machines })
  const onInventory = (inv: MachineInventory): void => set((s) => ({ inventory: { ...s.inventory, [inv.alias]: inv } }))
  const offs = [
    api.onSession(onSession),
    api.onMachines(onMachines),
    api.onInventory(onInventory),
    // Last-output times feed the tree's "last activity". Sampled at most every
    // few seconds per session, so a streaming agent does not re-render the app.
    api.onPtyData(({ sessionId }) => {
      const now = Date.now()
      if (now - (get().lastActivity[sessionId] ?? 0) < 5000) return
      set((s) => ({ lastActivity: { ...s.lastActivity, [sessionId]: now } }))
    }),
    api.onUsage((u) => set((s) => ({ usage: { ...s.usage, [u.sessionId]: u } }))),
    api.onPlan((p) => set((s) => ({ plan: { ...s.plan, [p.accountId]: p } }))),
    api.onAccounts((accounts) => set({ accounts })),
    api.onHandoff(onHandoff),
    api.onPtyExit(({ sessionId }) => {
      const meta = get().sessions[sessionId]
      if (meta) set((s) => ({ sessions: { ...s.sessions, [sessionId]: { ...meta, status: 'exited' } } }))
    }),
    api.onSessionClosed(({ sessionId }) => {
      if (!get().sessions[sessionId]) return
      set((s) => {
        const sessions = { ...s.sessions }
        delete sessions[sessionId]
        const usage = { ...s.usage }
        delete usage[sessionId]
        // Panes that showed it fall back to an empty terminal slot, exactly as after a restart.
        const live = new Set(Object.keys(sessions))
        return {
          sessions, usage,
          agents: s.agents.filter((a) => a.sessionId !== sessionId),
          renaming: s.renaming?.sessionId === sessionId ? null : s.renaming,
          tabs: s.tabs.map((t) => ({ ...t, root: pruneSessions(t.root, live) }))
        }
      })
    }),
    api.onHot(({ generation }) => get().notify(`main process reloaded · generation ${generation}`)),
    ...(fakesOn()
      ? [fake.onSession(onSession), fake.onHandoff(onHandoff), fake.onMachines(onMachines), fake.onInventory(onInventory)]
      : [])
  ]
  unbind = () => { for (const off of offs) off(); unbind = null }
}

/**
 * Introspection handle for the MCP tools (ui_state, ui_eval) and for anyone
 * poking at the app from DevTools. `snapshot` is the store minus its actions,
 * optionally narrowed to a dot path.
 */
declare global {
  interface Window {
    __paper: { store: typeof useStore; snapshot: (path?: string) => unknown; hmr: { updates: number; lastAt: number | null } }
  }
}
window.__paper = {
  store: useStore,
  snapshot(path = '') {
    let value: unknown = JSON.parse(JSON.stringify(useStore.getState()))
    for (const key of path.split('.').filter(Boolean)) value = (value as Record<string, unknown>)?.[key]
    return value ?? null
  },
  hmr: window.__paper?.hmr ?? { updates: 0, lastAt: null }
}

// Vite HMR: when this module is replaced, carry the state across so an edit
// to the store does not blank the UI or re-run boot.
if (import.meta.hot) {
  const previous = import.meta.hot.data.state as Partial<State> | undefined
  if (previous) {
    useStore.setState(previous)
    bind()
  }
  import.meta.hot.dispose((data) => {
    // Data only: the actions must come from the new module, or the edit
    // being hot-loaded would be overwritten by the old implementations.
    data.state = Object.fromEntries(Object.entries(useStore.getState()).filter(([, v]) => typeof v !== 'function'))
    unbind?.()
  })
  import.meta.hot.on('vite:afterUpdate', () => {
    window.__paper.hmr.updates += 1
    window.__paper.hmr.lastAt = Date.now()
  })
}

/** A tab wears the name of whichever session holds focus, unless pinned. */
function syncTabTitles(): void {
  const { tabs, sessions } = useStore.getState()
  let changed = false
  const next = tabs.map((tab) => {
    if (tab.titleOverride) return tab
    const panes = leaves(tab.root)
    const pane = panes.find((l) => l.id === tab.focusedPaneId) ?? panes[0]
    const sid = pane ? leafSession(pane) : null
    const meta = sid ? sessions[sid] : undefined
    // A tab showing only widgets should say so rather than claim a session.
    const firstTerminal = panes.map(leafSession).find(Boolean)
    const title = meta?.title
      ?? (firstTerminal ? sessions[firstTerminal]?.title : undefined)
      ?? (pane?.content.type === 'widget' ? 'Widgets' : 'New session')
    if (title === tab.title) return tab
    changed = true
    return { ...tab, title }
  })
  if (changed) useStore.setState({ tabs: next })
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
function persist(): void {
  const { tabs, activeTabId } = useStore.getState()
  void api.saveLayout(tabs, activeTabId)
}
function persistSoon(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(persist, 400)
}
