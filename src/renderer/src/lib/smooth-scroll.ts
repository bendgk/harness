/**
 * Smooth scrolling for one xterm pane: "moving paper underneath" instead of a
 * terminal that jumps a row at a time.
 *
 * Layer 1 — faithful input. Paper takes the wheel away from xterm
 * (`attachCustomWheelEventHandler` → false, preventDefault). Pixel deltas are
 * accumulated per pane and turned into whole rows — one per row height of
 * travel — so a 120 px trackpad event is 6 rows, not the single report xterm
 * sends per DOM event in mouse mode. Trackpad momentum is just more wheel
 * events: they are followed 1:1, no physics of our own — the OS stream *is*
 * the velocity. Notched wheels (see `isNotch`) move `scrollNotchRows` rows per
 * notch instead, and `scrollSensitivity` multiplies both. Without the glide
 * the remainder is carried exactly; with it rows are requested slightly
 * *ahead* of the finger (see Layer 2). Rows go out as:
 *   - mouse-tracking apps (Claude Code's fullscreen UI, vim with mouse=a):
 *     k wheel reports from xterm's own encoder (`coreMouseService`, so X10/
 *     SGR/URXVT/pixel encodings all work), captured and written to the pty
 *     as one chunk;
 *   - the normal buffer: `term.scrollLines(k)`;
 *   - the alternate screen without mouse tracking (less, vim mouse off):
 *     xterm's default (arrow keys), untouched.
 *
 * Layer 2 — the glide. Rows are still 19.5 px steps, so an opaque canvas laid
 * over `.xterm-screen` shows the content at a continuous position P while a
 * scroll is in progress, and is hidden otherwise (zero cost, pixel-exact text
 * when idle). It composites, per frame:
 *   fixed rows straight from the WebGL canvas (the current frame N),
 *   the scrolling region from N translated by F−P, and the band that reveals
 *   from the previous composite O translated by P_O−P, so it is never blank.
 * F is where N's content is (rows shifted × row height). For scrollback
 * panes the shift is known exactly (`viewportY`). For mouse apps the app
 * redraws on its own schedule, so the shift and its region are detected by
 * comparing row text with the previous frame (`findShift`); Claude's input
 * box, status rows and the sticky prompt header never match a shift, so they
 * never move, and a chip floating over a scrolling row ("Jump to bottom") is
 * held in place cell by cell (`withChips`). A frame that does not fit is
 * snapped, never glided.
 *
 * P follows a critically damped spring (with a guard so it can never pass
 * its target, i.e. never overshoots or oscillates). Its target is the finger
 * itself (travel), clamped to what the frames on hand can show — so rows are
 * requested *ahead* of the finger ("lead": ceil instead of floor, plus a
 * latency look-ahead), and the content tracks the trackpad 1:1 instead of
 * trailing a staircase. While tracking, P never moves faster than 1.3× the
 * finger, even catching up with a late frame. When the gesture ends P settles
 * on the row grid with an exponential that starts at its current speed.
 *
 * Typing, clicks, resizes and buffer switches snap and hide the overlay.
 * prefers-reduced-motion, or no WebGL canvas, means Layer 1 only.
 */
import type { IDisposable, Terminal } from '@xterm/xterm'

/** Tuning knobs (dev: `window.__paperScroll.tuning`). */
export const TUNING = {
  /** Layer 2 on/off (off = row-accurate input only, as with prefers-reduced-motion). */
  glide: true,
  /** Spring stiffness (1/s) while P tracks the finger: lag ≈ 2/ω ≈ 12 ms. */
  omegaTrack: 160,
  /** Stiffness for a notch's glide: three rows come to rest in ≈ 110 ms. */
  omegaGlide: 70,
  /**
   * Settling on the row grid after the last event: ω = speed / distance (a
   * pure exponential that starts at the current speed, so nothing lurches),
   * kept within these bounds so it neither crawls nor snaps.
   */
  omegaSettleMin: 60,
  omegaSettleMax: 140,
  /**
   * The gesture (or its momentum) has ended when no event came for two event
   * intervals (trackpads stream at the display rate), within these bounds. A
   * false alarm is harmless: settling moves toward the frame, which is ahead.
   */
  idleMinMs: 24,
  idleMaxMs: 90,
  /** Reports the app has not answered with a shift by then are dropped (top/bottom of its transcript). */
  pendingMs: 260,
  /** Movement before a gesture requests its first row (a resting finger's jitter does not scroll). */
  deadPx: 2,
  /** Movement against the direction of travel before it counts as a reversal. */
  reversePx: 3,
  /** While tracking, P moves at most this many times the finger's speed, and is always allowed `minCatchUp` px/s. */
  catchUp: 1.3,
  minCatchUp: 240,
  /** Look-ahead cap, in rows. */
  maxLookRows: 1.2,
  /** A smooth-looking event within this window means "this is a touchpad", whatever comes next. */
  smoothWindowMs: 400
}

