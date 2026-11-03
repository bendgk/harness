import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { providerFor } from './providers'
import { getAccount } from './accounts'
import { kernel } from './kernel'
import { PAPER_HOME } from './paths'
import { download } from './ssh'
import { probeMachine } from './machines'
import { findRemoteRollout } from './remote'
import { isRemote, type SessionManager } from './sessions'
import type { ProviderId, SessionMeta, UsageSnapshot } from '@shared/types'

const POLL_MS = 1000
/** Remote transcripts cost an ssh round trip, so they are fetched far less often. */
const REMOTE_WORKING_MS = 4000
const REMOTE_IDLE_MS = 20_000

/**
 * Local mirror of a remote transcript: `~/.paper/remote/<alias>/<id>.jsonl`,
 * append-only, private. Pointing `meta.transcriptPath` at it keeps usage,
 * titles and naming working exactly as they do for local sessions.
 */
export function remoteCachePath(alias: string, nativeId: string): string {
  const dir = join(PAPER_HOME, 'remote', alias)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(join(PAPER_HOME, 'remote'), 0o700); chmodSync(dir, 0o700) } catch { /* best effort */ }
  return join(dir, `${basename(nativeId).replace(/\.jsonl$/, '')}.jsonl`)
}

interface RemotePoll {
  lastAt: number
  inflight: boolean
}

/** Codex rollout names end in the conversation's uuid. */
function idFromRollout(path: string): string | undefined {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1]
}
/** Burn-rate samples retained for the sparkline (one per poll). */
const BURN_SAMPLES = 90

function emptySnapshot(sessionId: string, provider: ProviderId): UsageSnapshot {
  return {
    sessionId,
    provider,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    contextTokens: 0,
    contextWindow: 200_000,
    messages: 0,
    burn: [],
    updatedAt: Date.now()
  }
}

interface Track {
  lastMtime: number
  lastTotal: number
  burn: number[]
  snapshot: UsageSnapshot
}

/**
 * Usage is read from the CLIs' own transcripts rather than guessed from the
 * terminal stream, so the numbers match what the provider actually billed.
 */
export class UsageTracker extends EventEmitter {
  // Kept in a kernel slot so burn history survives a hot swap of this module.
  private tracks = kernel().slot('usage.tracks', () => new Map<string, Track>())
  private remotePolls = kernel().slot('usage.remote', () => new Map<string, RemotePoll>())
  private timer: NodeJS.Timeout | null = null

  constructor(private sessions: SessionManager) {
    super()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  forget(sessionId: string): void {
    this.tracks.delete(sessionId)
    this.remotePolls.delete(sessionId)
  }

  snapshot(sessionId: string): UsageSnapshot | undefined {
    return this.tracks.get(sessionId)?.snapshot
  }

  all(): UsageSnapshot[] {
    return [...this.tracks.values()].map((t) => t.snapshot)
  }

  /**
   * Re-derive each live Claude session's conversation id from the argv its
   * process was launched with. The CLI is the authority on which conversation
   * it is writing; meta can drift from it (an older transcript scan bound fresh
   * sessions to a busy neighbour's file, then adopted that file's id). Runs
   * once per generation, so a hot swap repairs sessions that are already wrong.
   * Emits `rebound` per repaired session; `staleTitle` says its name came from
   * the other conversation.
   */
  reconcile(): void {
    const live = this.sessions.list().flatMap((meta) => {
      const pid = this.sessions.get(meta.id)?.proc?.pid
      // A remote session's local pid is ssh, whose argv says nothing about the conversation.
      return meta.provider === 'claude' && pid && !isRemote(meta) ? [{ meta, pid }] : []
    })
    if (!live.length) return

    let out = ''
    try {
      out = execFileSync('ps', ['-o', 'pid=,args=', '-p', live.map((s) => s.pid).join(',')], {
        encoding: 'utf8',
        timeout: 2000
      })
    } catch (err) {
      // ps exits non-zero when some pids are gone but still prints the rest.
      out = String((err as { stdout?: unknown }).stdout ?? '')
    }
    const launched = new Map<number, string>()
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s.*--(?:session-id|resume)[ =]([0-9a-f-]{36})/.exec(line)
      if (m) launched.set(Number(m[1]), m[2])
    }

    const before = live.map(({ meta }) => ({ ...meta }))
    for (const { meta, pid } of live) {
      const real = launched.get(pid)
      if (!real || real === meta.nativeSessionId) continue
      const wrongId = meta.nativeSessionId
      const wrongPath = meta.transcriptPath
      const provider = providerFor(meta.provider)

      const nativeTitle = wrongPath && existsSync(wrongPath) ? provider.readTranscript(wrongPath).title : undefined
      const staleTitle = meta.title === nativeTitle ||
        before.some((o) => o.id !== meta.id && o.nativeSessionId === wrongId && o.title === meta.title)

      const account = getAccount(meta.accountId)
      const transcriptPath = account
        ? provider.findTranscript({ home: account.home, cwd: meta.cwd, since: 0, nativeSessionId: real })
        : undefined
      this.sessions.patchMeta(meta.id, { nativeSessionId: real, transcriptPath })
      // Drop the borrowed numbers; the next tick reads the right file, if any yet.
      this.tracks.delete(meta.id)
      this.emit('usage', emptySnapshot(meta.id, meta.provider))
      this.emit('rebound', { sessionId: meta.id, staleTitle })
      console.log(`[usage] rebound ${meta.id}: ${wrongId ?? '-'} → ${real}${staleTitle ? ' (title reset)' : ''}`)
    }
  }

