import { z } from 'zod'
import { defineTool } from './types'

/** Read the renderer's reactive store, which the renderer publishes as window.__paper. */
const STORE = 'window.__paper.store.getState()'

const MENU_COMMANDS = [
  'session.new', 'session.new.claude', 'session.new.codex', 'session.new.shell', 'session.newInFolder',
  'session.cd', 'session.close', 'session.restart', 'session.rename', 'session.interrupt', 'session.steer',
  'session.find', 'session.clear', 'session.moveMachine', 'agent.rename', 'account.switch', 'accounts.open',
  'machines.open',
  'palette.open',
  'pane.split.row', 'pane.split.col', 'pane.close', 'pane.contents', 'pane.next', 'pane.prev',
  'tab.next', 'tab.prev', 'tab.select.0', 'sidebar.toggle', 'widgets.toggle', 'zen.toggle',
  'font.bigger', 'font.smaller'
]

export const uiTools = [
  defineTool({
    name: 'ui_state',
    title: 'Renderer state',
    description:
      "The renderer's store (tabs, pane tree, sessions as the UI sees them, overlay, theme, drag state, toast...). " +
      'This is the truth about what is on screen. `path` narrows to one branch, e.g. "tabs" or "overlay".',
    group: 'ui',
    input: { path: z.string().optional().describe('Dot path into the state, e.g. "tabs.0.root"') },
    handler: async (args, ctx) => {
      const value = await ctx.evalInRenderer(`window.__paper.snapshot(${JSON.stringify(args.path ?? '')})`)
      return { json: value }
    }
  }),

  defineTool({
    name: 'ui_eval',
    title: 'Evaluate in the renderer',
    description:
      'Run JavaScript in the renderer window (main world, where React runs) and return its JSON-serialisable result. ' +
      'Expressions and statement bodies both work; async is awaited. `window.__paper.store` is the zustand store, ' +
      'so `window.__paper.store.getState().setOverlay("palette")` drives the UI directly.',
    group: 'ui',
    input: { code: z.string().describe('JavaScript source to run') },
    mutates: true,
    handler: async (args, ctx) => ({ json: await ctx.evalInRenderer(args.code) })
  }),

  defineTool({
    name: 'ui_screenshot',
    title: 'Screenshot the window',
    description:
      'Capture the Paper window as PNG. Returns the image and the path it was saved to under ~/.paper/shots. ' +
      'Use it to see what a user would see after a change.',
    group: 'ui',
    input: {
      max_width: z.number().int().min(200).max(4000).default(1400).describe('Downscale so the image is at most this wide'),
      save: z.boolean().default(true).describe('Also write the PNG to disk')
    },
    handler: async (args, ctx) => {
      const win = ctx.window()
      if (!win || win.isDestroyed()) throw new Error('No window')
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      let image = await win.webContents.capturePage()
      const { width } = image.getSize()
      if (width > args.max_width) image = image.resize({ width: args.max_width })
      const png = image.toPNG()
      let path: string | undefined
      if (args.save) {
        const dir = join(ctx.kernel.paths.home, 'shots')
        mkdirSync(dir, { recursive: true })
        path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
        writeFileSync(path, png)
      }
      return { text: path ? `saved ${path}` : 'captured', image: { data: png.toString('base64'), mimeType: 'image/png' } }
    }
  }),

  defineTool({
    name: 'ui_console',
    title: 'Renderer console',
    description: 'Recent console output from the renderer (errors, warnings, React messages). Newest last.',
    group: 'ui',
    input: {
      limit: z.number().int().min(1).max(2000).default(100).describe('How many entries'),
      level: z.enum(['error', 'warning', 'info', 'debug']).optional().describe('Only this level'),
      grep: z.string().optional().describe('Only entries containing this text'),
      clear: z.boolean().default(false).describe('Empty the buffer after reading')
    },
    handler: (args, ctx) => {
      let entries = ctx.kernel.console
      if (args.level) entries = entries.filter((e) => e.level === args.level)
      if (args.grep) entries = entries.filter((e) => e.text.includes(args.grep!))
      const out = entries.slice(-args.limit)
      if (args.clear) ctx.kernel.console.length = 0
      return { json: out }
    }
  }),

  defineTool({
    name: 'ui_command',
    title: 'Run a menu command',
    description:
      'Dispatch one of the application-menu commands exactly as its shortcut would (⌘K = palette.open, ⌘D = pane.split.row...). ' +
      `Known: ${MENU_COMMANDS.join(', ')} (tab.select.N for N in 0..8).`,
    group: 'ui',
    input: { command: z.string().describe('Command id, e.g. "pane.split.row"') },
    mutates: true,
    handler: (args, ctx) => {
      ctx.command(args.command)
      return { text: `sent ${args.command}` }
    }
  }),

  defineTool({
    name: 'ui_dom',
    title: 'Outline the DOM',
    description:
      'A compact outline of the rendered DOM under a selector: tag, id, classes, short text, and bounding box. ' +
      'Use it to find something to ui_click or to check that a component rendered.',
    group: 'ui',
    input: {
      selector: z.string().default('#root').describe('CSS selector for the root of the outline'),
      depth: z.number().int().min(0).max(12).default(3).describe('How many levels below the root to include'),
      max_nodes: z.number().int().min(1).max(2000).default(200).describe('Stop after this many nodes')
    },
    handler: async (args, ctx) => {
      const code = `(() => {
        const root = document.querySelector(${JSON.stringify(args.selector)})
        if (!root) return { error: 'no element matches ' + ${JSON.stringify(args.selector)} }
        const out = []
        const walk = (el, depth) => {
          if (out.length >= ${args.max_nodes}) return
          const r = el.getBoundingClientRect()
          const text = (el.childNodes.length && [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim()) || ''
          out.push({
            depth,
            tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
            text: text.slice(0, 60),
            box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
          })
          if (depth < ${args.depth}) for (const c of el.children) walk(c, depth + 1)
        }
        walk(root, 0)
        return out.map(n => '  '.repeat(n.depth) + n.tag + (n.text ? ' "' + n.text + '"' : '') + ' @' + n.box.join(',')).join('\\n')
      })()`
      const result = await ctx.evalInRenderer<string | { error: string }>(code)
      if (typeof result !== 'string') throw new Error((result as { error: string }).error)
      return { text: result }
    }
  }),

  defineTool({
    name: 'ui_click',
    title: 'Click an element',
    description:
      'Click the first element matching a CSS selector (optionally the first whose text contains `text`). ' +
      'Dispatches a real click event, so React handlers run.',
    group: 'ui',
    input: {
      selector: z.string().describe('CSS selector, e.g. "button.ghost-btn"'),
      text: z.string().optional().describe('Only match an element whose textContent contains this')
    },
    mutates: true,
    handler: async (args, ctx) => {
      const code = `(() => {
        const all = [...document.querySelectorAll(${JSON.stringify(args.selector)})]
        const el = ${args.text ? `all.find(e => (e.textContent || '').includes(${JSON.stringify(args.text)}))` : 'all[0]'}
        if (!el) return { clicked: false, matched: all.length }
        el.scrollIntoView?.({ block: 'nearest' })
        el.click()
        return { clicked: true, matched: all.length, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 80) }
      })()`
      return { json: await ctx.evalInRenderer(code) }
    }
  }),

  defineTool({
    name: 'ui_type',
    title: 'Type keystrokes',
    description:
      'Send real keyboard input to the window through Electron, hitting whatever is focused — an input in a sheet, the ' +
      'command palette, a terminal. `text` is typed character by character; `key` presses one named key ' +
      '(Enter, Escape, Tab, Backspace, ArrowDown, ...) with optional modifiers. Use it to test focus and keyboard flows ' +
      'the way a user experiences them, then ui_eval `document.activeElement` to see where focus ended up.',
    group: 'ui',
    input: {
      text: z.string().optional().describe('Characters to type'),
      key: z.string().optional().describe('A named key to press after `text`, e.g. "Enter" or "Escape"'),
      modifiers: z.array(z.enum(['cmd', 'shift', 'alt', 'ctrl'])).default([]).describe('Held while pressing `key`'),
      delay_ms: z.number().int().min(0).max(500).default(8).describe('Pause between characters')
    },
    mutates: true,
    handler: async (args, ctx) => {
      const win = ctx.window()
      if (!win || win.isDestroyed()) throw new Error('No window')
      const wc = win.webContents
      const pause = (): Promise<void> => new Promise((r) => setTimeout(r, args.delay_ms))
      for (const ch of args.text ?? '') {
        wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
        await pause()
      }
      if (args.key) {
        const modifiers = args.modifiers as ('cmd' | 'shift' | 'alt' | 'ctrl')[]
        wc.sendInputEvent({ type: 'keyDown', keyCode: args.key, modifiers })
        if (args.key === 'Enter' || args.key === 'Return') wc.sendInputEvent({ type: 'char', keyCode: 'Return', modifiers })
        wc.sendInputEvent({ type: 'keyUp', keyCode: args.key, modifiers })
      }
      const active = await ctx.evalInRenderer<string>(
        '(() => { const a = document.activeElement; return a ? a.tagName.toLowerCase() + (a.className ? "." + String(a.className).trim().split(/\\s+/).join(".") : "") + (a.value !== undefined ? " value=" + JSON.stringify(a.value) : "") : "none" })()'
      )
      return { json: { typed: args.text ?? '', key: args.key ?? null, activeElement: active } }
    }
  }),

  defineTool({
    name: 'ui_reload',
    title: 'Reload the renderer',
    description:
      'Full page reload of the renderer. Vite HMR normally makes this unnecessary; use it after a preload change or when the ' +
      'UI is wedged. Live sessions survive and re-attach to their panes.',
    group: 'ui',
    input: {},
    mutates: true,
    handler: (_args, ctx) => {
      ctx.kernel.reloadRenderer()
      return { text: 'reloading' }
    }
  }),

  defineTool({
    name: 'ui_window',
    title: 'Open or focus the window',
    description:
      'Ensure the Paper window exists and is in front. On macOS closing the window leaves the app (and its MCP server) ' +
      'running with no window, and every ui_* tool then fails with "No window" — call this first to get one back.',
    group: 'ui',
    input: {},
    mutates: true,
    handler: (_args, ctx) => {
      const win = ctx.kernel.openWindow()
      return { json: { bounds: win.getBounds(), visible: win.isVisible(), focused: win.isFocused() } }
    }
  }),

  defineTool({
    name: 'ui_notify',
    title: 'Show a toast',
    description: 'Show a toast in the Paper window, the same one the app uses for its own notices.',
    group: 'ui',
    input: { text: z.string().describe('Message'), tone: z.enum(['ok', 'warn']).default('ok') },
    mutates: true,
    handler: async (args, ctx) => {
      await ctx.evalInRenderer(`${STORE}.notify(${JSON.stringify(args.text)}, ${JSON.stringify(args.tone)})`)
      return { text: 'shown' }
    }
  })
]
