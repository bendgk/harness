import { z } from 'zod'
import { defineTool } from './types'

export const stateTools = [
  defineTool({
    name: 'state_get',
    title: 'Persisted state',
    description:
      'What Paper has saved to ~/.paper/state.json: saved tabs and pane layouts, defaults (provider, cwd, default account per provider), ' +
      'widget prefs and recent directories. Accounts are listed via accounts_list.',
    group: 'state',
    input: { path: z.string().optional().describe('Dot path into the state, e.g. "defaults.cwd"') },
    handler: (args, ctx) => {
      const { accounts: _accounts, ...state } = ctx.getState()
      let value: unknown = state
      for (const key of (args.path ?? '').split('.').filter(Boolean)) value = (value as Record<string, unknown>)?.[key]
      return { json: value ?? null }
    }
  }),

  defineTool({
    name: 'state_set_defaults',
    title: 'Set defaults',
    description: 'Change the default provider, working directory, or pinned account per provider for new sessions.',
    group: 'state',
    input: {
      provider: z.enum(['claude', 'codex', 'shell']).optional(),
      cwd: z.string().optional().describe('Absolute directory'),
      account_by_provider: z.record(z.string(), z.string()).optional().describe('e.g. {"claude": "<account id>"}')
    },
    mutates: true,
    handler: (args, ctx) => {
      const current = ctx.getState().defaults
      const defaults = {
        ...current,
        ...(args.provider ? { provider: args.provider } : {}),
        ...(args.cwd ? { cwd: args.cwd } : {}),
        ...(args.account_by_provider ? { accountByProvider: { ...current.accountByProvider, ...args.account_by_provider } } : {})
      }
      ctx.saveState({ defaults })
      return { json: defaults }
    }
  }),

  defineTool({
    name: 'accounts_list',
    title: 'List accounts',
    description: 'Configured logins per provider: id, label, isolated config home, whether a credential is present, and the identity/plan if readable.',
    group: 'state',
    input: {},
    handler: (_args, ctx) => ({ json: ctx.accounts() })
  })
]
