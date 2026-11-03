import { useEffect, useRef } from 'react'

interface Props {
  title?: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
}

/** A sheet of paper laid over the page: hairline border, one soft shadow. */
export default function Modal({ title, subtitle, onClose, children, wide }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  // Callers hand us a fresh `onClose` on every render. Keeping it in a ref
  // means nothing below re-runs as the sheet's own state changes — focus, in
  // particular, is placed exactly once, when the sheet opens. Re-running the
  // focus step on every keystroke would yank the caret out of whatever input
  // the user is typing into and onto the sheet's first control.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // An open @-mention menu inside the sheet takes Esc for itself first.
      if ((e.target as HTMLElement | null)?.closest?.('[data-mention-open="true"]')) return
      e.stopPropagation()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    // Make the sheet keyboard-usable immediately — unless a control inside it
    // already took focus (autoFocus runs before effects), which always wins.
    const sheet = ref.current
    if (sheet && !sheet.contains(document.activeElement)) {
      sheet.querySelector<HTMLElement>('input, textarea, button, [tabindex]')?.focus()
    }
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="scrim" onMouseDown={() => onCloseRef.current()}>
      <div
        className={`sheet ${wide ? 'sheet-wide' : ''} fade-in`}
        ref={ref}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {title && (
          <header className="sheet-head">
            <span className="sheet-title">{title}</span>
            {subtitle && <span className="sheet-sub">{subtitle}</span>}
          </header>
        )}
        {children}
      </div>
    </div>
  )
}
