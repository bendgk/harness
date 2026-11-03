import { EventEmitter } from 'node:events'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { isAgent, providerFor } from './providers'
import { getAccount } from './accounts'
import { ensureReady, probeMachine, requireMachine } from './machines'
import { MachineFailure, assertAlias, download, upload } from './ssh'
import { codexDayPath, findRemoteRollout, killRemote, resolveRemoteDir, tmuxNameFor } from './remote'
import { delay, isRemote, remoteTranscript, type SessionManager } from './sessions'
import { remoteCachePath, type UsageTracker } from './usage'
import { which } from './shell-env'
import { revokeRemoteSession } from './gateway'
import { LOCAL_HOST, type MachineHandoffRequest, type MachineProbe, type SessionMeta } from '@shared/types'

export interface HandoffProgress {
  sessionId: string
  stage: string
  detail?: string
  done?: boolean
  error?: string
}

/**
 * Moving a live conversation between logins.
 *
 * Same provider: the CLI's own transcript is transplanted into the target
 * account's config home and resumed by id, so the agent comes back with every
 * message, tool result and file edit intact — a true handoff, not a restart.
 *
 * Different provider: transcripts are not interchangeable, so we distil the
 * conversation into a written brief and open the new agent with it.
 */
export class HandoffService extends EventEmitter {
  constructor(private sessions: SessionManager, private usage: UsageTracker) {
    super()
  }

  private report(p: HandoffProgress): void {
    this.emit('progress', p)
  }

  /**
   * Point a running session at a different directory.
   *
   * A shell is simply told to `cd`, which is what anyone would expect. An agent
   * cannot change its own working directory once launched, so its conversation
   * is carried into the new directory the same way it is carried between
   * accounts: transplant the transcript, relaunch with resume. The agent comes
   * back standing somewhere else, remembering everything.
   */
  async retarget(sessionId: string, cwd: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')
    const meta = session.meta
    if (meta.cwd === cwd) return
    // On another machine "a different directory" is a move within that machine.
    if (isRemote(meta) && isAgent(meta.provider)) return this.toMachine({ sessionId, host: meta.host, cwd })

    if (!isAgent(meta.provider)) {
      // Quote defensively: directory names may contain spaces or quotes.
      this.sessions.write(sessionId, ` cd ${shellQuote(cwd)}\r`)
      this.sessions.setCwd(sessionId, cwd)
      this.report({ sessionId, stage: 'Done', done: true })
      return
    }

    const provider = providerFor(meta.provider)
    const account = getAccount(meta.accountId)
    if (!account) throw new Error('Account went missing')

    try {
      this.sessions.setStatus(session, 'handoff')
      this.report({ sessionId, stage: 'Pausing agent' })
      this.sessions.interrupt(sessionId)
      await delay(300)
      this.report({ sessionId, stage: 'Closing session' })
      this.sessions.kill(sessionId, 'SIGTERM')
      await delay(450)

      const transcript =
        meta.transcriptPath && existsSync(meta.transcriptPath)
          ? meta.transcriptPath
          : provider.findTranscript({
              home: account.home,
              cwd: meta.cwd,
              since: session.startedAt,
              nativeSessionId: meta.nativeSessionId
            })

      const nativeId =
        meta.nativeSessionId || (transcript ? provider.readTranscript(transcript).nativeSessionId : undefined)

      if (transcript && nativeId) {
        this.report({ sessionId, stage: 'Moving conversation', detail: cwd })
        provider.transplant({ fromPath: transcript, toHome: account.home, cwd, nativeSessionId: nativeId })
        this.sessions.setCwd(sessionId, cwd)
        meta.transcriptPath = undefined
        this.usage.forget(sessionId)
        session.buffer = ''
        this.sessions.start(session, { resume: nativeId })
        this.sessions.notice(sessionId, `\r\n  ↪ now working in ${cwd} · context preserved\r\n\r\n`)
      } else {
        // Nothing said yet, so there is nothing to carry.
        this.sessions.setCwd(sessionId, cwd)
        session.buffer = ''
        this.sessions.start(session)
      }
      this.report({ sessionId, stage: 'Done', done: true })
    } catch (err) {
      const message = (err as Error).message
      this.report({ sessionId, stage: 'Failed', error: message, done: true })
      this.sessions.setStatus(session, 'exited')
      throw err
    }
  }

