import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LOCAL_HOST, type AgentSummary } from '@shared/types'
import { useStore, type AgentCardState, type RenamingState } from '../state/store'
import { agentSummaries } from '../lib/agents'
import { ago } from '../lib/machines'
import { AliasChip } from './HostTag'
import Modal from './Modal'

/**
 * The violet `@name` chip — every reference to an agent wears it, the way
 * every machine reference wears the blue `@alias`. Always a span, so it can
 * sit inside a row button; hover shows the agent card.
 */
export function AgentChip({ name, size, title, card = 'left', onClick, onDoubleClick }: {
  name: string
  size?: 'sm' | 'md'
  title?: string
  /** Which side the hover card opens on; false for none. */
  card?: AgentCardState['side'] | false
  onClick?: (e: React.MouseEvent) => void
  onDoubleClick?: (e: React.MouseEvent) => void
}): JSX.Element {
  const hover = card ? agentHover(name, card) : {}
  const cls = `agent-chip mono ${size === 'md' ? 'alias-md' : ''} ${onClick || onDoubleClick ? 'alias-click' : ''}`
  return (
    <span className={cls} title={title} onClick={onClick} onDoubleClick={onDoubleClick} data-agent={name} {...hover}>
      @{name}
    </span>
  )
}

let showTimer: ReturnType<typeof setTimeout> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Mouse handlers that open the agent card beside an element after a short
 * dwell (instantly when a card is already up, so sweeping down a list reads
 * each one) and close it when the pointer leaves. Pure hover: no focus moves.
 */
export function agentHover(name: string, side: AgentCardState['side'], clearOf?: string): {
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void
  onMouseLeave: () => void
} {
  return {
    onMouseEnter: (e) => {
      const r = e.currentTarget.getBoundingClientRect()
      // `clearOf`: a container the card must not cover (the sidebar, the menu), so it sits beside that instead.
      const box = clearOf ? e.currentTarget.closest(clearOf)?.getBoundingClientRect() : undefined
      const card: AgentCardState = {
        name, side,
        rect: { left: box?.left ?? r.left, top: r.top, right: box?.right ?? r.right, bottom: r.bottom }
      }
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
      if (showTimer) clearTimeout(showTimer)
      const s = useStore.getState()
      if (s.renaming) return
      if (s.agentCard) s.showAgentCard(card)
      else showTimer = setTimeout(() => { showTimer = null; useStore.getState().showAgentCard(card) }, 350)
    },
    onMouseLeave: () => {
      if (showTimer) { clearTimeout(showTimer); showTimer = null }
      hideTimer = setTimeout(() => { hideTimer = null; useStore.getState().hideAgentCard() }, 90)
    }
  }
}

export function hideAgentCardNow(): void {
  if (showTimer) { clearTimeout(showTimer); showTimer = null }
  useStore.getState().hideAgentCard()
}

const STATUS_TEXT: Record<AgentSummary['status'], string> = {
  working: 'working', idle: 'waiting', starting: 'starting', handoff: 'moving', exited: 'exited', detached: 'detached'
}

const CARD_W = 288

/**
 * What another agent is up to, from agents.list(): what it is doing, the last
 * thing it was asked, its open todos, where it runs and when it last spoke.
 * A tooltip, not a dialog — never focusable, pointer-events none.
 */
export function AgentCard(): JSX.Element | null {
  const card = useStore((s) => s.agentCard)
  useStore((s) => s.agents)
  useStore((s) => s.sessions)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const agent = card ? agentSummaries(useStore.getState()).find((a) => a.name === card.name) : undefined

  useLayoutEffect(() => {
    if (!card || !ref.current) { setPos(null); return }
    const h = ref.current.offsetHeight
    const { rect } = card
    const vw = window.innerWidth
    const vh = window.innerHeight
    let side = card.side
    if (side === 'right' && rect.right + 10 + CARD_W > vw) side = 'left'
    if (side === 'left' && rect.left - 10 - CARD_W < 0) side = 'right'
    let left = side === 'left' ? rect.left - 10 - CARD_W : side === 'right' ? rect.right + 10 : rect.left
    let top = side === 'below' ? rect.bottom + 6 : rect.top - 6
    left = Math.max(8, Math.min(left, vw - CARD_W - 8))
    if (top + h > vh - 8) top = side === 'below' ? rect.top - 6 - h : vh - 8 - h
    setPos({ left, top: Math.max(8, top) })
  }, [card, agent?.doing, agent?.todos?.length, agent?.lastPrompt])

  if (!card || !agent) return null
  return <CardBody agent={agent} innerRef={ref} pos={pos} />
}

