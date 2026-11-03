/** A ruled bar: filled ink on a sunken paper channel. Used by every gauge. */
export function Meter({ value, tone = 'ink' }: { value: number; tone?: 'ink' | 'warn' | 'danger' | 'good' }): JSX.Element {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div className="meter" role="meter" aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`meter-fill meter-${tone}`} style={{ width: `${clamped}%` }} />
    </div>
  )
}

/** Tone follows pressure: quiet until it matters, loud only when nearly spent. */
export function toneFor(p: number): 'ink' | 'warn' | 'danger' {
  return p >= 90 ? 'danger' : p >= 70 ? 'warn' : 'ink'
}

export function Spark({ data, height = 26 }: { data: number[]; height?: number }): JSX.Element {
  const width = 160
  const max = Math.max(1, ...data)
  const step = data.length > 1 ? width / (data.length - 1) : width
  const points = data.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 2) - 1).toFixed(1)}`)
  const d = points.length ? `M${points.join(' L')}` : ''
  const area = points.length ? `${d} L${width},${height} L0,${height} Z` : ''
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {area && <path d={area} className="spark-area" />}
      {d && <path d={d} className="spark-line" />}
    </svg>
  )
}
