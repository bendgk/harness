import { z } from 'zod'
import { defineTool } from './types'
import type { ToolContext } from './types'

const ID = z.string().describe('Session id (from sessions_list)')
/** LOCAL_HOST, spelled out: tool modules import only zod and types. */
const LOCAL = 'local'
const HOST = z.string().describe('Where the agent runs: "local" (this computer) or a registered machine alias, e.g. "g6e"')

const ESC = String.fromCharCode(27)
const CSI = String.fromCharCode(155)
const BEL = String.fromCharCode(7)
// CSI / OSC / simple escape sequences, as emitted by the CLIs' TUIs.
const ANSI = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?${BEL})|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-Za-z=><~]))`,
  'g'
)

/** Turn a raw pty stream into something readable: drop escapes, honour CR and backspace. */
export function plainText(raw: string): string {
  const BS = String.fromCharCode(8)
  return raw
    .replace(ANSI, '')
    .split('\n')
    .map((line) => {
      // A carriage return *within* a line overwrites it (progress bars, spinners);
      // one at the end is just the pty's CRLF and must not blank the line.
      const parts = line.replace(/\r+$/, '').split('\r')
      const last = parts[parts.length - 1]
      // Line editors echo a char, backspace over it, then repaint: apply the erase.
      return last.split(BS).reduce((acc, part, i) => (i === 0 ? part : acc.slice(0, -1) + part))
    })
    .join('\n')
}

function requireSession(ctx: ToolContext, id: string) {
  const s = ctx.sessions.get(id)
  if (!s) throw new Error(`No session ${id}. Call sessions_list for live ids.`)
  return s
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const sessionTools = [
  defineTool({
    name: 'sessions_list',
    title: 'List sessions',
    description:
      'Every live session (agent or shell) with id, provider, account, host ("local" or the machine alias it runs on), ' +
      'cwd, status (starting/working/idle/exited/handoff), link (remote sessions: connecting/attached/reconnecting/lost), ' +
      'title and usage totals. `restoredAt` is set on sessions brought back after Paper restarted. ' +
      'Session ids are what every other session_* tool takes.',
    group: 'sessions',
    input: {},
    handler: (_args, ctx) => ({
      json: ctx.sessions.list().map((m) => {
        const u = ctx.usage.snapshot(m.id)
        return {
          ...m,
          host: m.host || LOCAL,
          link: m.remote?.link,
          usage: u ? { totalTokens: u.totalTokens, costUsd: u.costUsd, contextTokens: u.contextTokens, model: u.model } : undefined,
          alive: Boolean(ctx.sessions.get(m.id)?.proc)
        }
      })
    })
  }),

  defineTool({
    name: 'sessions_persisted',
    title: 'Persisted sessions',
    description:
      'The on-disk session registry (~/.paper/sessions.json) that brings sessions back after Paper restarts: one record per ' +
      'session with its full meta, wasWorking (mid-turn at the last write), lastActiveAt and terminal size, plus quitAt when ' +
      'the last run quit cleanly. `restore` is what this boot did with each record (resumed/fresh/reattached/shell/exited/failed, ' +
      'whether a continuation nudge was sent) and any orphaned CLI processes it terminated. Holds no secrets.',
    group: 'sessions',
    input: {},
    handler: (_args, ctx) => ({
      json: { path: ctx.persistence.path, registry: ctx.persistence.read(), restore: ctx.persistence.report() }
    })
  }),

  defineTool({
    name: 'session_read',
    title: 'Read session output',
    description:
      "The tail of a session's terminal output. ANSI escapes are stripped by default so you can read what the agent or " +
      'shell printed. Use `lines` for the last N lines, or `raw` for the exact byte stream.',
    group: 'sessions',
    input: {
      id: ID,
      lines: z.number().int().min(1).max(5000).default(80).describe('How many trailing lines to return'),
      raw: z.boolean().default(false).describe('Return the raw pty stream with escapes intact'),
      max_bytes: z.number().int().min(256).max(400_000).default(60_000).describe('Hard cap on returned bytes')
    },
    handler: (args, ctx) => {
      const s = requireSession(ctx, args.id)
      const text = args.raw ? s.buffer : plainText(s.buffer)
      const tail = text.split('\n').slice(-args.lines).join('\n')
      const clipped = tail.length > args.max_bytes ? tail.slice(-args.max_bytes) : tail
      return { text: clipped || '(no output yet)' }
    }
  }),

  defineTool({
    name: 'session_spawn',
    title: 'Start a session',
    description:
      'Start a Claude Code, Codex or shell session, on this computer or on a registered machine (`host`). On a machine the ' +
      'agent runs in tmux there and keeps working if Paper disconnects or quits. `where` controls the UI: "tab" opens a new ' +
      'tab, "pane" fills the focused pane, "headless" runs it without a pane (still inspectable via session_read). ' +
      'Returns the session meta (a remote session starts as status "starting", link "connecting").',
    group: 'sessions',
    input: {
      provider: z.enum(['claude', 'codex', 'shell']).describe('Which harness to run'),
      cwd: z.string().optional().describe('Working directory; defaults to the app default (on a machine: its default directory, else ~)'),
      account_id: z.string().optional().describe('Account to run under (accounts_list); default account otherwise'),
      prompt: z.string().optional().describe('Initial prompt typed into an agent, or a command for a shell'),
      where: z.enum(['tab', 'pane', 'headless']).default('tab').describe('Where the session appears'),
      host: HOST.default(LOCAL)
    },
    mutates: true,
    handler: async (args, ctx) => {
      if (args.host !== LOCAL) {
        // Main validates the alias against the registry; the renderer's spawn
        // path is local-only, so start it here and put it in a pane after.
        if (!ctx.machines.list().some((m) => m.alias === args.host)) {
          throw new Error(`"${args.host}" is not a registered machine. Registered: ${ctx.machines.list().map((m) => m.alias).join(', ') || 'none'}`)
        }
        const meta = ctx.sessions.spawn({ provider: args.provider, cwd: args.cwd, accountId: args.account_id, prompt: args.prompt, host: args.host })
        if (args.where !== 'headless') {
          const fn = args.where === 'tab' ? 'await s.newTab(); s = window.__paper.store.getState();' : ''
          await ctx.evalInRenderer(
            `let s = window.__paper.store.getState(); ${fn} const t = s.activeTab(); if (t) s.attachSession(t.focusedPaneId, ${JSON.stringify(meta.id)}); return true`
          )
        }
        return { json: meta }
      }
      const req = { provider: args.provider, cwd: args.cwd, accountId: args.account_id, prompt: args.prompt }
      if (args.where === 'headless') {
        const meta = ctx.sessions.spawn({ ...req, cwd: args.cwd || ctx.getState().defaults.cwd })
        return { json: meta }
      }
      const before = new Set(ctx.sessions.list().map((m) => m.id))
      const fn = args.where === 'tab' ? 'newTab' : 'spawnInFocusedPane'
      await ctx.evalInRenderer(`window.__paper.store.getState().${fn}(${JSON.stringify(req)})`)
      const created = ctx.sessions.list().find((m) => !before.has(m.id))
      if (!created) throw new Error('The renderer did not start a session (check ui_console for the reason)')
      return { json: created }
    }
  }),

  defineTool({
    name: 'session_write',
    title: 'Type into a session',
    description:
      "Send keystrokes to a session's pty, as if typed. `enter` appends a carriage return to submit. " +
      'For an agent mid-turn prefer session_steer; for a shell this is how you run a command.',
    group: 'sessions',
    input: {
      id: ID,
      text: z.string().describe('Text to type. Control characters are passed through (e.g. "\\u0003" for Ctrl-C).'),
      enter: z.boolean().default(true).describe('Press Enter after the text')
    },
    mutates: true,
    handler: (args, ctx) => {
      requireSession(ctx, args.id)
      ctx.sessions.write(args.id, args.text + (args.enter ? '\r' : ''))
      return { text: 'sent' }
    }
  }),

  defineTool({
    name: 'session_steer',
    title: 'Interrupt and redirect an agent',
    description: 'Interrupt the agent if it is working, then submit a new prompt on the same conversation (the ⌘↩ flow).',
    group: 'sessions',
    input: { id: ID, prompt: z.string().describe('The new instruction') },
    mutates: true,
    handler: async (args, ctx) => {
      requireSession(ctx, args.id)
      await ctx.sessions.steer(args.id, args.prompt)
      return { text: 'steered' }
    }
  }),

  defineTool({
    name: 'session_interrupt',
    title: 'Interrupt a session',
    description: "Send the provider's interrupt sequence (ESC for agents, Ctrl-C for shells) without ending the session.",
    group: 'sessions',
    input: { id: ID },
    mutates: true,
    handler: (args, ctx) => {
      requireSession(ctx, args.id)
      ctx.sessions.interrupt(args.id)
      return { text: 'interrupted' }
    }
  }),

  defineTool({
    name: 'session_restart',
    title: 'Restart a session',
    description:
      'Relaunch the CLI in place, resuming the same conversation (⌘R). For a session on a machine whose link dropped or ' +
      'failed, this reconnects to the still-running agent instead, relaunching (with resume) only if it is gone.',
    group: 'sessions',
    input: { id: ID },
    mutates: true,
    handler: (args, ctx) => {
      requireSession(ctx, args.id)
      ctx.sessions.restart(args.id)
      return { json: ctx.sessions.meta(args.id) }
    }
  }),

  defineTool({
    name: 'session_close',
    title: 'Close a session',
    description:
      'Kill the process and forget the session. For a session on a machine this ends the agent there too (its tmux ' +
      'session). The pane showing it (if any) reports it as exited.',
    group: 'sessions',
    input: { id: ID },
    mutates: true,
    handler: (args, ctx) => {
      requireSession(ctx, args.id)
      ctx.sessions.close(args.id)
      ctx.usage.forget(args.id)
      ctx.titles.forget(args.id)
      return { text: 'closed' }
    }
  }),

  defineTool({
    name: 'session_handoff',
    title: 'Move a session to another computer',
    description:
      'Hand a session off to a registered machine, or back to this computer (host "local"), with the conversation fully ' +
      'intact: the target is checked first, then the agent is stopped, its transcript moved and resumed there by id. ' +
      'If anything fails the session is resumed where it was. An agent may move ITSELF (id = $PAPER_SESSION): while the ' +
      'session is working the call returns "scheduled" at once and the move happens when the current turn ends, then ' +
      '`continue_prompt` (default: a note to carry on with the task) is typed into the resumed agent. A shell just opens ' +
      'a fresh shell on the target.',
    group: 'sessions',
    input: {
      id: ID,
      host: HOST,
      cwd: z.string().optional().describe('Directory on the target. Default: the machine\'s default, else the same path, else the same path under $HOME'),
      continue_prompt: z.string().optional().describe('Typed into the agent once it is running on the target')
    },
    mutates: true,
    handler: async (args, ctx) => {
      const s = requireSession(ctx, args.id)
      const host = args.host || LOCAL
      if (host !== LOCAL && !ctx.machines.list().some((m) => m.alias === host)) {
        throw new Error(`"${host}" is not a registered machine`)
      }
      const where = host === LOCAL ? "the user's computer" : host
      // A working session is (almost always) the caller handing itself off:
      // stopping it now would kill the agent inside this very tool call.
      if (s.meta.status === 'working' || s.meta.status === 'starting') {
        if (host === LOCAL && s.meta.host && s.meta.host !== LOCAL) {
          const m = ctx.machines.list().find((x) => x.alias === s.meta.host)
          if (m?.allowAgentHandoffToLocal === false) {
            throw new Error(`Agents on ${s.meta.host} are not allowed to move themselves to the user's computer (machine setting).`)
          }
        }
        const continuePrompt = args.continue_prompt ??
          `You have been handed off to ${where} and are now running there in {cwd}. Continue the task you were working on.`
        ctx.handoff.scheduleToMachine({ sessionId: args.id, host, cwd: args.cwd, continuePrompt })
        return {
          text: `scheduled: this session moves to ${where} as soon as its current turn ends (end your turn now). ` +
            'The conversation resumes there with full context.'
        }
      }
      await ctx.handoff.toMachine({ sessionId: args.id, host, cwd: args.cwd, continuePrompt: args.continue_prompt })
      const meta = ctx.sessions.meta(args.id)
      return { json: meta }
    }
  }),

  defineTool({
    name: 'machine_adopt',
    title: 'Adopt an agent running on a machine',
    description:
      'Bring an agent that is running in tmux on a registered machine (a "paper-*" session, e.g. from a Paper that ' +
      'restarted or another computer) into this Paper as a live session, re-attaching to it without restarting it. ' +
      'Returns the session meta.',
    group: 'sessions',
    input: {
      alias: z.string().describe('Registered machine alias'),
      tmux: z.string().describe('The tmux session name on that machine, e.g. "paper-1a2b3c4d5e6f"')
    },
    mutates: true,
    handler: async (args, ctx) => {
      if (!/^paper-[0-9a-f]{6,32}$/.test(args.tmux)) throw new Error(`"${args.tmux}" is not a Paper tmux session name`)
      return { json: await ctx.sessions.adoptRemote(args.alias, args.tmux) }
    }
  }),

  defineTool({
    name: 'session_wait',
    title: 'Wait for a session to settle',
    description:
      'Block until the session is idle or exited (an agent finished its turn), or the timeout passes. ' +
      'Returns the final status and the last lines of output, so "send a prompt, wait, read the answer" is one call.',
    group: 'sessions',
    input: {
      id: ID,
      timeout_ms: z.number().int().min(100).max(600_000).default(60_000).describe('Give up after this long'),
      settle_ms: z.number().int().min(0).max(30_000).default(1500).describe('Require this much quiet before declaring idle'),
      lines: z.number().int().min(0).max(500).default(30).describe('Trailing lines to return')
    },
    handler: async (args, ctx) => {
      const s = requireSession(ctx, args.id)
      const started = Date.now()
      let quietSince = s.meta.status === 'idle' ? Date.now() : 0
      let timedOut = false
      for (;;) {
        const status = s.meta.status
        if (status === 'exited') break
        if (status === 'idle') {
          if (!quietSince) quietSince = Date.now()
          if (Date.now() - quietSince >= args.settle_ms) break
        } else quietSince = 0
        if (Date.now() - started > args.timeout_ms) {
          timedOut = true
          break
        }
        await delay(150)
      }
      const tail = plainText(s.buffer).split('\n').slice(-args.lines).join('\n')
      return { json: { status: s.meta.status, timedOut, waitedMs: Date.now() - started, tail } }
    }
  }),

  defineTool({
    name: 'usage_get',
    title: 'Usage for a session',
    description: 'Token, cost, context-window and rate-limit figures Paper has parsed from the CLI transcript. Omit id for all sessions.',
    group: 'sessions',
    input: { id: z.string().optional().describe('Session id; all sessions when omitted') },
    handler: (args, ctx) => ({ json: args.id ? (ctx.usage.snapshot(args.id) ?? null) : ctx.usage.all() })
  }),

  defineTool({
    name: 'plan_usage',
    title: 'Plan usage per account',
    description:
      'What Claude Code\'s /usage shows, for every account: current session, current week (all models) and any ' +
      'model-scoped week (e.g. Fable), each with percent used and reset time. Claude numbers come from Anthropic\'s ' +
      'usage endpoint with the account\'s own login; Codex numbers from its transcripts. Cached ~1 min; `refresh` asks again.',
    group: 'sessions',
    input: { refresh: z.boolean().default(false).describe('Ask the provider again instead of using the cached numbers') },
    handler: async (args, ctx) => {
      const labels = new Map(ctx.accounts().map((a) => [a.id, a.label]))
      const plans = await ctx.plan(args.refresh)
      return { json: plans.map((p) => ({ account: labels.get(p.accountId) ?? p.accountId, ...p })) }
    }
  })
]