export interface SmoothScrollOptions {
  /** Raw bytes for the pty (the batched wheel reports). */
  write: (data: string) => void
  /** User multiplier (prefs `scrollSensitivity`, default 1). */
  sensitivity: () => number
  /** Rows per wheel notch (prefs `scrollNotchRows`, default 3). */
  notchRows: () => number
  /**
   * The app ignores the first wheel report after a direction change (Claude
   * Code's flip debounce, 2.1.x): send one extra so reversals are not short.
   */
  dropsFlipReport: () => boolean
  /** Dev-only trace sink. */
  trace?: (rec: ScrollTraceRecord) => void
}

type Mode = 'report' | 'scrollback' | 'native'

export interface ScrollTraceRecord {
  t: number
  kind: 'wheel' | 'render' | 'tick' | 'snap'
  mode: Mode
  /** Rows requested so far in this activation (scrollback: absolute viewport row). */
  sent: number
  /** Rows the frames have actually shifted. */
  shown: number
  pending: number
  /** wheel: rows emitted by this event, reports written, and the input. */
  rows?: number
  reports?: number
  deltaY?: number
  notch?: boolean
  /** render: the detected shift and scrolling region (screen rows). */
  shift?: number
  region?: [number, number]
  reason?: string
  /** Glide offset F − P (css px) and the effective content position P (css px). */
  v: number
  pos: number
  travel: number
  rowH: number
  /** Time spent in this handler/frame (ms). */
  ms: number
}

/** Cells [c0, c1] of a row that stay put while the rest of the row scrolls. */
interface Patch { row: number; c0: number; c1: number }

interface Region { top: number; bot: number; patches?: Patch[] }

const WHEEL_BUTTON = 4 // CoreMouseButton.WHEEL
const ACTION_UP = 0
const ACTION_DOWN = 1

/**
 * Where a frame's rows came from, for an app that redraws itself (mouse mode):
 * the shift s (signed: +s = content moved up, i.e. scrolled toward the end)
 * that explains the most non-blank rows that changed, and the screen rows it
 * covers. Rows that changed are compared, not rows that merely repeat (blank
 * lines, rules), so a fixed input box or status line never joins a region.
 */
export function findShift(prev: string[], next: string[], maxS: number): { s: number; top: number; bot: number } | null {
  const n = Math.min(prev.length, next.length)
  let best: { s: number; score: number; first: number; last: number } | null = null
  for (const dir of [1, -1]) {
    for (let s = 1; s <= Math.min(maxS, n - 2); s++) {
      let score = 0
      let first = -1
      let last = -1
      for (let r = 0; r < n; r++) {
        const src = r + dir * s
        if (src < 0 || src >= n) continue
        const line = next[r]
        if (line === prev[src] && line !== prev[r] && line.trim() !== '') {
          score++
          if (first < 0) first = r
          last = r
        }
      }
      if (score > (best?.score ?? 0)) best = { s: dir * s, score, first, last }
    }
  }
  if (!best || best.score < 2) return null
  // Most of the non-blank rows inside the span must agree, or it is a coincidence.
  let span = 0
  for (let r = best.first; r <= best.last; r++) if (next[r].trim() !== '') span++
  if (best.score < span * 0.6) return null
  const s = best.s
  const dir = Math.sign(s)
  const fits = (r: number): boolean => {
    const src = r + s
    if (src < 0 || src >= n || next[r] !== prev[src]) return false
    // An unchanged non-blank row is fixed chrome, not transcript.
    return !(next[r] === prev[r] && next[r].trim() !== '')
  }
  let { first, last } = best
  while (first > 0 && fits(first - 1)) first--
  while (last < n - 1 && fits(last + 1)) last++
  // Add the rows that scrolled into view on the leading side.
  const top = dir > 0 ? first : Math.max(0, first + s)
  const bot = dir > 0 ? Math.min(n - 1, last + s) : last
  return { s, top, bot }
}

export class SmoothScroll {
  private readonly core: any
  private disposed = false
  private subs: IDisposable[] = []

  // ---- Layer 1 -------------------------------------------------------------
  private mode: Mode = 'native'
  /** Carried remainder (rows) when there is no glide. */
  private acc = 0
  private smoothAt = -Infinity
  private lastWheel = -Infinity
  private lastEventAt = -Infinity
  /** Finger velocity, css px per ms (signed). */
  private vel = 0
  private dir = 0
  /** Direction of the last motion, kept across a pause. */
  private holdDir = 0
  private extreme = 0
  private lastReportDir = 0
  private capturing: string[] | null = null
  private lastNotch = false
  /** Recent interval between wheel events (ms, EWMA). */
  private gap = 16

