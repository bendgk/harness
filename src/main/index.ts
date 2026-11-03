/**
 * Paper kernel — the small, stable part of the main process.
 *
 * Owns what must not die on a code change: the window, the PTY registry, the
 * MCP listener, log buffers. Everything else lives in the hot app bundle
 * (`app.js`, built from src/main/app.ts) which is rebuilt by esbuild on save in
 * development and swapped in without restarting Electron or losing a session.
 *
 * Changing this file requires a restart (`npm run dev`). Keep it boring.
 */
import { app, BrowserWindow, nativeTheme } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import type { BuildRecord, ConsoleEntry, HotModule, HotState, Kernel, LogEntry } from './kernel'

const VERSION = app.getVersion()
const DEV = Boolean(process.env['ELECTRON_RENDERER_URL']) && !app.isPackaged
const ROOT = app.getAppPath()
const OUT = __dirname // out/main
const PAPER_HOME = process.env.PAPER_HOME || join(homedir(), '.paper')
const MCP_PORT_BASE = Number(process.env.PAPER_MCP_PORT) || 47810
const LOG_LIMIT = 2000

// A second instance (e.g. an isolated dev copy) must not share Chromium's
// profile lock with the one you are working in.
if (process.env.PAPER_USER_DATA) app.setPath('userData', resolve(process.env.PAPER_USER_DATA))
process.setSourceMapsEnabled?.(true)

// ---- log capture ------------------------------------------------------------

const logs: LogEntry[] = []
const rendererConsole: ConsoleEntry[] = []

function push<T>(buf: T[], entry: T): void {
  buf.push(entry)
  if (buf.length > LOG_LIMIT) buf.splice(0, buf.length - LOG_LIMIT)
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a)))
    .join(' ')
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}

for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    push(logs, { at: Date.now(), level, text: fmt(args) })
    original(...args)
  }
}
process.on('uncaughtException', (err) => console.error('[kernel] uncaught', err))
process.on('unhandledRejection', (err) => console.error('[kernel] unhandled rejection', err))

// ---- slots ------------------------------------------------------------------

const slots = new Map<string, unknown>()
function slot<T>(key: string, init: () => T): T {
  if (!slots.has(key)) slots.set(key, init())
  return slots.get(key) as T
}

// ---- window -----------------------------------------------------------------

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    // Matte paper, never glass: a flat warm ground with no vibrancy behind it.
    backgroundColor: '#f7f6f2',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(OUT, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // The terminal renderer leans on WebGL for scroll performance.
      webgl: true,
      // Agent output keeps arriving while the window sits behind others;
      // throttling it would make Paper repaint in a lurch on every refocus.
      backgroundThrottling: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })

  // Renderer console goes into a buffer the MCP tools can read back.
  mainWindow.webContents.on('console-message', (event: any, level?: number, message?: string, line?: number, sourceId?: string) => {
    const text = event?.message ?? message ?? ''
    const lvl = event?.level ?? level
    const levelName = typeof lvl === 'string' ? lvl : (['debug', 'info', 'warning', 'error'][lvl ?? 1] ?? 'info')
    push(rendererConsole, {
      at: Date.now(),
      level: levelName,
      text,
      source: event?.sourceId ?? sourceId,
      line: event?.lineNumber ?? line
    })
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => console.error('[kernel] renderer gone', details))
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('[kernel] load failed', code, desc, url))

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(OUT, '../renderer/index.html'))
  }
}

// ---- hot app bundle ---------------------------------------------------------

const APP_BUNDLE = join(OUT, 'app.js')
const hot: HotState = {
  generation: 0,
  activatedAt: null,
  lastError: null,
  watching: false,
  mode: DEV ? 'dev' : 'prod',
  builds: []
}

interface AppExports { activate(): HotModule }

let current: HotModule | null = null
let lastGood: AppExports | null = null
let swapping: Promise<unknown> = Promise.resolve()

/** Drop every cached module under out/main except the kernel, then require anew. */
function requireFresh(): AppExports {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(OUT) && key !== __filename) delete require.cache[key]
  }
  // Not a literal so the bundler leaves it alone.
  const path = APP_BUNDLE
  return require(path) as AppExports
}

function activate(exports: AppExports): void {
  current = exports.activate()
  lastGood = exports
  hot.generation += 1
  hot.activatedAt = Date.now()
  hot.lastError = null
}

function reload(reason = 'manual'): Promise<{ ok: boolean; generation: number; error?: string }> {
  const run = async (): Promise<{ ok: boolean; generation: number; error?: string }> => {
    let exports: AppExports
    try {
      exports = requireFresh()
      if (typeof exports.activate !== 'function') throw new Error('app bundle does not export activate()')
    } catch (err) {
      const error = (err as Error).stack || String(err)
      hot.lastError = error
      console.error(`[hot] load failed (${reason}); keeping generation ${hot.generation}\n${error}`)
      return { ok: false, generation: hot.generation, error }
    }

    const previous = current
    try { previous?.dispose() } catch (err) { console.error('[hot] dispose failed', err) }
    try {
      activate(exports)
      console.log(`[hot] generation ${hot.generation} live (${reason})`)
      return { ok: true, generation: hot.generation }
    } catch (err) {
      const error = (err as Error).stack || String(err)
      hot.lastError = error
      console.error(`[hot] activate failed (${reason})\n${error}`)
      // Roll back to the last bundle that worked so the app keeps running.
      if (lastGood) {
        try { current = lastGood.activate(); console.warn('[hot] rolled back to previous generation') } catch (e) {
          console.error('[hot] rollback failed', e)
          current = null
        }
      }
      return { ok: false, generation: hot.generation, error }
    }
  }
  const next = swapping.then(run, run)
  swapping = next.catch(() => undefined)
  return next
}

