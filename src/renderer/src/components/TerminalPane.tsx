import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useStore } from '../state/store'
import { termTheme } from './term-theme'
import MentionMenu, { menuHeight } from './MentionMenu'
import { MentionHighlighter, MentionTracker, locateToken, type MentionKind } from '../lib/term-mentions'
import { completionKeys } from '../lib/machines'
import { agentSummaries, knownAgentNames, mentionTargets } from '../lib/agents'
import type { ProviderId } from '@shared/types'

const api = window.paper

interface Props {
  sessionId: string
  focused: boolean
  provider?: ProviderId
  /** Registers imperative handles so the app can search/clear this pane. */
  register?: (handle: TerminalHandle | null) => void
}

export interface TerminalHandle {
  search: (q: string, forward?: boolean) => void
  clear: () => void
  focus: () => void
}

/**
 * Decoration colours must be opaque #RRGGBB, so the tag wash is pre-mixed onto
 * each paper. Machines are fountain-pen blue; agents the violet beside it
 * (same ink weight and wash depth, so the two read as siblings) — they match
 * --host / --agent in theme.css.
 */
const MENTION_COLORS: Record<'day' | 'night', Record<MentionKind, { fg: string; bg: string }>> = {
  day: { machine: { fg: '#2a5fae', bg: '#e1e9f5' }, agent: { fg: '#6a48a8', bg: '#ebe5f5' } },
  night: { machine: { fg: '#9cc3f3', bg: '#1d2836' }, agent: { fg: '#c4b0f2', bg: '#261f36' } }
}

/** Where the dropdown sits, in pane-body pixels. */
interface Anchor { left: number; top?: number; bottom?: number; placement: 'above' | 'below' }

