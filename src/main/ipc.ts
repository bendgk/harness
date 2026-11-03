import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { sessionManager } from './sessions'
import { finalFlush } from './persist'
import { UsageTracker } from './usage'
import { HandoffService } from './handoff'
import { TitleService } from './titles'
import {
  bootstrapAccounts, createAccount, describeAccount, listAccounts, removeAccount,
  renameAccount, setDefaultAccount, signOut, getAccount, importSystemLogin, systemLoginAvailable
} from './accounts'
import { getState, loadState, saveState, flush, rememberDir } from './store'
import { completeDir, dirInfo, prettyPath, resolvePath } from './fs'
import { invokeTool, toolManifest } from './tools/runtime'
import {
  addMachine, inventory, listMachines, machineEvents, probeMachine, removeMachine, startInventory, suggestMachines,
  updateMachine, type MachineInput
} from './machines'
import { shutdownGateway, startGateway } from './gateway'
import { listAgents } from './agents'
import { LOCAL_HOST, type AgentProviderId, type AppSnapshot, type MachineHandoffRequest, type SpawnRequest, type Tab } from '@shared/types'

export const usageTracker = new UsageTracker(sessionManager)
export const handoff = new HandoffService(sessionManager, usageTracker)
export const titles = new TitleService(sessionManager)

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** Connect services to the renderer. Returns the disposer a hot swap calls. */
export function wireEvents(): () => void {
  sessionManager.on('data', (p) => broadcast('pty:data', p))
  sessionManager.on('exit', (p) => broadcast('pty:exit', p))
  // A session can be closed from outside the window (a tool, an agent, a
  // handoff cleanup); the UI must drop it rather than show a ghost.
  sessionManager.on('closed', (sessionId: string) => broadcast('session:closed', { sessionId }))
  sessionManager.on('meta', (m) => broadcast('session:update', m))
  usageTracker.on('usage', (u) => broadcast('usage:update', u))
  usageTracker.on('title', ({ sessionId, title }) => titles.adoptNative(sessionId, title))
  usageTracker.on('rebound', ({ sessionId, staleTitle }) => { if (staleTitle) titles.reset(sessionId) })
  handoff.on('progress', (p) => broadcast('handoff:progress', p))
  const onMachines = (m: unknown): void => broadcast('machines:update', m)
  const onInventory = (inv: unknown): void => broadcast('machines:inventory', inv)
  machineEvents.on('update', onMachines)
  machineEvents.on('inventory', onInventory)

  // Before the first tick, so a drifted session never reads the wrong file again.
  usageTracker.reconcile()
  usageTracker.start()
  titles.start()
  const stopInventory = startInventory()
  const detachGateway = startGateway()
  return () => {
    stopInventory()
    detachGateway()
    machineEvents.off('update', onMachines)
    machineEvents.off('inventory', onInventory)
    usageTracker.stop()
    titles.stop()
    usageTracker.removeAllListeners()
    handoff.removeAllListeners()
  }
}

function snapshot(): AppSnapshot {
  const state = getState()
  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    sessions: sessionManager.list(),
    accounts: listAccounts().map((a) => ({ ...a, plan: describeAccount(a) ?? a.plan })),
    defaults: state.defaults,
    widgets: state.widgets,
    recentDirs: state.recentDirs,
    machines: listMachines()
  }
}

