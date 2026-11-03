import type { ProviderId, UsageSnapshot } from '@shared/types'
import type { Activity } from './activity'

export interface SpawnPlan {
  file: string
  args: string[]
  env: Record<string, string>
  /** Predicted transcript path, when the provider lets us pin the id up front. */
  transcriptPath?: string
  nativeSessionId?: string
  /** Text typed into the process once it has booted. */
  initialInput?: string
}

/**
 * A launch on another machine. Only argv: no config home (the remote CLI uses
 * its own login there) and no Paper MCP config — the remote cannot reach
 * Paper's loopback server and we deliberately do not tunnel it.
 */
export interface RemotePlan {
  /** CLI looked up on the remote login PATH; null runs the remote user's login shell. */
  bin: string | null
  args: string[]
  nativeSessionId?: string
  /** Text typed into the process once it has booted. */
  initialInput?: string
}

export interface PlanOptions {
  home: string
  cwd: string
  resume?: string
  prompt?: string
  /** Extra system-prompt text (machine context); providers without a safe mechanism ignore it. */
  systemPrompt?: string
  /** Pin this id for a fresh conversation (providers that let us choose it). */
  sessionId?: string
  /** Remote only: path *on the remote* of the agent's 0600 MCP config for the Paper gateway. */
  mcpConfig?: string
  /** Local only: Paper's MCP endpoint, when agents get Paper tools (PAPER_MCP != 0). */
  mcpUrl?: string
  /** The Paper session id, sent as X-Paper-Session so tools know who is calling (local only; no secret). */
  paperSession?: string
  /** Claude only: extra settings JSON for `--settings` (wheel acceleration off, the @mention hook; see hooks.ts). */
  settings?: string
}

export interface TranscriptRead {
  usage: Partial<UsageSnapshot>
  title?: string
  nativeSessionId?: string
}

/**
 * Incremental transcript state: the provider's usage counters plus what the
 * agent is doing. Plain data (it lives in a kernel slot across hot swaps);
 * `v` is bumped whenever its shape changes, which makes the usage tracker
 * re-read the transcript from the start once.
 */
export interface TranscriptState {
  v: number
  /** Provider-private counters. */
  u: Record<string, any>
  act: Activity
  title?: string
  nativeSessionId?: string
}

export interface Provider {
  id: ProviderId
  /** Display name for the UI. */
  name: string
  /** Executable looked up on PATH. */
  bin: string
  /** Env var that isolates this provider's config home. */
  homeEnv: string
  /** Build the argv/env for a fresh or resumed session. */
  plan(opts: PlanOptions): SpawnPlan
  /** Build the argv for running on a remote machine under tmux. */
  remotePlan(opts: Omit<PlanOptions, 'home' | 'cwd'>): RemotePlan
  /**
   * Locate the transcript for a session started at `since` in `cwd`. Any
   * fallback scan must skip `exclude` (transcripts other live sessions own),
   * or two sessions started close together end up tailing the same file.
   */
  findTranscript(opts: {
    home: string
    cwd: string
    since: number
    nativeSessionId?: string
    exclude?: ReadonlySet<string>
  }): string | undefined
  /** Parse a whole transcript into usage + title (one-off reads: handoff, rebinding). */
  readTranscript(path: string): TranscriptRead
  /** Fresh state for reading a transcript incrementally (`keep` = condensed turns retained). */
  newState(keep?: number): TranscriptState
  /** Fold one parsed JSONL record into the state. Must not depend on seeing the file from the start beyond what the state holds. */
  fold(state: TranscriptState, rec: any): void
  /** Usage, title and conversation id from the state so far. */
  summarize(state: TranscriptState): TranscriptRead
  /** Copy a conversation into another account's home, returning the new transcript path. */
  transplant(opts: { fromPath: string; toHome: string; cwd: string; nativeSessionId: string }): string
  /** Argv for a one-shot, non-interactive prompt (used for titling). */
  oneShot(opts: { home: string; cwd: string; prompt: string }): SpawnPlan
  /** Keystrokes that interrupt the agent without killing the process. */
  interruptSequence: string
  /** A title derived without asking a model — used where there is no transcript. */
  titleFor?: (cwd: string) => string
}
