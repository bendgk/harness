import { useEffect, useState } from 'react'
import type { PaneWidgetProps } from './types'

/** A printed clock face: hairline ticks, ink hands, one accent second hand. */
export default function AnalogClock({ props, setProps }: PaneWidgetProps): JSX.Element {
  const [now, setNow] = useState(() => new Date())
  const showSeconds = props.seconds !== false

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), showSeconds ? 1000 : 15_000)
    return () => clearInterval(t)
  }, [showSeconds])

  const s = now.getSeconds()
  const m = now.getMinutes() + s / 60
  const h = (now.getHours() % 12) + m / 60

  const hand = (angle: number, length: number, className: string): JSX.Element => {
    const rad = ((angle - 90) * Math.PI) / 180
    return (
      <line
        className={className}
        x1={100 - Math.cos(rad) * 12}
        y1={100 - Math.sin(rad) * 12}
        x2={100 + Math.cos(rad) * length}
        y2={100 + Math.sin(rad) * length}
      />
    )
  }

  return (
    <div className="clockface">
      <svg viewBox="0 0 200 200" className="clock-svg" role="img" aria-label={now.toLocaleTimeString()}>
        <circle className="clock-rim" cx="100" cy="100" r="88" />
        {Array.from({ length: 60 }, (_, i) => {
          const major = i % 5 === 0
          const rad = ((i * 6 - 90) * Math.PI) / 180
          const outer = 82
          const inner = major ? 71 : 78
          return (
            <line
              key={i}
              className={major ? 'tick tick-major' : 'tick'}
              x1={100 + Math.cos(rad) * inner}
              y1={100 + Math.sin(rad) * inner}
              x2={100 + Math.cos(rad) * outer}
              y2={100 + Math.sin(rad) * outer}
            />
          )
        })}
        {hand(h * 30, 44, 'hand hand-hour')}
        {hand(m * 6, 64, 'hand hand-minute')}
        {showSeconds && hand(s * 6, 70, 'hand hand-second')}
        <circle className="clock-pin" cx="100" cy="100" r="3.2" />
      </svg>
      <button
        className="clock-digital mono"
        onClick={() => setProps({ seconds: !showSeconds })}
        title="Toggle the second hand"
      >
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </button>
    </div>
  )
}
