import { z } from 'zod'
import { defineTool } from './types'

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const devTools = [
  defineTool({
    name: 'hot_status',
    title: 'Hot reload status',
    description:
      'State of live code reloading: current app-bundle generation, whether the dev watcher is on, the last error, ' +
      'and recent build results for the main-process (app) and preload bundles. The renderer reloads through Vite HMR separately.',
    group: 'dev',
    input: { builds: z.number().int().min(0).max(30).default(5).describe('How many recent builds to include') },
    handler: (args, ctx) => {
      const h = ctx.kernel.hot
      return {
        json: {
          mode: h.mode,
          generation: h.generation,
          activatedAt: h.activatedAt,
          watching: h.watching,
          lastError: h.lastError,
          builds: h.builds.slice(-args.builds)
        }
      }
    }
  }),

  defineTool({
    name: 'hot_wait',
    title: 'Wait for a rebuild',
    description:
      'After editing src/main, src/preload or src/shared, wait for the watcher to rebuild and activate the change. ' +
      'Resolves with the build result and the new generation, or the compile errors, so you know your edit is live before testing it.',
    group: 'dev',
    input: {
      since: z.number().optional().describe('Epoch ms; wait for a build newer than this (default: 20s ago)'),
      timeout_ms: z.number().int().min(500).max(120_000).default(20_000).describe('Give up after this long')
    },
    handler: async (args, ctx) => {
      const h = ctx.kernel.hot
      if (!h.watching) return { json: { watching: false, note: 'Not in dev mode; run `npm run dev` for hot reload.' }, isError: true }
      const since = args.since ?? Date.now() - 20_000
      const started = Date.now()
      for (;;) {
        const build = [...h.builds].reverse().find((b) => b.at >= since)
        if (build) {
          // Activation follows a successful app build almost immediately; give it a beat.
          if (build.ok && build.target === 'app' && (h.activatedAt ?? 0) < build.at) {
            if (Date.now() - started < args.timeout_ms) { await delay(100); continue }
          }
          return { json: { build, generation: h.generation, activatedAt: h.activatedAt, lastError: h.lastError }, isError: !build.ok }
        }
        if (Date.now() - started > args.timeout_ms) {
          return { json: { timedOut: true, generation: h.generation, note: 'No build since `since`. Did the edit touch a watched file?' }, isError: true }
        }
        await delay(150)
      }
    }
  }),

  defineTool({
    name: 'hot_reload',
    title: 'Force a reload',
    description:
      'Re-activate the main-process app bundle from disk ("app"), reload the renderer page ("renderer"), or both. ' +
      'The watcher normally does this for you on save; use it after building by hand or to recover from a failed activation.',
    group: 'dev',
    input: { target: z.enum(['app', 'renderer', 'both']).default('app') },
    mutates: true,
    handler: async (args, ctx) => {
      const out: Record<string, unknown> = {}
      if (args.target !== 'renderer') out.app = await ctx.kernel.reload('tool')
      if (args.target !== 'app') { ctx.kernel.reloadRenderer(); out.renderer = 'reloading' }
      return { json: out, isError: out.app ? !(out.app as { ok: boolean }).ok : false }
    }
  }),

  defineTool({
    name: 'logs_main',
    title: 'Main-process logs',
    description: 'Recent console output from the Electron main process (kernel, sessions, hot reload, MCP). Newest last.',
    group: 'dev',
    input: {
      limit: z.number().int().min(1).max(2000).default(100),
      level: z.enum(['log', 'info', 'warn', 'error', 'debug']).optional(),
      grep: z.string().optional().describe('Only entries containing this text')
    },
    handler: (args, ctx) => {
      let entries = ctx.kernel.logs
      if (args.level) entries = entries.filter((e) => e.level === args.level)
      if (args.grep) entries = entries.filter((e) => e.text.includes(args.grep!))
      return { json: entries.slice(-args.limit) }
    }
  })
]
