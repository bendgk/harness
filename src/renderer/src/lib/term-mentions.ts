/**
 * @-mentions inside an xterm: tracking the token the user is typing (for the
 * autocomplete) and painting registered `@alias`es (blue) and agent `@name`s
 * (violet) in the viewport.
 *
 * Both work from what xterm already has — the keystrokes it is about to send
 * (`onData`) and the cells in its buffer — so nothing here depends on which
 * program is running, and none of it sits on the keystroke → pty path for
 * longer than a few string comparisons.
 */
import type { IBufferLine, IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm'
import { mentionRegex } from './machines'

const ALIAS_CHAR = /^[A-Za-z0-9._-]$/

/**
 * Follows what the user is typing to decide whether they are in the middle of
 * an `@token`. It only sees keystrokes, never the program's line editor, so it
 * is deliberately conservative: an `@` opens a token only at what is very
 * likely a word start (beginning of input, or after whitespace/Enter), and
 * anything that could have moved the cursor somewhere unknown ends it.
 */
export class MentionTracker {
  /** Characters typed after the `@`, or null when not in a token. */
  query: string | null = null
  private boundary = true
  private boundaryBeforeAt = true

  feed(data: string): void {
    if (data.length > 1) {
      // A paste (or IME commit) arrives as one chunk; an escape sequence is a
      // cursor key. Either way the token, if any, is over.
      const esc = data.charCodeAt(0) === 0x1b && !data.startsWith('\x1b[200~')
      this.query = null
      this.boundary = esc ? false : /\s$/.test(data)
      return
    }
    const c = data
    const code = c.charCodeAt(0)
    if (c === '\x7f' || c === '\b') {
      if (this.query === null) { this.boundary = false; return }
      if (this.query.length) this.query = this.query.slice(0, -1)
      else { this.query = null; this.boundary = this.boundaryBeforeAt }
      return
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || code < 0x20) {
      this.query = null
      this.boundary = true
      return
    }
    if (c === '@') {
      if (this.query === null && this.boundary) {
        this.boundaryBeforeAt = this.boundary
        this.query = ''
      } else this.query = null
      this.boundary = false
      return
    }
    if (this.query !== null) this.query = ALIAS_CHAR.test(c) ? this.query + c : null
    this.boundary = false
  }

  /** End any token. `boundary` says whether the next `@` may open a new one. */
  reset(boundary: boolean): void {
    this.query = null
    this.boundary = boundary
  }
}

/** A buffer line as text plus, for each UTF-16 unit, the cell column it sits in. */
function mapLine(line: IBufferLine, cols: number): { text: string; colOf: number[] } {
  let text = ''
  const colOf: number[] = []
  let cell = line.getCell(0)
  for (let x = 0; x < cols; x++) {
    cell = line.getCell(x, cell)
    if (!cell) break
    if (cell.getWidth() === 0) continue
    const chars = cell.getChars() || ' '
    for (let i = 0; i < chars.length; i++) colOf.push(x)
    text += chars
  }
  colOf.push(cols)
  return { text, colOf }
}

/**
 * Where on screen the `@query` being typed is drawn: viewport row and column
 * of its `@`. Agent TUIs (Claude Code, Codex) often park the real cursor away
 * from their input box, so rather than trust the cursor we look for the token
 * itself and take the occurrence nearest the cursor. Before the echo arrives
 * the cursor position is the best guess.
 */
export function locateToken(term: Terminal, query: string): { row: number; col: number } {
  const buf = term.buffer.active
  const cursorRow = buf.cursorY
  const needle = `@${query}`
  let best: { row: number; col: number; d: number } | null = null
  for (let row = 0; row < term.rows; row++) {
    const line = buf.getLine(buf.viewportY + row)
    if (!line) continue
    const raw = line.translateToString(true)
    if (!raw.includes(needle)) continue
    const { text, colOf } = mapLine(line, term.cols)
    let i = text.indexOf(needle)
    while (i >= 0) {
      const after = text[i + needle.length]
      if (!after || !ALIAS_CHAR.test(after)) {
        const col = colOf[i]
        const d = Math.abs(row - cursorRow) * 1000 + Math.abs(col + needle.length - buf.cursorX)
        if (!best || d < best.d) best = { row, col, d }
      }
      i = text.indexOf(needle, i + 1)
    }
  }
  if (best) return { row: best.row, col: best.col }
  return { row: cursorRow, col: Math.max(0, buf.cursorX - needle.length) }
}

export interface MentionColors { fg: string; bg: string }

/**
 * Where the smooth-scroll overlay is showing the live frame's scrolling rows
 * while it rests off the row grid (see `SmoothScroll.restShift`): rows
 * top..bot are drawn `dy` css px from where the buffer has them.
 */
export interface ScreenShift { dy: number; top: number; bot: number }

/** What an `@word` refers to: a registered machine or a named agent. */
export type MentionKind = 'machine' | 'agent'

/**
 * Paints `@alias` and `@name` (registered machines and named agents only, on
 * word boundaries) in the visible rows with xterm decorations, each kind in its
 * own colour, and makes them clickable with a link provider.
 * Rescans are coalesced to one per ~60 ms however fast output arrives, only
 * touch the viewport, and keep decorations whose match did not move — so a
 * redraw of Claude's input box does not make the tags flicker.
 */
export class MentionHighlighter {
  private regex: RegExp | null = null
  /** Mention text → what it names. A machine wins a clash (main never allows one). */
  private kinds = new Map<string, MentionKind>()
  private targetsKey = ''
  private live = new Map<string, { marker: IMarker; deco: IDecoration | undefined }>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private subs: IDisposable[] = []
  private disposed = false

  constructor(
    private term: Terminal,
    private colors: (kind: MentionKind) => MentionColors,
    onActivate: (kind: MentionKind, target: string) => void
  ) {
    const schedule = (): void => this.schedule()
    this.subs.push(term.onWriteParsed(schedule), term.onScroll(schedule), term.onResize(schedule))
    this.subs.push(term.registerLinkProvider({
      provideLinks: (lineNo, callback) => {
        const re = this.regex
        const line = re ? term.buffer.active.getLine(lineNo - 1) : undefined
        if (!re || !line || !line.translateToString(true).includes('@')) return callback(undefined)
        const { text, colOf } = mapLine(line, term.cols)
        const links = [...text.matchAll(re)].map((m) => {
          const start = colOf[m.index!]
          const end = colOf[m.index! + m[0].length] - 1
          return {
            range: { start: { x: start + 1, y: lineNo }, end: { x: end + 1, y: lineNo } },
            text: m[0],
            decorations: { pointerCursor: true, underline: true },
            activate: () => onActivate(this.kindOf(m[1]), m[1])
          }
        })
        callback(links.length ? links : undefined)
      }
    }))
  }

  /** What to paint: machine aliases and agent names. A no-op when nothing changed. */
  setTargets(aliases: string[], names: string[]): void {
    const key = `${aliases.join(' ')}|${names.join(' ')}`
    if (key === this.targetsKey) return
    this.targetsKey = key
    this.kinds = new Map<string, MentionKind>()
    for (const n of names) this.kinds.set(n, 'agent')
    for (const a of aliases) this.kinds.set(a, 'machine')
    this.regex = mentionRegex([...this.kinds.keys()])
    this.repaint()
  }

  private kindOf(target: string): MentionKind { return this.kinds.get(target) ?? 'machine' }

  /** Colours changed (theme): decorations bake their colour in, so rebuild them. */
  repaint(): void {
    this.clear()
    this.schedule()
  }

  schedule(): void {
    if (this.timer || this.disposed) return
    this.timer = setTimeout(() => { this.timer = null; this.scan() }, 60)
  }

  private clear(): void {
    for (const { marker, deco } of this.live.values()) { deco?.dispose(); marker.dispose() }
    this.live.clear()
    this.clearOverlay()
  }

  /** Tags drawn over the alternate screen, keyed like `live` (row:x:width). */
  private overlay: HTMLDivElement | null = null
  private overlayKeys = ''
  private lastFound: { row: number; x: number; width: number; text: string; kind: MentionKind }[] = []
  private shift: () => ScreenShift | null = () => null

  /** Follow the smooth-scroll overlay's resting offset (alternate screen only; decorations are in the frame). */
  setShift(fn: () => ScreenShift | null): void { this.shift = fn }

  /** The resting offset changed: move the tags, no rescan. */
  relayout(): void {
    if (this.term.buffer.active.type !== 'normal') this.paintAlternate(this.lastFound)
  }

  private clearOverlay(): void {
    if (this.overlay) this.overlay.replaceChildren()
    this.overlayKeys = ''
  }

  /**
   * The alternate screen has no markers, so decorations cannot live there —
   * and Claude Code draws its whole UI in it. Instead, lay cell-aligned tags
   * over the screen: an opaque tinted box per match with the mention re-drawn
   * in its kind's ink, one character per cell so it lines up with the glyphs underneath.
   * pointer-events:none, so clicks fall through to the link provider.
   */
  private paintAlternate(matches: { row: number; x: number; width: number; text: string; kind: MentionKind }[]): void {
    const term = this.term
    const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null
    if (!screen) return
    this.lastFound = matches
    // While the glide overlay rests off the grid it covers the screen
    // (z-index 9): the tags go above it, moved with the rows they sit on.
    const sh = this.shift()
    const keys = matches.map((m) => `${m.row}:${m.x}:${m.width}:${m.text}:${m.kind}`).join('|') + (sh ? `|@${sh.dy}:${sh.top}:${sh.bot}` : '')
    if (keys === this.overlayKeys && this.overlay?.isConnected) return
    if (!this.overlay || !this.overlay.isConnected) {
      this.overlay = document.createElement('div')
      this.overlay.className = 'paper-mention-overlay'
      Object.assign(this.overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '7' })
      screen.appendChild(this.overlay)
    }
    this.overlayKeys = keys
    this.overlay.style.zIndex = sh ? '10' : '7'
    const cellW = screen.clientWidth / term.cols
    const cellH = screen.clientHeight / term.rows
    const font = term.options
    const moved = (row: number): number | null => {
      if (!sh || row < sh.top || row > sh.bot) return row * cellH
      const y = row * cellH + sh.dy
      // A tag scrolled (partly) out of the region is hidden like its text.
      return y < sh.top * cellH - 0.5 || y + cellH > (sh.bot + 1) * cellH + 0.5 ? null : y
    }
    const nodes = matches.filter((m) => moved(m.row) !== null).map((m) => {
      const { fg, bg } = this.colors(m.kind)
      const tag = document.createElement('div')
      tag.dataset.mention = m.kind
      Object.assign(tag.style, {
        position: 'absolute',
        left: `${m.x * cellW}px`,
        top: `${moved(m.row)}px`,
        width: `${m.width * cellW}px`,
        height: `${cellH}px`,
        background: bg,
        color: fg,
        display: 'flex',
        fontFamily: String(font.fontFamily ?? 'monospace'),
        fontSize: `${font.fontSize ?? 12}px`,
        lineHeight: `${cellH}px`,
        borderRadius: '2px'
      })
      for (const ch of m.text) {
        const c = document.createElement('span')
        Object.assign(c.style, { width: `${cellW}px`, textAlign: 'center', flex: 'none' })
        c.textContent = ch
        tag.appendChild(c)
      }
      return tag
    })
    this.overlay.replaceChildren(...nodes)
  }

  private scan(): void {
    if (this.disposed) return
    const term = this.term
    const buf = term.buffer.active
    if (!this.regex) { this.clear(); return }
    if (buf.type !== 'normal') {
      // Decorations need markers, which only the normal buffer has: overlay instead.
      for (const { marker, deco } of this.live.values()) { deco?.dispose(); marker.dispose() }
      this.live.clear()
      const found: { row: number; x: number; width: number; text: string; kind: MentionKind }[] = []
      for (let row = 0; row < term.rows; row++) {
        const line = buf.getLine(buf.viewportY + row)
        if (!line || !line.translateToString(true).includes('@')) continue
        const { text, colOf } = mapLine(line, term.cols)
        for (const m of text.matchAll(this.regex)) {
          const x = colOf[m.index!]
          found.push({ row, x, width: colOf[m.index! + m[0].length] - x, text: m[0], kind: this.kindOf(m[1]) })
        }
      }
      this.paintAlternate(found)
      return
    }
    this.clearOverlay()
    const seen = new Set<string>()
    for (let row = 0; row < term.rows; row++) {
      const y = buf.viewportY + row
      const line = buf.getLine(y)
      if (!line) continue
      if (!line.translateToString(true).includes('@')) continue
      const { text, colOf } = mapLine(line, term.cols)
      for (const m of text.matchAll(this.regex)) {
        const x = colOf[m.index!]
        const width = colOf[m.index! + m[0].length] - x
        const kind = this.kindOf(m[1])
        const key = `${y}:${x}:${width}:${kind}`
        seen.add(key)
        if (this.live.has(key)) continue
        const marker = term.registerMarker(y - (buf.baseY + buf.cursorY))
        if (!marker) continue
        const { fg, bg } = this.colors(kind)
        const deco = term.registerDecoration({ marker, x, width, foregroundColor: fg, backgroundColor: bg, layer: 'top' })
        this.live.set(key, { marker, deco })
      }
    }
    for (const [key, { marker, deco }] of this.live) {
      // Keys are absolute buffer lines; a trimmed scrollback shifts markers, so check both.
      const [y] = key.split(':').map(Number)
      if (seen.has(key) && marker.line === y && !marker.isDisposed) continue
      deco?.dispose()
      marker.dispose()
      this.live.delete(key)
    }
  }

  /** What is painted right now, for tests and ui_eval. */
  snapshot(): { line: number; x: number; width: number; kind: string }[] {
    return [...this.live.keys()].map((k) => {
      const [line, x, width, kind] = k.split(':')
      return { line: Number(line), x: Number(x), width: Number(width), kind }
    })
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.clear()
    for (const s of this.subs) s.dispose()
  }
}
