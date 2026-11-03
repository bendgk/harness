import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import { isAgent, providerFor } from './providers'
import { agentEnv, which } from './shell-env'
import { getAccount, defaultAccountFor } from './accounts'
import { kernel } from './kernel'
import { LOCAL_HOST, type ProviderId, type SessionMeta, type SessionStatus, type SpawnRequest } from '@shared/types'

/** Bytes of scrollback retained so a pane can re-attach with history intact. */
const SCROLLBACK_LIMIT = 1_500_000
/** Quiet period after which an agent is considered idle rather than working. */
const IDLE_AFTER_MS = 900

export interface Session {
  meta: SessionMeta
  proc: pty.IPty | null
  buffer: string
  cols: number
  rows: number
  idleTimer: NodeJS.Timeout | null
  startedAt: number
  /** Listeners bound to the live pty; replaced wholesale on a hot swap. */
  subs: pty.IDisposable[]
}

export class SessionManager extends EventEmitter {
  /**
   * The session table lives in a kernel slot, so it — and the pty handles in
   * it — survive the app bundle being rebuilt and swapped underneath it.
   */
  private sessions = kernel().slot('sessions', () => new Map<string, Session>())

  /**
   * Take over sessions left by the previous generation of this module: rebind
   * pty listeners to this instance and re-arm idle detection. Nothing is
   * restarted; output keeps flowing into the same buffers.
   */
  adopt(): void {
    for (const s of this.sessions.values()) {
      for (const d of s.subs ?? []) { try { d.dispose() } catch { /* already gone */ } }
      s.subs = []
      if (s.proc) this.attach(s, s.proc)
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null }
      if (s.meta.status === 'working') this.markActive(s)
      this.emit('meta', s.meta)
    }
  }

  /** Let go of the sessions without ending them, for the next generation to adopt. */
  detach(): void {
    for (const s of this.sessions.values()) {
      for (const d of s.subs ?? []) { try { d.dispose() } catch { /* already gone */ } }
      s.subs = []
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null }
    }
    this.removeAllListeners()
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => s.meta)
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  meta(id: string): SessionMeta | undefined {
    return this.sessions.get(id)?.meta
  }

  /** Create a session record and start its process. */
  spawn(req: SpawnRequest): SessionMeta {
    // A plain terminal has no login to pick, so it skips accounts entirely.
    const account = isAgent(req.provider)
      ? (req.accountId ? getAccount(req.accountId) : defaultAccountFor(req.provider))
      : undefined
    if (isAgent(req.provider) && !account) {
      throw new Error(`No ${req.provider} account configured. Add one in Accounts (⌘,).`)
    }

    const cwd = req.cwd || process.env.HOME || '/'
    const provider = providerFor(req.provider)
    const id = randomUUID()
    const meta: SessionMeta = {
      id,
      title: provider.titleFor ? provider.titleFor(cwd) : provider.name,
      titleIsAi: Boolean(provider.titleFor),
      provider: req.provider,
      accountId: account?.id ?? '',
      cwd,
      status: 'starting',
      createdAt: Date.now(),
      host: LOCAL_HOST,
      lineage: account ? [{ accountId: account.id, at: Date.now() }] : []
    }
    const session: Session = {
      meta,
      proc: null,
      buffer: '',
      cols: 120,
      rows: 34,
      idleTimer: null,
      startedAt: Date.now(),
      subs: []
    }
    this.sessions.set(id, session)
    this.start(session, { resume: req.resume, prompt: req.prompt })
    return meta
  }

  /** Boot (or re-boot, after an account switch) the underlying CLI. */
  start(session: Session, opts: { resume?: string; prompt?: string } = {}): void {
    const { meta } = session
    const provider = providerFor(meta.provider)
    const account = isAgent(meta.provider) ? getAccount(meta.accountId) : undefined
    if (isAgent(meta.provider) && !account) throw new Error('Account went missing')

    if (!which(provider.bin)) {
      this.writeNotice(
        session,
        `\r\n  ${provider.name} CLI not found on PATH.\r\n  Install it, then press ⌘R to retry.\r\n\r\n`
      )
      this.setStatus(session, 'exited')
      return
    }

    const plan = provider.plan({
      home: account?.home ?? '',
      cwd: meta.cwd,
      resume: opts.resume,
      prompt: opts.prompt
    })
    meta.nativeSessionId = plan.nativeSessionId || meta.nativeSessionId
    if (plan.transcriptPath) meta.transcriptPath = plan.transcriptPath
    session.startedAt = Date.now()
    meta.exitCode = undefined

    const env = {
      ...agentEnv(),
      ...plan.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // Identify ourselves so agents and hooks can tell where they are running.
      TERM_PROGRAM: 'Paper',
      PAPER_SESSION: meta.id,
      PAPER_MCP_URL: kernel().mcp.url
    }

    let proc: pty.IPty
    try {
      proc = pty.spawn(plan.file, plan.args, {
        name: 'xterm-256color',
        cols: session.cols,
        rows: session.rows,
        cwd: existsSync(meta.cwd) ? meta.cwd : process.env.HOME || '/',
        env
      })
    } catch (err) {
      this.writeNotice(session, `\r\n  Failed to launch ${provider.bin}: ${(err as Error).message}\r\n`)
      this.setStatus(session, 'exited')
      return
    }

    session.proc = proc
    this.setStatus(session, 'starting')

    // A shell takes its opening command as typed input rather than as argv.
    if (plan.initialInput) {
      const line = plan.initialInput
      setTimeout(() => proc.write(`${line}\r`), 120)
    }

    this.attach(session, proc)
    this.emit('meta', meta)
  }

  /** Bind this instance to a live pty. Disposables are kept so a hot swap can rebind. */
  private attach(session: Session, proc: pty.IPty): void {
    const { meta } = session
    session.subs.push(
      proc.onData((data) => {
        session.buffer += data
        if (session.buffer.length > SCROLLBACK_LIMIT) {
          session.buffer = session.buffer.slice(-SCROLLBACK_LIMIT)
        }
        this.emit('data', { sessionId: meta.id, data })
        this.markActive(session)
      }),
      proc.onExit(({ exitCode }) => {
        // A handoff replaces the process while the old one is still dying; its
        // late exit event must not mark the new, healthy session as finished.
        if (session.proc !== proc) return
        session.proc = null
        meta.exitCode = exitCode
        // A handoff kills the process on purpose; don't report that as a crash.
        if (meta.status !== 'handoff') {
          this.setStatus(session, 'exited')
          this.emit('exit', { sessionId: meta.id, exitCode })
        }
      })
    )
  }

  /** Output means the agent is thinking; silence means it is waiting on us. */
  private markActive(session: Session): void {
    if (session.meta.status !== 'working') this.setStatus(session, 'working')
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      if (session.meta.status === 'working') this.setStatus(session, 'idle')
    }, IDLE_AFTER_MS)
  }

  setStatus(session: Session, status: SessionStatus): void {
    if (session.meta.status === status) return
    session.meta.status = status
    this.emit('meta', session.meta)
  }

  patchMeta(id: string, patch: Partial<SessionMeta>): SessionMeta | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    Object.assign(s.meta, patch)
    this.emit('meta', s.meta)
    return s.meta
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.proc?.write(data)
  }

  /** Stop the current turn without tearing down the conversation. */
  interrupt(id: string): void {
    const s = this.sessions.get(id)
    if (!s?.proc) return
    s.proc.write(providerFor(s.meta.provider).interruptSequence)
    this.setStatus(s, 'idle')
  }

  /**
   * Interrupt, let the agent settle, then submit a new prompt. This is the
   * "stop and redirect" path — the conversation keeps every bit of its context.
   */
  async steer(id: string, prompt: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s?.proc) return
    if (s.meta.status === 'working') {
      s.proc.write(providerFor(s.meta.provider).interruptSequence)
      await delay(260)
    }
    s.proc.write(prompt.replace(/\r?\n/g, ' '))
    await delay(60)
    s.proc.write('\r')
    this.markActive(s)
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.cols = cols
    s.rows = rows
    try { s.proc?.resize(cols, rows) } catch { /* pty may have exited */ }
  }

  scrollback(id: string): string {
    return this.sessions.get(id)?.buffer ?? ''
  }

  /** Inject a Paper-authored message into the pane's scrollback. */
  writeNotice(session: Session, text: string): void {
    const styled = `\x1b[2m${text}\x1b[0m`
    session.buffer += styled
    this.emit('data', { sessionId: session.meta.id, data: styled })
  }

  notice(id: string, text: string): void {
    const s = this.sessions.get(id)
    if (s) this.writeNotice(s, text)
  }

  kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): void {
    const s = this.sessions.get(id)
    if (!s?.proc) return
    try { s.proc.kill(signal) } catch { /* already gone */ }
    s.proc = null
    for (const d of s.subs) { try { d.dispose() } catch { /* already gone */ } }
    s.subs = []
  }

  close(id: string): void {
    this.kill(id, 'SIGKILL')
    const s = this.sessions.get(id)
    if (s?.idleTimer) clearTimeout(s.idleTimer)
    this.sessions.delete(id)
  }

  /** Change a session's working directory in place. */
  setCwd(id: string, cwd: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    const provider = providerFor(s.meta.provider)
    // A directory-derived title should follow the directory — unless the title
    // has since been changed by hand, which must not be overwritten.
    if (provider.titleFor && s.meta.title === provider.titleFor(s.meta.cwd)) {
      s.meta.title = provider.titleFor(cwd)
    }
    s.meta.cwd = cwd
    this.emit('meta', s.meta)
  }

  /** Relaunch in place, keeping the same conversation via provider resume. */
  restart(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.kill(id, 'SIGKILL')
    s.buffer = ''
    this.start(s, { resume: s.meta.nativeSessionId })
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  countByAccount(accountId: string): number {
    return [...this.sessions.values()].filter((s) => s.meta.accountId === accountId).length
  }

  byProvider(provider: ProviderId): Session[] {
    return [...this.sessions.values()].filter((s) => s.meta.provider === provider)
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const sessionManager = new SessionManager()
