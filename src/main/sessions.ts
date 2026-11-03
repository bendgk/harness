import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { isAgent, providerFor } from './providers'
import { projectSlug } from './providers/claude'
import { agentEnv, which } from './shell-env'
import { getAccount, defaultAccountFor } from './accounts'
import { kernel } from './kernel'
import { ensureReady, machineContextPrompt, machineEvents, requireMachine } from './machines'
import { MachineFailure, assertAlias, interactiveArgs, sshEnv } from './ssh'
import { ensureTunnel, provisionRemoteSession, revokeRemoteSession } from './gateway'
import { getState } from './store'
import {
  assertTmuxName, attachCommand, killRemote, launchRemote, readTags, remoteFileExists, remoteState, resolveRemoteDir, setTags,
  tmuxNameFor, type RemoteTags
} from './remote'
import {
  LOCAL_HOST, type MachineError, type ProviderId, type SessionMeta, type SessionStatus, type SpawnRequest
} from '@shared/types'

/** Bytes of scrollback retained so a pane can re-attach with history intact. */
const SCROLLBACK_LIMIT = 1_500_000
/** Quiet period after which an agent is considered idle rather than working. */
const IDLE_AFTER_MS = 900
/** An attach that lived this long was healthy; the next drop starts the backoff over. */
const STABLE_LINK_MS = 15_000

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
  /** Remote sessions only: reconnect bookkeeping (runtime state, never persisted). */
  link?: RemoteLink
  /**
   * A new remote session spawned without a directory: candidates tried on the
   * machine, first existing wins (else ~). Consumed by the first launch.
   */
  cwdCandidates?: string[]
}

/**
 * For a remote session the local pty is only an ssh client; the agent lives
 * in tmux on the machine. `gen` invalidates in-flight launches and reconnects
 * when the session is killed, restarted or handed off while one is pending.
 */
export interface RemoteLink {
  gen: number
  attempt: number
  timer: NodeJS.Timeout | null
  /** When the current ssh client attached, to tell a flapping link from a long-lived one. */
  attachedAt: number
}

export interface StartOptions {
  resume?: string
  prompt?: string
  /**
   * Remote sessions: attach to the agent's tmux session if it is still alive,
   * and only relaunch (resuming the conversation) if it is gone. Used when
   * Paper restores sessions on boot and when ⌘R retries a dropped link.
   * Meaningless for local sessions.
   */
  reattach?: boolean
}

/**
 * The manager of the newest app generation. Async remote work (connecting,
 * reconnect timers) can outlive the generation that started it; its
 * continuation must bind the pty to — and emit through — the live manager,
 * or the pane would never hear about it after a hot swap.
 */
const liveRef = (): { current: SessionManager | null } =>
  kernel().slot('sessions.live', () => ({ current: null as SessionManager | null }))

export function isRemote(meta: SessionMeta): boolean {
  return Boolean(meta.host) && meta.host !== LOCAL_HOST
}

/** Where a new remote session without a directory should stand, in order of preference. */
function remoteCwdCandidates(defaultCwd?: string): string[] {
  const here = getState().defaults.cwd
  const home = homedir()
  const relative = here === home || here.startsWith(`${home}/`) ? `~${here.slice(home.length)}` : undefined
  return [defaultCwd, here, relative, '~'].filter((c): c is string => Boolean(c))
}

/** Where Claude on a remote keeps a conversation: `<claudeHome>/projects/<slug(cwd)>/<id>.jsonl`. */
export function remoteTranscript(claudeHome: string, cwd: string, nativeId: string): string {
  return join(claudeHome, 'projects', projectSlug(cwd), `${nativeId}.jsonl`)
}

/**
 * Terminal *queries* (device attributes, cursor position, XTVERSION, colour
 * and mode reports) must reach the pane live, but not be kept for replay: a
 * pane that re-attaches (page reload, pane moved) replays the scrollback into
 * a fresh xterm, which answers every old query again — and the answers arrive
 * as typed input. tmux asks on every attach, so a remote shell would see
 * `1;2c0;276;0c` typed at its prompt.
 */
