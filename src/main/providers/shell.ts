import { basename } from 'node:path'
import { newActivity } from './activity'
import type { Provider, RemotePlan, SpawnPlan, TranscriptRead, TranscriptState } from './types'

/**
 * A plain login shell. It has no account, no transcript and no usage — it is
 * here so a pane can be an ordinary terminal beside the agents, and so `cd`
 * behaves the way it does everywhere else.
 */
export const shellProvider: Provider = {
  id: 'shell',
  name: 'Terminal',
  bin: process.env.SHELL || '/bin/zsh',
  homeEnv: '',
  interruptSequence: '\x03', // a shell wants Ctrl-C, not ESC

  plan({ cwd, prompt }): SpawnPlan {
    return {
      file: process.env.SHELL || '/bin/zsh',
      args: ['-l'],
      env: {},
      nativeSessionId: undefined,
      // A shell's "session name" is simply where it is standing.
      transcriptPath: undefined,
      initialInput: prompt
    }
  },

  remotePlan({ prompt }): RemotePlan {
    // The remote user's own login shell, whatever it is.
    return { bin: null, args: ['-l'], initialInput: prompt }
  },

  findTranscript(): string | undefined {
    return undefined
  },

  readTranscript(): TranscriptRead {
    return { usage: {} }
  },

  newState(): TranscriptState {
    return { v: 1, u: {}, act: newActivity(0) }
  },

  fold(): void { /* no transcript */ },

  summarize(): TranscriptRead {
    return { usage: {} }
  },

  transplant(): string {
    throw new Error('A terminal has no conversation to carry across')
  },

  oneShot(): SpawnPlan {
    throw new Error('A terminal cannot be asked to name itself')
  },

  titleFor(cwd: string): string {
    return basename(cwd) || 'terminal'
  }
}