  private tick(): void {
    // Transcripts already bound to a live session; a fallback scan must not
    // hand one of them to a second session.
    const claimed = new Set(this.sessions.list().flatMap((m) => (m.transcriptPath ? [m.transcriptPath] : [])))
    const claimedRemote = new Set(this.sessions.list().flatMap((m) => (m.remote?.transcriptPath ? [m.remote.transcriptPath] : [])))
    for (const meta of this.sessions.list()) {
      const provider = providerFor(meta.provider)
      if (isRemote(meta)) {
        this.pollRemote(meta, claimedRemote)
        if (!meta.transcriptPath || !existsSync(meta.transcriptPath)) continue
      } else if (!meta.transcriptPath || !existsSync(meta.transcriptPath)) {
        // Codex names its own rollout file, so keep looking until it appears.
        const account = getAccount(meta.accountId)
        if (!account) continue
        const session = this.sessions.get(meta.id)
        const found = provider.findTranscript({
          home: account.home,
          cwd: meta.cwd,
          since: session?.startedAt ?? meta.createdAt,
          nativeSessionId: meta.nativeSessionId,
          exclude: claimed
        })
        if (!found) continue
        claimed.add(found)
        this.sessions.patchMeta(meta.id, { transcriptPath: found })
        meta.transcriptPath = found
      }

      let mtime: number
      try { mtime = statSync(meta.transcriptPath).mtimeMs } catch { continue }

      const track = this.tracks.get(meta.id)
      if (track && track.lastMtime === mtime) {
        // No new activity: record a zero so the sparkline decays honestly.
        this.pushBurn(track, 0)
        continue
      }

      const read = provider.readTranscript(meta.transcriptPath)
      if (read.nativeSessionId && read.nativeSessionId !== meta.nativeSessionId) {
        this.sessions.patchMeta(meta.id, { nativeSessionId: read.nativeSessionId })
      }
      if (read.title) this.emit('title', { sessionId: meta.id, title: read.title })

      const snapshot: UsageSnapshot = {
        sessionId: meta.id,
        provider: meta.provider,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        contextTokens: 0,
        contextWindow: 200_000,
        messages: 0,
        burn: track?.burn ?? [],
        updatedAt: Date.now(),
        ...read.usage
      }

      const next: Track = track ?? { lastMtime: 0, lastTotal: 0, burn: [], snapshot }
      const delta = Math.max(0, snapshot.totalTokens - next.lastTotal)
      next.lastTotal = snapshot.totalTokens
      next.lastMtime = mtime
      this.pushBurn(next, delta, snapshot)
      next.snapshot = { ...snapshot, burn: next.burn }
      this.tracks.set(meta.id, next)
      this.emit('usage', next.snapshot)
    }
  }

  /**
   * Mirror a remote transcript into the local cache, incrementally: only the
   * bytes past what the cache already holds cross the wire. Runs only while
   * the session's ssh link is attached (a dead link would just time out), and
   * every few seconds while the agent works, rarely while it idles.
   */
  private pollRemote(meta: SessionMeta, claimed: Set<string>): void {
    if (meta.provider === 'shell' || meta.remote?.link !== 'attached') return
    const poll = this.remotePolls.get(meta.id) ?? { lastAt: 0, inflight: false }
    this.remotePolls.set(meta.id, poll)
    // Decided at check time, so a session that starts working is polled soon, not after the idle interval.
    const every = meta.status === 'working' || meta.status === 'starting' ? REMOTE_WORKING_MS : REMOTE_IDLE_MS
    if (poll.inflight || Date.now() - poll.lastAt < every) return
    poll.inflight = true
    const alias = meta.host
    void (async () => {
      let path = meta.remote?.transcriptPath
      if (!path && meta.provider === 'codex') {
        const probe = await probeMachine(alias, { maxAgeMs: 10 * 60_000 })
        if (!probe.codexHome) return
        const session = this.sessions.get(meta.id)
        path = await findRemoteRollout(alias, probe.codexHome, session?.startedAt ?? meta.createdAt, meta.nativeSessionId, claimed)
        if (!path || !meta.remote) return
        claimed.add(path)
        const nativeSessionId = meta.nativeSessionId || idFromRollout(path)
        this.sessions.patchMeta(meta.id, { remote: { ...meta.remote, transcriptPath: path }, nativeSessionId })
      }
      if (!path) return
      const id = meta.provider === 'claude' ? meta.nativeSessionId || basename(path) : idFromRollout(path) || basename(path)
      const cache = remoteCachePath(alias, id)
      let offset = 0
      try { offset = statSync(cache).size } catch { /* first fetch */ }
      const chunk = await download(alias, path, offset)
      if (chunk && chunk.length) appendFileSync(cache, chunk, { mode: 0o600 })
      if (existsSync(cache) && meta.transcriptPath !== cache) this.sessions.patchMeta(meta.id, { transcriptPath: cache })
    })()
      .catch(() => { /* the link watcher reports connection problems; usage just waits */ })
      .finally(() => {
        poll.inflight = false
        poll.lastAt = Date.now()
      })
  }

  private pushBurn(track: Track, delta: number, snapshot?: UsageSnapshot): void {
    track.burn.push(delta)
    if (track.burn.length > BURN_SAMPLES) track.burn.shift()
    if (!snapshot) {
      track.snapshot = { ...track.snapshot, burn: [...track.burn], updatedAt: Date.now() }
      this.emit('usage', track.snapshot)
    }
  }
}
