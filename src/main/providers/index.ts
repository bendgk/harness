import { claudeProvider } from './claude'
import { codexProvider } from './codex'
import { shellProvider } from './shell'
import type { Provider } from './types'
import type { ProviderId } from '@shared/types'

export const providers: Record<ProviderId, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
  shell: shellProvider
}

/** Providers that run an agent, and so have accounts and transcripts. */
export const AGENT_PROVIDERS = ['claude', 'codex'] as const

export function isAgent(id: ProviderId): boolean {
  return id !== 'shell'
}

export function providerFor(id: ProviderId): Provider {
  return providers[id]
}
export type { Provider, RemotePlan, SpawnPlan, TranscriptRead } from './types'
