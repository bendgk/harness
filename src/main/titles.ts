import { getAccount } from './accounts'
import { aiTitle, firstUserPrompt, heuristicTitle } from './naming'
import { kernel } from './kernel'
import { providerFor } from './providers'
import type { SessionManager } from './sessions'

const CHECK_MS = 2500

/**
 * Tab names, in order of preference:
 *   1. a title the CLI generated itself (Claude Code writes `ai-title`),
 *   2. a title we ask the same CLI to write with a cheap one-shot call,
 *   3. keywords lifted from the first prompt.
 * The heuristic lands instantly so a tab is never left saying "Claude" while
 * the model call is in flight.
 */
export class TitleService {
  // A hot swap must not re-title every session, so attempts live in a kernel slot.
  private attempted = kernel().slot('titles.attempted', () => new Set<string>())
  private timer: NodeJS.Timeout | null = null

  constructor(private sessions: SessionManager) {}

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.tick(), CHECK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** A title straight from the provider's own transcript always wins. */
  adoptNative(sessionId: string, title: string): void {
    const meta = this.sessions.meta(sessionId)
    if (!meta || meta.title === title) return
    this.sessions.patchMeta(sessionId, { title, titleIsAi: true })
    this.attempted.add(sessionId)
  }

  private tick(): void {
    for (const meta of this.sessions.list()) {
      if (meta.titleIsAi || this.attempted.has(meta.id)) continue
      if (!meta.transcriptPath) continue
      const prompt = firstUserPrompt(meta.provider, meta.transcriptPath)
      if (!prompt) continue

      this.attempted.add(meta.id)
      this.sessions.patchMeta(meta.id, { title: heuristicTitle(prompt) })

      const account = getAccount(meta.accountId)
      if (!account) continue
      aiTitle(account, prompt)
        .then((title) => {
          // Don't clobber a name the user pinned while we were thinking.
          const current = this.sessions.meta(meta.id)
          if (current && !current.titleIsAi) {
            this.sessions.patchMeta(meta.id, { title, titleIsAi: true })
          }
        })
        .catch(() => { /* heuristic title stands */ })
    }
  }

  forget(sessionId: string): void {
    this.attempted.delete(sessionId)
  }

  /**
   * Back to the placeholder a fresh session gets, and eligible for naming
   * again — for a session whose title was taken from someone else's transcript.
   */
  reset(sessionId: string): void {
    const meta = this.sessions.meta(sessionId)
    if (!meta) return
    const provider = providerFor(meta.provider)
    this.attempted.delete(sessionId)
    this.sessions.patchMeta(sessionId, {
      title: provider.titleFor ? provider.titleFor(meta.cwd) : provider.name,
      titleIsAi: Boolean(provider.titleFor)
    })
  }
}
