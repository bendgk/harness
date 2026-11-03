import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../state/store'
import { mentionRegex } from '../lib/machines'
import { agentSummaries, knownAgentNames, mentionTargets } from '../lib/agents'
import MentionMenu from './MentionMenu'

interface Props {
  /** Names the field in `mention.owner` ("input:<name>"), so ui_state says which field is completing. */
  name: string
  value: string
  onChange: (value: string) => void
  multiline?: boolean
  rows?: number
  placeholder?: string
  autoFocus?: boolean
  /** 'steer' = the roomy prompt box, 'text' = a one-line .text-input. */
  variant?: 'steer' | 'text'
  /** The session this field talks to (steer, handoff), left out of the Agents section. */
  selfSessionId?: string
  /** Called for every key the mention menu does not claim. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => void
}

const TOKEN = /(?:^|\s)@([A-Za-z0-9._-]*)$/

/**
 * A text field that understands @mentions: registered machine aliases are
 * drawn as blue tags and agent callsigns as violet ones, and typing `@` opens
 * the same two-section dropdown the terminal has.
 *
 * The tags are a mirror layer behind a transparent-ink field: the field keeps
 * the caret, selection and native editing, the mirror paints the text, glyph
 * for glyph, with the aliases coloured. Tag backgrounds use box-shadow rather
 * than padding so they cannot shift a single character out of alignment.
 */
export default function MentionField({
  name, value, onChange, multiline, rows, placeholder, autoFocus, variant = 'text', selfSessionId, onKeyDown
}: Props): JSX.Element {
  const machines = useStore((s) => s.machines)
  // The pieces agentSummaries reads, so the Agents section stays current.
  const sessions = useStore((s) => s.sessions)
  const agentsCache = useStore((s) => s.agents)
  const inventory = useStore((s) => s.inventory)
  const nameKey = useStore((s) => knownAgentNames(s).join(' '))
  const owner = `input:${name}`
  const mention = useStore((s) => (s.mention?.owner === owner ? s.mention : null))
  const setMention = useStore((s) => s.setMention)
  const fieldRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const tokenRef = useRef<HTMLSpanElement>(null)
  const [caret, setCaret] = useState(value.length)
  // Esc dismisses the menu for the token where it was pressed, not for good.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const aliases = useMemo(() => machines.map((m) => m.alias), [machines])
  const agentNames = useMemo(() => new Set(nameKey ? nameKey.split(' ') : []), [nameKey])
  const regex = useMemo(() => mentionRegex([...aliases, ...agentNames]), [aliases, agentNames])

  // The token being typed, if the caret sits at the end of one.
  const token = useMemo(() => {
    const m = value.slice(0, caret).match(TOKEN)
    if (!m) return null
    return { query: m[1], start: caret - m[1].length - 1 }
  }, [value, caret])
  const targets = useMemo(
    () => (token && token.start !== dismissedAt
      ? mentionTargets(token.query, { ...useStore.getState(), sessions, agents: agentsCache, inventory, machines }, selfSessionId)
      : { matches: [], agents: 0 }),
    [token, dismissedAt, sessions, agentsCache, inventory, machines, selfSessionId]
  )
  const open = targets.matches.length > 0

  // Mirror the menu into the store so ui_state shows it; the index lives there too.
  const matchKey = targets.matches.join(' ')
  useLayoutEffect(() => {
    if (!open || !token) { if (useStore.getState().mention?.owner === owner) setMention(null); return }
    const prev = useStore.getState().mention
    if (prev?.owner !== owner) void useStore.getState().refreshAgents()
    const keep = prev?.owner === owner ? prev.matches[prev.index] : undefined
    const list = matchKey.split(' ')
    setMention({
      owner, query: token.query, matches: list, agents: targets.agents,
      index: Math.max(0, keep ? list.indexOf(keep) : 0), passive: false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, matchKey, token?.query])

  useLayoutEffect(() => () => { if (useStore.getState().mention?.owner === owner) useStore.getState().setMention(null) }, [owner])

  // Place the menu under the token, in viewport coordinates (it is portalled
  // out of the sheet, which clips its overflow).
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const t = tokenRef.current?.getBoundingClientRect()
    if (!t) return
    setPos({ left: Math.min(t.left - 8, window.innerWidth - 340), top: t.bottom + 6 })
  }, [open, value, caret])

  const syncCaret = (): void => {
    const el = fieldRef.current
    if (el) setCaret(el.selectionStart ?? el.value.length)
  }

  const accept = (alias: string): void => {
    if (!token) return
    const next = `${value.slice(0, token.start)}@${alias} ${value.slice(caret)}`
    const at = token.start + alias.length + 2
    onChange(next)
    setCaret(at)
    // Put the caret after the inserted tag once React has written the value.
    requestAnimationFrame(() => fieldRef.current?.setSelectionRange(at, at))
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement & HTMLInputElement>): void => {
    if (open && mention && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const n = mention.matches.length
      if (e.key === 'ArrowDown') { e.preventDefault(); setMention({ ...mention, index: (mention.index + 1) % n }); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMention({ ...mention, index: (mention.index - 1 + n) % n }); return }
      if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter') {
        e.preventDefault()
        accept(mention.matches[mention.index])
        return
      }
      if (e.key === 'Escape') { e.preventDefault(); setDismissedAt(token?.start ?? null); return }
    }
    onKeyDown?.(e)
  }