// eslint-disable-next-line no-control-regex
const TERMINAL_QUERY = /\x1b\[[>=?]?[0-9;]*[cnq]|\x1b\[\?u|\x1b\[\??[0-9;]+\$p|\x1b\](?:4;[0-9]+|1[0-2]);\?(?:\x07|\x1b\\)/g

function replayable(data: string): string {
  return data.includes('\x1b') ? data.replace(TERMINAL_QUERY, '') : data
}

/** Reconnect backoff: 1 s doubling to a 30 s cap, jittered so many panes do not stampede. */
function backoff(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))
  return Math.round(base * (0.5 + Math.random() * 0.5))
}

function failureInfo(err: unknown): MachineError {
  if (err instanceof MachineFailure) return err.info
  return { kind: 'unknown', message: (err as Error)?.message || String(err), hint: '' }
}

/**
 * Machine context for an agent's system prompt. machines.ts owns the text; a
 * failure there must never stop an agent from starting.
 */
function contextPrompt(meta: SessionMeta, paperTools = true): string | undefined {
  if (!isAgent(meta.provider)) return undefined
  let text = ''
  try { text = machineContextPrompt({ sessionId: meta.id, host: meta.host }) || '' } catch { /* no machine context */ }
  if (isRemote(meta)) {
    const where = `You are running on the machine "${meta.host}" (over ssh, inside tmux), started by Paper on the user's computer.`
    const tools = paperTools
      ? 'You can call a limited set of Paper tools (mcp__paper__*) through a private tunnel: `session_handoff` with ' +
        'id = $PAPER_SESSION and host = "local" moves you back to the user\'s Mac (or another machine alias moves you ' +
        'there) once your current turn ends, with this conversation intact; `machines_list`, `sessions_list`, and ' +
        '`session_spawn` for sessions on remote machines only.'
      : 'Paper tools are not available to you in this session; work with the files and commands on this machine.'
    text = [text, `${where} ${tools}`].filter(Boolean).join('\n\n')
  }
  return text || undefined
}

/**
 * Give a remote Claude its scoped Paper tools: the machine's reverse tunnel to
 * the gateway, and a per-session token in a 0600 config file on the remote.
 * Idempotent, so it runs on every launch and re-attach. Failure is not fatal —
 * the agent still runs, just without Paper tools, and the pane says why.
 * Codex is skipped: its HTTP MCP auth needs the token in argv or env (see CLAUDE.md).
 */