function CardBody({ agent, innerRef, pos }: {
  agent: AgentSummary
  innerRef: React.RefObject<HTMLDivElement>
  pos: { left: number; top: number } | null
}): JSX.Element {
  // Any click or keystroke means the user has moved on; so has a chip that unmounted under the pointer.
  useEffect(() => {
    const hide = (): void => hideAgentCardNow()
    window.addEventListener('mousedown', hide, true)
    window.addEventListener('keydown', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      window.removeEventListener('mousedown', hide, true)
      window.removeEventListener('keydown', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])
  const ref = innerRef
  const open =(agent.todos ?? []).filter((t) => t.status !== 'completed')
  const done = (agent.todos ?? []).length - open.length
  const remote = agent.host && agent.host !== LOCAL_HOST
  return createPortal(
    <div
      ref={ref}
      className="agent-card fade-in"
      role="tooltip"
      aria-label={`@${agent.name}`}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: CARD_W }}
    >
      <div className="agent-card-head">
        <span className={`dot dot-${agent.status}`} />
        <AgentChip name={agent.name} card={false} />
        <span className="agent-card-status">{STATUS_TEXT[agent.status]}</span>
        <span className={`prov-dot prov-${agent.provider}`} title={agent.provider === 'claude' ? 'Claude Code' : 'Codex'} />
      </div>
      <div className="agent-card-title">{agent.title}</div>
      {agent.doing && <div className="agent-card-doing">{agent.doing}</div>}
      {agent.lastPrompt && (
        <div className="agent-card-sec">
          <span className="label">last asked</span>
          <p className="agent-card-prompt">{agent.lastPrompt}</p>
        </div>
      )}
      {open.length > 0 && (
        <div className="agent-card-sec">
          <span className="label">todo{done ? <span className="agent-card-done"> · {done} done</span> : null}</span>
          <ul className="agent-card-todos">
            {open.slice(0, 5).map((t, i) => (
              <li key={i} className={`todo-${t.status}`}>
                <span className="todo-mark" aria-hidden="true">{t.status === 'in_progress' ? '◐' : '○'}</span>
                <span>{t.text}</span>
              </li>
            ))}
            {open.length > 5 && <li className="todo-more">+{open.length - 5} more</li>}
          </ul>
        </div>
      )}
      <div className="agent-card-foot mono">
        {remote ? <AliasChip alias={agent.host} /> : <span>this Mac</span>}
        {agent.cwd && <span className="agent-card-cwd">{tildePath(agent.cwd)}</span>}
        <span className="agent-card-when">{agent.lastActiveAt ? ago(agent.lastActiveAt) : ''}</span>
      </div>
    </div>,
    document.body
  )
}

function tildePath(p: string): string {
  const m = p.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/)
  return m ? `~${m[1] ?? ''}` : p
}

/** Put the keyboard back in the focused terminal (after an inline editor closes). */
export function refocusTerminal(): void {
  requestAnimationFrame(() => window.dispatchEvent(new Event('paper:refocus')))
}

/**
 * The inline callsign editor, shown wherever `renaming.where` says (a tree
 * row, the SESSION card, the rename sheet). `@` + a lowercase field, live
 * validation underneath, ↩ saves, Esc cancels; main's own refusal (taken,
 * invalid) lands in the same line.
 */
export function AgentNameEditor({ where, sessionId, inline = true }: {
  where: RenamingState['where']
  sessionId: string
  inline?: boolean
}): JSX.Element | null {
  const r = useStore((s) => s.renaming)
  const setDraft = useStore((s) => s.setRenameDraft)
  const commit = useStore((s) => s.commitRename)
  const cancel = useStore((s) => s.cancelRename)
  if (!r || r.where !== where || r.sessionId !== sessionId) return null
  const bad = !!r.error
  return (
    <span className={`agent-edit ${inline ? 'agent-edit-inline' : ''}`} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <span className={`agent-edit-box ${bad ? 'agent-edit-bad' : ''}`}>
        <span className="agent-at mono">@</span>
        <input
          className="mono"
          value={r.draft}
          autoFocus
          spellCheck={false}
          maxLength={20}
          aria-label="Agent name"
          aria-invalid={bad}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value.toLowerCase().replace(/\s+/g, ''))}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              void commit().then((ok) => { if (ok && inline) refocusTerminal() })
            } else if (e.key === 'Escape' && inline) {
              e.preventDefault()
              cancel()
              refocusTerminal()
            }
          }}
          onBlur={() => { if (inline && !useStore.getState().renaming?.saving) cancel() }}
        />
        {r.saving && <span className="mini-spin agent-edit-spin" />}
      </span>
      <span className={`agent-edit-msg ${bad ? 'agent-edit-msg-bad' : ''}`} role={bad ? 'alert' : undefined}>
        {r.error ?? (r.saving ? 'saving…' : '↩ save · esc cancel')}
      </span>
    </span>
  )
}

/** "Rename agent…" from the palette or menu: the same editor on a small sheet. */
export function AgentNameSheet(): JSX.Element | null {
  const r = useStore((s) => s.renaming)
  const cancel = useStore((s) => s.cancelRename)
  const setOverlay = useStore((s) => s.setOverlay)
  const title = useStore((s) => (s.renaming ? s.sessions[s.renaming.sessionId]?.title : undefined))
  const commit = useStore((s) => s.commitRename)
  const close = (): void => { cancel(); setOverlay(null) }
  if (!r || r.where !== 'sheet') return null
  return (
    <Modal title="Rename agent" subtitle={title} onClose={close}>
      <div className="sheet-pad agent-sheet">
        <AgentNameEditor where="sheet" sessionId={r.sessionId} inline={false} />
        <p className="sheet-note">
          Short and memorable — other agents and you mention it as <span className="agent-chip mono">@{r.draft || r.current}</span>.
          Lowercase letters and digits, 2–16 characters, not a machine&apos;s alias.
        </p>
      </div>
      <footer className="sheet-foot">
        <button className="ghost-btn" onClick={close}>cancel</button>
        <button className="solid-btn" disabled={!!r.error || r.saving} onClick={() => void commit()}>rename</button>
      </footer>
    </Modal>
  )
}