// ---- dev watcher ------------------------------------------------------------

type Esbuild = typeof import('esbuild')
const contexts: { dispose(): Promise<void> }[] = []

async function startWatcher(): Promise<void> {
  let esbuild: Esbuild
  try {
    esbuild = createRequire(__filename)('esbuild') as Esbuild
  } catch (err) {
    console.warn('[hot] esbuild not available; main-process hot reload is off', (err as Error).message)
    return
  }

  const shared = join(ROOT, 'src/shared')
  const alias = {
    name: 'paper-alias',
    setup(build: import('esbuild').PluginBuild) {
      build.onResolve({ filter: /^@shared\// }, (args) => ({
        path: resolveTs(join(shared, args.path.slice('@shared/'.length)))
      }))
    }
  }

  const record = (target: BuildRecord['target'], started: number, result: import('esbuild').BuildResult): BuildRecord => {
    const errors = result.errors.map((e) => `${e.location?.file ?? '?'}:${e.location?.line ?? 0} ${e.text}`)
    const rec: BuildRecord = { at: Date.now(), target, ok: errors.length === 0, durationMs: Date.now() - started, errors }
    hot.builds.push(rec)
    if (hot.builds.length > 30) hot.builds.shift()
    if (!rec.ok) {
      hot.lastError = errors.join('\n')
      console.error(`[hot] ${target} build failed\n${hot.lastError}`)
    }
    return rec
  }

  const watch = async (
    target: BuildRecord['target'],
    entry: string,
    outfile: string,
    onBuilt: () => void
  ): Promise<void> => {
    let started = Date.now()
    let first = true
    const ctx = await esbuild.context({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      packages: 'external',
      sourcemap: true,
      logLevel: 'silent',
      plugins: [
        alias,
        {
          name: 'paper-hot',
          setup(build) {
            build.onStart(() => { started = Date.now() })
            build.onEnd((result) => {
              const rec = record(target, started, result)
              // The first build only mirrors what electron-vite already produced.
              if (first) { first = false; return }
              if (rec.ok) onBuilt()
            })
          }
        }
      ]
    })
    contexts.push(ctx)
    await ctx.watch()
  }

  await watch('app', join(ROOT, 'src/main/app.ts'), APP_BUNDLE, () => void reload('rebuild'))
  await watch('preload', join(ROOT, 'src/preload/index.ts'), join(OUT, '../preload/index.js'), () => {
    console.log('[hot] preload rebuilt; reloading renderer')
    reloadRenderer()
  })
  hot.watching = true
  console.log('[hot] watching src/main, src/preload, src/shared')
}

function resolveTs(base: string): string {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return `${base}.ts`
}

function reloadRenderer(): void {
  mainWindow?.webContents.reload()
}

function openWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  const win = mainWindow!
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return win
}

// ---- MCP listener -----------------------------------------------------------

const mcp = { port: 0, url: '', configPath: join(PAPER_HOME, 'mcp.json') }

function health(): Record<string, unknown> {
  return {
    ok: current !== null,
    name: 'paper',
    version: VERSION,
    pid: process.pid,
    dev: DEV,
    generation: hot.generation,
    watching: hot.watching,
    lastError: hot.lastError,
    mcp: mcp.url
  }
}

function serve(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url || '/'
  if (url === '/health' || (req.method === 'GET' && url === '/')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(health()))
    return
  }
  if (!current) {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'app bundle not active', lastError: hot.lastError }))
    return
  }
  current.handleHttp(req, res).catch((err) => {
    console.error('[mcp] request failed', err)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: (err as Error).message }))
  })
}

function listen(port: number, attemptsLeft: number): Promise<void> {
  return new Promise((resolvePort, reject) => {
    const server = createServer(serve)
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
        console.warn(`[mcp] port ${port} busy, trying ${port + 1}`)
        listen(port + 1, attemptsLeft - 1).then(resolvePort, reject)
      } else reject(err)
    })
    server.listen(port, '127.0.0.1', () => {
      mcp.port = port
      mcp.url = `http://127.0.0.1:${port}/mcp`
      resolvePort()
    })
  })
}

/** Advertise the endpoint so `claude` sessions spawned by Paper can attach. */
function writeMcpConfig(): void {
  try {
    mkdirSync(dirname(mcp.configPath), { recursive: true })
    writeFileSync(
      mcp.configPath,
      JSON.stringify({ mcpServers: { paper: { type: 'http', url: mcp.url } } }, null, 2)
    )
  } catch (err) {
    console.warn('[mcp] could not write', mcp.configPath, err)
  }
}

// ---- boot -------------------------------------------------------------------

const kernelObject: Kernel = {
  version: VERSION,
  startedAt: Date.now(),
  dev: DEV,
  paths: { root: ROOT, out: OUT, home: PAPER_HOME },
  window: () => mainWindow,
  slot,
  logs,
  console: rendererConsole,
  hot,
  mcp,
  reload,
  reloadRenderer,
  openWindow
}
;(globalThis as { __paperKernel?: Kernel }).__paperKernel = kernelObject

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light'
  try {
    await listen(MCP_PORT_BASE, 9)
    writeMcpConfig()
    console.log(`[mcp] listening at ${mcp.url}`)
  } catch (err) {
    console.error('[mcp] listener failed', err)
  }

  await reload('boot')
  createWindow()
  if (DEV) void startWatcher()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  for (const ctx of contexts) void ctx.dispose()
  try { current?.shutdown() } catch (err) { console.error('[kernel] shutdown failed', err) }
})