export default function TerminalPane({ sessionId, focused, provider, register }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const highlightRef = useRef<MentionHighlighter | null>(null)
  const theme = useStore((s) => s.theme)
  const fontSize = useStore((s) => s.fontSize)
  const machines = useStore((s) => s.machines)
  const nameKey = useStore((s) => knownAgentNames(s).join(' '))
  // The dropdown re-renders when fresh summaries (what each agent is doing) arrive.
  useStore((s) => (s.mention?.owner === `term:${sessionId}` ? s.agents : null))
  const owner = `term:${sessionId}`
  const mention = useStore((s) => (s.mention?.owner === owner ? s.mention : null))
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const themeRef = useRef(theme)
  themeRef.current = theme
  // Re-anchoring is driven from xterm callbacks, which must not capture stale state.
  const placeRef = useRef<() => void>(() => {})
  const acceptRef = useRef<(alias: string) => void>(() => {})

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize,
      lineHeight: 1.32,
      letterSpacing: 0.2,
      theme: termTheme(theme),
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      allowProposedApi: true,
      scrollback: 20000,
      smoothScrollDuration: 0,
      macOptionIsMeta: true,
      // Paper margins: the text should never touch the edge of the sheet.
      drawBoldTextInBrightColors: false
    })

    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon((_e, uri) => void api.openExternal(uri)))
    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'

    term.open(host)

    // GPU rendering keeps long agent streams smooth; fall back silently if the
    // context is lost (external display changes, GPU switch on Apple silicon).
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* canvas/DOM renderer still works */
    }

    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    // The attach reply and resize observations can land after this effect has
    // been torn down (StrictMode's double mount, a quick pane swap); fitting a
    // disposed terminal throws from deep inside xterm.
    let disposed = false
    const sendResize = (): void => {
      if (disposed) return
      try {
        fit.fit()
        api.session.resize(sessionId, term.cols, term.rows)
      } catch { /* pane is hidden or mid-teardown */ }
    }
    sendResize()

    // ---- @-mention autocomplete -------------------------------------------
    // The tracker watches keystrokes on their way to the pty; while it holds a
    // token that matches an agent or a machine, the dropdown is open and the key handler
    // below claims ↑ ↓ Tab ↩ Esc. Every other key passes straight through.
    const tracker = new MentionTracker()
    const store = useStore.getState
    const mine = (): ReturnType<typeof store>['mention'] => {
      const m = store().mention
      return m?.owner === owner ? m : null
    }
    const refresh = (): void => {
      const q = tracker.query
      // Full-screen programs in a plain shell (vim, less) have their own use for @.
      const fullscreen = provider === 'shell' && term.buffer.active.type === 'alternate'
      // This pane's own agent is never offered: mentioning yourself is noise.
      const { matches, agents } = q === null || fullscreen ? { matches: [], agents: 0 } : mentionTargets(q, store(), sessionId)
      if (!matches.length) {
        if (mine()) store().setMention(null)
        return
      }
      const prev = mine()
      // Opening the menu is when "what is everyone doing" is worth re-reading.
      if (!prev) void store().refreshAgents()
      const index = prev && prev.matches[prev.index] ? Math.max(0, matches.indexOf(prev.matches[prev.index])) : 0
      // A bare "@" only advertises: in Claude Code it is also the file picker,
      // so keys are not taken until the user has typed toward an agent or machine.
      store().setMention({ owner, query: q!, matches, agents, index, passive: q === '' })
      placeRef.current()
    }
    const close = (boundary: boolean): void => {
      tracker.reset(boundary)
      if (mine()) store().setMention(null)
    }
    const accept = (alias: string): void => {
      const q = tracker.query ?? ''
      // Written straight to the pty, not through term.input, so the tracker
      // does not see its own completion as typing.
      void api.session.write(sessionId, completionKeys(q, alias))
      close(true)
    }
    acceptRef.current = accept

    const disposeData = term.onData((d) => {
      void api.session.write(sessionId, d)
      tracker.feed(d)
      if (tracker.query !== null || mine()) refresh()
    })
    const disposeBinary = term.onBinary((d) => void api.session.write(sessionId, d))

    // keydown is acted on; its keypress/keyup twins are swallowed too, or
    // Enter's keypress would still reach the program as a carriage return.
    let swallow: string | null = null
    term.attachCustomKeyEventHandler((ev) => {
      if (swallow && ev.key === swallow && ev.type !== 'keydown') {
        if (ev.type === 'keyup') swallow = null
        return false
      }
      const m = mine()
      if (!m || m.passive || ev.type !== 'keydown' || ev.metaKey || ev.ctrlKey || ev.altKey) return true
      const take = (): false => { ev.preventDefault(); ev.stopPropagation(); swallow = ev.key; return false }
      switch (ev.key) {
        case 'ArrowDown':
          store().setMention({ ...m, index: (m.index + 1) % m.matches.length })
          return take()
        case 'ArrowUp':
          store().setMention({ ...m, index: (m.index - 1 + m.matches.length) % m.matches.length })
          return take()
        case 'Tab':
          if (ev.shiftKey) return true
          accept(m.matches[m.index])
          return take()
        case 'Enter':
          accept(m.matches[m.index])
          return take()
        case 'Escape':
          close(false)
          return take()
        default:
          return true
      }
    })

    // A click can move the cursor anywhere, and leaving the pane abandons the token.
    const onMouse = (): void => close(false)
    host.addEventListener('mousedown', onMouse)
    const textarea = term.textarea
    const onBlur = (): void => close(false)
    textarea?.addEventListener('blur', onBlur)

    // ---- @alias (blue) and @agent (violet) tags -----------------------------
    // Clicking a machine opens its details; clicking an agent goes to it,
    // exactly as the tree does (its tab, a new tab, or adopt then a new tab).
    const highlighter = new MentionHighlighter(
      term,
      (kind) => MENTION_COLORS[themeRef.current][kind],
      (kind, target) => { if (kind === 'agent') void store().goToAgent(target); else store().openMachines({ focus: target }) }
    )
    highlighter.setTargets(store().machines.map((m) => m.alias), knownAgentNames(store()))
    highlightRef.current = highlighter

    // Keep the dropdown glued to the token as the program echoes and redraws.
    let raf = 0
    const replace = (): void => {
      if (!mine() || raf) return
      raf = requestAnimationFrame(() => { raf = 0; placeRef.current() })
    }
    const disposeWrite = term.onWriteParsed(replace)

    placeRef.current = () => {
      const m = mine()
      const body = host.parentElement
      const screen = term.element?.querySelector('.xterm-screen')
      if (!m || !body || !screen) { setAnchor(null); return }
      const b = body.getBoundingClientRect()
      const r = screen.getBoundingClientRect()
      const cellW = r.width / term.cols
      const cellH = r.height / term.rows
      const { row, col } = locateToken(term, m.query)
      const rowTop = r.top - b.top + row * cellH
      const left = Math.max(6, Math.min(r.left - b.left + col * cellW - 9, b.width - 340))
      // Above the line by default: Claude Code draws its own picker below its input.
      const all = agentSummaries(store())
      const shownAgents = m.matches.slice(0, m.agents).map((n) => all.find((a) => a.name === n)).filter((a): a is NonNullable<typeof a> => !!a)
      const need = menuHeight(shownAgents, m.matches.length - m.agents)
      setAnchor(rowTop >= need + 8
        ? { left, bottom: b.height - rowTop + 4, placement: 'above' }
        : { left, top: rowTop + cellH + 4, placement: 'below' })
    }

    // Replay scrollback so a re-mounted pane looks untouched.
    void api.session.attach(sessionId).then(({ scrollback }) => {
      if (disposed) return
      if (scrollback) term.write(scrollback)
      sendResize()
    })

    const off = api.onPtyData((p) => {
      if (p.sessionId === sessionId) term.write(p.data)
    })

    const ro = new ResizeObserver(() => sendResize())
    ro.observe(host)

    register?.({
      search: (q, forward = true) => (forward ? search.findNext(q) : search.findPrevious(q)),
      clear: () => term.clear(),
      focus: () => term.focus()
    })

    return () => {
      disposed = true
      register?.(null)
      off()
      ro.disconnect()
      disposeData.dispose()
      disposeBinary.dispose()
      disposeWrite.dispose()
      cancelAnimationFrame(raf)
      host.removeEventListener('mousedown', onMouse)
      textarea?.removeEventListener('blur', onBlur)
      highlighter.dispose()
      highlightRef.current = null
      if (mine()) store().setMention(null)
      term.dispose()
      termRef.current = null
    }
    // A terminal instance is bound to one session for its whole life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = termTheme(theme)
    highlightRef.current?.repaint()
  }, [theme])

  // Registering or removing a machine, or naming/renaming an agent, changes what gets painted.
  const aliasKey = machines.map((m) => m.alias).join(' ')
  useEffect(() => {
    highlightRef.current?.setTargets(aliasKey ? aliasKey.split(' ') : [], nameKey ? nameKey.split(' ') : [])
  }, [aliasKey, nameKey])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    try {
      fitRef.current?.fit()
      api.session.resize(sessionId, term.cols, term.rows)
    } catch { /* ignore */ }
  }, [fontSize, sessionId])

  useEffect(() => {
    if (focused) termRef.current?.focus()
  }, [focused])

  // Find and clear are app-level commands, but only the focused pane answers.
  useEffect(() => {
    if (!focused) return
    const onFind = (e: Event): void => {
      const { q, forward } = (e as CustomEvent<{ q: string; forward: boolean }>).detail
      if (q) searchRef.current?.[forward ? 'findNext' : 'findPrevious'](q)
    }
    const onClear = (): void => termRef.current?.clear()
    // An inline editor elsewhere (agent rename in the tree) hands the keyboard back.
    const onRefocus = (): void => termRef.current?.focus()
    window.addEventListener('paper:find', onFind)
    window.addEventListener('paper:clear', onClear)
    window.addEventListener('paper:refocus', onRefocus)
    return () => {
      window.removeEventListener('paper:find', onFind)
      window.removeEventListener('paper:clear', onClear)
      window.removeEventListener('paper:refocus', onRefocus)
    }
  }, [focused])

  // Opening (or re-filtering) the menu re-measures; closing drops the anchor.
  const mentionKey = mention ? `${mention.query}|${mention.matches.length}` : ''
  useEffect(() => {
    if (mentionKey) placeRef.current()
    else setAnchor(null)
  }, [mentionKey])

  const all = mention && anchor ? agentSummaries(useStore.getState()) : []
  const shownAgents = mention && anchor
    ? mention.matches.slice(0, mention.agents).map((n) => all.find((a) => a.name === n)).filter((a): a is NonNullable<typeof a> => !!a)
    : []
  const shownMachines = mention && anchor
    ? mention.matches.slice(mention.agents).map((a) => machines.find((m) => m.alias === a)).filter((m): m is NonNullable<typeof m> => !!m)
    : []

  return (
    <>
      <div className="term-host" ref={hostRef} />
      {mention && anchor && shownAgents.length + shownMachines.length > 0 && (
        <MentionMenu
          agents={shownAgents}
          machines={shownMachines}
          index={mention.index}
          passive={mention.passive}
          placement={anchor.placement}
          style={{ left: anchor.left, top: anchor.top, bottom: anchor.bottom }}
          onHover={(i) => { if (!mention.passive) useStore.getState().setMention({ ...mention, index: i }) }}
          onPick={(alias) => acceptRef.current(alias)}
        />
      )}
    </>
  )
}
