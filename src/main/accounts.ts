import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, rmSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { accountHome, SYSTEM_CLAUDE_HOME, SYSTEM_CODEX_HOME, ensureDirs } from './paths'
import { keychainHasClaudeLogin, readClaudeKeychain } from './keychain'
import { getState, saveState } from './store'
import type { Account, AgentProviderId, ProviderId } from '@shared/types'

const ACCENTS = ['#c2410c', '#0f766e', '#4338ca', '#a16207', '#9d174d', '#3f6212']

/**
 * Files that carry a login. With a config home set, Claude Code reads
 * `.credentials.json` from it (verified on macOS 26); Codex uses `auth.json`.
 */
const CREDENTIAL_FILES: Record<AgentProviderId, string[]> = {
  claude: ['.credentials.json'],
  codex: ['auth.json']
}

/** Config worth inheriting from the system home when creating an account. */
const CONFIG_FILES: Record<AgentProviderId, string[]> = {
  claude: ['settings.json', 'CLAUDE.md', 'commands', 'agents', 'plugins', 'skills'],
  codex: ['config.toml', 'AGENTS.md', 'prompts', 'hooks.json']
}

export function systemHome(provider: AgentProviderId): string {
  return provider === 'claude' ? SYSTEM_CLAUDE_HOME : SYSTEM_CODEX_HOME
}

export function listAccounts(): Account[] {
  return getState().accounts.map((a) => ({ ...a, authed: isAuthed(a) }))
}

/** A login exists if a credential file is present, or the config names an account. */
export function isAuthed(account: Account): boolean {
  if (CREDENTIAL_FILES[account.provider].some((f) => existsSync(join(account.home, f)))) return true
  if (account.provider === 'claude') return Boolean(claudeOauth(account.home))
  return false
}

/** Claude Code records the signed-in identity in `<home>/.claude.json`. */
function claudeOauth(home: string): { emailAddress?: string } | undefined {
  try {
    const json = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    return json?.oauthAccount
  } catch {
    return undefined
  }
}

export function getAccount(id: string): Account | undefined {
  return getState().accounts.find((a) => a.id === id)
}

export function defaultAccountFor(provider: ProviderId): Account | undefined {
  if (provider === 'shell') return undefined
  const { defaults, accounts } = getState()
  const pinned = defaults.accountByProvider[provider]
  const byPin = pinned ? accounts.find((a) => a.id === pinned) : undefined
  if (byPin) return byPin
  return accounts.find((a) => a.provider === provider && isAuthed(a)) ||
    accounts.find((a) => a.provider === provider)
}

interface CreateOpts {
  provider: AgentProviderId
  label: string
  /** Copy the user's existing system login into this account. */
  adoptSystem?: boolean
  /** Copy config (not credentials) from this existing account. */
  inheritFrom?: string
}

export function createAccount(opts: CreateOpts): Account {
  ensureDirs()
  const id = randomUUID().slice(0, 8)
  const home = accountHome(id)
  mkdirSync(home, { recursive: true })

  const source = opts.inheritFrom ? getAccount(opts.inheritFrom)?.home : systemHome(opts.provider)
  if (source && existsSync(source)) {
    // Config always; credentials only when explicitly adopting the system login.
    const files = [
      ...CONFIG_FILES[opts.provider],
      ...(opts.adoptSystem ? CREDENTIAL_FILES[opts.provider] : [])
    ]
    for (const f of files) copyIfPresent(join(source, f), join(home, f))
  }
  const imported = opts.adoptSystem ? importSystemLogin(opts.provider, home) : false

  // Claude keeps its per-user config beside HOME, not inside the config home.
  // It is worth inheriting for settings and MCP servers, but it also names the
  // signed-in identity — which must not travel to an account holding no
  // credentials, or the account would claim to be logged in when it is not.
  if (opts.provider === 'claude' && !opts.inheritFrom) {
    copyIfPresent(join(homedir(), '.claude.json'), join(home, '.claude.json'))
    if (!imported) stripIdentity(join(home, '.claude.json'))
  }

  const accounts = getState().accounts
  const account: Account = {
    id,
    provider: opts.provider,
    label: opts.label,
    home,
    color: ACCENTS[accounts.length % ACCENTS.length],
    createdAt: Date.now()
  }
  saveState({ accounts: [...accounts, account] })
  return { ...account, authed: isAuthed(account) }
}