  async switchAccount(sessionId: string, targetAccountId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')
    const target = getAccount(targetAccountId)
    if (!target) throw new Error('Target account not found')
    const source = getAccount(session.meta.accountId)
    if (target.id === session.meta.accountId) return
    if (isRemote(session.meta)) {
      throw new Error(`This agent runs on @${session.meta.host} under that machine's own login. Hand it back to this Mac first.`)
    }

    const meta = session.meta
    const crossProvider = target.provider !== meta.provider
    const provider = providerFor(meta.provider)

    try {
      this.sessions.setStatus(session, 'handoff')
      this.report({ sessionId, stage: 'Pausing agent' })
      this.sessions.interrupt(sessionId)
      await delay(350)

      // Let the CLI flush its final transcript lines before we copy the file.
      this.report({ sessionId, stage: 'Closing session', detail: source?.label })
      this.sessions.kill(sessionId, 'SIGTERM')
      await delay(500)

      const transcript =
        meta.transcriptPath && existsSync(meta.transcriptPath)
          ? meta.transcriptPath
          : provider.findTranscript({
              home: source?.home || '',
              cwd: meta.cwd,
              since: session.startedAt,
              nativeSessionId: meta.nativeSessionId
            })

      meta.lineage.push({ accountId: target.id, at: Date.now(), nativeSessionId: meta.nativeSessionId })
      meta.accountId = target.id

      if (crossProvider) {
        await this.bridgeProviders(sessionId, transcript, target.provider)
        return
      }

      if (!transcript) {
        // Nothing said yet — a plain relaunch loses nothing.
        this.report({ sessionId, stage: 'Starting fresh', detail: 'no transcript yet' })
        this.sessions.start(session)
      } else {
        const nativeId = meta.nativeSessionId || provider.readTranscript(transcript).nativeSessionId
        if (!nativeId) throw new Error('Could not determine the conversation id to resume')

        this.report({ sessionId, stage: 'Transferring context', detail: `${countTurns(transcript)} messages` })
        provider.transplant({ fromPath: transcript, toHome: target.home, cwd: meta.cwd, nativeSessionId: nativeId })

        this.report({ sessionId, stage: 'Resuming', detail: target.label })
        meta.nativeSessionId = nativeId
        meta.transcriptPath = undefined // recomputed for the new home
        this.usage.forget(sessionId)
        session.buffer = ''
        this.sessions.start(session, { resume: nativeId })
      }

      this.sessions.notice(
        sessionId,
        `\r\n  ↪ handed off to ${target.label} · context preserved\r\n\r\n`
      )
      this.report({ sessionId, stage: 'Done', done: true })
    } catch (err) {
      const message = (err as Error).message
      this.report({ sessionId, stage: 'Failed', error: message, done: true })
      this.sessions.notice(sessionId, `\r\n  handoff failed: ${message}\r\n`)
      this.sessions.setStatus(session, 'exited')
      throw err
    }
  }

