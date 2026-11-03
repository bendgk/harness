import type { ProviderId, UsageSnapshot } from '@shared/types'

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

export interface TranscriptRead {
  usage: Partial<UsageSnapshot>
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
  plan(opts: { home: string; cwd: string; resume?: string; prompt?: string }): SpawnPlan
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
  /** Parse a transcript into usage + title. */
  readTranscript(path: string): TranscriptRead
  /** Copy a conversation into another account's home, returning the new transcript path. */
  transplant(opts: { fromPath: string; toHome: string; cwd: string; nativeSessionId: string }): string
  /** Argv for a one-shot, non-interactive prompt (used for titling). */
  oneShot(opts: { home: string; cwd: string; prompt: string }): SpawnPlan
  /** Keystrokes that interrupt the agent without killing the process. */
  interruptSequence: string
  /** A title derived without asking a model — used where there is no transcript. */
  titleFor?: (cwd: string) => string
}