async function provisionTools(meta: SessionMeta): Promise<{ mcpConfig?: string; why?: string; rotated?: boolean }> {
  if (meta.provider !== 'claude') return { why: meta.provider === 'codex' ? 'not supported for Codex yet' : undefined }
  try {
    const tunnel = await ensureTunnel(meta.host)
    if (tunnel.state === 'failed') return { why: tunnel.error ? `${tunnel.error.message}. ${tunnel.error.hint}` : 'the tunnel failed' }
    // `rotated`: the token changed, so an agent that is already running still holds the old one.
    const res: { mcpConfigPath: string; rotated?: boolean } = await provisionRemoteSession(meta.id, meta.host)
    return { mcpConfig: res.mcpConfigPath, rotated: res.rotated }
  } catch (err) {
    return { why: failureInfo(err).message }
  }
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
    liveRef().current = this
    for (const s of this.sessions.values()) {
      // Sessions started by a generation that predates machines have no host;
      // they are, by definition, local. Backfill so nothing downstream guesses.
      if (!s.meta.host) s.meta.host = LOCAL_HOST
      if (!s.meta.lineage) s.meta.lineage = []
      for (const d of s.subs ?? []) { try { d.dispose() } catch { /* already gone */ } }
      s.subs = []
      if (s.proc) this.attach(s, s.proc)
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null }
      if (s.meta.status === 'working') this.markActive(s)
      // A reconnect timer died with the previous generation; pick the retry up here.
      if (s.link && !s.proc && s.meta.remote?.link === 'reconnecting') this.scheduleReconnect(s, 500)
      this.emit('meta', s.meta)
    }
  }

  /** Let go of the sessions without ending them, for the next generation to adopt. */
  detach(): void {
    for (const s of this.sessions.values()) {
      for (const d of s.subs ?? []) { try { d.dispose() } catch { /* already gone */ } }
      s.subs = []
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null }
      if (s.link?.timer) { clearTimeout(s.link.timer); s.link.timer = null }
    }
    this.removeAllListeners()
  }

  /** See liveRef: async continuations go through the newest generation. */
  private live(): SessionManager {
    return liveRef().current ?? this
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
    const host = req.host && req.host !== LOCAL_HOST ? assertAlias(req.host) : LOCAL_HOST
    // The allowlist: an agent can only be started on a registered machine.
    const machine = host !== LOCAL_HOST ? requireMachine(host) : undefined
    // A plain terminal has no login to pick, so it skips accounts entirely. A
    // remote agent uses the machine's own login; the local account is kept
    // (when there is one) for titles and for a handoff back to this Mac.
    const account = isAgent(req.provider)
      ? (req.accountId ? getAccount(req.accountId) : defaultAccountFor(req.provider))
      : undefined
    if (isAgent(req.provider) && !account && !machine) {
      throw new Error(`No ${req.provider} account configured. Add one in Accounts (⌘,).`)
    }

    const cwd = req.cwd || (machine ? machine.defaultCwd || '~' : process.env.HOME || '/')
    // No directory asked for on a machine: the handoff chain — its default,
    // the same path as here, the same path under $HOME — and ~ rather than failing.
    const cwdCandidates = machine && !req.cwd ? remoteCwdCandidates(machine.defaultCwd) : undefined
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
      host,
      lineage: account ? [{ accountId: account.id, at: Date.now(), host }] : []
    }
    const session: Session = {
      meta,
      proc: null,
      buffer: '',
      cols: 120,
      rows: 34,
      idleTimer: null,
      startedAt: Date.now(),
      subs: [],
      cwdCandidates
    }
    this.sessions.set(id, session)
    this.start(session, { resume: req.resume, prompt: req.prompt })
    return meta
  }

  /**
   * Put a session record back into the table without starting anything — the
   * restore-after-restart path (persist.ts). The id is the one the record had,
   * so tabs saved in state.json re-bind to it. The caller decides how to start it.
   */
  insert(meta: SessionMeta, init: { buffer?: string; cols?: number; rows?: number } = {}): Session {
    const session: Session = {
      meta,
      proc: null,
      buffer: init.buffer ?? '',
      cols: init.cols || 120,
      rows: init.rows || 34,
      idleTimer: null,
      startedAt: Date.now(),
      subs: []
    }
    this.sessions.set(meta.id, session)
    this.emit('meta', meta)
    return session
  }

  /**
   * Boot (or re-boot, after an account switch or handoff) the underlying CLI.
   * `reattach` is for remote sessions (restored after a Paper restart, or ⌘R on
   * a dropped link): rejoin the tmux session if it still exists, else relaunch
   * with `resume`.
   */
  start(session: Session, opts: StartOptions = {}): void {
    if (isRemote(session.meta)) {
      // Failures are already in the pane and on meta; nothing to throw to.
      void this.startRemote(session, opts).catch(() => {})
      return
    }
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
      prompt: opts.prompt,
      systemPrompt: contextPrompt(meta)
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

  /**
   * Start and wait for the outcome: resolves once the CLI is running (remote:
   * launched and attached), rejects with the reason (a MachineFailure for
   * machine problems) otherwise. Handoff uses this to know when to roll back.
   */
  async launch(session: Session, opts: StartOptions = {}): Promise<void> {
    if (isRemote(session.meta)) return this.startRemote(session, opts)
    this.start(session, opts)
    if (!session.proc) throw new Error(`${providerFor(session.meta.provider).name} did not start on this computer`)
  }

  // ---- remote sessions ------------------------------------------------------

  /**
   * Launch (or re-attach to) the agent in tmux on `meta.host`, then attach a
   * local ssh client to it as this session's pty. Status is 'starting' and the
   * link 'connecting' until then; progress is written into the pane.
   */
  private async startRemote(session: Session, opts: StartOptions): Promise<void> {
    const { meta } = session
    const alias = assertAlias(meta.host)
    const provider = providerFor(meta.provider)
    const link = this.linkOf(session)
    const gen = ++link.gen
    link.attempt = 0
    if (link.timer) { clearTimeout(link.timer); link.timer = null }
    const name = meta.remote?.tmux ? assertTmuxName(meta.remote.tmux) : tmuxNameFor(meta.id)
    meta.remote = { ...meta.remote, tmux: name, link: 'connecting' }
    meta.exitCode = undefined
    session.startedAt = Date.now()
    this.setStatus(session, 'starting')
    this.emit('meta', meta)
    this.writeNotice(session, `\r\n  connecting to @${alias}…\r\n`)

    try {
      const probe = await ensureReady(alias, meta.provider === 'shell' ? 'shell' : meta.provider)
      if (gen !== link.gen) return
      if (session.cwdCandidates) {
        const found = await resolveRemoteDir(alias, session.cwdCandidates)
        session.cwdCandidates = undefined
        if (gen !== link.gen) return
        if (found && found !== meta.cwd) this.live().setCwd(meta.id, found)
      }

      // `--resume` of a conversation Claude never wrote (no prompt yet) fails;
      // pinning the same id fresh loses nothing.
      let resume = opts.resume
      let sessionId: string | undefined
      if (resume && meta.provider === 'claude' && probe.claudeHome && meta.cwd.startsWith('/')) {
        if (!(await remoteFileExists(alias, remoteTranscript(probe.claudeHome, meta.cwd, resume)))) {
          sessionId = resume
          resume = undefined
        }
        if (gen !== link.gen) return
      }
      const tools = await provisionTools(meta)
      if (gen !== link.gen) return
      if (tools.why) this.live().writeNotice(session, `  Paper tools unavailable in this session: ${tools.why}\r\n`)
      const plan = provider.remotePlan({
        resume,
        sessionId,
        prompt: opts.prompt,
        mcpConfig: tools.mcpConfig,
        systemPrompt: contextPrompt(meta, Boolean(tools.mcpConfig))
      })
      const nativeId = plan.nativeSessionId || meta.nativeSessionId
      const result = await launchRemote({
        alias,
        name,
        cwd: meta.cwd,
        cols: session.cols,
        rows: session.rows,
        bin: plan.bin,
        args: plan.args,
        env: { COLORTERM: 'truecolor', PAPER_SESSION: meta.id, PAPER_HOST: alias },
        tags: { id: meta.id, provider: meta.provider, native: nativeId, cwd: meta.cwd, title: meta.title },
        reattach: Boolean(opts.reattach)
      })
      if (gen !== link.gen) return

      if (!result.reattached) {
        if (result.cwd && result.cwd !== meta.cwd) {
          // The physical path is what the CLI sees (and what Claude slugs).
          this.live().setCwd(meta.id, result.cwd)
          this.retag(meta, { cwd: meta.cwd, title: meta.title })
        }
        meta.nativeSessionId = nativeId
        // A fresh codex conversation writes a new rollout; it is discovered again.
        if (meta.provider === 'codex' && !resume) meta.remote = { ...meta.remote, tmux: name, link: 'connecting', transcriptPath: undefined }
      }
      if (meta.provider === 'claude' && meta.nativeSessionId && probe.claudeHome && meta.cwd.startsWith('/')) {
        meta.remote = { ...meta.remote, tmux: name, link: 'connecting', transcriptPath: remoteTranscript(probe.claudeHome, meta.cwd, meta.nativeSessionId) }
      }
      const live = this.live()
      live.attachRemote(session, result.reattached ? 'reattached' : 'launched')
      if (result.reattached && tools.rotated) {
        live.writeNotice(session, '  Paper tools unavailable for this agent until it restarts (⌘R)\r\n')
      }
      if (!session.proc) throw new Error('Could not run ssh')
      if (!result.reattached && plan.initialInput) {
        const line = plan.initialInput
        setTimeout(() => session.proc?.write(`${line}\r`), 900)
      }
    } catch (err) {
      if (gen !== link.gen) throw err
      const live = this.live()
      const info = failureInfo(err)
      meta.remote = { ...meta.remote, tmux: name, link: 'lost' }
      live.writeNotice(session, `\r\n  ${info.message}\r\n${info.hint ? `  ${info.hint}\r\n` : ''}  Press ⌘R to retry.\r\n\r\n`)
      live.setStatus(session, 'exited')
      live.emit('meta', meta)
      live.emit('exit', { sessionId: meta.id, exitCode: -1 })
      throw err
    } finally {
      machineEvents.emit('poke', alias)
    }
  }

  private linkOf(session: Session): RemoteLink {
    if (!session.link) session.link = { gen: 0, attempt: 0, timer: null, attachedAt: 0 }
    return session.link
  }

  /** Spawn the local ssh client that shows the remote tmux session in the pane. */
  private attachRemote(session: Session, how: 'launched' | 'reattached' | 'reconnected'): void {
    const { meta } = session
    const alias = assertAlias(meta.host)
    const name = assertTmuxName(meta.remote?.tmux)
    let proc: pty.IPty
    try {
      proc = pty.spawn('ssh', interactiveArgs(alias, attachCommand(name)), {
        name: 'xterm-256color',
        cols: session.cols,
        rows: session.rows,
        cwd: process.env.HOME || '/',
        env: { ...sshEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      })
    } catch (err) {
      this.writeNotice(session, `\r\n  Could not run ssh: ${(err as Error).message}\r\n`)
      meta.remote = { tmux: name, ...meta.remote, link: 'lost' }
      this.setStatus(session, 'exited')
      this.emit('meta', meta)
      return
    }
    this.linkOf(session).attachedAt = Date.now()
    session.proc = proc
    meta.remote = { tmux: name, ...meta.remote, link: 'attached' }
    if (how !== 'launched') this.writeNotice(session, `\r\n  ↻ ${how} to @${alias} · tmux ${name}\r\n`)
    this.attach(session, proc)
    this.emit('meta', meta)
  }

  /**
   * The ssh client ended without us asking. Either the agent exited (its tmux
   * session is gone) or the link dropped (the session is still there): find
   * out which, and reconnect in the second case.
   */
  private async onRemoteExit(session: Session): Promise<void> {
    const link = this.linkOf(session)
    if (Date.now() - link.attachedAt > STABLE_LINK_MS) link.attempt = 0
    await this.recheck(session, link.gen)
  }

  /** `retry` = a backoff timer fired: the wait is over, so an alive session is attached. */
  private async recheck(session: Session, gen: number, retry = false): Promise<void> {
    const { meta } = session
    const name = meta.remote?.tmux
    if (!name || !isRemote(meta)) return
    const alias = meta.host
    const state = await remoteState(alias, name)
    const live = this.live()
    const link = live.linkOf(session)
    if (gen !== link.gen || session.proc || !live.sessions.has(meta.id)) return

    if (state.state === 'alive') {
      // One drop reconnects at once; an attach that dies again right away backs off.
      if (retry || link.attempt === 0) {
        if (!retry) link.attempt++
        live.attachRemote(session, 'reconnected')
        machineEvents.emit('poke', alias)
      } else {
        live.markReconnecting(session, `the link to @${alias} keeps dropping`)
      }
      return
    }
    if (state.state === 'gone') {
      live.writeNotice(session, `\r\n  the agent on @${alias} exited\r\n`)
      live.setStatus(session, 'exited')
      live.emit('exit', { sessionId: meta.id, exitCode: meta.exitCode ?? 0 })
      machineEvents.emit('poke', alias)
      return
    }
    const { error } = state
    if (error.kind === 'auth' || error.kind === 'host-key') {
      // Only a person can fix these; retrying would just hammer sshd.
      meta.remote = { ...meta.remote, tmux: name, link: 'lost' }
      live.writeNotice(
        session,
        `\r\n  ${error.message}\r\n  ${error.hint}\r\n  The agent may still be running on @${alias}. Press ⌘R to reconnect.\r\n\r\n`
      )
      live.emit('meta', meta)
      return
    }
    live.markReconnecting(session, error.message)
  }

  private markReconnecting(session: Session, why: string): void {
    const { meta } = session
    const link = this.linkOf(session)
    const wait = backoff(link.attempt)
    link.attempt++
    if (meta.remote?.link !== 'reconnecting') {
      this.writeNotice(session, `\r\n  ↻ ${why} — reconnecting; the agent keeps running on @${meta.host}\r\n`)
    }
    meta.remote = { ...meta.remote!, link: 'reconnecting' }
    this.emit('meta', meta)
    this.scheduleReconnect(session, wait)
  }

  private scheduleReconnect(session: Session, ms: number): void {
    const link = this.linkOf(session)
    if (link.timer) clearTimeout(link.timer)
    const gen = link.gen
    link.timer = setTimeout(() => {
      link.timer = null
      void this.live().recheck(session, gen, true).catch(() => {})
    }, ms)
  }

  /** Best-effort: mirror a meta change into the session's @paper_* tags, so the machine stays the source of truth. */
  private retag(meta: SessionMeta, tags: RemoteTags): void {
    if (!isRemote(meta) || !meta.remote?.tmux) return
    void setTags(meta.host, meta.remote.tmux, tags).catch(() => {})
  }

  /**
   * Bring an agent found on a machine (a `paper-*` tmux session no live
   * session is attached to) into Paper, rebuilt from its own @paper_* tags.
   */
  async adoptRemote(alias: string, tmux: string): Promise<SessionMeta> {
    requireMachine(assertAlias(alias))
    const name = assertTmuxName(tmux)
    const already = [...this.sessions.values()].find((s) => s.meta.host === alias && s.meta.remote?.tmux === name)
    if (already) return already.meta
    const tags = await readTags(alias, name)
    const provider: ProviderId = tags.provider === 'claude' || tags.provider === 'codex' ? tags.provider : 'shell'
    const id = tags.id && /^[0-9a-f-]{8,64}$/i.test(tags.id) && !this.sessions.has(tags.id) ? tags.id : randomUUID()
    const account = isAgent(provider) ? defaultAccountFor(provider) : undefined
    const p = providerFor(provider)
    const cwd = tags.cwd || '~'
    const meta: SessionMeta = {
      id,
      title: tags.title || (p.titleFor ? p.titleFor(cwd) : p.name),
      titleIsAi: Boolean(tags.title) || Boolean(p.titleFor),
      provider,
      accountId: account?.id ?? '',
      cwd,
      status: 'starting',
      nativeSessionId: tags.native,
      createdAt: Date.now(),
      host: alias,
      remote: { tmux: name, link: 'connecting' },
      lineage: account ? [{ accountId: account.id, at: Date.now(), nativeSessionId: tags.native, host: alias }] : []
    }
    const session = this.insert(meta)
    // The tmux session may carry another Paper's id; from now on it carries ours.
    if (id !== tags.id) this.retag(meta, { id })
    await this.startRemote(session, { resume: tags.native, reattach: true })
    return meta
  }

  // ---- pty plumbing ---------------------------------------------------------

  /** Bind this instance to a live pty. Disposables are kept so a hot swap can rebind. */
  private attach(session: Session, proc: pty.IPty): void {
    const { meta } = session
    session.subs.push(
      proc.onData((data) => {
        session.buffer += replayable(data)
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
        // A remote pty is only the ssh client; its exit says nothing yet about the agent.
        if (isRemote(meta) && meta.status !== 'handoff') {
          void this.onRemoteExit(session).catch(() => {})
          return
        }
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
    const tags: RemoteTags = {}
    if (patch.title !== undefined && patch.title !== s.meta.title) tags.title = patch.title
    if (patch.nativeSessionId && patch.nativeSessionId !== s.meta.nativeSessionId) tags.native = patch.nativeSessionId
    Object.assign(s.meta, patch)
    if (tags.title !== undefined || tags.native) this.retag(s.meta, tags)
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
    // Remote: ssh carries the window change to the tmux client, which resizes the pane.
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

  /**
   * End the local process. For a remote session that is only the ssh client:
   * the agent keeps running in tmux (`close` and `stopRemote` end it). Any
   * pending connect or reconnect is cancelled.
   */
  kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.link) {
      s.link.gen++
      s.link.attempt = 0
      if (s.link.timer) { clearTimeout(s.link.timer); s.link.timer = null }
    }
    if (!s.proc) return
    try { s.proc.kill(signal) } catch { /* already gone */ }
    s.proc = null
    for (const d of s.subs) { try { d.dispose() } catch { /* already gone */ } }
    s.subs = []
  }

  /** End a remote agent itself: drop the ssh client, then kill its tmux session. */
  async stopRemote(id: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s || !isRemote(s.meta) || !s.meta.remote?.tmux) return
    const { host, remote } = s.meta
    this.kill(id, 'SIGKILL')
    try {
      await killRemote(host, remote.tmux)
    } finally {
      machineEvents.emit('poke', host)
    }
  }

  /** The user closed the session: end it everywhere, the remote agent included. */
  close(id: string): void {
    const s = this.sessions.get(id)
    if (s && isRemote(s.meta) && s.meta.remote?.tmux) {
      const { host, remote } = s.meta
      void killRemote(host, remote.tmux)
        .catch((err) => console.warn(`[remote] could not end ${remote.tmux} on ${host}: ${(err as Error).message}`))
        .finally(() => machineEvents.emit('poke', host))
      void revokeRemoteSession(id).catch(() => { /* nothing was issued */ })
    }
    this.kill(id, 'SIGKILL')
    if (s?.idleTimer) clearTimeout(s.idleTimer)
    this.sessions.delete(id)
    // An explicit close is the one thing that drops a session from the on-disk
    // registry; persist.ts listens for it.
    if (s) this.emit('closed', id)
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
    // A remote agent that is merely unreachable is still working: ⌘R then means
    // "reconnect", and relaunches (with resume) only if it really is gone.
    const reattach = isRemote(s.meta) && (!s.proc || s.meta.remote?.link !== 'attached')
    this.kill(id, 'SIGKILL')
    if (!reattach) s.buffer = ''
    this.start(s, { resume: s.meta.nativeSessionId, reattach })
  }

  /**
   * Paper is quitting. Unlike close(), this keeps every session's record (the
   * registry was flushed before this runs) so the next launch brings it back.
   * Local CLIs get SIGTERM and a short grace to flush their transcripts; a
   * remote session's kill() only drops the local ssh client, so its agent
   * keeps running in tmux. Blocks the quit for at most `graceMs`.
   */
  disposeAll(graceMs = 1200): void {
    const pids: number[] = []
    for (const [id, s] of this.sessions) {
      if (s.proc?.pid) pids.push(s.proc.pid)
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null }
      this.kill(id, 'SIGTERM')
    }
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
    const deadline = Date.now() + graceMs
    // before-quit is synchronous, so the grace has to be a blocking wait.
    while (pids.some(alive) && Date.now() < deadline) sleepSync(50)
    for (const pid of pids.filter(alive)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  }

  countByAccount(accountId: string): number {
    return [...this.sessions.values()].filter((s) => s.meta.accountId === accountId).length
  }

  byProvider(provider: ProviderId): Session[] {
    return [...this.sessions.values()].filter((s) => s.meta.provider === provider)
  }
}

/** Block the thread; only for quit/boot paths where the event loop must not run. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const sessionManager = new SessionManager()
