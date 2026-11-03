import { z } from 'zod'
import { defineTool } from './types'
import type { ToolResult } from './types'

const ALIAS = z.string().describe('Registered machine alias (its ~/.ssh/config Host name), e.g. "g6e"')

/**
 * Machine failures carry a classified error (kind/message/hint) — return that
 * as data, not a stack trace, so the calling agent can relay the hint to the
 * human instead of trying to fix ssh itself.
 */
async function guarded(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn()
  } catch (err) {
    const info = (err as { info?: unknown }).info
    if (info) return { json: { error: info }, isError: true }
    return { text: (err as Error).message || String(err), isError: true }
  }
}

export const machineTools = [
  defineTool({
    name: 'machines_list',
    title: 'List machines',
    description:
      'Registered remote machines (the allowlist agents may ssh into or be moved to): alias, label, note, default cwd, and the last ' +
      'probe — target user@hostname, OS, remote $HOME and CLI homes, installed claude/codex/tmux versions, best-effort login state, ' +
      'latency, or the classified error (kind + hint for the human).',
    group: 'machines',
    input: {},
    handler: (_args, ctx) => ({ json: ctx.machines.list() })
  }),

  defineTool({
    name: 'machines_suggest',
    title: 'Suggest machines',
    description:
      'Host aliases found in ~/.ssh/config (and its Includes) that could be registered, with hostname/user from `ssh -G` and whether ' +
      'each is already registered. Wildcard and negated patterns are skipped; named aliases come before bare IPs.',
    group: 'machines',
    input: {},
    handler: (_args, ctx) => guarded(async () => ({ json: await ctx.machines.suggest() }))
  }),

  defineTool({
    name: 'machine_add',
    title: 'Add machine',
    description:
      'Register an ssh host alias as a Paper machine, then probe it. The alias must already work with the system ssh ' +
      '(~/.ssh/config, known_hosts, ssh-agent); Paper stores no keys. The machine is registered even if the probe fails — ' +
      'the error and its fix-it hint are on `probe`.',
    group: 'machines',
    input: {
      alias: z.string().describe('ssh host alias, e.g. "g6e" (letters, digits, ".", "_", "-"; not "local")'),
      label: z.string().optional().describe('Display label'),
      note: z.string().optional().describe('One line shown to agents, e.g. "8xL40S GPU box, repos in ~/work"'),
      default_cwd: z.string().optional().describe('Default working directory on the machine (absolute or ~/...)')
    },
    mutates: true,
    handler: (args, ctx) => guarded(async () => ({
      json: await ctx.machines.add({ alias: args.alias, label: args.label, note: args.note, defaultCwd: args.default_cwd })
    }))
  }),

  defineTool({
    name: 'machine_update',
    title: 'Update machine',
    description: 'Change a registered machine\'s label, note or default working directory. Pass "" to clear a field.',
    group: 'machines',
    input: {
      alias: ALIAS,
      label: z.string().optional().describe('Display label'),
      note: z.string().optional().describe('One line shown to agents'),
      default_cwd: z.string().optional().describe('Default working directory on the machine (absolute or ~/...)')
    },
    mutates: true,
    handler: (args, ctx) => guarded(() => ({
      json: ctx.machines.update(args.alias, { label: args.label, note: args.note, defaultCwd: args.default_cwd })
    }))
  }),

  defineTool({
    name: 'machine_remove',
    title: 'Remove machine',
    description:
      'Unregister a machine and close Paper\'s shared ssh connection to it. Agents already running there in tmux are not killed.',
    group: 'machines',
    input: { alias: ALIAS },
    mutates: true,
    handler: (args, ctx) => guarded(async () => {
      await ctx.machines.remove(args.alias)
      return { json: ctx.machines.list() }
    })
  }),

  defineTool({
    name: 'machine_probe',
    title: 'Probe machine',
    description:
      'Check a registered machine over ssh (BatchMode, one round trip): reachability, OS, $HOME, CLI homes, claude/codex/tmux on the ' +
      'login-shell PATH with versions, login state, latency. Failures come back classified (auth, host-key, dns, unreachable, timeout) ' +
      'with a hint for the human — Paper never fixes ssh itself.',
    group: 'machines',
    input: {
      alias: ALIAS,
      max_age_ms: z.number().int().min(0).default(0).describe('Reuse a cached probe younger than this; 0 = always ask the machine')
    },
    mutates: true,
    handler: (args, ctx) => guarded(async () => {
      const probe = await ctx.machines.probe(args.alias, { maxAgeMs: args.max_age_ms })
      return { json: probe, isError: !probe.ok }
    })
  }),

  defineTool({
    name: 'machine_exec',
    title: 'Run on machine',
    description:
      'Run a shell command on a registered machine under its login shell (ssh BatchMode, no tty, no stdin) and return stdout, ' +
      'stderr and the exit code. Refuses unregistered aliases. Output past max_bytes keeps the tail. For long jobs start them ' +
      'detached (`tmux new -d -s name ...` or nohup) and poll.',
    group: 'machines',
    input: {
      alias: ALIAS,
      command: z.string().min(1).describe('POSIX shell command, run as-is by the remote login shell'),
      cwd: z.string().optional().describe('Directory to run in (absolute or ~/...)'),
      timeout_ms: z.number().int().min(1000).max(600_000).default(60_000).describe('Kill the command after this long'),
      max_bytes: z.number().int().min(1000).max(4_000_000).default(100_000).describe('Cap on returned stdout and stderr each')
    },
    mutates: true,
    handler: (args, ctx) => guarded(async () => {
      const r = await ctx.machines.exec(args.alias, args.command, { cwd: args.cwd, timeoutMs: args.timeout_ms, maxBytes: args.max_bytes })
      return { json: r, isError: r.code !== 0 }
    })
  }),

  defineTool({
    name: 'machines_inventory',
    title: 'Machine inventory',
    description:
      'What is actually running on each registered machine, read from the machine itself: Paper\'s tmux sessions ' +
      '(`tmux -L paper`, names paper-*) with Paper session id, provider, conversation id, cwd, title, activity, and whether a ' +
      'local session is attached (unattached ones are adoptable). Polled in the background; `refresh` reads every machine now.',
    group: 'machines',
    input: {
      refresh: z.boolean().default(false).describe('Ask the machines now instead of returning the last poll'),
      alias: z.string().optional().describe('Only this machine')
    },
    handler: (args, ctx) => guarded(async () => ({ json: await ctx.machines.inventory({ refresh: args.refresh, alias: args.alias }) }))
  })
]
