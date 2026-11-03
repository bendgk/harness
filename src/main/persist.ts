/**
 * Sessions survive Paper restarts.
 *
 * `~/.paper/sessions.json` is a registry of every session the manager holds:
 * the full SessionMeta plus what it takes to bring the session back (was it
 * mid-turn, when was it last active, its terminal size). It is rewritten,
 * coalesced, ~200 ms after any meaningful change, so even a SIGKILLed Paper
 * leaves a registry that says which agents were working. On the next *cold*
 * start `restoreOnce()` puts every record back under its old id — tabs in
 * state.json point at those ids, so panes re-bind untouched — and relaunches:
 *
 *   local agent with a transcript   → `--resume` the same conversation (+ nudge if it was mid-turn)
 *   local agent never prompted      → fresh start in the same cwd/account
 *   remote session                  → start({ reattach }) — tmux kept the agent alive
 *   shell                           → new login shell in the last cwd, old output replayed dimmed
 *   anything that cannot come back  → `exited`, with a notice saying why
 *
 * Only shells get scrollback on disk (`~/.paper/scrollback/<id>.log`, 0600):
 * an agent's `--resume` redraws its own conversation, and agent output is the
 * likelier place for a pasted secret to sit.
 */
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAPER_HOME } from './paths'
import { kernel } from './kernel'
import { sessionManager, sleepSync, type Session } from './sessions'
import { isAgent, providerFor } from './providers'
import { getAccount } from './accounts'
import { getState } from './store'
import { LOCAL_HOST, type ProviderId, type SessionMeta } from '@shared/types'

export const SESSIONS_FILE = join(PAPER_HOME, 'sessions.json')
export const SCROLLBACK_DIR = join(PAPER_HOME, 'scrollback')

/** Registry writes are coalesced, not debounced: a busy pane must not starve them. */
const WRITE_AFTER_MS = 200
const SCROLLBACK_AFTER_MS = 1000
const SCROLLBACK_CAP = 200_000
/** How long a resumed agent must sit idle before the nudge is typed. */
const NUDGE_SETTLE_MS = 2000
const NUDGE_GIVE_UP_MS = 90_000
const ORPHAN_GRACE_MS = 1500

export const RESUME_NUDGE = 'Paper restarted while you were working. Continue exactly where you left off.'

export interface PersistedSession {
  meta: SessionMeta
  /** Status at the last write was `working`: the agent was mid-turn. */
  wasWorking: boolean
  /** Last pty output or keystroke-driven activity (epoch ms). */
  lastActiveAt: number
  cols: number
  rows: number
  /** Shells: the directory the shell itself was in (it can `cd` without Paper knowing). */
  liveCwd?: string
}

export interface SessionRegistry {
  version: 1
  savedAt: number
  /** Pid of the Paper that wrote it. */
  pid: number
  /** Set by a graceful quit; absent after a crash. */
  quitAt?: number
  sessions: PersistedSession[]
}

export type RestoreOutcome = 'resumed' | 'fresh' | 'reattached' | 'shell' | 'exited' | 'failed'

export interface RestoreReport {
  at: number
  /** Whether the previous run quit cleanly (false = crash or SIGKILL). */
  cleanQuit: boolean
  sessions: { id: string; provider: ProviderId; host: string; outcome: RestoreOutcome; detail?: string; nudge?: boolean }[]
  /** Leftover CLI processes from the previous run that were terminated before resuming. */
  orphans: { pid: number; sessionId: string; command: string; killed: boolean }[]
}

/**
 * Survives hot swaps. `restored` is what makes restore a cold-start-only
 * event: the first generation sets it, every later generation sees it set.
 * `writable` stays false until restore has run, so nothing can overwrite the
 * registry with an empty session table before the records are back.
 */
const st = kernel().slot('restore', () => ({
  restored: false,
  writable: false,
  frozen: false,
  report: null as RestoreReport | null,
  lastActive: new Map<string, number>(),
  liveCwd: new Map<string, string>()
}))

let writeTimer: NodeJS.Timeout | null = null
let scrollTimer: NodeJS.Timeout | null = null
const dirtyScroll = new Set<string>()

// ---- writing ------------------------------------------------------------

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  // `mode` only applies when the file is created; a leftover tmp keeps its own.
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

