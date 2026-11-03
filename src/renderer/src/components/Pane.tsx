import { useCallback, useRef, useState } from 'react'
import TerminalPane, { type TerminalHandle } from './TerminalPane'
import { useStore } from '../state/store'
import { PANE_WIDGETS, paneWidget } from '../widgets/panes'
import { CloseIcon, ContentsIcon, FolderIcon, SplitDownIcon, SplitRightIcon } from './Icons'
import type { DropZone, PaneContent, ProviderId, SessionMeta } from '@shared/types'
import { leaves } from '../state/tree'

const PROVIDER_NAME: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  shell: 'Terminal'
}
const PROVIDER_TAG: Record<ProviderId, string> = { claude: 'CC', codex: 'CX', shell: 'SH' }

const api = window.paper

/** Marks a drag as one of our panes, so stray drags are ignored. */
const PANE_MIME = 'application/x-paper-pane'

function StatusDot({ meta }: { meta: SessionMeta }): JSX.Element {
  const title =
    meta.status === 'working' ? 'Agent is working'
    : meta.status === 'idle' ? 'Waiting for you'
    : meta.status === 'handoff' ? 'Handing off'
    : meta.status === 'starting' ? 'Starting'
    : 'Exited'
  return <span className={`dot dot-${meta.status}`} title={title} />
}

/** A pane with nothing in it: choose a harness, or drop in a widget. */
function EmptyPane({ paneId }: { paneId: string }): JSX.Element {
  const spawn = useStore((s) => s.spawnInFocusedPane)
  const focusPane = useStore((s) => s.focusPane)
  const openWidget = useStore((s) => s.openWidget)
  const setOverlay = useStore((s) => s.setOverlay)
  const accounts = useStore((s) => s.accounts)
  const defaults = useStore((s) => s.defaults)
  const paneNode = useStore((s) => {
    const tab = s.activeTab()
    return tab ? leaves(tab.root).find((l) => l.id === paneId) : undefined
  })
  const [showWidgets, setShowWidgets] = useState(false)

  const cwd = (paneNode?.content.type === 'terminal' ? paneNode.content.cwd : undefined) ?? defaults.cwd

  const start = (provider: ProviderId): void => {
    focusPane(paneId)
    void spawn({ provider })
  }

  return (
    <div className="empty-pane">
      <div className="empty-inner fade-in">
        <p className="empty-title">Start a session</p>
        <div className="empty-actions">
          <button
            className="ghost-btn"
            onClick={() => start('claude')}
            title="Run Claude Code in this pane"
          >
            <span className="prov-dot prov-claude" /> Claude Code
          </button>
          <button
            className="ghost-btn"
            onClick={() => start('codex')}
            title="Run Codex in this pane"
          >
            <span className="prov-dot prov-codex" /> Codex
          </button>
          <button
            className="ghost-btn"
            onClick={() => start('shell')}
            title="Open a plain login shell in this pane"
          >
            <span className="prov-dot prov-shell" /> Terminal
          </button>
        </div>

        {/* Where it will start, and one click to change that. */}
        <button
          className="empty-dir"
          title="Choose the working directory (⌘L)"
          onClick={() => { focusPane(paneId); setOverlay('cwd') }}
        >
          <FolderIcon />
          <span className="mono">{shortPath(cwd)}</span>
        </button>

        <button
          className="empty-widget-toggle"
          onClick={() => setShowWidgets((v) => !v)}
          title="Put something other than a terminal in this pane"
        >
          {showWidgets ? 'hide widgets' : 'or place a widget'}
        </button>

        {showWidgets && (
          <div className="widget-grid fade-in">
            {PANE_WIDGETS.map((w) => (
              <button
                key={w.id}
                className="widget-chip"
                title={w.note}
                onClick={() => { focusPane(paneId); openWidget(w.id, paneId) }}
              >
                <span className="widget-glyph">{w.glyph}</span>
                <span className="widget-chip-name">{w.name}</span>
              </button>
            ))}
          </div>
        )}

        <p className="empty-hint mono">
          {accounts.length ? '⌘D split right · ⌘⇧D split down · drag a pane header to rearrange' : 'Add an account with ⌘, to begin'}
        </p>
      </div>
    </div>
  )
}

/**
 * Which edge of a pane the cursor is docking against.
 *
 * The edge bands scale with the pane but are clamped at both ends: a wide pane
 * keeps a generous centre target instead of a hair-thin one, and a narrow pane
 * stays dockable instead of being all centre. Depth is measured relative to
 * each band, so a corner resolves to the edge you are proportionally deeper
 * into rather than whichever happens to be nearer in raw pixels.
 */
function zoneFor(rect: DOMRect, x: number, y: number): DropZone {
  const px = (x - rect.left) / rect.width
  const py = (y - rect.top) / rect.height
  const band = (size: number): number => Math.min(0.35, Math.max(0.16, 72 / Math.max(size, 1)))
  const bx = band(rect.width)
  const by = band(rect.height)
  const nearest = [
    { zone: 'left' as const, depth: px / bx },
    { zone: 'right' as const, depth: (1 - px) / bx },
    { zone: 'top' as const, depth: py / by },
    { zone: 'bottom' as const, depth: (1 - py) / by }
  ].sort((a, b) => a.depth - b.depth)[0]
  return nearest.depth < 1 ? nearest.zone : 'center'
}

