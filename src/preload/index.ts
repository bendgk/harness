import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  Account, AgentProviderId, AgentSummary, AppSnapshot, DirComplete, Machine, MachineHandoffRequest, MachineInventory, MachineProbe, SessionMeta,
  SpawnRequest, Tab, ToolManifestEntry, ToolResult, UsageSnapshot, WidgetPrefs
} from '@shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args)

const on = (channel: string, fn: (payload: any) => void): (() => void) => {
  const listener = (_e: IpcRendererEvent, payload: any): void => fn(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  snapshot: () => invoke<AppSnapshot>('app:snapshot'),
  saveLayout: (tabs: Tab[], activeTabId: string | null) => invoke<void>('app:saveLayout', tabs, activeTabId),
  setDefaults: (patch: Partial<AppSnapshot['defaults']>) => invoke<AppSnapshot['defaults']>('app:setDefaults', patch),
  setWidgets: (w: WidgetPrefs) => invoke<WidgetPrefs>('app:setWidgets', w),
  pickDirectory: () => invoke<string | null>('app:pickDirectory'),
  openExternal: (url: string) => invoke<void>('app:openExternal', url),
  revealHome: (accountId: string) => invoke<void>('app:revealHome', accountId),

  dirs: {
    complete: (input: string, from: string) => invoke<DirComplete>('fs:complete', input, from),
    resolve: (input: string, from: string) => invoke<string>('fs:resolve', input, from),
    info: (path: string) =>
      invoke<{ exists: boolean; repo: boolean; name: string; parent: string }>('fs:info', path),
    pretty: (path: string) => invoke<string>('fs:pretty', path),
    remember: (dir: string) => invoke<string[]>('fs:remember', dir),
    home: () => invoke<string>('fs:home')
  },

  accounts: {
    list: () => invoke<Account[]>('accounts:list'),
    create: (opts: { provider: AgentProviderId; label: string; adoptSystem?: boolean; inheritFrom?: string }) =>
      invoke<Account>('accounts:create', opts),
    rename: (id: string, label: string) => invoke<Account[]>('accounts:rename', id, label),
    remove: (id: string, deleteFiles: boolean) => invoke<Account[]>('accounts:remove', id, deleteFiles),
    signOut: (id: string) => invoke<Account[]>('accounts:signOut', id),
    setDefault: (provider: AgentProviderId, id: string) => invoke<void>('accounts:setDefault', provider, id),
    login: (id: string) => invoke<SessionMeta>('accounts:login', id),
    systemLoginAvailable: (provider: AgentProviderId) =>
      invoke<boolean>('accounts:systemLoginAvailable', provider),
    importSystemLogin: (id: string) => invoke<boolean>('accounts:importSystemLogin', id)
  },

  session: {
    spawn: (req: SpawnRequest) => invoke<SessionMeta>('session:spawn', req),
    list: () => invoke<SessionMeta[]>('session:list'),
    attach: (id: string) =>
      invoke<{ meta?: SessionMeta; scrollback: string; usage?: UsageSnapshot }>('session:attach', id),
    write: (id: string, data: string) => invoke<void>('session:write', id, data),
    resize: (id: string, cols: number, rows: number) => invoke<void>('session:resize', id, cols, rows),
    interrupt: (id: string) => invoke<void>('session:interrupt', id),
    steer: (id: string, prompt: string) => invoke<void>('session:steer', id, prompt),
    restart: (id: string) => invoke<void>('session:restart', id),
    rename: (id: string, title: string) => invoke<SessionMeta>('session:rename', id, title),
    close: (id: string) => invoke<void>('session:close', id),
    retarget: (id: string, cwd: string) => invoke<void>('session:retarget', id, cwd),
    /** Give an agent a different callsign (validated; must not clash with an agent or machine). */
    setName: (id: string, name: string) => invoke<SessionMeta>('session:setName', id, name)
  },

  usage: {
    get: (id: string) => invoke<UsageSnapshot | undefined>('usage:get', id),
    all: () => invoke<UsageSnapshot[]>('usage:all')
  },

  handoff: {
    switchAccount: (sessionId: string, accountId: string) => invoke<void>('handoff:switch', sessionId, accountId),
    /** Move a session's agent to another computer (or back to LOCAL_HOST), conversation intact. */
    toMachine: (req: MachineHandoffRequest) => invoke<void>('handoff:machine', req)
  },

  /** Every named agent, local and on machines (live + detached), with what it is doing. Cheap. */
  agents: {
    list: () => invoke<AgentSummary[]>('agents:list')
  },

  /** Remote computers agents may ssh into or be moved to (ssh host aliases). */
  machines: {
    list: () => invoke<Machine[]>('machines:list'),
    suggest: () =>
      invoke<{ alias: string; hostname?: string; user?: string; registered: boolean }[]>('machines:suggest'),
    add: (input: { alias: string; label?: string; note?: string; defaultCwd?: string }) =>
      invoke<Machine>('machines:add', input),
    update: (alias: string, patch: { label?: string; note?: string; defaultCwd?: string; allowAgentHandoffToLocal?: boolean; allowAgentIntrospection?: boolean }) =>
      invoke<Machine>('machines:update', alias, patch),
    remove: (alias: string) => invoke<void>('machines:remove', alias),
    probe: (alias: string) => invoke<MachineProbe>('machines:probe', alias),
    /** What is really running on each machine (polled; `refresh` forces a fresh read). */
    inventory: (refresh?: boolean) => invoke<MachineInventory[]>('machines:inventory', refresh ?? false),
    /** Bring an agent found on a machine (not attached here) into Paper as a session. */
    adopt: (alias: string, tmux: string) => invoke<SessionMeta>('machines:adopt', alias, tmux)
  },

  /** The same tool registry the MCP server exposes, callable from the UI. */
  tools: {
    list: () => invoke<ToolManifestEntry[]>('tools:list'),
    invoke: (name: string, args?: Record<string, unknown>) => invoke<ToolResult>('tools:invoke', name, args ?? {})
  },

  onPtyData: (fn: (p: { sessionId: string; data: string }) => void) => on('pty:data', fn),
  onPtyExit: (fn: (p: { sessionId: string; exitCode: number }) => void) => on('pty:exit', fn),
  onSessionClosed: (fn: (p: { sessionId: string }) => void) => on('session:closed', fn),
  onSession: (fn: (m: SessionMeta) => void) => on('session:update', fn),
  onUsage: (fn: (u: UsageSnapshot) => void) => on('usage:update', fn),
  onAccounts: (fn: (a: Account[]) => void) => on('accounts:update', fn),
  onHandoff: (fn: (p: { sessionId: string; stage: string; detail?: string; done?: boolean; error?: string }) => void) =>
    on('handoff:progress', fn),
  onMachines: (fn: (m: Machine[]) => void) => on('machines:update', fn),
  onInventory: (fn: (inv: MachineInventory) => void) => on('machines:inventory', fn),
  onCommand: (fn: (p: { command: string }) => void) => on('app:command', fn),
  onHot: (fn: (p: { generation: number; at: number; tools: number }) => void) => on('hot:update', fn)
}

contextBridge.exposeInMainWorld('paper', api)

export type PaperApi = typeof api
