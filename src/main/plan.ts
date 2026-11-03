/**
 * Plan usage: the numbers Claude Code's `/usage` shows — current session,
 * current week, and any model-scoped week — per account.
 *
 * Claude transcripts carry no rate-limit data, so this asks the same endpoint
 * `/usage` does (`GET api.anthropic.com/api/oauth/usage`) with the account's
 * own OAuth token. Rules that keep that safe:
 * - The token is read fresh from where Claude Code keeps it (the macOS
 *   Keychain item `Claude Code-credentials[-<sha256(home)[:8]>]`, else
 *   `<home>/.credentials.json`) for each request, used once, and dropped. It
 *   is never cached, logged, put in an event, or sent anywhere but Anthropic.
 * - Paper never refreshes a token. A refresh rotates the refresh token and
 *   would sign the running Claude Code out; an expired token is reported
 *   ("use this account to refresh it") and Claude Code renews it on its own.
 * - Only percentages, reset times and labels leave this module.
 *
 * Codex accounts report their windows in their own transcripts; those are
 * mapped onto the same shape from the live usage snapshots.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { kernel } from './kernel'
import { listAccounts } from './accounts'
import { SYSTEM_CLAUDE_HOME } from './paths'
import type { Account, PlanUsage, PlanWindow, UsageSnapshot } from '@shared/types'

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const FOCUSED_MS = 60_000
const BACKGROUND_MS = 5 * 60_000

interface PlanSlot {
  byAccount: Map<string, PlanUsage>
  /** Earliest time each account may be asked again (429 / failures back off). */
  notBefore: Map<string, number>
}

function slot(): PlanSlot {
  return kernel().slot<PlanSlot>('plan', () => ({ byAccount: new Map(), notBefore: new Map() }))
}

// ---- credentials -------------------------------------------------------------------

/** Claude Code's Keychain service for a config home: bare for the default home, hashed otherwise. */
export function keychainService(home: string): string {
  if (home === SYSTEM_CLAUDE_HOME && !process.env.CLAUDE_CONFIG_DIR) return 'Claude Code-credentials'
  return `Claude Code-credentials-${createHash('sha256').update(home).digest('hex').slice(0, 8)}`
}

function readKeychain(service: string): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 15_000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null)
    })
  })
}

interface OAuth { accessToken: string; expiresAt?: number }

async function readOAuth(account: Account): Promise<OAuth | null> {
  const parse = (raw: string | null): OAuth | null => {
    if (!raw) return null
    try {
      const o = JSON.parse(raw)?.claudeAiOauth
      return o && typeof o.accessToken === 'string' ? { accessToken: o.accessToken, expiresAt: o.expiresAt } : null
    } catch {
      return null
    }
  }
  const fromKeychain = parse(await readKeychain(keychainService(account.home)))
  if (fromKeychain) return fromKeychain
  const file = join(account.home, '.credentials.json')
  try { return existsSync(file) ? parse(readFileSync(file, 'utf8')) : null } catch { return null }
}

// ---- the endpoint ------------------------------------------------------------------

const ts = (s: unknown): number | undefined => {
  const n = typeof s === 'string' ? Date.parse(s) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** Map the endpoint's response onto windows, named the way `/usage` names them. Exported for tests. */
export function parsePlan(body: any): PlanWindow[] {
  const out: PlanWindow[] = []
  if (Array.isArray(body?.limits)) {
    for (const l of body.limits) {
      const percent = Number(l?.percent)
      if (!Number.isFinite(percent)) continue
      const base = { percent, resetsAt: ts(l.resets_at), severity: typeof l.severity === 'string' ? l.severity : undefined }
      if (l.kind === 'session') out.push({ kind: 'session', label: 'Current session', ...base })
      else if (l.kind === 'weekly_all') out.push({ kind: 'weekly', label: 'Current week (all models)', ...base })
      else if (l.kind === 'weekly_scoped') {
        const scope = l.scope?.model?.display_name || l.scope?.surface?.display_name || l.scope?.surface || 'scoped'
        out.push({ kind: 'weekly_scoped', label: `Current week (${String(scope)})`, ...base })
      }
    }
    if (out.length) return out
  }
  // Older shape: fixed windows with `utilization`.
  const win = (o: any): { percent: number; resetsAt?: number } | null =>
    o && Number.isFinite(Number(o.utilization)) ? { percent: Number(o.utilization), resetsAt: ts(o.resets_at) } : null
  const five = win(body?.five_hour)
  const week = win(body?.seven_day)
  if (five) out.push({ kind: 'session', label: 'Current session', ...five })
  if (week) out.push({ kind: 'weekly', label: 'Current week (all models)', ...week })
  for (const [key, name] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']] as const) {
    const w = win(body?.[key])
    if (w) out.push({ kind: 'weekly_scoped', label: `Current week (${name})`, ...w })
  }
  return out
}

async function fetchClaude(account: Account): Promise<PlanUsage> {
  const base = { accountId: account.id, provider: account.provider, at: Date.now() }
  const oauth = await readOAuth(account)
  if (!oauth) {
    return { ...base, ok: false, windows: [], error: 'No Claude login found for this account. Sign in from Accounts (⌘,).' }
  }
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    return { ...base, ok: false, windows: [], error: 'Login token expired. Use this account in a Claude session and it renews itself.' }
  }
  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'User-Agent': 'paper-harness'
      },
      signal: AbortSignal.timeout(15_000)
    })
  } catch (err) {
    return { ...base, ok: false, windows: [], error: `Could not reach Anthropic (${(err as Error).name === 'TimeoutError' ? 'timed out' : 'network error'}).` }
  }
  if (res.status === 401 || res.status === 403) {
    return { ...base, ok: false, windows: [], error: 'Anthropic rejected this login. Sign in again from Accounts (⌘,).' }
  }
  if (res.status === 429) {
    slot().notBefore.set(account.id, Date.now() + 5 * 60_000)
    return { ...base, ok: false, windows: [], error: 'Rate-limited by Anthropic; trying again in a few minutes.' }
  }
  if (!res.ok) return { ...base, ok: false, windows: [], error: `Anthropic returned ${res.status}.` }
  let body: unknown
  try { body = await res.json() } catch { return { ...base, ok: false, windows: [], error: 'Unreadable response from Anthropic.' } }
  const windows = parsePlan(body)
  return windows.length
    ? { ...base, ok: true, windows }
    : { ...base, ok: false, windows: [], error: 'This plan reports no usage limits.' }
}