interface Props {
  paneId: string
  content: PaneContent
  focused: boolean
}

export default function Pane({ paneId, content, focused }: Props): JSX.Element {
  const sessionId = content.type === 'terminal' ? content.sessionId : null
  const meta = useStore((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const account = useStore((s) => s.accounts.find((a) => a.id === meta?.accountId))
  const focusPane = useStore((s) => s.focusPane)
  const setOverlay = useStore((s) => s.setOverlay)
  const split = useStore((s) => s.split)
  const killPane = useStore((s) => s.killPane)
  const dragging = useStore((s) => s.dragging)
  const setDragging = useStore((s) => s.setDragging)
  const setDragOver = useStore((s) => s.setDragOver)
  const dropPane = useStore((s) => s.dropPane)
  const setWidgetProps = useStore((s) => s.setWidgetProps)
  const agentStatus = useStore((s) => s.activeSession()?.status ?? 'none')

  const handle = useRef<TerminalHandle | null>(null)
  const register = useCallback((h: TerminalHandle | null) => { handle.current = h }, [])

  const widget = content.type === 'widget' ? paneWidget(content.widget) : undefined
  const title = meta?.title ?? widget?.name ?? 'Empty pane'

  return (
    <div
      className={`pane ${focused ? 'pane-focused' : ''} ${dragging === paneId ? 'pane-dragging' : ''}`}
      onMouseDown={() => focusPane(paneId)}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(PANE_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDragOver({ paneId, zone: zoneFor(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY) })
      }}
      onDrop={(e) => {
        const source = e.dataTransfer.getData(PANE_MIME) || dragging
        if (!source || source === paneId) { setDragOver(null); return }
        e.preventDefault()
        dropPane(source, paneId, zoneFor(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY))
      }}
    >
      <header
        className="pane-head"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(PANE_MIME, paneId)
          setDragging(paneId)
        }}
        onDragEnd={() => { setDragging(null); setDragOver(null) }}
        title="Drag to move this pane"
      >
        <span className="grip" aria-hidden="true">⠿</span>
        {meta ? <StatusDot meta={meta} /> : <span className="dot dot-idle" title="No session" />}
        <span className="pane-title">{title}</span>

        {meta && (
          <>
            <span className={`prov-tag prov-${meta.provider}`} title={PROVIDER_NAME[meta.provider]}>
              {PROVIDER_TAG[meta.provider]}
            </span>
            {meta.provider !== 'shell' && (
              <button
                className="acct-chip"
                title={`Account: ${account?.label ?? 'none'} — click to switch with full context (⌘P)`}
                onClick={(e) => { e.stopPropagation(); focusPane(paneId); setOverlay('switch') }}
              >
                <span className="acct-swatch" style={{ background: account?.color ?? 'var(--ink-ghost)' }} />
                {account?.label ?? 'no account'}
              </button>
            )}
            <button
              className="pane-cwd mono"
              title={`${meta.cwd} — click to change directory (⌘L)`}
              onClick={(e) => { e.stopPropagation(); focusPane(paneId); setOverlay('cwd') }}
            >
              {shortPath(meta.cwd)}
            </button>
            {meta.status === 'exited' && (
              <button
                className="ghost-btn tiny"
                title="Relaunch this session, keeping its conversation"
                onClick={() => void api.session.restart(meta.id)}
              >restart</button>
            )}
          </>
        )}

        <div className="pane-tools">
          <button
            className="pane-tool"
            title="Split right (⌘D)"
            onClick={(e) => { e.stopPropagation(); focusPane(paneId); void split('row') }}
          ><SplitRightIcon /></button>
          <button
            className="pane-tool"
            title="Split down (⌘⇧D)"
            onClick={(e) => { e.stopPropagation(); focusPane(paneId); void split('col') }}
          ><SplitDownIcon /></button>
          <button
            className="pane-tool"
            title="Change what this pane is showing (⌘J)"
            onClick={(e) => { e.stopPropagation(); focusPane(paneId); setOverlay('panewidgets') }}
          ><ContentsIcon /></button>
          <button
            className="pane-tool pane-tool-close"
            title="Close this pane (⌘X) — the last pane empties instead"
            onClick={(e) => { e.stopPropagation(); killPane(paneId) }}
          ><CloseIcon /></button>
        </div>
      </header>

      <div className="pane-body">
        {content.type === 'terminal'
          ? sessionId
            ? <TerminalPane sessionId={sessionId} focused={focused} register={register} />
            : <EmptyPane paneId={paneId} />
          : widget
            ? <widget.component
                paneId={paneId}
                props={content.props ?? {}}
                setProps={(p) => setWidgetProps(paneId, p)}
                agentStatus={agentStatus}
              />
            : <div className="empty-pane"><p className="empty-title">Unknown widget</p></div>}
      </div>

    </div>
  )
}

export function shortPath(p: string): string {
  const home = '/Users/'
  if (p.startsWith(home)) {
    const rest = p.slice(home.length).split('/').slice(1).join('/')
    return rest ? `~/${rest}` : '~'
  }
  return p
}
