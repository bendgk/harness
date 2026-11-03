import { LOCAL_HOST, type Machine, type ProviderId } from '@shared/types'

/** Same rule main enforces: an ssh-config-shaped alias, never the reserved local sentinel. */
export const ALIAS_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/

/** Why an alias cannot be registered, or null when it can. */
export function aliasProblem(alias: string, taken: string[] = []): string | null {
  const a = alias.trim().replace(/^@/, '')
  if (!a) return 'Type an ssh host alias'
  if (a.toLowerCase() === LOCAL_HOST) return '"local" is reserved for this Mac'
  if (!ALIAS_RE.test(a)) return 'Letters, digits, . _ - only (as in ~/.ssh/config)'
  if (taken.includes(a)) return `@${a} is already registered`
  return null
}

export type MachineHealth = 'ok' | 'degraded' | 'error' | 'unknown'

/**
 * Reachable with every tool is "ok"; reachable but missing tmux or both agent
 * CLIs is "degraded" — sessions there would fail at launch, so say so early.
 */
export function machineHealth(m: Machine | undefined): MachineHealth {
  const p = m?.probe
  if (!p) return 'unknown'
  if (!p.ok) return 'error'
  if (!p.tools.tmux || (!p.tools.claude && !p.tools.codex)) return 'degraded'
  return 'ok'
}

/** What is missing on a reachable machine, phrased for a tooltip. */
export function missingTools(m: Machine): string[] {
  const t = m.probe?.tools ?? {}
  const out: string[] = []
  if (!t.tmux) out.push('tmux')
  if (!t.claude) out.push('claude')
  if (!t.codex) out.push('codex')
  return out
}

/** Whether `provider` can be launched on `m`, and if not, the reason to show. */
export function canLaunch(m: Machine | undefined, provider: ProviderId | 'any' = 'any'): { ok: boolean; reason?: string } {
  if (!m) return { ok: false, reason: 'Not a registered machine' }
  const p = m.probe
  if (!p) return { ok: true }
  if (!p.ok) return { ok: false, reason: p.error?.message ?? 'Last ssh test failed' }
  if (!p.tools.tmux) return { ok: false, reason: `tmux is not installed on @${m.alias}` }
  if (provider === 'claude' && !p.tools.claude) return { ok: false, reason: `Claude Code is not installed on @${m.alias}` }
  if (provider === 'codex' && !p.tools.codex) return { ok: false, reason: `Codex is not installed on @${m.alias}` }
  return { ok: true }
}

/** "ben@10.0.0.4" (with :port only when it is not 22). */
export function targetLabel(m: Machine): string | undefined {
  const t = m.probe?.target
  if (!t) return undefined
  return `${t.user ? `${t.user}@` : ''}${t.hostname}${t.port && t.port !== 22 ? `:${t.port}` : ''}`
}

/** The tools a machine offers, compactly: "claude · codex · tmux". */
export function toolsHint(m: Machine): string {
  const t = m.probe?.tools
  if (!t) return 'not tested yet'
  if (!m.probe?.ok) return 'unreachable'
  const have = (['claude', 'codex', 'tmux'] as const).filter((k) => t[k])
  return have.length ? have.join(' · ') : 'no agent CLIs'
}

/** A short version string out of whatever the probe reported ("2.0.31 (Claude Code)" → "2.0.31"). */
export function shortVersion(v?: string): string {
  if (!v) return ''
  const m = v.match(/\d+(\.\d+)+[\w.-]*/)
  return m ? m[0] : v.split(/\s+/)[0].slice(0, 18)
}

/**
 * Rank machines for an @-mention query: alias prefix first, then alias
 * substring, then label/hostname substring. Case-insensitive; the empty query
 * lists everything in registration order.
 */
export function rankMachines(query: string, machines: Machine[]): Machine[] {
  const q = query.toLowerCase()
  if (!q) return machines.slice()
  const scored: { m: Machine; s: number; i: number }[] = []
  machines.forEach((m, i) => {
    const a = m.alias.toLowerCase()
    const extra = `${m.label ?? ''} ${m.probe?.target?.hostname ?? ''}`.toLowerCase()
    // Labels and hostnames only count once the query is specific enough to mean them.
    const s = a.startsWith(q) ? 0 : a.includes(q) ? 1 : q.length >= 2 && extra.includes(q) ? 2 : -1
    if (s >= 0) scored.push({ m, s, i })
  })
  return scored.sort((x, y) => x.s - y.s || x.i - y.i).map((x) => x.m)
}

/** The keystrokes that turn a typed `@query` into `@alias ` in a line editor. */
export function completionKeys(query: string, alias: string): string {
  // A plain prefix only needs its tail typed; anything else (a different case,
  // a substring hit) is erased and retyped so the CLI sees exactly the alias.
  if (alias.startsWith(query)) return `${alias.slice(query.length)} `
  return `${'\x7f'.repeat(query.length)}${alias} `
}

/** Regex matching `@alias` for the given aliases on word boundaries. Group 1 is the alias. */
export function mentionRegex(aliases: string[]): RegExp | null {
  if (!aliases.length) return null
  const alts = aliases
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((a) => a.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'))
    .join('|')
  // Not preceded by a word char (so user@host is left alone), and not followed
  // by more alias characters — a trailing full stop is punctuation, not part of it.
  return new RegExp(`(?<![A-Za-z0-9_.@-])@(${alts})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_])`, 'g')
}

/** "4s ago", "3m ago", "2h ago" — for "checked …" and "last probed …". */
export function ago(ts?: number, now = Date.now()): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** Electron prefixes rejected invokes with its own plumbing; people only need the message. */
export function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}

/** Main sends "message\nhint" (or "message — hint:"); split it so the hint can stand out. */
export function splitHint(text: string): { message: string; hint?: string } {
  const nl = text.indexOf('\n')
  if (nl > 0) return { message: text.slice(0, nl).trim(), hint: text.slice(nl + 1).trim() || undefined }
  const m = text.match(/^(.*?)\s+[—–]\s+(?:hint:\s*)?(.+)$/i)
  if (m && m[2].length > 12) return { message: m[1], hint: m[2] }
  return { message: text }
}

export const isRemote = (host?: string): boolean => !!host && host !== LOCAL_HOST