  // ---- Layer 2 -------------------------------------------------------------
  private active = false
  private rowH = 0
  private travel = 0
  /** Travel when the current gesture began. */
  private origin = 0
  private sent = 0
  private shown = 0
  private pending = 0
  private pendingAbs = 0
  private lastSendAt = 0
  /** Send → shifted frame, ms (EWMA; Claude Code answers in ≈ 9 ms). */
  private latency = 12
  private P = 0
  private pv = 0
  private pO = 0
  private drawnP = 0
  private live = false
  private settleOmega = TUNING.omegaGlide
  private region: Region | null = null
  private lastRows: string[] | null = null
  private raf = 0
  private lastTick = 0
  private gl: HTMLCanvasElement | null = null
  private overlay: HTMLCanvasElement | null = null
  private prev: HTMLCanvasElement | null = null
  private octx: CanvasRenderingContext2D | null = null
  private pctx: CanvasRenderingContext2D | null = null
  private reduced: MediaQueryList | null = null
  private shownOverlay = false
  /** Rows shown in earlier activations (report mode counts from 0 per activation), so traces stay continuous. */
  private base = 0
  private releaseTimer: ReturnType<typeof setTimeout> | 0 = 0

  constructor(private readonly term: Terminal, private readonly opts: SmoothScrollOptions) {
    this.core = (term as any)._core
    term.attachCustomWheelEventHandler(this.onWheel)
    this.subs.push(
      term.onRender(this.onRender),
      term.onResize(() => this.cancel('resize')),
      term.buffer.onBufferChange(() => this.cancel('buffer'))
    )
    this.reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  }

  /** Swallows what xterm's encoder emits while we are generating wheel reports. */
  capture(data: string): boolean {
    if (!this.capturing) return false
    this.capturing.push(data)
    return true
  }

  /** Any non-wheel input: stop gliding at once and show the real frame. */
  cancel(reason = 'input'): void {
    if (!this.active) return
    this.deactivate(reason)
  }

  /** For ui_eval / tests. */
  stats(): Record<string, unknown> {
    return {
      mode: this.mode, glide: this.canGlide(), active: this.active, sent: this.sent, shown: this.shown,
      pending: this.pending, pos: this.P, frame: this.shown * this.rowH, v: this.shown * this.rowH - this.P,
      region: this.region, latency: Math.round(this.latency), rowH: this.rowH, overlay: this.overlay?.style.display ?? 'none'
    }
  }

  dispose(): void {
    this.disposed = true
    this.deactivate('dispose')
    if (this.releaseTimer) clearTimeout(this.releaseTimer)
    this.releaseCanvases()
    for (const s of this.subs) s.dispose()
  }

  // ---- input -----------------------------------------------------------------

  private currentMode(): Mode {
    const t = this.term
    const mouse = t.modes.mouseTrackingMode
    // X10 reports buttons only, never the wheel: xterm scrolls as usual.
    if (mouse !== 'none' && mouse !== 'x10') return this.core?.coreMouseService ? 'report' : 'native'
    if (t.buffer.active.type === 'alternate') return 'native'
    return 'scrollback'
  }

  private screen(): HTMLElement | null {
    return (this.term.element?.querySelector('.xterm-screen') as HTMLElement | null) ?? null
  }

