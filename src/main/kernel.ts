/**
 * The kernel/hot-module contract.
 *
 * The main process is split in two so the app can be rewritten while it runs:
 *
 *   kernel  (src/main/index.ts)  the part that must survive a code change:
 *                                the BrowserWindow, live PTY handles, the MCP
 *                                listener socket, log buffers, the dev watcher.
 *   app     (src/main/app.ts)    everything else — IPC, providers, sessions,
 *                                handoff, usage, menu, MCP tools. Rebuilt by
 *                                esbuild on save and swapped in place.
 *
 * Persistent data lives in kernel *slots*; hot code attaches behaviour to it.
 * A slot is created once and handed back unchanged to every generation of the
 * app bundle, which is how a session keeps streaming through a hot swap.
 */
import type { BrowserWindow } from 'electron'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface LogEntry {
  at: number
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
}

export interface ConsoleEntry {
  at: number
  level: string
  text: string
  source?: string
  line?: number
}

export interface BuildRecord {
  at: number
  target: 'app' | 'preload'
  ok: boolean
  durationMs: number
  errors: string[]
}

export interface HotState {
  /** Increments every time a new app bundle is activated. */
  generation: number
  activatedAt: number | null
  /** Last activation or build failure, cleared by the next success. */
  lastError: string | null
  /** True when the dev watcher is rebuilding on save. */
  watching: boolean
  mode: 'dev' | 'prod'
  builds: BuildRecord[]
}

export interface Kernel {
  version: string
  startedAt: number
  dev: boolean
  paths: { root: string; out: string; home: string }
  window(): BrowserWindow | null
  /** Persistent storage that outlives app-bundle generations. */
  slot<T>(key: string, init: () => T): T
  /** Main-process console output, newest last. */
  logs: LogEntry[]
  /** Renderer console output, newest last. */
  console: ConsoleEntry[]
  hot: HotState
  mcp: { port: number; url: string; configPath: string }
  /** Re-require the app bundle from disk and swap it in. */
  reload(reason?: string): Promise<{ ok: boolean; generation: number; error?: string }>
  /** Reload the renderer page (Vite HMR handles most edits without this). */
  reloadRenderer(): void
  /** Make sure a window exists (macOS keeps the app alive with none) and bring it forward. */
  openWindow(): BrowserWindow
}

export interface HotModule {
  /** Serve one MCP HTTP request. The socket belongs to the kernel. */
  handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** Detach from kernel slots so the next generation can attach. Sessions stay alive. */
  dispose(): void
  /** App is quitting: tear everything down, including sessions. */
  shutdown(): void
}

export function kernel(): Kernel {
  const k = (globalThis as { __paperKernel?: Kernel }).__paperKernel
  if (!k) throw new Error('Paper kernel is not initialised')
  return k
}
