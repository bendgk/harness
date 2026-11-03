export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

export function usd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n > 0 && n < 0.01) return '<$0.01'
  return `$${n.toFixed(3)}`
}

export function pct(n: number): string {
  return `${Math.round(n)}%`
}

/** "2h 14m" — time remaining before a rate-limit window resets. */
export function until(ts?: number): string {
  if (!ts) return '—'
  const ms = ts - Date.now()
  if (ms <= 0) return 'now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function windowLabel(minutes: number): string {
  if (minutes >= 10080) return 'weekly'
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}-day`
  if (minutes >= 60) return `${Math.round(minutes / 60)}-hour`
  return `${minutes}-min`
}

export function elapsed(since: number): string {
  const s = Math.floor((Date.now() - since) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
