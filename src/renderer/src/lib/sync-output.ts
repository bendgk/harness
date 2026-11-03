/**
 * DEC mode 2026 (synchronized output) for xterm.js 5.5, which parses the
 * BSU/ESU pair but ignores it. A program wraps each frame in
 * `CSI ? 2026 h` … `CSI ? 2026 l` so the terminal never shows it half drawn;
 * without that, a frame that reaches the pane in several pty chunks (macOS
 * ptys read ~1 KB at a time, and Claude Code redraws ~30 rows per scroll
 * step) can be rendered between chunks: the top of the transcript already
 * scrolled, the bottom not yet — a tear, live and in the smooth-scroll glide.
 *
 * Everything between BSU and ESU is held here and handed to xterm as one
 * write, which xterm parses in one go, so its next render sees the whole
 * frame. Data outside a frame passes straight through. A frame whose ESU
 * never comes is released after `maxHoldMs` (terminals use 150 ms), and a
 * marker split across chunks is carried to the next one.
 */
const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'

export class SyncOutput {
  private held: string[] | null = null
  private carry = ''
  private timer: ReturnType<typeof setTimeout> | 0 = 0

  constructor(private readonly write: (data: string) => void, private readonly maxHoldMs = 150) {}

  /** Whether a frame is being held right now (dev/tests). */
  get holding(): boolean { return this.held !== null }

  feed(chunk: string): void {
    let d = this.carry + chunk
    this.carry = ''
    // A chunk may end in the first bytes of a marker: keep them for the next one.
    const tail = partialMarker(d)
    if (tail) { this.carry = d.slice(d.length - tail); d = d.slice(0, d.length - tail) }
    let i = 0
    while (i < d.length) {
      if (this.held) {
        const e = d.indexOf(ESU, i)
        if (e < 0) { this.held.push(d.slice(i)); this.arm(); break }
        this.held.push(d.slice(i, e + ESU.length))
        i = e + ESU.length
        this.release()
      } else {
        const b = d.indexOf(BSU, i)
        if (b < 0) { this.write(d.slice(i)); break }
        if (b > i) this.write(d.slice(i, b))
        this.held = [BSU]
        i = b + BSU.length
      }
    }
    if (this.carry && !this.held) this.arm()
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = 0
    this.release()
  }

  private arm(): void {
    if (!this.timer) this.timer = setTimeout(this.expire, this.maxHoldMs)
  }

  private expire = (): void => {
    this.timer = 0
    const rest = this.carry
    this.carry = ''
    this.release()
    if (rest) this.write(rest)
  }

  private release(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = 0 }
    const h = this.held
    this.held = null
    if (h && h.length) this.write(h.join(''))
  }
}

/** Length of the longest suffix of `d` that is a proper prefix of BSU or ESU. */
function partialMarker(d: string): number {
  const max = Math.min(d.length, BSU.length - 1)
  for (let n = max; n > 0; n--) {
    const s = d.slice(d.length - n)
    if (BSU.startsWith(s) || ESU.startsWith(s)) return n
  }
  return 0
}