  /**
   * Move a session to another computer — or back to this one — with the
   * conversation intact.
   *
   * The order is what makes it safe: everything that can fail without side
   * effects (target reachable, CLI and tmux installed, logged in, directory
   * exists) is checked *before* the source is touched. Only then is the source
   * stopped, its final transcript fetched, transplanted to where the target
   * CLI looks for it, and the agent resumed there by id. If anything fails
   * after the source stopped, the source is relaunched where it was, resuming
   * the same conversation, and the error is reported with its hint.
   */
  async toMachine(req: MachineHandoffRequest): Promise<void> {
    const { sessionId } = req
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')
    const meta = session.meta
    const source = meta.host || LOCAL_HOST
    const target = req.host && req.host !== LOCAL_HOST ? assertAlias(req.host) : LOCAL_HOST
    const provider = providerFor(meta.provider)
    const agent = isAgent(meta.provider)
    const where = (h: string): string => (h === LOCAL_HOST ? 'this Mac' : `@${h}`)

    // ---- preflight: nothing below touches the source ------------------------
    let probe: MachineProbe | undefined
    let cwd: string
    let account = agent ? getAccount(meta.accountId) : undefined
    try {
      this.report({ sessionId, stage: 'Checking target', detail: where(target) })
      // A source we cannot reach is a source whose conversation we cannot fetch.
      if (isRemote(meta)) await ensureReady(meta.host, meta.provider)
      if (target !== LOCAL_HOST) {
        requireMachine(target)
        probe = await ensureReady(target, meta.provider)
        if (agent && !(meta.provider === 'claude' ? probe.claudeHome : probe.codexHome)) {
          throw new MachineFailure({
            kind: 'missing-tool',
            message: `Could not find ${provider.name}'s config folder on ${target}`,
            hint: `Run ${provider.bin} once on ${target} and log in, then retry.`
          })
        }
      } else if (agent) {
        if (!which(provider.bin)) {
          throw new MachineFailure({ kind: 'missing-tool', message: `${provider.name} is not installed on this Mac`, hint: `Install ${provider.bin}, then retry.` })
        }
        // The conversation lands in a local account's config home.
        account = account ?? (getAccount(meta.lineage.at(-1)?.accountId ?? '') || undefined)
        if (!account) throw new Error(`No local ${provider.name} account to resume under. Add one in Accounts (⌘,).`)
      }
      cwd = await this.resolveTargetCwd(meta, source, target, req.cwd)
      if (target === source && cwd === meta.cwd) {
        this.report({ sessionId, stage: 'Done', detail: 'already there', done: true })
        return
      }
    } catch (err) {
      this.failed(sessionId, err, 'handoff not started; the session is untouched')
      throw err
    }

    // What the source looked like, for a rollback.
    const before = {
      host: meta.host,
      cwd: meta.cwd,
      title: meta.title,
      accountId: meta.accountId,
      remote: meta.remote ? { ...meta.remote } : undefined,
      transcriptPath: meta.transcriptPath,
      nativeSessionId: meta.nativeSessionId,
      lineage: meta.lineage.length
    }
    const scratch = mkdtempSync(join(tmpdir(), 'paper-handoff-'))
    let stopped = false
    let launchedOnTarget = false

    try {
      // ---- stop the source --------------------------------------------------
      this.report({ sessionId, stage: 'Pausing agent', detail: where(source) })
      if (agent) this.sessions.interrupt(sessionId)
      this.sessions.setStatus(session, 'handoff')
      await delay(400)
      this.report({ sessionId, stage: 'Closing session', detail: where(source) })
      stopped = true
      if (isRemote(meta)) {
        await this.sessions.stopRemote(sessionId)
        // The source's Paper-tools token must not outlive the agent there.
        await revokeRemoteSession(sessionId).catch(() => {})
      } else {
        this.sessions.kill(sessionId, 'SIGTERM')
      }
      await delay(500)

      // ---- the final transcript, as a local file ------------------------------
      let transcript: string | undefined
      let nativeId = meta.nativeSessionId
      let rolloutName: string | undefined
      if (agent) {
        if (isRemote(meta)) {
          let remotePath = meta.remote?.transcriptPath
          if (!remotePath && meta.provider === 'codex') {
            const p = await probeMachine(meta.host, { maxAgeMs: 10 * 60_000 })
            if (p.codexHome) {
              remotePath = await findRemoteRollout(meta.host, p.codexHome, session.startedAt, nativeId, new Set())
            }
          }
          if (remotePath) {
            this.report({ sessionId, stage: 'Fetching conversation', detail: `from @${meta.host}` })
            const bytes = await download(meta.host, remotePath, 0)
            if (bytes && bytes.length) {
              rolloutName = basename(remotePath)
              transcript = join(scratch, rolloutName)
              writeFileSync(transcript, bytes, { mode: 0o600 })
            }
          }
        } else {
          transcript = meta.transcriptPath && existsSync(meta.transcriptPath)
            ? meta.transcriptPath
            : provider.findTranscript({
                home: getAccount(meta.accountId)?.home || '',
                cwd: meta.cwd,
                since: session.startedAt,
                nativeSessionId: meta.nativeSessionId
              })
          if (transcript) rolloutName = basename(transcript)
        }
        if (transcript && !nativeId) nativeId = provider.readTranscript(transcript).nativeSessionId
      }
      const carry = Boolean(transcript && nativeId)

      // ---- transplant ----------------------------------------------------------
      let remoteTranscriptPath: string | undefined
      if (carry) {
        this.report({ sessionId, stage: 'Moving conversation', detail: `${countTurns(transcript!)} messages → ${where(target)}` })
        if (target === LOCAL_HOST) {
          provider.transplant({ fromPath: transcript!, toHome: account!.home, cwd, nativeSessionId: nativeId! })
        } else {
          remoteTranscriptPath = meta.provider === 'claude'
            ? remoteTranscript(probe!.claudeHome!, cwd, nativeId!)
            : `${probe!.codexHome!.replace(/\/+$/, '')}/sessions/${codexDayPath()}/${rolloutName || `rollout-${nativeId}.jsonl`}`
          await upload(target, transcript!, remoteTranscriptPath)
        }
      }

      // ---- relaunch on the target ----------------------------------------------
      meta.host = target
      this.sessions.setCwd(sessionId, cwd)
      meta.remote = target === LOCAL_HOST
        ? undefined
        : { tmux: before.remote?.tmux ?? tmuxNameFor(meta.id), link: 'connecting', transcriptPath: remoteTranscriptPath }
      meta.transcriptPath = undefined
      if (carry && target !== LOCAL_HOST) {
        // Seed the local mirror with what we just sent, so usage continues
        // without re-downloading the whole conversation.
        const cache = remoteCachePath(target, meta.provider === 'claude' ? nativeId! : rolloutName || nativeId!)
        copyFileSync(transcript!, cache)
        meta.transcriptPath = cache
      }
      if (account && target === LOCAL_HOST) meta.accountId = account.id
      meta.nativeSessionId = carry ? nativeId : undefined
      if (meta.accountId) meta.lineage.push({ accountId: meta.accountId, at: Date.now(), nativeSessionId: meta.nativeSessionId, host: target })
      this.usage.forget(sessionId)
      session.buffer = ''
      this.report({ sessionId, stage: 'Resuming', detail: where(target) })
      launchedOnTarget = true
      // The continue prompt rides along as the CLI's own initial prompt rather
      // than being typed into the TUI: Claude may first show a dialog (trust
      // this folder?, whose default is "No, exit"), and keystrokes would answer
      // it. As an argument it is submitted only once the CLI is really ready.
      // `{cwd}` lets a caller that scheduled the move name the directory it could not know yet.
      const prompt = agent && req.continuePrompt ? req.continuePrompt.split('{cwd}').join(cwd) : undefined
      await this.sessions.launch(session, { resume: carry ? nativeId : undefined, prompt })

      this.sessions.notice(
        sessionId,
        `\r\n  ↪ handed off to ${where(target)}${agent ? (carry ? ' · context preserved' : ' · nothing said yet, started fresh') : ''} · ${cwd}\r\n\r\n`
      )
      this.report({ sessionId, stage: 'Done', done: true })
    } catch (err) {
      if (!stopped) {
        this.failed(sessionId, err, 'the session is untouched')
        this.sessions.setStatus(session, 'idle')
        throw err
      }
      await this.rollback(session, before, target, launchedOnTarget, err)
      throw err
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /** Put the session back where it was and resume it there. */
  private async rollback(
    session: NonNullable<ReturnType<SessionManager['get']>>,
    before: { host: string; cwd: string; title: string; accountId: string; remote?: SessionMeta['remote']; transcriptPath?: string; nativeSessionId?: string; lineage: number },
    target: string,
    launchedOnTarget: boolean,
    err: unknown
  ): Promise<void> {
    const meta = session.meta
    const sessionId = meta.id
    this.report({ sessionId, stage: 'Rolling back', detail: `resuming on ${before.host === LOCAL_HOST ? 'this Mac' : `@${before.host}`}` })
    // Never leave two agents on one conversation: end anything started on the target.
    this.sessions.kill(sessionId, 'SIGKILL')
    if (launchedOnTarget && target !== LOCAL_HOST && meta.remote?.tmux) {
      await killRemote(target, meta.remote.tmux).catch(() => {})
    }
    Object.assign(meta, {
      host: before.host,
      cwd: before.cwd,
      title: before.title,
      accountId: before.accountId,
      remote: before.remote ? { ...before.remote, link: 'connecting' as const } : undefined,
      transcriptPath: before.transcriptPath,
      nativeSessionId: before.nativeSessionId
    })
    meta.lineage.length = before.lineage
    this.usage.forget(sessionId)
    let restored = true
    try {
      await this.sessions.launch(session, { resume: before.nativeSessionId })
    } catch {
      restored = false
    }
    this.failed(sessionId, err, restored ? 'rolled back; the conversation resumed where it was' : 'could not resume the source either — press ⌘R')
  }

  private failed(sessionId: string, err: unknown, outcome: string): void {
    const info = err instanceof MachineFailure ? err.info : undefined
    // The overlay shows the hint on its own line: "<message>\n<hint>".
    const message = info ? (info.hint ? `${info.message}\n${info.hint}` : info.message) : (err as Error).message
    this.report({ sessionId, stage: 'Failed', error: message, detail: outcome, done: true })
    this.sessions.notice(
      sessionId,
      `\r\n  handoff failed: ${info?.message ?? (err as Error).message}\r\n${info?.hint ? `  ${info.hint}\r\n` : ''}  ${outcome}\r\n\r\n`
    )
  }

  /**
   * Where the session should stand on the target: the requested directory, the
   * machine's default, the same absolute path, or the same path relative to
   * $HOME (/Users/me/work/x → ~/work/x) — the first that exists. Fails with a
   * `remote-dir` error asking for a directory rather than guessing further.
   */
  private async resolveTargetCwd(meta: SessionMeta, source: string, target: string, requested?: string): Promise<string> {
    const sourceHome = source === LOCAL_HOST
      ? homedir()
      : (await probeMachine(source, { maxAgeMs: 10 * 60_000 }).catch(() => undefined))?.home
    const relative = sourceHome && (meta.cwd === sourceHome || meta.cwd.startsWith(`${sourceHome}/`))
      ? `~${meta.cwd.slice(sourceHome.length)}`
      : undefined
    const candidates = requested
      ? [requested]
      : [
          target !== LOCAL_HOST ? requireMachine(target).defaultCwd : undefined,
          meta.cwd.startsWith('/') ? meta.cwd : undefined,
          relative
        ].filter((c): c is string => Boolean(c))

    let found: string | undefined
    if (target === LOCAL_HOST) {
      found = candidates
        .map((c) => (c === '~' ? homedir() : c.startsWith('~/') ? join(homedir(), c.slice(2)) : c))
        .find((c) => c.startsWith('/') && isDir(c))
    } else {
      found = await resolveRemoteDir(target, candidates)
    }
    if (found) return found
    throw new MachineFailure({
      kind: 'remote-dir',
      message: `No working directory for this session on ${target === LOCAL_HOST ? 'this Mac' : target}`,
      hint: `Tried ${candidates.join(', ') || 'nothing'}. Pick a directory that exists there and hand off again with it.`
    })
  }

  /**
   * An agent asked to move *itself*: killing it now would cut its own tool
   * call off mid-turn and corrupt the conversation. Return at once and run the
   * handoff when the turn has ended (the session has been idle a moment).
   */
  scheduleToMachine(req: MachineHandoffRequest, timeoutMs = 10 * 60_000): void {
    const where = req.host === LOCAL_HOST ? 'this Mac' : `@${req.host}`
    this.report({ sessionId: req.sessionId, stage: 'Scheduled', detail: `moves to ${where} when the current turn ends` })
    void (async () => {
      const started = Date.now()
      let quietSince = 0
      for (;;) {
        const s = this.sessions.get(req.sessionId)
        if (!s) return
        if (s.meta.status === 'exited') break
        if (s.meta.status === 'idle') {
          if (!quietSince) quietSince = Date.now()
          if (Date.now() - quietSince >= 2500) break
        } else quietSince = 0
        if (Date.now() - started > timeoutMs) {
          this.failed(req.sessionId, new Error(`the agent was still busy after ${Math.round(timeoutMs / 60_000)} minutes`), 'handoff cancelled; the session is untouched')
          return
        }
        await delay(300)
      }
      await this.toMachine(req).catch(() => { /* reported in the pane and via progress */ })
    })()
  }

  /** Claude ⇄ Codex: carry the intent across as a written brief. */
  private async bridgeProviders(sessionId: string, transcript: string | undefined, to: string): Promise<void> {
    const session = this.sessions.get(sessionId)!
    const meta = session.meta
    this.report({ sessionId, stage: 'Writing handoff brief', detail: `to ${to}` })
    const brief = transcript ? buildBrief(transcript, meta.provider) : ''
    meta.provider = to as typeof meta.provider
    meta.nativeSessionId = undefined
    meta.transcriptPath = undefined
    this.usage.forget(sessionId)
    session.buffer = ''
    this.sessions.start(session, { prompt: brief || undefined })
    this.sessions.notice(
      sessionId,
      `\r\n  ↪ switched to ${to} · context carried over as a brief\r\n\r\n`
    )
    this.report({ sessionId, stage: 'Done', done: true })
  }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

/** POSIX single-quote escaping for a path typed into a shell. */
function shellQuote(p: string): string {
  return `'${p.split("'").join(`'\\''`)}'`
}

function countTurns(path: string): number {
  try {
    return readFileSync(path, 'utf8').split('\n').filter((l) => l.includes('"role"') || l.includes('"type":"user"')).length
  } catch {
    return 0
  }
}

/** Distil a transcript into a prompt the other CLI can pick up from. */
export function buildBrief(path: string, provider: string, maxTurns = 14): string {
  const turns: string[] = []
  let cwd = ''
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue
      let rec: any
      try { rec = JSON.parse(line) } catch { continue }
      cwd = rec.cwd || rec.payload?.cwd || cwd
      let role: string | undefined
      let text = ''
      if (provider === 'claude') {
        if (rec.type === 'user' || rec.type === 'assistant') {
          role = rec.type
          const c = rec.message?.content
          text = typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c.filter((x: any) => x.type === 'text').map((x: any) => x.text).join(' ')
              : ''
        }
      } else if (rec.type === 'response_item' && rec.payload?.type === 'message') {
        role = rec.payload.role
        const c = rec.payload.content
        text = Array.isArray(c) ? c.map((x: any) => x.text ?? '').join(' ') : String(c ?? '')
      }
      if (!role || !text) continue
      const clean = text.replace(/\s+/g, ' ').trim().slice(0, 500)
      if (clean) turns.push(`${role === 'user' ? 'Me' : 'Previous agent'}: ${clean}`)
    }
  } catch { /* fall through to whatever we gathered */ }

  const tail = turns.slice(-maxTurns)
  if (!tail.length) return ''
  return [
    'You are taking over an in-progress session from another coding agent.',
    cwd ? `Working directory: ${cwd}.` : '',
    'Here is the conversation so far:',
    '',
    ...tail,
    '',
    'Re-read any files you need to confirm the current state, then continue this work. Do not restart from scratch.'
  ]
    .filter(Boolean)
    .join('\n')
}