  // The mirror: same text, aliases tagged, the live token marked so the menu can find it.
  const painted = useMemo(() => {
    const out: React.ReactNode[] = []
    const text = value
    const tokenStart = open && token ? token.start : -1
    let last = 0
    const push = (from: number, to: number): void => {
      if (to <= from) return
      if (tokenStart >= from && tokenStart < to) {
        out.push(text.slice(from, tokenStart))
        out.push(<span key={`tok${tokenStart}`} ref={tokenRef}>{text.slice(tokenStart, caret)}</span>)
        out.push(text.slice(caret, to))
      } else out.push(text.slice(from, to))
    }
    if (regex) {
      for (const m of text.matchAll(regex)) {
        push(last, m.index!)
        // A finished alias that is also the live token anchors the menu itself.
        const cls = agentNames.has(m[1]) && !aliases.includes(m[1]) ? 'mention-hl mention-hl-agent' : 'mention-hl'
        out.push(<span key={m.index} className={cls} ref={m.index === tokenStart ? tokenRef : undefined}>{m[0]}</span>)
        last = m.index! + m[0].length
      }
    }
    push(last, text.length)
    // A trailing newline needs a character after it or the mirror is a line short.
    out.push(text.endsWith('\n') ? ' ' : '')
    return out
  }, [value, regex, open, token, caret, agentNames, aliases])

  const common = {
    ref: fieldRef,
    className: 'mention-input mono',
    value,
    placeholder,
    autoFocus,
    spellCheck: false,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement & HTMLInputElement>) => {
      onChange(e.target.value)
      setCaret(e.target.selectionStart ?? e.target.value.length)
      setDismissedAt(null)
    },
    onSelect: syncCaret,
    onClick: syncCaret,
    onKeyDown: handleKey,
    onKeyUp: (e: React.KeyboardEvent) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') syncCaret() },
    onScroll: (e: React.UIEvent<HTMLElement>) => {
      if (!mirrorRef.current) return
      mirrorRef.current.scrollTop = e.currentTarget.scrollTop
      mirrorRef.current.scrollLeft = e.currentTarget.scrollLeft
    },
    onBlur: () => setDismissedAt(token?.start ?? null),
    onFocus: () => setDismissedAt(null)
  }

  const all = mention ? agentSummaries(useStore.getState()) : []
  const shownAgents = mention
    ? mention.matches.slice(0, mention.agents).map((n) => all.find((a) => a.name === n)).filter((a): a is NonNullable<typeof a> => !!a)
    : []
  const shownMachines = mention
    ? mention.matches.slice(mention.agents).map((a) => machines.find((m) => m.alias === a)).filter((m): m is NonNullable<typeof m> => !!m)
    : []

  return (
    <div className={`mention-field mention-${variant} ${multiline ? 'mention-multi' : ''}`} data-mention-open={open ? 'true' : undefined}>
      <div className="mention-mirror mono" ref={mirrorRef} aria-hidden="true">{painted}</div>
      {multiline ? <textarea rows={rows ?? 4} {...common} /> : <input {...common} />}
      {open && pos && mention && shownAgents.length + shownMachines.length > 0 && createPortal(
        <MentionMenu
          agents={shownAgents}
          machines={shownMachines}
          index={mention.index}
          style={{ position: 'fixed', left: pos.left, top: pos.top }}
          onHover={(i) => setMention({ ...mention, index: i })}
          onPick={accept}
        />,
        document.body
      )}
    </div>
  )
}
