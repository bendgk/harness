import { z } from 'zod'
import { defineTool } from './types'

export const appTools = [
  defineTool({
    name: 'paper_status',
    title: 'Paper status',
    description:
      'Health of the running Paper instance: version, pid, uptime, dev/prod mode, hot-reload generation, ' +
      'MCP endpoint, window bounds and how many sessions are alive. Call this first to confirm you are talking to the right instance.',
    group: 'app',
    input: {},
    handler: (_args, ctx) => {
      const win = ctx.window()
      const k = ctx.kernel
      return {
        json: {
          name: 'paper',
          version: k.version,
          pid: process.pid,
          uptimeMs: Date.now() - k.startedAt,
          mode: k.hot.mode,
          electron: process.versions.electron,
          node: process.versions.node,
          root: k.paths.root,
          home: k.paths.home,
          mcp: k.mcp,
          hot: { generation: k.hot.generation, activatedAt: k.hot.activatedAt, watching: k.hot.watching, lastError: k.hot.lastError },
          window: win && !win.isDestroyed()
            ? { bounds: win.getBounds(), focused: win.isFocused(), visible: win.isVisible(), url: win.webContents.getURL() }
            : null,
          sessions: ctx.sessions.list().length
        }
      }
    }
  }),

  defineTool({
    name: 'tools_list',
    title: 'List tools',
    description:
      'The manifest of every Paper tool with its JSON-schema input, including tools added since your MCP client connected. ' +
      'Use with tools_invoke to call a tool your client has not loaded yet.',
    group: 'app',
    input: { group: z.enum(['app', 'sessions', 'ui', 'dev', 'state', 'machines', 'agents']).optional().describe('Only tools in this group') },
    handler: (args, ctx) => ctx.invoke('__manifest', { group: args.group })
  }),

  defineTool({
    name: 'tools_invoke',
    title: 'Invoke a tool by name',
    description:
      'Call any Paper tool by name with a JSON argument object. Reaches tools registered after your client connected ' +
      '(after a hot reload added one), without reconnecting the MCP server.',
    group: 'app',
    input: {
      name: z.string().describe('Tool name, e.g. "sessions_list"'),
      args: z.record(z.string(), z.unknown()).optional().describe('Arguments for that tool')
    },
    mutates: true,
    handler: (args, ctx) => ctx.invoke(args.name, args.args ?? {})
  })
]
