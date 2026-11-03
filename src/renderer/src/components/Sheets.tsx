import { useState } from 'react'
import Modal from './Modal'
import { useStore } from '../state/store'
import { PANE_WIDGETS } from '../widgets/panes'
import MentionField from './MentionField'
import { AliasChip } from './HostTag'
import { splitHint } from '../lib/machines'
import { LOCAL_HOST } from '@shared/types'

const api = window.paper

/**
 * Interrupt and redirect. The agent is stopped mid-turn and handed a new
 * instruction on the same conversation, so nothing it has already learned or
 * done is thrown away.
 */
export function SteerSheet(): JSX.Element {
  const session = useStore((s) => s.activeSession())
  const setOverlay = useStore((s) => s.setOverlay)
  const notify = useStore((s) => s.notify)
  const [text, setText] = useState('')
  const close = (): void => setOverlay(null)

  const send = (): void => {
    if (!session || !text.trim()) return
    void api.session.steer(session.id, text.trim())
    notify(session.status === 'working' ? 'Interrupted and redirected' : 'Prompt sent')
    close()
  }

  return (
    <Modal
      title={session?.status === 'working' ? 'Interrupt and steer' : 'Send a prompt'}
      subtitle={session?.title}
      onClose={close}
    >
      <MentionField
        name="steer"
        variant="steer"
        multiline
        rows={4}
        placeholder="Tell the agent what to do instead… (@ to mention an agent or machine)"
        selfSessionId={session?.id}
        value={text}
        autoFocus
        onChange={setText}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
        }}
      />
      <footer className="sheet-foot">
        <span className="sheet-note">
          ↩ send · ⇧↩ newline — the conversation keeps its full context
        </span>
        <button className="solid-btn" onClick={send}>send</button>
      </footer>
    </Modal>
  )
}

export function RenameSheet(): JSX.Element {
  const session = useStore((s) => s.activeSession())
  const tab = useStore((s) => s.activeTab())
  const setTabTitle = useStore((s) => s.setTabTitle)
  const setOverlay = useStore((s) => s.setOverlay)
  const [text, setText] = useState(tab?.title ?? '')
  const close = (): void => setOverlay(null)

  const save = (): void => {
    const title = text.trim()
    if (!title) return close()
    if (tab) setTabTitle(tab.id, title)
    if (session) void api.session.rename(session.id, title)
    close()
  }

  return (
    <Modal title="Rename" subtitle="Pins the name — auto-naming stops for this tab" onClose={close}>
      <input
        className="text-input mono"
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save() }}
      />
      <footer className="sheet-foot">
        <button className="ghost-btn" onClick={close}>cancel</button>
        <button className="solid-btn" onClick={save}>rename</button>
      </footer>
    </Modal>
  )
}

const WIDGETS: { id: string; name: string; note: string }[] = [
  { id: 'context', name: 'Context gauge', note: 'how full the model window is' },
  { id: 'usage', name: 'Token ledger', note: 'input, output, cache and cost' },
  { id: 'burn', name: 'Burn sparkline', note: 'token rate over the last minute or two' },
  { id: 'limits', name: 'Plan usage', note: 'session and weekly limits per account, like /usage' },
  { id: 'pet', name: 'Desk pet', note: 'a small creature that mirrors the agent' },
  { id: 'clock', name: 'Clock', note: 'the time, quietly' }
]