/**
 * Bring an existing system login into an isolated home. Codex stores a file we
 * can copy; Claude's default login lives in the Keychain, so it is lifted out
 * into the home's `.credentials.json` (macOS prompts for approval).
 */
export function importSystemLogin(provider: AgentProviderId, home: string): boolean {
  if (provider === 'codex') {
    const from = join(systemHome('codex'), 'auth.json')
    if (!existsSync(from)) return false
    copyIfPresent(from, join(home, 'auth.json'))
    return existsSync(join(home, 'auth.json'))
  }
  const secret = readClaudeKeychain()
  if (!secret) return false
  try {
    writeFileSync(join(home, '.credentials.json'), secret, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** Whether an importable system login exists for this provider right now. */
export function systemLoginAvailable(provider: AgentProviderId): boolean {
  return provider === 'codex'
    ? existsSync(join(systemHome('codex'), 'auth.json'))
    : keychainHasClaudeLogin()
}

/** Remove the signed-in identity from an inherited Claude config. */
function stripIdentity(configPath: string): void {
  try {
    if (!existsSync(configPath)) return
    const json = JSON.parse(readFileSync(configPath, 'utf8'))
    delete json.oauthAccount
    delete json.userID
    delete json.hasAvailableSubscription
    writeFileSync(configPath, JSON.stringify(json, null, 2))
  } catch {
    // A config we cannot parse is safer removed than left claiming an identity.
    try { rmSync(configPath, { force: true }) } catch { /* best effort */ }
  }
}

function copyIfPresent(from: string, to: string): void {
  try {
    if (!existsSync(from)) return
    cpSync(from, to, { recursive: statSync(from).isDirectory(), force: true })
  } catch (err) {
    console.warn('[accounts] copy skipped', from, (err as Error).message)
  }
}

export function renameAccount(id: string, label: string): Account[] {
  const accounts = getState().accounts.map((a) => (a.id === id ? { ...a, label } : a))
  saveState({ accounts })
  return listAccounts()
}

export function removeAccount(id: string, deleteFiles: boolean): Account[] {
  const account = getAccount(id)
  if (account && deleteFiles) {
    try { rmSync(account.home, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  saveState({ accounts: getState().accounts.filter((a) => a.id !== id) })
  return listAccounts()
}

export function setDefaultAccount(provider: AgentProviderId, accountId: string): void {
  const defaults = getState().defaults
  saveState({ defaults: { ...defaults, accountByProvider: { ...defaults.accountByProvider, [provider]: accountId } } })
}

/** Clear the login but keep settings — the account is then ready for a fresh `/login`. */
export function signOut(id: string): Account[] {
  const account = getAccount(id)
  if (account) {
    for (const f of CREDENTIAL_FILES[account.provider]) {
      try { rmSync(join(account.home, f), { force: true }) } catch { /* best effort */ }
    }
  }
  return listAccounts()
}

/** Best-effort read of the identity a home is signed into, for the account chip. */
export function describeAccount(account: Account): string | undefined {
  if (account.provider === 'claude') {
    const oauth = claudeOauth(account.home)
    if (oauth?.emailAddress) return oauth.emailAddress
  }
  for (const f of CREDENTIAL_FILES[account.provider]) {
    const p = join(account.home, f)
    if (!existsSync(p)) continue
    try {
      const json = JSON.parse(readFileSync(p, 'utf8'))
      const email =
        json?.tokens?.account?.email ??
        json?.account?.email ??
        json?.claudeAiOauth?.emailAddress
      const plan =
        json?.claudeAiOauth?.subscriptionType ??
        json?.tokens?.account?.planType ??
        json?.plan_type
      const text = [email, plan].filter(Boolean).join(' \u00b7 ')
      if (text) return text
    } catch { /* unreadable credential is fine */ }
  }
  return undefined
}

/**
 * First run: give every installed provider an account so a session can start
 * immediately. A login is adopted when that costs nothing (Codex's file); for
 * Claude the pane simply shows the CLI's own "run /login" prompt, which the
 * Accounts sheet can also do for you.
 */
export function bootstrapAccounts(): Account[] {
  const existing = getState().accounts
  if (existing.length) return listAccounts()
  for (const provider of ['claude', 'codex'] as AgentProviderId[]) {
    createAccount({
      provider,
      label: 'default',
      adoptSystem: provider === 'codex' && systemLoginAvailable('codex')
    })
  }
  return listAccounts()
}