  /**
   * Is this a notched mouse wheel (rather than a trackpad / precision touchpad)?
   *   - deltaMode LINE or PAGE: always a wheel (Firefox-style).
   *   - Chromium reports `wheelDeltaY` in 120ths of a notch: a wheel is a
   *     nonzero multiple of 120 with a sizeable deltaY (Windows ≈ 100 px per
   *     notch at 100 %, macOS ≈ 40 per tick). Trackpads mostly report small
   *     or fractional deltas whose wheelDelta is not a multiple of 120 (mac
   *     Chromium: wheelDeltaY = −3·deltaY), and once one such event is seen,
   *     everything within `smoothWindowMs` is treated as touchpad too — so a
   *     flick that happens to hit deltaY 40 or 100 mid-stream stays 1:1.
   */
  private isNotch(ev: WheelEvent, now: number): boolean {
    if (ev.deltaMode !== 0) return true
    const d = Math.abs(ev.deltaY)
    const w = (ev as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY
    const smooth = d < 16 || (w !== undefined ? w === 0 || w % 120 !== 0 : !Number.isInteger(ev.deltaY))
    if (smooth) { this.smoothAt = now; return false }
    return now - this.smoothAt > TUNING.smoothWindowMs
  }

  private canGlide(): boolean {
    if (!TUNING.glide || this.reduced?.matches) return false
    if (this.gl?.isConnected) return true
    const screen = this.screen()
    const gl = screen?.querySelector('canvas:not(.xterm-link-layer):not(.paper-glide)') as HTMLCanvasElement | null
    // Only the WebGL renderer draws into a canvas we can copy; getContext with
    // the type it was created with returns that context (null otherwise).
    this.gl = gl && gl.getContext('webgl2') ? gl : null
    return Boolean(this.gl)
  }

  private onWheel = (ev: WheelEvent): boolean => {
    if (this.disposed || ev.type !== 'wheel') return true
    // Pinch-zoom (ctrl) and shift+wheel (horizontal) keep their defaults.
    if (ev.ctrlKey || ev.shiftKey || ev.deltaY === 0) return true
    const mode = this.currentMode()
    if (mode !== this.mode) { this.cancel('mode'); this.mode = mode; this.acc = 0; this.lastReportDir = 0 }
    if (mode === 'native') return true
    const screen = this.screen()
    if (!screen || !this.term.rows) return true
    ev.preventDefault()
    const t0 = performance.now()
    const now = t0
    // Geometry first: reading layout after activate() shows the overlay would
    // force a synchronous layout of the whole window (≈ 4 ms).
    const rect = screen.getBoundingClientRect()
    const rowH = rect.height / this.term.rows
    if (!(rowH > 0)) return true
    const glide = this.canGlide()
    if (glide) this.activate(rowH)
    if (!this.live) {
      // A gesture after a full stop starts from the frame (activate() puts
      // travel there); one resumed mid-settle keeps its mapping, and target()
      // holds P rather than pull it back to a finger it ran ahead of.
      this.origin = this.travel
      if (this.dir) this.holdDir = this.dir
      this.dir = 0
    }

    const notch = this.isNotch(ev, now)
    const sens = Math.max(0.1, this.opts.sensitivity() || 1)
    let px = ev.deltaY
    if (ev.deltaMode === 1) px *= rowH
    else if (ev.deltaMode === 2) px *= rowH * this.term.rows
    let rowsIn: number
    if (notch) {
      const w = Math.abs((ev as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY ?? 0)
      // LINE mode already counts lines (3 per notch in Firefox); otherwise count notches.
      const lines = ev.deltaMode === 1 ? Math.abs(ev.deltaY) : Math.max(1, Math.round(w ? w / 120 : Math.abs(ev.deltaY) / 100)) * this.opts.notchRows()
      rowsIn = Math.sign(ev.deltaY) * Math.max(1, Math.round(lines * sens))
      px = rowsIn * rowH
    } else {
      px *= sens
      rowsIn = px / rowH
    }
    // Velocity for the look-ahead; a pause starts a new gesture.
    const dt = now - this.lastEventAt
    if (notch || dt > 120) this.vel = notch ? 0 : px / 16
    else {
      this.vel += 0.5 * (px / Math.max(4, dt) - this.vel)
      this.gap += 0.3 * (Math.max(4, dt) - this.gap)
    }
    this.lastEventAt = now
    this.lastNotch = notch

    let n: number
    if (glide) n = this.lead(px, rowH)
    else {
      if (Math.sign(rowsIn) !== Math.sign(this.acc)) this.acc = 0
      this.acc += rowsIn
      n = Math.trunc(this.acc)
      this.acc -= n
    }
    const reports = n ? this.emit(n, ev, now, rect) : 0
    this.lastWheel = now
    this.live = true
    if (glide) this.schedule()
    this.record({ t: now, kind: 'wheel', rows: n, reports, deltaY: ev.deltaY, notch, ms: performance.now() - t0 })
    return false
  }

  /**
   * Rows to request so the frame stays *ahead* of the finger: ceil (in the
   * direction of travel) of the travel plus how far the finger will have
   * moved by the time the frame arrives.
   */
  private lead(px: number, rowH: number): number {
    this.travel += px
    if (this.mode === 'scrollback') {
      const max = this.term.buffer.active.baseY * rowH
      this.travel = Math.max(0, Math.min(max, this.travel))
    }
    // A resting finger's jitter is not a scroll.
    if (Math.abs(this.travel - this.origin) < TUNING.deadPx) return 0
    // Direction with hysteresis, so a little wobble is not a reversal.
    if (this.dir === 0) { this.dir = Math.sign(this.travel - this.origin); this.extreme = this.travel }
    else if (this.dir > 0) {
      if (this.travel > this.extreme) this.extreme = this.travel
      else if (this.extreme - this.travel >= TUNING.reversePx) { this.dir = -1; this.extreme = this.travel }
    } else {
      if (this.travel < this.extreme) this.extreme = this.travel
      else if (this.travel - this.extreme >= TUNING.reversePx) { this.dir = 1; this.extreme = this.travel }
    }
    // Where the finger will be when the frame lands: one display frame for
    // scrollback, the app's measured round trip (plus a frame) for a mouse app.
    const lookMs = this.mode === 'scrollback' ? 10 : 1.25 * this.latency + 4
    let look = this.lastNotch ? 0 : this.vel * lookMs
    if (Math.sign(look) !== this.dir) look = 0
    look = Math.max(-TUNING.maxLookRows * rowH, Math.min(TUNING.maxLookRows * rowH, look))
    const pos = (this.travel + look) / rowH
    let E = this.sent
    if (this.dir > 0) E = Math.max(E, Math.ceil(pos - 1e-6))
    else if (this.dir < 0) E = Math.min(E, Math.floor(pos + 1e-6))
    if (this.mode === 'scrollback') E = Math.max(0, Math.min(this.term.buffer.active.baseY, E))
    return E - this.sent
  }

  /** Send n rows. Returns how many reports were written (0 for scrollback). */
  private emit(n: number, ev: WheelEvent, now: number, r: DOMRect): number {
    if (this.mode === 'scrollback') {
      this.term.scrollLines(n)
      this.sent = this.active ? this.term.buffer.active.viewportY : this.sent + n
      return 0
    }
    const dir = Math.sign(n)
    let count = Math.abs(n)
    if (this.lastReportDir && dir !== this.lastReportDir && this.opts.dropsFlipReport()) count++
    this.lastReportDir = dir
    const cellW = r.width / this.term.cols
    const cellH = r.height / this.term.rows
    const x = Math.max(0, Math.min(r.width - 1, ev.clientX - r.left))
    const y = Math.max(0, Math.min(r.height - 1, ev.clientY - r.top))
    const col = Math.min(this.term.cols - 1, Math.floor(x / cellW))
    const row = Math.min(this.term.rows - 1, Math.floor(y / cellH))
    const ms = this.core.coreMouseService
    const out: string[] = []
    this.capturing = out
    try {
      for (let i = 0; i < count; i++) {
        // triggerMouseEvent mutates its argument (1-based coords), so a fresh one each time.
        ms.triggerMouseEvent({ col, row, x: Math.floor(x), y: Math.floor(y), button: WHEEL_BUTTON, action: dir < 0 ? ACTION_UP : ACTION_DOWN, ctrl: false, alt: ev.altKey, shift: false })
      }
    } finally {
      this.capturing = null
    }
    if (out.length) this.opts.write(out.join(''))
    this.sent += n
    if (this.active) {
      this.pending += n
      this.pendingAbs += Math.abs(n)
      this.lastSendAt = now
    }
    return out.length
  }

  // ---- glide -----------------------------------------------------------------

  private frameY(): number { return this.shown * this.rowH }

  private ensureCanvases(): boolean {
    const screen = this.screen()
    const gl = this.gl
    if (!screen || !gl) return false
    if (!this.overlay || !this.overlay.isConnected) {
      const c = document.createElement('canvas')
      c.className = 'paper-glide'
      // Above the WebGL canvas, the link layer and the mention tags (z 7); below
      // the (transparent) accessibility layer. Clicks and wheels fall through.
      Object.assign(c.style, { position: 'absolute', left: '0', top: '0', zIndex: '9', pointerEvents: 'none', display: 'none' })
      screen.appendChild(c)
      this.overlay = c
      this.octx = c.getContext('2d', { alpha: false })
      this.prev = document.createElement('canvas')
      this.pctx = this.prev.getContext('2d', { alpha: false })
    }
    const o = this.overlay
    const p = this.prev!
    if (o.width !== gl.width || o.height !== gl.height) {
      o.width = p.width = gl.width
      o.height = p.height = gl.height
    }
    o.style.width = gl.style.width
    o.style.height = gl.style.height
    return Boolean(this.octx && this.pctx)
  }

  /** The overlay goes up with the first frame that needs compositing (until then it would only copy N). */
  private show(): void {
    if (this.shownOverlay || !this.overlay) return
    this.shownOverlay = true
    this.overlay.style.display = 'block'
  }

  private releaseCanvases = (): void => {
    this.releaseTimer = 0
    if (this.active) return
    this.overlay?.remove()
    this.overlay = this.prev = null
    this.octx = this.pctx = null
  }

  private activate(rowH: number): void {
    if (this.active && Math.abs(rowH - this.rowH) < 1e-6) return
    if (this.active) this.deactivate('row height')
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = 0 }
    if (!this.ensureCanvases()) return
    this.active = true
    this.rowH = rowH
    this.shown = this.sent = this.mode === 'scrollback' ? this.term.buffer.active.viewportY : 0
    this.pending = this.pendingAbs = 0
    this.travel = this.extreme = this.frameY()
    this.dir = this.holdDir = 0
    this.P = this.pO = this.drawnP = this.frameY()
    this.pv = 0
    this.region = this.mode === 'scrollback' ? { top: 0, bot: this.term.rows - 1 } : null
    this.lastRows = this.mode === 'report' ? this.readRows() : null
    // preserveDrawingBuffer keeps the last frame readable between renders:
    // this is the band source until the overlay itself is on screen.
    this.pctx!.drawImage(this.gl!, 0, 0)
    this.shownOverlay = false
    this.lastTick = performance.now()
  }

  private deactivate(reason: string): void {
    if (!this.active) return
    this.active = false
    this.live = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    if (this.overlay) this.overlay.style.display = 'none'
    this.shownOverlay = false
    if (this.mode === 'report') this.base += this.shown
    // Rows still in flight just land unglided; Layer 1 restarts from here.
    this.pending = this.pendingAbs = 0
    this.lastRows = null
    this.region = null
    this.record({ t: performance.now(), kind: 'snap', reason, ms: 0 })
    // Two full-screen bitmaps per pane add up: keep them for the next
    // gesture, drop them once scrolling has stopped for a while.
    if (this.disposed) this.releaseCanvases()
    else if (!this.releaseTimer) this.releaseTimer = setTimeout(this.releaseCanvases, 3000)
  }

  private readRows(): string[] {
    const b = this.term.buffer.active
    const out: string[] = new Array(this.term.rows)
    for (let r = 0; r < this.term.rows; r++) out[r] = b.getLine(b.viewportY + r)?.translateToString(true) ?? ''
    return out
  }

  /**
   * A row at the region's edge can scroll *under* a floating chip — Claude
   * Code's "Jump to bottom (click) ↓" sits on the last transcript row whenever
   * it is scrolled up. Text matching cannot call that row either scrolling or
   * fixed, so: a run of cells with an explicit background whose text was
   * already in that row last frame is a chip. The row joins the region and
   * the chip is drawn fixed from N on top; neither source draws it shifted.
   */
  private withChips(region: Region, prev: string[], next: string[]): Region {
    const b = this.term.buffer.active
    const patches: Patch[] = []
    for (const row of [region.bot + 1, region.top - 1]) {
      if (row < 0 || row >= this.term.rows || next[row] === prev[row]) continue
      const line = b.getLine(b.viewportY + row)
      if (!line) continue
      let cell = line.getCell(0)
      let start = -1
      let text = ''
      for (let x = 0; x <= this.term.cols; x++) {
        cell = x < this.term.cols ? line.getCell(x, cell) : undefined
        const chip = !!cell && cell.getBgColorMode() !== 0
        if (chip) { if (start < 0) { start = x; text = '' } text += cell!.getChars() || ' ' }
        else if (start >= 0) {
          if (x - start >= 4 && text.trim().length >= 3 && prev[row].includes(text.trim())) patches.push({ row, c0: start, c1: x - 1 })
          start = -1
        }
      }
      if (patches.some((p) => p.row === row)) {
        if (row > region.bot) region.bot = row
        else region.top = row
      }
    }
    if (patches.length) region.patches = patches
    return region
  }

  /** Make the current composite the band source, then move F. */
  private accept(shift: number, region: Region): void {
    // What is on screen becomes the band source: the composite, or (before the
    // overlay went up) the frame prev already holds.
    if (this.shownOverlay) this.pctx!.drawImage(this.overlay!, 0, 0)
    this.pO = this.drawnP
    this.shown += shift
    this.region = region
    const F = this.frameY()
    // The band is only fillable while the jump is smaller than the region.
    const room = (region.bot - region.top) * this.rowH
    if (Math.abs(F - this.pO) > room) this.snapTo('too far')
  }

  /** Show the real frame now (P = F) but stay active. */
  private snapTo(reason: string): void {
    this.P = this.pO = this.frameY()
    this.pv = 0
    this.pctx?.drawImage(this.gl!, 0, 0)
    this.record({ t: performance.now(), kind: 'snap', reason, ms: 0 })
  }

  private onRender = (): void => {
    if (!this.active) return
    const t0 = performance.now()
    let shift: number | undefined
    let reason: string | undefined
    if (!this.gl?.isConnected || this.overlay?.width !== this.gl.width || this.overlay?.height !== this.gl.height) {
      this.deactivate('canvas')
      return
    }
    if (this.mode === 'scrollback') {
      const y = this.term.buffer.active.viewportY
      if (y !== this.shown) {
        if (y === this.sent) { shift = y - this.shown; this.accept(shift, { top: 0, bot: this.term.rows - 1 }) }
        else { this.shown = this.sent = y; this.travel = this.extreme = this.frameY(); this.snapTo('scrolled elsewhere') }
      }
    } else {
      const rows = this.readRows()
      const prev = this.lastRows ?? rows
      const hit = this.pendingAbs > 0 ? findShift(prev, rows, this.pendingAbs + 1) : null
      if (hit) {
        shift = hit.s
        this.pending -= hit.s
        this.pendingAbs = Math.max(0, this.pendingAbs - Math.abs(hit.s))
        if (!this.pendingAbs) this.pending = 0
        this.latency += 0.3 * (Math.max(4, Math.min(80, t0 - this.lastSendAt)) - this.latency)
        this.accept(hit.s, this.withChips({ top: hit.top, bot: hit.bot }, prev, rows))
      } else if (this.region && this.P !== this.frameY()) {
        // Not a scroll. Small edits inside the region (a spinner, the sticky
        // header appearing) glide along; an edge row that changed is fixed
        // chrome now; anything bigger is streaming output — snap.
        let changed = 0
        for (let r = this.region.top; r <= this.region.bot; r++) if (rows[r] !== prev[r]) changed++
        if (changed) {
          while (this.region.top < this.region.bot && rows[this.region.top] !== prev[this.region.top]) { this.region.top++; changed-- }
          while (this.region.bot > this.region.top && rows[this.region.bot] !== prev[this.region.bot]) { this.region.bot--; changed-- }
          if (changed > (this.region.bot - this.region.top + 1) * 0.3) { reason = 'content changed'; this.snapTo(reason) }
        }
      }
      this.lastRows = rows
    }
    // Same task as the WebGL draw, so the overlay never shows a frame late.
    if (this.shownOverlay || this.P !== this.frameY()) { this.draw(); this.show() }
    else this.pctx!.drawImage(this.gl!, 0, 0)
    this.record({ t: t0, kind: 'render', shift, region: this.region ? [this.region.top, this.region.bot] : undefined, reason, ms: performance.now() - t0 })
    this.schedule()
  }

  private schedule(): void {
    if (!this.raf && this.active) this.raf = requestAnimationFrame(this.tick)
  }

  private tick = (now: number): void => {
    this.raf = 0
    if (!this.active) return
    const t0 = performance.now()
    const dt = Math.max(0, Math.min(0.05, (now - this.lastTick) / 1000))
    this.lastTick = now
    const F0 = this.frameY()
    // Rows the app never answered (its top or bottom): forget them.
    if (this.pendingAbs && t0 - this.lastSendAt > Math.max(TUNING.pendingMs, 4 * this.latency)) {
      this.pending = this.pendingAbs = 0
      this.sent = this.shown
      this.travel = this.extreme = F0
    }
    if (this.live && t0 - this.lastWheel > Math.max(TUNING.idleMinMs, Math.min(TUNING.idleMaxMs, 2 * this.gap))) {
      // The gesture is over: settle on the row grid from the current speed.
      this.live = false
      const d = Math.abs(F0 - this.P)
      const toward = Math.sign(F0 - this.P) === Math.sign(this.pv) ? Math.abs(this.pv) : 0
      this.settleOmega = d > 0.01 ? Math.max(TUNING.omegaSettleMin, Math.min(TUNING.omegaSettleMax, toward / d)) : TUNING.omegaGlide
    }
    this.step(dt)
    if (this.shownOverlay) this.draw()
    const F = this.frameY()
    this.record({ t: now, kind: 'tick', ms: performance.now() - t0 })
    if (!this.live && !this.pendingAbs && this.P === F && this.pv === 0) {
      this.deactivate('settled')
      return
    }
    this.schedule()
  }

  /** The finger (while it moves) or the frame (a notch, the settle), within what O and N can show. */
  private target(): { T: number; tracking: boolean } {
    const F = this.frameY()
    const tracking = this.live && !this.lastNotch
    const want = tracking ? this.travel : F
    const lo = Math.min(this.pO, F)
    const hi = Math.max(this.pO, F)
    let T = Math.max(lo, Math.min(hi, want))
    // Content never runs back toward a finger that is still going forward
    // (after the settle of a pause that was not the end); only a reversal does.
    const d = this.dir || this.holdDir
    if (tracking && d && Math.sign(T - this.P) === -d) T = this.P
    return { T, tracking }
  }

  private step(dt: number): void {
    const { T, tracking } = this.target()
    // Following a finger (even one a late frame holds back) stays stiff; a
    // notch glides; the end of a gesture settles from its own speed.
    const w = tracking ? TUNING.omegaTrack : this.live ? TUNING.omegaGlide : this.settleOmega
    const x0 = this.P - T
    const v0 = this.pv
    // Exact critically damped step (stable for any dt).
    const e = Math.exp(-w * dt)
    let x = (x0 + (v0 + w * x0) * dt) * e
    let v = (v0 - w * (v0 + w * x0) * dt) * e
    // Never pass the target: no overshoot, no oscillation.
    if (x0 !== 0 && Math.sign(x) !== Math.sign(x0)) { x = 0; v = 0 }
    const dpr = this.gl ? this.gl.height / this.term.rows / this.rowH : 1
    if (Math.abs(x) < 0.25 / dpr && Math.abs(v) < 20) { x = 0; v = 0 }
    let P = T + x
    if (tracking) {
      // Catching up after a late frame (Claude draws at ≈ 60 fps, several rows
      // at once) must not outrun the finger: no faster than 1.3× its speed.
      const cap = Math.max(TUNING.minCatchUp, TUNING.catchUp * Math.abs(this.vel) * 1000)
      const step = P - this.P
      if (Math.abs(step) > cap * dt) { P = this.P + Math.sign(step) * cap * dt; v = Math.sign(v) * Math.min(Math.abs(v), cap) }
    }
    this.P = P
    this.pv = v
  }

  private draw(): void {
    const gl = this.gl
    const ctx = this.octx
    const o = this.overlay
    if (!gl || !ctx || !o || !this.prev) return
    const W = o.width
    const H = o.height
    const rh = H / this.term.rows
    const scale = rh / this.rowH
    const F = this.frameY()
    // Whole device pixels, so text stays crisp and O lines up with N exactly.
    const Pd = Math.round(this.P * scale) / scale
    const region = this.region
    if (Pd === F || !region) {
      ctx.drawImage(gl, 0, 0)
    } else {
      const y0 = region.top * rh
      const y1 = (region.bot + 1) * rh
      const h = y1 - y0
      if (y0 > 0) ctx.drawImage(gl, 0, 0, W, y0, 0, 0, W, y0)
      if (y1 < H) ctx.drawImage(gl, 0, y1, W, H - y1, 0, y1, W, H - y1)
      const dN = Math.round((F - Pd) * scale)
      const dO = Math.round((this.pO - Pd) * scale)
      const cw = W / this.term.cols
      const patches = region.patches
      // The region's rows from one source, moved by d; chip cells stay behind.
      const shifted = (src: CanvasImageSource, d: number): void => {
        if (!patches) { ctx.drawImage(src, 0, y0, W, h, 0, y0 + d, W, h); return }
        let r = region.top
        while (r <= region.bot) {
          const chips = patches.filter((p) => p.row === r)
          if (!chips.length) {
            let e = r
            while (e + 1 <= region.bot && !patches.some((p) => p.row === e + 1)) e++
            ctx.drawImage(src, 0, r * rh, W, (e - r + 1) * rh, 0, r * rh + d, W, (e - r + 1) * rh)
            r = e + 1
            continue
          }
          let x = 0
          for (const p of chips.sort((a, b) => a.c0 - b.c0)) {
            if (p.c0 * cw > x) ctx.drawImage(src, x, r * rh, p.c0 * cw - x, rh, x, r * rh + d, p.c0 * cw - x, rh)
            x = (p.c1 + 1) * cw
          }
          if (x < W) ctx.drawImage(src, x, r * rh, W - x, rh, x, r * rh + d, W - x, rh)
          r++
        }
      }
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, y0, W, h)
      ctx.clip()
      shifted(this.prev, dO)
      shifted(gl, dN)
      ctx.restore()
      for (const p of patches ?? []) {
        const x = p.c0 * cw
        const w = (p.c1 - p.c0 + 1) * cw
        ctx.drawImage(gl, x, p.row * rh, w, rh, x, p.row * rh, w, rh)
      }
    }
    this.drawnP = Pd
  }

  private record(r: Partial<ScrollTraceRecord> & { t: number; kind: ScrollTraceRecord['kind']; ms: number }): void {
    if (!this.opts.trace) return
    const F = this.frameY()
    const b = this.active && this.mode === 'report' ? this.base : 0
    const bp = b * this.rowH
    this.opts.trace({
      mode: this.mode, sent: this.sent + b, shown: this.shown + b, pending: this.pending,
      v: F - this.drawnP, pos: this.drawnP + bp, travel: this.travel + bp, rowH: this.rowH, ...r
    })
  }
}
