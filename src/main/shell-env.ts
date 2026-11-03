import { execFileSync } from 'node:child_process'

let cached: Record<string, string> | null = null

/**
 * A GUI app launched from Finder inherits a bare PATH, so `claude` and `codex`
 * would not be found. Resolve the user's real login-shell environment once.
 */
export function shellEnv(): Record<string, string> {
  if (cached) return cached
  const base = { ...process.env } as Record<string, string>
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const raw = execFileSync(shell, ['-ilc', 'command env -0'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    for (const entry of raw.split('\0')) {
      const eq = entry.indexOf('=')
      if (eq > 0) base[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
  } catch {
    // Fall back to the inherited environment; PATH may still be workable.
    base.PATH = [base.PATH, '/opt/homebrew/bin', '/usr/local/bin', `${base.HOME}/.local/bin`]
      .filter(Boolean)
      .join(':')
  }
  cached = base
  return base
}

/**
 * Variables that must never reach a spawned agent.
 *
 * Paper may itself be launched from inside an agent session, and those sessions
 * export markers (CLAUDE_CODE_CHILD_SESSION and friends) that switch transcript
 * saving off — which would silently break usage tracking and account handoff,
 * since both read the CLI's own transcript. Inherited API keys are dropped for a
 * second reason: they override the account's stored login, so a session could
 * quietly run as the wrong identity.
 */
const SCRUB_PREFIXES = ['CLAUDE_CODE_', 'CODEX_', 'CLAUDE_CONFIG_']
const SCRUB_EXACT = [
  'CLAUDECODE',
  'CLAUDE_CODE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENTRYPOINT'
]

/** A clean base environment for a freshly spawned agent. */
export function agentEnv(): Record<string, string> {
  const env = { ...shellEnv() }
  for (const key of Object.keys(env)) {
    if (SCRUB_EXACT.includes(key) || SCRUB_PREFIXES.some((p) => key.startsWith(p))) delete env[key]
  }
  return env
}

/** Resolve a CLI on the login PATH, so we can report a clear error if missing. */
export function which(bin: string): string | null {
  try {
    const out = execFileSync('/usr/bin/env', ['which', bin], {
      encoding: 'utf8',
      env: shellEnv(),
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.trim() || null
  } catch {
    return null
  }
}
