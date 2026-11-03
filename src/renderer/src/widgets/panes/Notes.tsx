import { useEffect, useRef, useState } from 'react'
import type { PaneWidgetProps } from './types'

/** A ruled sheet for the thoughts that do not belong in a prompt. */
export default function Notes({ props, setProps }: PaneWidgetProps): JSX.Element {
  const [text, setText] = useState((props.text as string) ?? '')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Persist through the pane, debounced — every keystroke would rewrite state.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setProps({ text }), 500)
    return () => { if (timer.current) clearTimeout(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const words = text.trim() ? text.trim().split(/\s+/).length : 0

  return (
    <div className="notes">
      <textarea
        className="notes-area mono"
        value={text}
        placeholder="notes, scratch, a plan…"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="notes-foot mono">{words} {words === 1 ? 'word' : 'words'}</div>
    </div>
  )
}
