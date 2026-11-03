/**
 * API-equivalent pricing, USD per million tokens. Subscription users are not
 * billed this, so the sidebar labels it "equivalent" — it is the honest way to
 * show the weight of a session without pretending to know a plan's true cost.
 */
export interface Price { input: number; output: number; cacheRead: number; cacheWrite: number }

const TABLE: Record<string, Price> = {
  'claude-opus-5':    { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5':  { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-5':            { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5-codex':      { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'o3':               { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }
}

const FALLBACK: Price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

export function priceFor(model?: string): Price {
  if (!model) return FALLBACK
  const key = Object.keys(TABLE).find((k) => model.includes(k))
  return key ? TABLE[key] : FALLBACK
}

export function costOf(
  model: string | undefined,
  t: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
): number {
  const p = priceFor(model)
  return (
    (t.inputTokens * p.input +
      t.outputTokens * p.output +
      t.cacheReadTokens * p.cacheRead +
      t.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  )
}

/** Context window sizes by model family. */
export function contextWindowFor(model?: string): number {
  if (!model) return 200_000
  if (model.includes('[1m]') || model.includes('-1m')) return 1_000_000
  if (model.startsWith('gpt-5')) return 272_000
  return 200_000
}
