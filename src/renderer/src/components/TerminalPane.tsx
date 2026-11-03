import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useStore } from '../state/store'
import { termTheme } from './term-theme'

const api = window.paper

interface Props {
  sessionId: string
  focused: boolean
  /** Registers imperative handles so the app can search/clear this pane. */
  register?: (handle: TerminalHandle | null) => void
}

export interface TerminalHandle {
  search: (q: string, forward?: boolean) => void
  clear: () => void
  focus: () => void
}

export default function TerminalPane({ sessionId, focused, register }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const theme = useStore((s) => s.theme)
  const fontSize = useStore((s) => s.fontSize)

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

    const disposeData = term.onData((d) => void api.session.write(sessionId, d))
    const disposeBinary = term.onBinary((d) => void api.session.write(sessionId, d))

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
  }, [theme])

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
    window.addEventListener('paper:find', onFind)
    window.addEventListener('paper:clear', onClear)
    return () => {
      window.removeEventListener('paper:find', onFind)
      window.removeEventListener('paper:clear', onClear)
    }
  }, [focused])

  return <div className="term-host" ref={hostRef} />
}