/** Codex: the windows its own transcripts report, from the freshest live session on that account. */
function codexPlan(account: Account, snapshots: UsageSnapshot[], accountOf: (sessionId: string) => string | undefined): PlanUsage | null {
  const fresh = snapshots
    .filter((u) => u.limits?.length && accountOf(u.sessionId) === account.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (!fresh) return null
  const windows: PlanWindow[] = fresh.limits!.map((l) => ({
    kind: l.windowMinutes <= 600 ? 'session' : 'weekly',
    label: l.windowMinutes <= 600 ? 'Current session' : 'Current week',
    percent: l.usedPercent,
    resetsAt: l.resetsAt
  }))
  return { accountId: account.id, provider: account.provider, at: fresh.updatedAt, ok: true, windows }
}

// ---- service ----------------------------------------------------------------------

export interface PlanDeps {
  snapshots(): UsageSnapshot[]
  accountOf(sessionId: string): string | undefined
}

function broadcast(p: PlanUsage): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('plan:update', p)
  }
}

let inflight: Promise<PlanUsage[]> | null = null

/** Every account's plan usage. Cached; `refresh` asks Anthropic again (respecting back-off). */
export async function planUsage(deps: PlanDeps, opts: { refresh?: boolean } = {}): Promise<PlanUsage[]> {
  const s = slot()
  if (opts.refresh || !s.byAccount.size) {
    inflight ??= poll(deps).finally(() => { inflight = null })
    await inflight
  }
  return [...s.byAccount.values()]
}

async function poll(deps: PlanDeps): Promise<PlanUsage[]> {
  const s = slot()
  const accounts = listAccounts()
  for (const id of [...s.byAccount.keys()]) if (!accounts.some((a) => a.id === id)) s.byAccount.delete(id)
  for (const account of accounts) {
    let next: PlanUsage | null
    if (account.provider === 'claude') {
      if ((s.notBefore.get(account.id) ?? 0) > Date.now()) continue
      next = await fetchClaude(account)
      // A transient failure should not wipe good numbers: keep them, flag the error.
      const prev = s.byAccount.get(account.id)
      if (!next.ok && prev?.ok && !/rejected|No Claude login|expired/.test(next.error ?? '')) {
        next = { ...prev, stale: true, error: next.error }
      }
    } else {
      next = codexPlan(account, deps.snapshots(), deps.accountOf)
    }
    if (!next) continue
    s.byAccount.set(account.id, next)
    broadcast(next)
  }
  return [...s.byAccount.values()]
}

/** Poll on a cadence: every minute while a window is focused, every five otherwise. Returns the stop function. */
export function startPlanPoller(deps: PlanDeps): () => void {
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  const focused = (): boolean => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())
  const tick = async (): Promise<void> => {
    if (stopped) return
    try { await planUsage(deps, { refresh: true }) } catch (err) { console.warn('[plan] poll failed', (err as Error).message) }
    if (!stopped) timer = setTimeout(tick, focused() ? FOCUSED_MS : BACKGROUND_MS)
  }
  timer = setTimeout(tick, 1_500)
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