/** Register every IPC handler. Returns the disposer a hot swap calls. */
export function registerIpc(): () => void {
  const channels: string[] = []
  const handle = <T>(channel: string, fn: (...args: any[]) => T): void => {
    // A previous generation may still own the channel if its dispose was skipped.
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (_e, ...args) => fn(...args))
    channels.push(channel)
  }

  // ---- app ----------------------------------------------------------------
  handle('app:snapshot', () => {
    loadState()
    bootstrapAccounts()
    return snapshot()
  })
  handle('app:saveLayout', (tabs: Tab[], activeTabId: string | null) => {
    saveState({ tabs, activeTabId })
  })
  handle('app:setDefaults', (patch: Partial<AppSnapshot['defaults']>) => {
    saveState({ defaults: { ...getState().defaults, ...patch } })
    return getState().defaults
  })
  handle('app:setWidgets', (widgets: AppSnapshot['widgets']) => {
    saveState({ widgets })
    return widgets
  })
  handle('app:pickDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a working directory'
    })
    return res.canceled ? null : res.filePaths[0]
  })
  handle('app:openExternal', (url: string) => shell.openExternal(url))
  handle('app:revealHome', (accountId: string) => {
    const account = getAccount(accountId)
    if (account) shell.openPath(account.home)
  })

  // ---- directories --------------------------------------------------------
  handle('fs:complete', (input: string, from: string) => completeDir(input, from))
  handle('fs:resolve', (input: string, from: string) => resolvePath(input, from))
  handle('fs:info', (path: string) => dirInfo(path))
  handle('fs:pretty', (path: string) => prettyPath(path))
  handle('fs:remember', (dir: string) => rememberDir(dir))
  handle('fs:home', () => process.env.HOME || '/')

  // ---- accounts -----------------------------------------------------------
  handle('accounts:list', () => listAccounts().map((a) => ({ ...a, plan: describeAccount(a) ?? a.plan })))
  handle('accounts:create', (opts: { provider: AgentProviderId; label: string; adoptSystem?: boolean; inheritFrom?: string }) => {
    const account = createAccount(opts)
    broadcast('accounts:update', listAccounts())
    return account
  })
  handle('accounts:rename', (id: string, label: string) => {
    const list = renameAccount(id, label)
    broadcast('accounts:update', list)
    return list
  })
  handle('accounts:remove', (id: string, deleteFiles: boolean) => {
    const list = removeAccount(id, deleteFiles)
    broadcast('accounts:update', list)
    return list
  })
  handle('accounts:signOut', (id: string) => {
    const list = signOut(id)
    broadcast('accounts:update', list)
    return list
  })
  handle('accounts:setDefault', (provider: AgentProviderId, id: string) => {
    setDefaultAccount(provider, id)
    return getState().defaults
  })
  handle('accounts:systemLoginAvailable', (provider: AgentProviderId) => systemLoginAvailable(provider))
  handle('accounts:importSystemLogin', (id: string) => {
    const account = getAccount(id)
    if (!account) throw new Error('Account not found')
    const ok = importSystemLogin(account.provider, account.home)
    broadcast('accounts:update', listAccounts())
    return ok
  })
  /** Open a throwaway session purely to run the CLI's own login flow. */
  handle('accounts:login', (id: string) => {
    const account = getAccount(id)
    if (!account) throw new Error('Account not found')
    const meta = sessionManager.spawn({
      provider: account.provider,
      accountId: account.id,
      cwd: getState().defaults.cwd
    })
    sessionManager.patchMeta(meta.id, { title: `Sign in · ${account.label}`, titleIsAi: true })
    // The CLIs use a slash command for interactive login.
    setTimeout(() => sessionManager.write(meta.id, '/login\r'), 1800)
    return sessionManager.meta(meta.id)
  })

  // ---- sessions -----------------------------------------------------------
  handle('session:spawn', (req: SpawnRequest) => {
    // A remote session's directory is a path on that machine: no local default,
    // and it must not become the local default either. spawn() picks the
    // machine's defaultCwd (or ~) when none is given.
    if (req.host && req.host !== LOCAL_HOST) return sessionManager.spawn(req)
    const cwd = req.cwd || getState().defaults.cwd
    if (req.cwd && existsSync(req.cwd)) saveState({ defaults: { ...getState().defaults, cwd: req.cwd } })
    return sessionManager.spawn({ ...req, cwd })
  })
  handle('session:list', () => sessionManager.list())
  handle('session:attach', (id: string) => ({
    meta: sessionManager.meta(id),
    scrollback: sessionManager.scrollback(id),
    usage: usageTracker.snapshot(id)
  }))
  handle('session:write', (id: string, data: string) => sessionManager.write(id, data))
  handle('session:resize', (id: string, cols: number, rows: number) => sessionManager.resize(id, cols, rows))
  handle('session:interrupt', (id: string) => sessionManager.interrupt(id))
  handle('session:steer', (id: string, prompt: string) => sessionManager.steer(id, prompt))
  handle('session:restart', (id: string) => sessionManager.restart(id))
  handle('session:rename', (id: string, title: string) => sessionManager.patchMeta(id, { title, titleIsAi: true }))
  // Callsign: validated, unique across agents and machine aliases; emits session:update; retags a remote's tmux.
  handle('session:setName', (id: string, name: string) => sessionManager.setName(id, name))
  // Every named agent, live (exited included, the UI decides) and detached on machines. Memory only.
  handle('agents:list', () => listAgents({ includeExited: true }))
  handle('session:close', (id: string) => {
    sessionManager.close(id)
    usageTracker.forget(id)
    titles.forget(id)
  })

  // ---- usage & handoff ----------------------------------------------------
  handle('usage:get', (id: string) => usageTracker.snapshot(id))
  handle('usage:all', () => usageTracker.all())
  handle('handoff:switch', (sessionId: string, accountId: string) => handoff.switchAccount(sessionId, accountId))
  handle('handoff:machine', (req: MachineHandoffRequest) => handoff.toMachine(req))
  handle('machines:adopt', (alias: string, tmux: string) => sessionManager.adoptRemote(alias, tmux))
  handle('session:retarget', (sessionId: string, cwd: string) => {
    rememberDir(cwd)
    saveState({ defaults: { ...getState().defaults, cwd } })
    return handoff.retarget(sessionId, cwd)
  })

  // ---- machines -----------------------------------------------------------
  // machines:update is broadcast from machineEvents (wireEvents), so these just return.
  handle('machines:list', () => listMachines())
  handle('machines:suggest', () => suggestMachines())
  handle('machines:add', (input: MachineInput) => addMachine(input))
  handle('machines:update', (alias: string, patch: Partial<Omit<MachineInput, 'alias'>>) => updateMachine(alias, patch))
  handle('machines:remove', (alias: string) => removeMachine(alias))
  handle('machines:probe', (alias: string) => probeMachine(alias))
  handle('machines:inventory', (refresh?: boolean) => inventory({ refresh: Boolean(refresh) }))

  // ---- tools: the same registry the MCP server exposes, for the UI ---------
  handle('tools:list', () => toolManifest())
  handle('tools:invoke', (name: string, args: unknown) => invokeTool(name, args))

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}

/**
 * Quit. Order matters: the session registry is written first, while every
 * status is still the truth (then frozen, so the kills below never reach
 * disk); local CLIs then get SIGTERM and ~1.2 s to flush their transcripts.
 * Remote agents keep running in tmux — only their ssh clients go.
 */
export function shutdown(): void {
  finalFlush()
  shutdownGateway()
  usageTracker.stop()
  titles.stop()
  sessionManager.disposeAll()
  flush()
}

export { broadcast }
