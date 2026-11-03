import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../state/store'
import type { DirComplete } from '@shared/types'

const api = window.paper

interface Row {
  kind: 'self' | 'dir' | 'recent'
  label: string
  path: string
  repo?: boolean
}

/**
 * The location bar: `cd` with the ergonomics of a shell rather than a file
 * dialog. You type a path, Tab completes the shared prefix the way a shell
 * does, the faint remainder of that prefix sits inline ahead of the cursor,
 * and the matches below are there to glance at — never to click through.
 *
 * Enter always acts on the highlighted row, and when what you typed is already
 * a directory that row is pinned to the top, so the muscle-memory sequence
 * "type a path, press Enter" lands exactly where you asked.
 */
export default function CwdPalette(): JSX.Element {
  const setOverlay = useStore((s) => s.setOverlay)
  const retarget = useStore((s) => s.retarget)
  const recentDirs = useStore((s) => s.recentDirs)
  const session = useStore((s) => s.activeSession())
  const from = useStore((s) => s.paneCwd())

  const [text, setText] = useState('')
  const [comp, setComp] = useState<DirComplete | null>(null)
  const [index, setIndex] = useState(0)
  const [home, setHome] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  useEffect(() => { void api.dirs.home().then(setHome) }, [])

  // Completion follows the caret; stale replies are dropped by sequence number.
  useEffect(() => {
    const mine = ++seq.current
    void api.dirs.complete(text, from).then((c) => {
      if (seq.current === mine) { setComp(c); setIndex(0) }
    })
  }, [text, from])

  const pretty = (p: string): string =>
    home && p.startsWith(home) ? (p === home ? '~' : `~${p.slice(home.length)}`) : p

  const rows = useMemo<Row[]>(() => {
    if (!comp) return []
    const out: Row[] = []
    // What you typed, if it is already a directory, always comes first.
    if (comp.exact) {
      out.push({ kind: 'self', label: pretty(comp.resolved), path: comp.resolved })
    }
    for (const e of comp.entries) {
      out.push({ kind: 'dir', label: e.name, path: e.path, repo: e.repo })
    }
    if (!text.trim()) {
      for (const d of recentDirs) {
        if (d === comp.resolved || out.some((r) => r.path === d)) continue
        out.push({ kind: 'recent', label: pretty(d), path: d })
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comp, recentDirs, text, home])

  const active = rows[Math.min(index, rows.length - 1)]

  /** The greyed remainder shown inline: what Tab would add. */
  const ghost = useMemo(() => {
    if (!comp || !text || text.endsWith('/')) return ''
    const fragment = text.slice(text.lastIndexOf('/') + 1)
    if (!comp.common || comp.common.length <= fragment.length) return ''
    if (!comp.common.toLowerCase().startsWith(fragment.toLowerCase())) return ''
    return comp.common.slice(fragment.length)
  }, [comp, text])

  const acceptGhost = (): void => {
    if (!comp) return
    if (ghost) {
      const next = text + ghost
      // A unique match is a finished directory name, so step into it.
      setText(comp.entries.length === 1 ? `${next}/` : next)
      return
    }
    // No shared prefix left to add: step into whatever is highlighted.
    if (active && active.kind !== 'self') setText(`${pretty(active.path)}/`)
  }

  const go = (path?: string): void => {
    const target = path ?? active?.path ?? comp?.resolved
    if (!target) return
    setOverlay(null)
    void retarget(target)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Tab') { e.preventDefault(); acceptGhost(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, rows.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter') { e.preventDefault(); go(); return }
    if (e.key === 'Escape') { e.preventDefault(); setOverlay(null); return }
    // Right arrow at the end of the line accepts the completion, as in a shell.
    const el = e.currentTarget
    if (e.key === 'ArrowRight' && ghost && el.selectionStart === text.length) {
      e.preventDefault()
      acceptGhost()
    }
  }

  // Say plainly what Enter will do, because it differs by what is running.
  const outcome = !session
    ? 'sets the directory for new sessions here'
    : session.provider === 'shell'
      ? `runs cd in ${session.title}`
      : `moves ${session.title} there, keeping its context`

  return (
    <div className="scrim scrim-top" onMouseDown={() => setOverlay(null)}>
      <div className="cwdbar fade-in" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Change directory">
        <div className="cwd-line" onClick={() => inputRef.current?.focus()}>
          <span className="cwd-cmd mono">cd</span>
          <div className="cwd-field">
            {/* The ghost sits underneath, aligned glyph-for-glyph with the input. */}
            <div className="cwd-ghost mono" aria-hidden="true">
              <span className="cwd-ghost-typed">{text}</span>
              <span className="cwd-ghost-rest">{ghost}</span>
            </div>
            <input
              ref={inputRef}
              className="cwd-input mono"
              value={text}
              autoFocus
              spellCheck={false}
              placeholder={pretty(from)}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
        </div>

        <div className="cwd-rows">
          {rows.map((r, i) => (
            <button
              key={`${r.kind}:${r.path}`}
              className={`cwd-row ${i === index ? 'cwd-row-on' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => go(r.path)}
            >
              <span className={`cwd-glyph ${r.kind === 'self' ? 'cwd-glyph-here' : ''}`}>
                {r.kind === 'self' ? '▸' : r.kind === 'recent' ? '◷' : '/'}
              </span>
              <span className="cwd-name mono">{r.label}</span>
              {r.repo && <span className="cwd-repo" title="git repository">git</span>}
              {r.kind === 'self' && <span className="cwd-tag">open here</span>}
              {r.kind === 'recent' && <span className="cwd-tag cwd-tag-dim">recent</span>}
            </button>
          ))}
          {!rows.length && <div className="cwd-none mono">no directory matches</div>}
        </div>

        <div className="cwd-foot">
          <span className="cwd-hint mono">tab complete · ↑↓ pick · ↵ go · esc cancel</span>
          <span className="cwd-target">{outcome}</span>
        </div>
      </div>
    </div>
  )
}
