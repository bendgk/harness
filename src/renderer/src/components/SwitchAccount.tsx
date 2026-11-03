import { useState } from 'react'
import Modal from './Modal'
import { useStore } from '../state/store'

/**
 * The switch sheet. Same-provider moves are lossless — the transcript follows
 * the session into the other account's home and resumes by id. Cross-provider
 * moves carry a written brief instead, and say so plainly.
 */
export default function SwitchAccount(): JSX.Element {
  const session = useStore((s) => s.activeSession())
  const accounts = useStore((s) => s.accounts)
  const setOverlay = useStore((s) => s.setOverlay)
  const switchAccount = useStore((s) => s.switchAccount)
  const [index, setIndex] = useState(0)
  const close = (): void => setOverlay(null)

  const options = accounts.filter((a) => a.id !== session?.accountId)
  const active = options[Math.min(index, options.length - 1)]

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, options.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
    if (e.key === 'Enter' && active) { e.preventDefault(); void switchAccount(active.id) }
  }

  if (!session) {
    return (
      <Modal title="Switch account" onClose={close}>
        <p className="sheet-note">Open a session first.</p>
      </Modal>
    )
  }

  return (
    <Modal
      title="Switch account"
      subtitle={`${session.title} · currently ${accounts.find((a) => a.id === session.accountId)?.label ?? '—'}`}
      onClose={close}
    >
      <div className="switch-list" tabIndex={0} onKeyDown={onKeyDown} autoFocus>
        {options.map((a, i) => {
          const lossless = a.provider === session.provider
          return (
            <button
              key={a.id}
              className={`switch-row ${a === active ? 'switch-active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => void switchAccount(a.id)}
            >
              <span className="acct-swatch" style={{ background: a.color }} />
              <span className="switch-label">
                {a.label}
                <span className="switch-prov">{a.provider === 'claude' ? 'Claude Code' : 'Codex'}</span>
              </span>
              <span className={`switch-mode ${lossless ? 'mode-exact' : 'mode-brief'}`}>
                {lossless ? 'full context' : 'brief handoff'}
              </span>
              {!a.authed && <span className="switch-warn">signed out</span>}
            </button>
          )
        })}
        {!options.length && <p className="sheet-note">No other accounts yet. Add one with ⌘,</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-note">
          {active?.provider === session.provider
            ? 'The conversation moves across intact: history, tool results and file edits.'
            : 'Different harness — the new agent receives a written brief of the work so far.'}
        </span>
      </footer>
    </Modal>
  )
}
