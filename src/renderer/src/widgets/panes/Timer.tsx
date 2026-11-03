import { useEffect, useState } from 'react'
import type { PaneWidgetProps } from './types'

const PRESETS = [5, 15, 25, 50]

/** A focus timer — a ring that empties while you work. */
export default function Timer({ props, setProps }: PaneWidgetProps): JSX.Element {
  const minutes = (props.minutes as number) ?? 25
  const endsAt = props.endsAt as number | undefined
  const [, tick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(t)
  }, [])

  const total = minutes * 60_000
  const remaining = endsAt ? Math.max(0, endsAt - Date.now()) : total
  const done = Boolean(endsAt) && remaining === 0
  const running = Boolean(endsAt) && !done
  const progress = total > 0 ? remaining / total : 0

  const mm = Math.floor(remaining / 60_000)
  const ss = Math.floor((remaining % 60_000) / 1000)
  const R = 78
  const C = 2 * Math.PI * R

  return (
    <div className="timer">
      <svg viewBox="0 0 200 200" className="timer-svg">
        <circle className="timer-track" cx="100" cy="100" r={R} />
        <circle
          className={`timer-arc ${done ? 'timer-done' : ''}`}
          cx="100" cy="100" r={R}
          strokeDasharray={C}
          strokeDashoffset={C * (1 - progress)}
          transform="rotate(-90 100 100)"
        />
      </svg>
      <div className="timer-read mono">
        {done ? 'done' : `${mm}:${String(ss).padStart(2, '0')}`}
      </div>
      <div className="timer-controls">
        {running || done ? (
          <button className="ghost-btn tiny" onClick={() => setProps({ endsAt: undefined })}>reset</button>
        ) : (
          <>
            {PRESETS.map((p) => (
              <button
                key={p}
                className={`ghost-btn tiny ${p === minutes ? 'seg-on' : ''}`}
                onClick={() => setProps({ minutes: p })}
              >{p}m</button>
            ))}
            <button className="solid-btn tiny" onClick={() => setProps({ endsAt: Date.now() + total })}>start</button>
          </>
        )}
      </div>
    </div>
  )
}
