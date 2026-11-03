import { useEffect, useRef, useState } from 'react'
import type { SessionStatus } from '@shared/types'

/**
 * A small ink creature that lives on the page. It watches the agent: it works
 * while the agent works, waits while you type, and sleeps when nothing is
 * running. Pure decoration — but it makes session state readable at a glance.
 */
const FRAMES: Record<string, string[]> = {
  working: ['(·̀ᴗ·́)', '(·̀ᴗ·́)ﾉ', '(ง·̀ᴗ·́)ง', '(·̀ᴗ·́)ﾉ'],
  idle: ['(￣ω￣)', '(￣ω￣)', '(・ω・)', '(￣ω￣)'],
  starting: ['(⊙_⊙)', '(⊙ω⊙)', '(◎_◎)', '(⊙ω⊙)'],
  handoff: ['(≧▽≦)', '(⌐■_■)', '(≧▽≦)', '(・∀・)'],
  exited: ['(－_－) zzZ', '(－_－) zzZ', '(－ω－) zzZ', '(－_－) zzZ'],
  none: ['( ˘ω˘ )', '( ˘ω˘ )', '( ･ω･ )', '( ˘ω˘ )']
}

const MOODS: Record<string, string> = {
  working: 'on it',
  idle: 'your move',
  starting: 'waking up',
  handoff: 'hopping accounts',
  exited: 'asleep',
  none: 'nothing to do'
}

export default function Pet({ name, status }: { name: string; status: SessionStatus | 'none' }): JSX.Element {
  const [frame, setFrame] = useState(0)
  const [pats, setPats] = useState(0)
  const workedRef = useRef(0)

  useEffect(() => {
    // Busier agent, livelier pet.
    const period = status === 'working' ? 420 : status === 'starting' ? 600 : 1400
    const t = setInterval(() => setFrame((f) => f + 1), period)
    return () => clearInterval(t)
  }, [status])

  useEffect(() => {
    if (status === 'working') workedRef.current += 1
  }, [status])

  const frames = FRAMES[status] ?? FRAMES.none
  const face = pats > 0 && Date.now() % 2 === 0 ? '(^ω^)' : frames[frame % frames.length]

  return (
    <button
      className="pet"
      onClick={() => setPats((p) => p + 1)}
      title={`Pat ${name}`}
    >
      <span className="pet-face mono">{face}</span>
      <span className="pet-meta">
        <span className="pet-name">{name}</span>
        <span className="pet-mood">{MOODS[status] ?? MOODS.none}</span>
      </span>
      {pats > 0 && <span className="pet-hearts mono">{'♥'.repeat(Math.min(3, pats))}</span>}
    </button>
  )
}
