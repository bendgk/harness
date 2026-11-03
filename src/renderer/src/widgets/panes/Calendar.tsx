import { useState } from 'react'
import type { PaneWidgetProps } from './types'

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** A month on paper. Today is circled in ink. */
export default function Calendar(_p: PaneWidgetProps): JSX.Element {
  const today = new Date()
  const [offset, setOffset] = useState(0)
  const view = new Date(today.getFullYear(), today.getMonth() + offset, 1)

  const year = view.getFullYear()
  const month = view.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  // Monday-first, which is how a week reads on a printed calendar.
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7

  const cells: (number | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1)
  ]

  const isToday = (d: number): boolean =>
    d === today.getDate() && month === today.getMonth() && year === today.getFullYear()

  return (
    <div className="cal">
      <div className="cal-head">
        <button className="cal-nav" onClick={() => setOffset(offset - 1)} title="Previous month">‹</button>
        <button className="cal-title" onClick={() => setOffset(0)} title="Back to this month">
          {view.toLocaleDateString([], { month: 'long', year: 'numeric' })}
        </button>
        <button className="cal-nav" onClick={() => setOffset(offset + 1)} title="Next month">›</button>
      </div>
      <div className="cal-grid mono">
        {DOW.map((d, i) => <span key={i} className="cal-dow">{d}</span>)}
        {cells.map((d, i) => (
          <span key={i} className={`cal-day ${d && isToday(d) ? 'cal-today' : ''}`}>{d ?? ''}</span>
        ))}
      </div>
    </div>
  )
}
