import { useEffect, useRef, useState } from 'react'
import type { PaneWidgetProps } from './types'

/**
 * Kumo — an ink-drawn companion who sits in a pane and watches the agent work.
 * Drawn from scratch in SVG so she inherits the paper palette, follows the
 * cursor with her eyes, blinks on her own, and changes expression with the
 * session: focused while the agent runs, expectant when it is your turn,
 * asleep once it exits.
 */
const LINES: Record<string, string[]> = {
  working: ['leave it to me', 'almost there…', 'thinking hard', 'nearly done!'],
  idle: ['your turn', 'what next?', 'waiting on you', 'ready when you are'],
  starting: ['waking up…', 'one moment', 'booting'],
  handoff: ['switching seats', 'hopping over', 'new account, same me'],
  exited: ['zzz…', 'all done', 'nap time'],
  none: ['open a session', 'nothing running', 'hello!']
}

export default function Companion({ props, setProps, agentStatus }: PaneWidgetProps): JSX.Element {
  const name = (props.name as string) || 'Kumo'
  const [blink, setBlink] = useState(false)
  const [gaze, setGaze] = useState({ x: 0, y: 0 })
  const [line, setLine] = useState(0)
  const [editing, setEditing] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)

  // Blink at irregular intervals — a fixed rhythm reads as mechanical.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const schedule = (): void => {
      timer = setTimeout(() => {
        setBlink(true)
        setTimeout(() => setBlink(false), 130)
        schedule()
      }, 2200 + Math.random() * 3800)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    const t = setInterval(() => setLine((n) => n + 1), 5200)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const box = hostRef.current?.getBoundingClientRect()
      if (!box) return
      const cx = box.left + box.width / 2
      const cy = box.top + box.height / 2.4
      const dx = (e.clientX - cx) / Math.max(box.width, 1)
      const dy = (e.clientY - cy) / Math.max(box.height, 1)
      setGaze({ x: Math.max(-1, Math.min(1, dx * 2)) * 2.2, y: Math.max(-1, Math.min(1, dy * 2)) * 1.6 })
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  const asleep = agentStatus === 'exited' || agentStatus === 'none'
  const working = agentStatus === 'working'
  const eyesShut = blink || asleep
  const lines = LINES[agentStatus] ?? LINES.none
  const speech = lines[line % lines.length]

  return (
    <div className="companion" ref={hostRef}>
      <svg className="companion-art" viewBox="0 0 200 215" role="img" aria-label={`${name}, an ink companion`}>
        {/* back hair: one closed shell whose inner edge frames the face */}
        <path
          className="hair"
          d="M100 20c-31 0-52 23-52 56v44c0 12-4 26-9 36-4 8 4 14 10 8 9-9 16-22 19-35V86c0-20 14-34 32-34s32 14 32 34v43c3 13 10 26 19 35 6 6 14 0 10-8-5-10-9-24-9-36V76c0-33-21-56-52-56z"
        />
        {/* neck and shoulders, drawn behind the face so their edges tuck under it */}
        <path className="ink-face" d="M85 132h30v22c0 9-30 9-30 0z" />
        <path className="ink-face" d="M56 212c1-25 15-39 44-42 29 3 43 17 44 42z" />
        {/* face */}
        <ellipse className="ink-face" cx="100" cy="106" rx="35" ry="41" />
        {/* bangs, with a parting so the face reads as a face */}
        <path
          className="hair"
          d="M66 92c0-22 15-38 34-38s34 16 34 38c-5-13-13-22-21-25-5 11-17 19-31 20-6 1-12 2-16 5z"
        />
        {/* side locks framing the cheeks */}
        <path className="hair" d="M65 92c-3 16-3 34 0 48 1 6-6 8-8 2-4-16-3-36 1-51 1-5 8-4 7 1z" />
        <path className="hair" d="M135 92c3 16 3 34 0 48-1 6 6 8 8 2 4-16 3-36-1-51-1-5-8-4-7 1z" />
        {/* the one accent: a ribbon clip */}
        <path className="accent-fill" d="M128 74c7-5 16-4 20 2 3 5 0 11-6 12-7 1-14-3-17-8-1-2 1-5 3-6z" />

        {/* eyes */}
        <g transform={`translate(${gaze.x} ${gaze.y})`}>
          {eyesShut ? (
            <>
              <path className="ink-stroke" d="M76 108c4 5 11 5 15 0" />
              <path className="ink-stroke" d="M109 108c4 5 11 5 15 0" />
            </>
          ) : (
            <>
              <ellipse className="eye-white" cx="83" cy="107" rx="9" ry={working ? 9 : 10.5} />
              <ellipse className="eye-white" cx="117" cy="107" rx="9" ry={working ? 9 : 10.5} />
              <ellipse className="ink-fill" cx="83" cy="107" rx="6" ry={working ? 6.5 : 7.5} />
              <ellipse className="ink-fill" cx="117" cy="107" rx="6" ry={working ? 6.5 : 7.5} />
              <circle className="eye-glint" cx="85.5" cy="103.5" r="2.4" />
              <circle className="eye-glint" cx="119.5" cy="103.5" r="2.4" />
              <path className="lash" d="M73 100c4-3 12-4 18-1" />
              <path className="lash" d="M109 99c6-3 14-2 18 1" />
            </>
          )}
        </g>
        {/* brows shift with mood */}
        <path className="ink-stroke thin" d={working ? 'M74 92l16 4' : 'M74 94l16 -3'} />
        <path className="ink-stroke thin" d={working ? 'M126 92l-16 4' : 'M126 94l-16 -3'} />

        <ellipse className="blush" cx="70" cy="120" rx="7.5" ry="4" />
        <ellipse className="blush" cx="130" cy="120" rx="7.5" ry="4" />

        {/* mouth */}
        {asleep ? (
          <path className="ink-stroke" d="M96 129c3 3 5 3 8 0" />
        ) : working ? (
          <path className="ink-stroke" d="M94 127c4 6 8 6 12 0" />
        ) : (
          <path className="ink-stroke" d="M95 128q5 5 10 0" />
        )}

        {/* collar */}
        <path className="ink-stroke thin" d="M84 160c6 10 26 10 32 0" />
        <path className="accent-stroke" d="M93 174c4 5 10 5 14 0" />

        {asleep && (
          <g className="zzz">
            <text x="150" y="66" className="zzz-text">z</text>
            <text x="161" y="52" className="zzz-text sm">z</text>
          </g>
        )}
      </svg>

      <div className="companion-say">
        <span className="bubble">{speech}</span>
      </div>

      {editing ? (
        <input
          className="companion-name-input mono"
          defaultValue={name}
          autoFocus
          onBlur={(e) => { setProps({ name: e.target.value.trim() || 'Kumo' }); setEditing(false) }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        />
      ) : (
        <button className="companion-name" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
          {name}
        </button>
      )}
    </div>
  )
}