function record(s: Session): PersistedSession {
  const { meta } = s
  const working = meta.status === 'working'
  const lastActiveAt = working ? Date.now() : st.lastActive.get(meta.id) ?? meta.createdAt
  return {
    meta: { ...meta },
    wasWorking: working,
    lastActiveAt,
    cols: s.cols,
    rows: s.rows,
    liveCwd: meta.provider === 'shell' ? st.liveCwd.get(meta.id) : undefined
  }
}

function writeRegistry(extra: Partial<SessionRegistry> = {}): void {
  if (!st.writable || st.frozen) return
  const sessions = sessionManager.list().flatMap((m) => {
    const s = sessionManager.get(m.id)
    return s ? [record(s)] : []
  })
  const registry: SessionRegistry = { version: 1, savedAt: Date.now(), pid: process.pid, ...extra, sessions }
  try {
    mkdirSync(PAPER_HOME, { recursive: true })
    writeAtomic(SESSIONS_FILE, JSON.stringify(registry, null, 2))
  } catch (err) {
    console.error('[persist] failed to write session registry', err)
  }
  pruneScrollback(new Set(sessions.map((r) => r.meta.id)))
}

function scheduleWrite(): void {
  if (writeTimer || !st.writable || st.frozen) return
  writeTimer = setTimeout(() => { writeTimer = null; writeRegistry() }, WRITE_AFTER_MS)
}

/** Keep the replayable tail of a shell; start at a line boundary so no escape is cut in half. */
function writeScrollback(id: string): void {
  const s = sessionManager.get(id)
  if (!s || s.meta.provider !== 'shell') return
  let text = s.buffer
  if (text.length > SCROLLBACK_CAP) {
    text = text.slice(-SCROLLBACK_CAP)
    const nl = text.indexOf('\n')
    if (nl >= 0) text = text.slice(nl + 1)
  }
  try {
    mkdirSync(SCROLLBACK_DIR, { recursive: true, mode: 0o700 })
    writeAtomic(join(SCROLLBACK_DIR, `${id}.log`), text)
  } catch (err) {
    console.error('[persist] failed to write scrollback', id, err)
  }
}

function flushScrollback(): void {
  for (const id of dirtyScroll) writeScrollback(id)
  dirtyScroll.clear()
}

function scheduleScrollback(id: string): void {
  dirtyScroll.add(id)
  if (scrollTimer || st.frozen) return
  scrollTimer = setTimeout(() => {
    scrollTimer = null
    const ids = [...dirtyScroll]
    flushScrollback()
    // The shell may have `cd`'d; learn where it stands, off the main thread.
    for (const id of ids) refreshShellCwd(id)
  }, SCROLLBACK_AFTER_MS)
}

function pruneScrollback(keep: Set<string>): void {
  let files: string[]
  try { files = readdirSync(SCROLLBACK_DIR) } catch { return }
  for (const f of files) {
    const id = f.replace(/\.log(\.tmp)?$/, '')
    if (!keep.has(id)) { try { rmSync(join(SCROLLBACK_DIR, f), { force: true }) } catch { /* best effort */ } }
  }
}

function parseLsofCwd(out: string): string | undefined {
  const line = out.split('\n').find((l) => l.startsWith('n'))
  return line ? line.slice(1) : undefined
}

function refreshShellCwd(id: string): void {
  const pid = sessionManager.get(id)?.proc?.pid
  if (!pid) return
  execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 1500 }, (err, out) => {
    const cwd = err ? undefined : parseLsofCwd(String(out))
    if (cwd && cwd !== st.liveCwd.get(id)) { st.liveCwd.set(id, cwd); scheduleWrite() }
  })
}

function refreshShellCwdsSync(): void {
  for (const s of sessionManager.byProvider('shell')) {
    if (!s.proc?.pid) continue
    try {
      const out = execFileSync('lsof', ['-a', '-p', String(s.proc.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 400 })
      const cwd = parseLsofCwd(out)
      if (cwd) st.liveCwd.set(s.meta.id, cwd)
    } catch { /* keep the last known */ }
  }
}

/**
 * Attach persistence to this generation's session manager. Listeners go with
 * `sessionManager.detach()` on a hot swap; the returned disposer flushes and
 * stops the timers.
 */
export function wirePersistence(): () => void {
  sessionManager.on('meta', (m: SessionMeta) => {
    if (m.status === 'working') st.lastActive.set(m.id, Date.now())
    scheduleWrite()
  })
  sessionManager.on('data', ({ sessionId }: { sessionId: string }) => {
    st.lastActive.set(sessionId, Date.now())
    if (sessionManager.get(sessionId)?.meta.provider === 'shell') scheduleScrollback(sessionId)
  })
  sessionManager.on('closed', (id: string) => {
    st.lastActive.delete(id)
    st.liveCwd.delete(id)
    dirtyScroll.delete(id)
    try { rmSync(join(SCROLLBACK_DIR, `${id}.log`), { force: true }) } catch { /* best effort */ }
    scheduleWrite()
  })
  return () => flushPersistence()
}

/** Write everything pending now (hot swap dispose). */
export function flushPersistence(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
  if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null }
  flushScrollback()
  writeRegistry()
}

