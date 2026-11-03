import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { isAgent, providerFor } from './providers'
import { getAccount } from './accounts'
import { delay, type SessionManager } from './sessions'
import type { UsageTracker } from './usage'

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
