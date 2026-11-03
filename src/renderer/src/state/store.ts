import { create } from 'zustand'
import type {
  Account, DropZone, PaneContent, PaneNode, ProviderId, SessionMeta, SpawnRequest, Tab,
  UsageSnapshot, WidgetPrefs
} from '@shared/types'
import {
  leaf, leafSession, leaves, migrateNode, movePane, neighbourLeaf, patchWidgetProps, removePane,
  resizeSplit, setPaneContent, setPaneSession, splitPane, terminalLeaf, uid
} from './tree'

export type Overlay =
  | null | 'palette' | 'accounts' | 'switch' | 'steer' | 'rename' | 'widgets' | 'panewidgets' | 'cwd'

interface HandoffState {
  sessionId: string
  stage: string
  detail?: string
  error?: string
}

interface State {
  ready: boolean
  tabs: Tab[]
  activeTabId: string | null
  sessions: Record<string, SessionMeta>
  usage: Record<string, UsageSnapshot>
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
  notify: (text: string, tone?: 'ok' | 'warn') => void
  refreshAccounts: () => Promise<void>
  switchAccount: (accountId: string) => Promise<void>
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

  async init() {
    // StrictMode mounts twice in dev, and a hot update re-runs App's effect;
    // neither should boot a second time or double the event listeners.
    if (get().ready) { bind(); return }
    if (booting) return booting
    booting = (async () => {
      const snap = await api.snapshot()
      const sessions: Record<string, SessionMeta> = {}
      for (const s of snap.sessions) sessions[s.id] = s

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
        sessions,
        tabs,
        activeTabId: snap.activeTabId && tabs.some((t) => t.id === snap.activeTabId) ? snap.activeTabId : tabs[0]?.id ?? null
      })
      bind()
      syncTabTitles()
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
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, root, focusedPaneId: fresh.id } : t))
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
    try {
      const meta = await api.session.spawn({
        provider: req.provider ?? defaults.provider,
        accountId: req.accountId,
        cwd: req.cwd ?? paneCwd ?? defaults.cwd,
        resume: req.resume,
        prompt: req.prompt
      })
      set((s) => ({ sessions: { ...s.sessions, [meta.id]: meta } }))
      get().attachSession(tab.focusedPaneId, meta.id)
      syncTabTitles()
    } catch (err) {
      get().notify((err as Error).message, 'warn')
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
  notify(text, tone) {
    set({ toast: { text, tone } })
    setTimeout(() => set((s) => (s.toast?.text === text ? { toast: null } : s)), 3200)
  },

  async refreshAccounts() {
    set({ accounts: await api.accounts.list() })
  },

  async switchAccount(accountId) {
    const session = get().activeSession()
    if (!session) return
    set({ handoff: { sessionId: session.id, stage: 'Starting handoff' }, overlay: null })
    try {
      await api.handoff.switchAccount(session.id, accountId)
    } catch (err) {
      set({ handoff: null })
      get().notify((err as Error).message, 'warn')
    }
  }
}))

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
let unbind: (() => void) | null = null

/** Subscribe to main-process events. Idempotent; the previous subscription is dropped. */
function bind(): void {
  unbind?.()
  const { setState: set, getState: get } = useStore
  const offs = [
    api.onSession((meta) => {
      set((s) => ({ sessions: { ...s.sessions, [meta.id]: meta } }))
      syncTabTitles()
    }),
    api.onUsage((u) => set((s) => ({ usage: { ...s.usage, [u.sessionId]: u } }))),
    api.onAccounts((accounts) => set({ accounts })),
    api.onHandoff((p) => {
      if (p.done) {
        set({ handoff: null })
        get().notify(p.error ? `Handoff failed: ${p.error}` : 'Context handed off', p.error ? 'warn' : 'ok')
      } else {
        set({ handoff: { sessionId: p.sessionId, stage: p.stage, detail: p.detail } })
      }
    }),
    api.onPtyExit(({ sessionId }) => {
      const meta = get().sessions[sessionId]
      if (meta) set((s) => ({ sessions: { ...s.sessions, [sessionId]: { ...meta, status: 'exited' } } }))
    }),
    api.onHot(({ generation }) => get().notify(`main process reloaded · generation ${generation}`))
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
