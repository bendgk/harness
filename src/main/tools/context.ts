/** Binds the pure tool registry to the live services of this app generation. */
import { kernel } from '../kernel'
import { sessionManager } from '../sessions'
import { usageTracker, handoff, titles, planDeps } from '../ipc'
import { planUsage } from '../plan'
import { sendCommand } from '../menu'
import { getState, saveState } from '../store'
import { describeAccount, listAccounts } from '../accounts'
import {
  addMachine, execOnMachine, inventory, listMachines, probeMachine, removeMachine, suggestMachines, updateMachine
} from '../machines'
import { gatewayStatus } from '../gateway'
import { agentInfo, agentTranscript, listAgents, renameAgent } from '../agents'
import { SESSIONS_FILE, readRegistry, restoreReport } from '../persist'
import { invokeTool } from './runtime'
import type { ToolContext } from './types'

export function createToolContext(): ToolContext {
  return {
    kernel: kernel(),
    sessions: sessionManager,
    usage: usageTracker,
    titles,
    handoff,
    machines: {
      list: listMachines,
      add: addMachine,
      update: updateMachine,
      remove: removeMachine,
      probe: probeMachine,
      suggest: suggestMachines,
      exec: execOnMachine,
      inventory,
      gateway: gatewayStatus
    },
    agents: { list: listAgents, info: agentInfo, transcript: agentTranscript, rename: renameAgent },
    getState,
    saveState,
    accounts: () => listAccounts().map((a) => ({ ...a, plan: describeAccount(a) ?? a.plan })),
    plan: (refresh) => planUsage(planDeps, { refresh }),
    persistence: { path: SESSIONS_FILE, read: readRegistry, report: restoreReport },
    window: () => kernel().window(),
    command: sendCommand,
    evalInRenderer,
    invoke: invokeTool
  }
}

/**
 * Run code in the page. An expression is tried first; if it does not parse,
 * the code is run as a statement body (so `return` works). The value comes
 * back through JSON so anything non-serialisable degrades to a string rather
 * than failing the call.
 */
async function evalInRenderer<T = unknown>(code: string): Promise<T> {
  const win = kernel().window()
  if (!win || win.isDestroyed()) throw new Error('No renderer window')
  const wc = win.webContents

  const wrap = (body: string): string => `(async () => {
    try {
      const value = await (${body})
      return { ok: true, json: JSON.stringify(value === undefined ? null : value, (_k, v) => typeof v === 'function' ? '[function]' : typeof v === 'bigint' ? String(v) : v) }
    } catch (e) { return { ok: false, error: (e && e.stack) || String(e) } }
  })()`

  // Electron reports a parse failure only as "Script failed to execute", so
  // decide the form here: V8 in main parses the same grammar as the page.
  const body = isExpression(code) ? `(async () => (${code}))()` : `(async () => { ${code} })()`
  let result: { ok: boolean; json?: string; error?: string }
  try {
    result = await wc.executeJavaScript(wrap(body), true)
  } catch (err) {
    const recent = kernel().console.slice(-3).map((e) => e.text).join(' | ')
    throw new Error(`${(err as Error).message}${recent ? ` — renderer console: ${recent}` : ''}`)
  }
  if (!result.ok) throw new Error(result.error)
  return (result.json === undefined ? null : JSON.parse(result.json)) as T
}

function isExpression(code: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(`return (async () => (${code}))`)
    return true
  } catch {
    return false
  }
}