export function WidgetSheet(): JSX.Element {
  const widgets = useStore((s) => s.widgets)
  const setWidgets = useStore((s) => s.setWidgets)
  const setOverlay = useStore((s) => s.setOverlay)

  const toggle = (id: string): void => {
    const enabled = widgets.enabled.includes(id)
      ? widgets.enabled.filter((w) => w !== id)
      : [...widgets.enabled, id]
    setWidgets({ ...widgets, enabled })
  }

  return (
    <Modal title="Widgets" subtitle="What sits in the margin" onClose={() => setOverlay(null)}>
      <div className="widget-list">
        {WIDGETS.map((w) => (
          <label key={w.id} className="widget-row">
            <input
              type="checkbox"
              checked={widgets.enabled.includes(w.id)}
              onChange={() => toggle(w.id)}
            />
            <span className="widget-main">
              <span className="widget-name">{w.name}</span>
              <span className="widget-note">{w.note}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="widget-pet">
        <span className="label">Pet name</span>
        <input
          className="text-input mono"
          value={widgets.petName}
          onChange={(e) => setWidgets({ ...widgets, petName: e.target.value })}
        />
      </div>
    </Modal>
  )
}

/** Choose what the focused pane shows: an agent, or any widget. */
export function PaneWidgetSheet(): JSX.Element {
  const setOverlay = useStore((s) => s.setOverlay)
  const openWidget = useStore((s) => s.openWidget)
  const setContent = useStore((s) => s.setContent)
  const spawn = useStore((s) => s.spawnInFocusedPane)
  const tab = useStore((s) => s.activeTab())
  const close = (): void => setOverlay(null)
  const paneId = tab?.focusedPaneId

  return (
    <Modal title="Pane contents" subtitle="What this pane should show" onClose={close}>
      <div className="picker">
        <div className="label picker-group">Agents</div>
        <div className="widget-grid">
          <button
            className="widget-chip"
            title="Run Claude Code here"
            onClick={() => { close(); void spawn({ provider: 'claude' }) }}
          >
            <span className="widget-glyph prov-claude-ink">◧</span>
            <span className="widget-chip-name">Claude Code</span>
          </button>
          <button
            className="widget-chip"
            title="Run Codex here"
            onClick={() => { close(); void spawn({ provider: 'codex' }) }}
          >
            <span className="widget-glyph prov-codex-ink">◨</span>
            <span className="widget-chip-name">Codex</span>
          </button>
          <button
            className="widget-chip"
            title="Empty this pane back to the chooser"
            onClick={() => {
              if (paneId) setContent(paneId, { type: 'terminal', sessionId: null })
              close()
            }}
          >
            <span className="widget-glyph">◻</span>
            <span className="widget-chip-name">Empty</span>
          </button>
        </div>
        <div className="label picker-group">Widgets</div>
        <div className="widget-grid">
          {PANE_WIDGETS.map((w) => (
            <button
              key={w.id}
              className="widget-chip"
              title={w.note}
              onClick={() => { openWidget(w.id, paneId); close() }}
            >
              <span className="widget-glyph">{w.glyph}</span>
              <span className="widget-chip-name">{w.name}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

/**
 * A quiet progress line while a session moves between accounts or machines.
 * A failed machine move turns into a card that stays until dismissed, with
 * the hint — what the human has to do — set apart from the error itself.
 * When the agent moved itself, it says so, so the overlay is not a surprise.
 */
export function HandoffOverlay(): JSX.Element | null {
  const handoff = useStore((s) => s.handoff)
  const title = useStore((s) => (s.handoff ? s.sessions[s.handoff.sessionId]?.title : undefined))
  const dismiss = useStore((s) => s.dismissHandoff)
  const openMachines = useStore((s) => s.openMachines)
  if (!handoff) return null
  const target = handoff.target
  const where = target === LOCAL_HOST
    ? <span>this Mac</span>
    : target ? <AliasChip alias={target} /> : null

  if (handoff.error) {
    const { message, hint } = splitHint(handoff.error)
    return (
      <div className="handoff handoff-error fade-in" role="alert">
        <div className="handoff-err-main">
          <span className="handoff-err-title">
            Could not move {title ? <b>{title}</b> : 'the session'}{where && <> to {where}</>}
          </span>
          <span className="handoff-err-msg">{message}</span>
          {hint && <span className="handoff-hint">{hint}</span>}
          <span className="handoff-err-note">The session is unchanged and still running where it was.</span>
        </div>
        <div className="handoff-err-actions">
          {target && target !== LOCAL_HOST && (
            <button className="ghost-btn tiny" onClick={() => { dismiss(); openMachines({ focus: target }) }}>machine</button>
          )}
          <button className="ghost-btn tiny" onClick={dismiss}>dismiss</button>
        </div>
      </div>
    )
  }

  const byAgent = handoff.initiator === 'agent'
  return (
    <div className={`handoff fade-in ${byAgent ? 'handoff-agent' : ''}`}>
      <span className="handoff-spinner" />
      {byAgent && (
        <>
          <span className="handoff-who">{title ?? 'The agent'} is moving itself{where && <> to {where}</>}</span>
          <span className="status-sep">·</span>
        </>
      )}
      <span className={byAgent ? 'handoff-detail' : 'handoff-stage'}>{handoff.stage}</span>
      {handoff.detail && <span className="handoff-detail mono">{handoff.detail}</span>}
    </div>
  )
}

export function Toast(): JSX.Element | null {
  const toast = useStore((s) => s.toast)
  if (!toast) return null
  return <div className={`toast fade-in ${toast.tone === 'warn' ? 'toast-warn' : ''}`}>{toast.text}</div>
}

/** Incremental find across the focused terminal. */
export function FindBar({ onClose }: { onClose: () => void }): JSX.Element {
  const [q, setQ] = useState('')
  return (
    <div className="findbar fade-in">
      <input
        className="find-input mono"
        placeholder="find in session"
        value={q}
        autoFocus
        onChange={(e) => {
          setQ(e.target.value)
          window.dispatchEvent(new CustomEvent('paper:find', { detail: { q: e.target.value, forward: true } }))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter') {
            window.dispatchEvent(new CustomEvent('paper:find', { detail: { q, forward: !e.shiftKey } }))
          }
        }}
      />
      <button className="ghost-btn tiny" onClick={onClose}>done</button>
    </div>
  )
}
