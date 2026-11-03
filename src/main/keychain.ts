import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'

/**
 * Claude Code keeps the *default* login in the macOS Keychain, but reads
 * `<CLAUDE_CONFIG_DIR>/.credentials.json` when a config home is set. Importing
 * therefore means lifting the Keychain item into an account home once.
 * macOS will ask the user to approve the read — that prompt is the point.
 */
const SERVICE = 'Claude Code-credentials'

export function readClaudeKeychain(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', SERVICE, '-a', userInfo().username, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }
    ).trim()
    return out || null
  } catch {
    // Denied, missing, or locked keychain — the caller falls back to /login.
    return null
  }
}

export function keychainHasClaudeLogin(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    execFileSync('/usr/bin/security', ['find-generic-password', '-s', SERVICE], {
      stdio: 'ignore',
      timeout: 10_000
    })
    return true
  } catch {
    return false
  }
}