/**
 * Paper is quitting: record every session as it is *now* — before the kill
 * that follows turns them all `exited` — then stop writing, so those exits
 * never reach disk. Remote records are kept like any other.
 */
export function finalFlush(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
  if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null }
  refreshShellCwdsSync()
  for (const s of sessionManager.byProvider('shell')) dirtyScroll.add(s.meta.id)
  flushScrollback()
  writeRegistry({ quitAt: Date.now() })
  st.frozen = true
}

// ---- reading ------------------------------------------------------------

export function readRegistry(): SessionRegistry | null {
  if (!existsSync(SESSIONS_FILE)) return null
  try {
    const reg = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as SessionRegistry
    if (!Array.isArray(reg?.sessions)) throw new Error('no sessions array')
    return reg
  } catch (err) {
    // Keep the evidence; the next write would otherwise destroy it.
    const aside = `${SESSIONS_FILE}.corrupt-${Date.now()}`
    try { renameSync(SESSIONS_FILE, aside) } catch { /* best effort */ }
    console.error(`[persist] unreadable session registry moved to ${aside}`, err)
    return null
  }
}

export function restoreReport(): RestoreReport | null {
  return st.report
}

// ---- restoring ----------------------------------------------------------

/**
 * Run the restore exactly once per Electron process — the first activation.
 * A hot swap finds `restored` already set and does nothing, so it can never
 * relaunch a live session.
 */
export function restoreOnce(): void {
  if (st.restored) return
  st.restored = true
  try {
    restore()
  } catch (err) {
    console.error('[persist] restore failed', err)
  }
  st.writable = true
  scheduleWrite()
}

function restore(): void {
  const reg = readRegistry()
  const report: RestoreReport = { at: Date.now(), cleanQuit: Boolean(reg?.quitAt), sessions: [], orphans: [] }
  st.report = report
  if (!reg || !reg.sessions.length) return

  const live = new Set(sessionManager.list().map((m) => m.id))
  const records = reg.sessions.filter((r) => r?.meta?.id && r.meta.provider && !live.has(r.meta.id))

  // Before any CLI relaunches: two processes must never write one transcript.
  report.orphans = reapOrphans(records.filter((r) => isLocal(r.meta) && isAgent(r.meta.provider) && r.meta.nativeSessionId))

  for (const r of records) {
    try {
      report.sessions.push(restoreOne(r))
    } catch (err) {
      console.error('[persist] could not restore', r.meta.id, err)
      report.sessions.push({ id: r.meta.id, provider: r.meta.provider, host: r.meta.host, outcome: 'failed', detail: (err as Error).message })
    }
  }
  const counts = report.sessions.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.outcome]: (acc[s.outcome] ?? 0) + 1 }), {})
  console.log(`[persist] restored ${report.sessions.length} session(s) after ${report.cleanQuit ? 'quit' : 'crash'}: ${JSON.stringify(counts)}`)
}

function isLocal(meta: SessionMeta): boolean {
  return !meta.host || meta.host === LOCAL_HOST
}

