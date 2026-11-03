/**
 * The hot app bundle. Everything in the main process except the kernel is
 * reachable from here, and this module is what gets rebuilt and swapped when
 * a file under src/main, src/preload or src/shared changes.
 *
 * `activate()` attaches this generation to the kernel's slots (sessions keep
 * running), registers IPC, menu and tools, and returns the disposer the kernel
 * calls before activating the next generation.
 */
import { BrowserWindow } from 'electron'
import { kernel, type HotModule } from './kernel'
import { registerIpc, wireEvents, shutdown } from './ipc'
import { sessionManager } from './sessions'
import { buildMenu, sendCommand } from './menu'
import { ensureDirs } from './paths'
import { loadState, flush } from './store'
import { createMcpHandler } from './mcp'
import { createToolContext } from './tools/context'
import { setToolContext } from './tools/runtime'
import { TOOLS } from './tools'

export function activate(): HotModule {
  const k = kernel()
  ensureDirs()
  loadState()

  // Sessions started by an earlier generation are still running; take them over.
  sessionManager.adopt()

  setToolContext(createToolContext())
  const unregisterIpc = registerIpc()
  const unwireEvents = wireEvents()
  buildMenu(sendCommand)
  const handleHttp = createMcpHandler()

  // Tell open windows a new generation is live, so the UI can say so.
  const generation = k.hot.generation + 1
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('hot:update', { generation, at: Date.now(), tools: TOOLS.length })
  }

  return {
    handleHttp,
    dispose() {
      unregisterIpc()
      unwireEvents()
      setToolContext(null)
      sessionManager.detach()
      flush()
    },
    shutdown() {
      shutdown()
    }
  }
}

