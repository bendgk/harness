import { z } from 'zod'
import { defineTool } from './types'
import type { ToolResult } from './types'

/** "No agent @x. Known: …" is an answer for the calling agent, not a stack trace. */
async function plain(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn()
  } catch (err) {
    return { text: (err as Error).message || String(err), isError: true }
  }
}

const NAME = z.string().describe('Agent callsign, e.g. "leonardo" or "@leonardo" (case-insensitive), or a session id')

export const agentTools = [
  defineTool({
    name: 'agents_list',
    title: 'List agents',
    description:
      'Every named Paper agent (Claude Code / Codex root sessions; subagents and shells are not listed), on this Mac and on ' +
      'every machine, attached or detached: callsign, host, provider, status, cwd, title, what it is doing now, its last ' +
      'ask/reply, last tool call and open todos. Pure memory and cheap — call it whenever "@name" comes up. Your own row ' +
      'has `self: true`. Use agent_info for one agent in depth.',
    group: 'agents',
    input: {
      host: z.string().optional().describe('Only agents running here: "local" or a machine alias'),
      include_exited: z.boolean().default(false).describe('Also list agents whose process has exited'),
      from: z.string().optional().describe('Your own session id ($PAPER_SESSION) to mark your row; Paper fills it in for its agents')
    },
    handler: (args, ctx) => ({
      json: ctx.agents.list({ host: args.host, includeExited: args.include_exited, from: args.from })
    })
  }),

  defineTool({
    name: 'agent_info',
    title: 'What an agent is doing',
    description:
      'One agent in depth: status, host, cwd and branch, what it is doing, its last ask and reply, its todo list, files it ' +
      'edited, and its recent exchanges condensed (user asks, agent replies, tool calls as one-liners), oldest first. Works ' +
      'for agents on machines too (a detached one is read from the tail of its transcript there). Output is capped at ' +
      '`max_chars`; agent_transcript pages further back.',
    group: 'agents',
    input: {
      name: NAME,
      turns: z.number().int().min(1).max(50).default(6).describe('How many recent exchanges (a user ask and what followed) to include'),
      max_chars: z.number().int().min(500).max(20_000).default(4000).describe('Hard cap on the output')
    },
    handler: (args, ctx) => plain(async () => ({ text: await ctx.agents.info(args.name, { turns: args.turns, maxChars: args.max_chars }) }))
  }),

  defineTool({
    name: 'agent_transcript',
    title: 'Page through an agent\'s conversation',
    description:
      'Older condensed turns of an agent\'s conversation (user / agent / tool / paper lines, numbered #seq), `limit` at a ' +
      'time, ending before turn `before` (default: the newest). Each page says what `before` to pass for the next one.',
    group: 'agents',
    input: {
      name: NAME,
      before: z.number().int().min(0).optional().describe('Return turns numbered below this (from a previous page or agent_info)'),
      limit: z.number().int().min(1).max(200).default(30).describe('Turns per page')
    },
    handler: (args, ctx) => plain(async () => ({ text: await ctx.agents.transcript(args.name, { before: args.before, limit: args.limit }) }))
  }),

  defineTool({
    name: 'agent_rename',
    title: 'Rename an agent',
    description:
      'Give a live agent a different callsign: 2–16 lowercase letters/digits starting with a letter, not "local", and not ' +
      'already an agent\'s callsign or a machine alias. The name follows the session through handoffs and restarts; on a ' +
      'machine it is also written to the tmux session\'s @paper_name tag.',
    group: 'agents',
    input: {
      name_or_id: NAME,
      new_name: z.string().describe('The new callsign, e.g. "hypatia"')
    },
    mutates: true,
    handler: (args, ctx) => plain(() => ({ json: ctx.agents.rename(args.name_or_id, args.new_name) }))
  })
]