function restoreOne(r: PersistedSession): RestoreReport['sessions'][number] {
  const wasExited = r.meta.status === 'exited'
  const meta: SessionMeta = {
    ...r.meta,
    host: r.meta.host || LOCAL_HOST,
    lineage: r.meta.lineage ?? [],
    // Nothing is running yet: never show a stale `working` from the last run.
    status: wasExited ? 'exited' : 'starting',
    restoredAt: Date.now()
  }
  if (!wasExited) meta.exitCode = undefined
  if (meta.remote) meta.remote = { ...meta.remote, link: 'connecting' }
  const base = { id: meta.id, provider: meta.provider, host: meta.host }

  if (meta.provider === 'shell') return restoreShell(r, meta, wasExited, base)

  const session = sessionManager.insert(meta, { cols: r.cols, rows: r.rows })
  const exited = (why: string): RestoreReport['sessions'][number] => {
    sessionManager.writeNotice(session, `\r\n  restored · ${why}\r\n`)
    sessionManager.setStatus(session, 'exited')
    return { ...base, outcome: 'exited', detail: why }
  }

  if (!isLocal(meta)) {
    // The agent lives in tmux on the remote and kept going while Paper was away.
    sessionManager.writeNotice(session, `\r\n  restored · reattaching to ${meta.host}\r\n`)
    sessionManager.start(session, { resume: meta.nativeSessionId, reattach: true })
    return { ...base, outcome: 'reattached' }
  }

  if (wasExited) return exited('this session had already exited · ⌘R relaunches it')
  const account = getAccount(meta.accountId)
  if (!account) return exited(`its account (${meta.accountId || 'none'}) no longer exists · switch account (⌘P) or close it`)
  if (!existsSync(meta.cwd)) return exited(`${meta.cwd} no longer exists · change directory (⌘L) or close it`)

  const provider = providerFor(meta.provider)
  const transcript = meta.nativeSessionId
    ? (meta.transcriptPath && existsSync(meta.transcriptPath)
        ? meta.transcriptPath
        : provider.findTranscript({ home: account.home, cwd: meta.cwd, since: 0, nativeSessionId: meta.nativeSessionId }))
    : undefined

  if (transcript) {
    meta.transcriptPath = transcript
    sessionManager.writeNotice(session, '\r\n  restored · resuming the conversation\r\n')
    sessionManager.start(session, { resume: meta.nativeSessionId })
    if (meta.status === 'exited') return { ...base, outcome: 'exited', detail: `${provider.bin} could not be launched` }
    const nudge = r.wasWorking && getState().defaults.resumeNudge !== false
    if (nudge) nudgeWhenReady(session)
    return { ...base, outcome: 'resumed', nudge }
  }

  // Never prompted, so there is no conversation to resume: start it afresh.
  meta.nativeSessionId = undefined
  meta.transcriptPath = undefined
  sessionManager.writeNotice(session, '\r\n  restored · nothing had been said yet, so this is a fresh start\r\n')
  sessionManager.start(session, {})
  if (meta.status === 'exited') return { ...base, outcome: 'exited', detail: `${provider.bin} could not be launched` }
  return { ...base, outcome: 'fresh' }
}

function restoreShell(
  r: PersistedSession,
  meta: SessionMeta,
  wasExited: boolean,
  base: { id: string; provider: ProviderId; host: string }
): RestoreReport['sessions'][number] {
  const before = meta.cwd
  const cwd = [r.liveCwd, meta.cwd].find((d): d is string => Boolean(d && existsSync(d))) ?? process.env.HOME ?? '/'
  const titleFor = providerFor('shell').titleFor
  if (titleFor && meta.title === titleFor(before)) meta.title = titleFor(cwd)
  meta.cwd = cwd

  const session = sessionManager.insert(meta, { buffer: replay(meta.id), cols: r.cols, rows: r.rows })
  if (wasExited) {
    sessionManager.writeNotice(session, '\r\n  restored · this shell had already exited · ⌘R opens a new one\r\n')
    return { ...base, outcome: 'exited', detail: 'had exited before the restart' }
  }
  const moved = r.liveCwd && r.liveCwd !== cwd ? ` · ${r.liveCwd} is gone, opened in ${cwd}` : ''
  sessionManager.writeNotice(session, `\r\n  restored · previous output above${moved}\r\n\r\n`)
  sessionManager.start(session, {})
  if (meta.status === 'exited') return { ...base, outcome: 'exited', detail: 'shell could not be launched' }
  return { ...base, outcome: 'shell' }
}

/**
 * The previous shell's output, dimmed so it reads as history. Every SGR in it
 * gets `;2` appended, so its own colour resets cannot undo the dim. A
 * full-screen program that was open when Paper died would leave the terminal
 * on the alternate screen; step back out of it.
 */
