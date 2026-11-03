import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { STATE_FILE, ensureDirs } from './paths'
import type { Account, AgentProviderId, Machine, Tab, WidgetPrefs, ProviderId } from '@shared/types'

export interface Persisted {
  accounts: Account[]
  tabs: Tab[]
  activeTabId: string | null
  defaults: {
    provider: ProviderId
    cwd: string
    accountByProvider: Partial<Record<AgentProviderId, string>>
    /**
     * After a restart, tell an agent that was mid-turn to carry on (persist.ts).
     * Absent means true: state files written before this field existed.
     */
    resumeNudge?: boolean
  }
  widgets: WidgetPrefs
  recentDirs: string[]
  /** Registered remote machines (the allowlist agents may use). */
  machines: Machine[]
  /** Loopback port of the remote-agent gateway (gateway.ts); stable so tunnels and configs survive restarts. */
  gatewayPort?: number
}

const EMPTY: Persisted = {
  accounts: [],
  tabs: [],
  activeTabId: null,
  defaults: { provider: 'claude', cwd: process.env.HOME || '/', accountByProvider: {}, resumeNudge: true },
  widgets: { enabled: ['usage', 'context', 'limits', 'burn', 'pet', 'clock'], petName: 'Inky' },
  recentDirs: [],
  machines: []
}

let state: Persisted = { ...EMPTY }

export function loadState(): Persisted {
  ensureDirs()
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    // Defaults merge one level deep so a field added later (resumeNudge) gets its default.
    state = { ...EMPTY, ...saved, defaults: { ...EMPTY.defaults, ...saved?.defaults } }
  } catch {
    state = { ...EMPTY }
  }
  return state
}

export function getState(): Persisted {
  return state
}

/** Keep a short, de-duplicated trail of directories for the location bar. */
export function rememberDir(dir: string): string[] {
  const recentDirs = [dir, ...state.recentDirs.filter((d) => d !== dir)].slice(0, 12)
  saveState({ recentDirs })
  return recentDirs
}

let flushTimer: NodeJS.Timeout | null = null

/** Debounced atomic write — layout changes fire on every drag. */
export function saveState(patch: Partial<Persisted> = {}): void {
  state = { ...state, ...patch }
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(flush, 250)
}

export function flush(): void {
  try {
    ensureDirs()
    const tmp = `${STATE_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, STATE_FILE)
  } catch (err) {
    console.error('[store] failed to persist state', err)
  }
}