function replay(id: string): string {
  let text: string
  try { text = readFileSync(join(SCROLLBACK_DIR, `${id}.log`), 'utf8') } catch { return '' }
  if (!text) return ''
  const dimmed = text.replace(/\x1b\[([\d;]*)m/g, (_m, p: string) => `\x1b[${p || '0'};2m`)
  const altOn = Math.max(text.lastIndexOf('\x1b[?1049h'), text.lastIndexOf('\x1b[?47h'))
  const altOff = Math.max(text.lastIndexOf('\x1b[?1049l'), text.lastIndexOf('\x1b[?47l'))
  const leaveAlt = altOn > altOff ? '\x1b[?1049l' : ''
  return `\x1b[2m${dimmed}\x1b[0m${leaveAlt}\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?2004l`
}

/**
 * The agent was mid-turn when Paper died. Once the resumed CLI has drawn its
 * conversation and gone quiet, type the continuation prompt — the same
 * keystrokes `steer` sends, written straight to the pty so it works from
 * whichever generation of this module is current.
 */
function nudgeWhenReady(session: Session): void {
  const started = Date.now()
  let quietSince = 0
  const tick = (): void => {
    const s = sessionManager.get(session.meta.id)
    if (s !== session || !s.proc || s.meta.status === 'exited') return
    if (s.meta.status === 'idle') {
      quietSince ||= Date.now()
      if (Date.now() - quietSince >= NUDGE_SETTLE_MS) {
        const proc = s.proc
        proc.write(RESUME_NUDGE)
        setTimeout(() => { if (s.proc === proc) proc.write('\r') }, 80)
        console.log(`[persist] nudged ${s.meta.id} to continue`)
        return
      }
    } else quietSince = 0
    if (Date.now() - started > NUDGE_GIVE_UP_MS) {
      console.warn(`[persist] ${s.meta.id} never settled; no continuation nudge sent`)
      return
    }
    setTimeout(tick, 250)
  }
  setTimeout(tick, 1000)
}

// ---- orphans ------------------------------------------------------------

/**
 * CLIs from the previous run usually die with their pty, but not always. Find
 * any process still running one of *our* conversations — matched on the exact
 * conversation id in its argv, the way usage.reconcile() reads them — and
 * terminate it before the resume starts a second writer on that transcript.
 * When the process environment is readable, a PAPER_SESSION naming another
 * session vetoes the match.
 */
function reapOrphans(records: PersistedSession[]): RestoreReport['orphans'] {
  if (!records.length) return []
  let out = ''
  try {
    out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 2000, maxBuffer: 32 * 1024 * 1024 })
  } catch (err) {
    out = String((err as { stdout?: unknown }).stdout ?? '')
  }

  const found: RestoreReport['orphans'] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const command = m[2]
    if (pid === process.pid) continue
    for (const r of records) {
      const id = r.meta.nativeSessionId!
      if (!/^[0-9A-Za-z-]+$/.test(id)) continue
      const exact = r.meta.provider === 'claude'
        ? new RegExp(`(?:^|\\s)--(?:session-id|resume)[ =]${id}(?=\\s|$)`)
        : new RegExp(`(?:^|\\s)resume\\s+${id}(?=\\s|$)`)
      if (!command.includes(r.meta.provider) || !exact.test(command)) continue
      if (ownedElsewhere(pid, r.meta.id)) continue
      found.push({ pid, sessionId: r.meta.id, command: command.slice(0, 200), killed: false })
    }
  }
  if (!found.length) return found

  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
  for (const o of found) { try { process.kill(o.pid, 'SIGTERM') } catch { /* gone */ } }
  const deadline = Date.now() + ORPHAN_GRACE_MS
  while (found.some((o) => alive(o.pid)) && Date.now() < deadline) sleepSync(50)
  for (const o of found) {
    if (alive(o.pid)) { try { process.kill(o.pid, 'SIGKILL') } catch { /* gone */ } }
  }
  sleepSync(100)
  for (const o of found) {
    o.killed = !alive(o.pid)
    console.warn(`[persist] orphan ${o.pid} of ${o.sessionId} ${o.killed ? 'terminated' : 'would not die'}: ${o.command}`)
  }
  return found
}

/** True only when the process provably belongs to a different Paper session. */
function ownedElsewhere(pid: number, sessionId: string): boolean {
  try {
    const env = execFileSync('ps', ['-E', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 })
    const m = /(?:^|\s)PAPER_SESSION=(\S+)/.exec(env)
    return Boolean(m && m[1] !== sessionId)
  } catch {
    return false
  }
}
