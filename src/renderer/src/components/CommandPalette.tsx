import { useMemo, useState } from 'react'
import Modal from './Modal'
import { useStore } from '../state/store'
import { PANE_WIDGETS } from '../widgets/panes'
import { LOCAL_HOST } from '@shared/types'
import { canLaunch } from '../lib/machines'

interface Command {
  id: string
  label: string
  hint?: string
  group: string
  run: () => void | Promise<void>
}

/** Subsequence match, so "nsc" finds "New session · Claude". */
function matches(query: string, text: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (t.includes(q)) return true
  let i = 0
  for (const ch of t) if (ch === q[i]) i++
  return i === q.length
}

export default function CommandPalette(): JSX.Element {
  const store = useStore()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const close = (): void => store.setOverlay(null)

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: 'new.claude', group: 'Session', label: 'New session · Claude Code', hint: '⌘⌥C',
        run: () => store.newTab({ provider: 'claude' }) },
      { id: 'new.codex', group: 'Session', label: 'New session · Codex', hint: '⌘⌥X',
        run: () => store.newTab({ provider: 'codex' }) },
      { id: 'new.shell', group: 'Session', label: 'New terminal', hint: '⌘⌥T',
        run: () => store.newTab({ provider: 'shell' }) },
      { id: 'new.folder', group: 'Session', label: 'New session in folder…', hint: '⌘⇧N',
        run: async () => {
          const dir = await window.paper.pickDirectory()
          if (dir) await store.newTab({ cwd: dir })
        } },
      { id: 'cd', group: 'Session', label: 'Change directory…', hint: '⌘L',
        run: () => store.setOverlay('cwd') },
      { id: 'switch', group: 'Accounts', label: 'Switch account for this session…', hint: '⌘P',
        run: () => store.setOverlay('switch') },
      { id: 'accounts', group: 'Accounts', label: 'Manage accounts…', hint: '⌘,',
        run: () => store.setOverlay('accounts') },
      { id: 'machines', group: 'Machines', label: 'Manage machines…', hint: '⌘⇧M',
        run: () => store.openMachines() },
      { id: 'machines.add', group: 'Machines', label: 'Add a machine…',
        run: () => store.openMachines({ adding: true }) },
      { id: 'split.row', group: 'Layout', label: 'Split right', hint: '⌘D', run: () => store.split('row') },
      { id: 'split.col', group: 'Layout', label: 'Split down', hint: '⌘⇧D', run: () => store.split('col') },
      { id: 'pane.close', group: 'Layout', label: 'Close pane', hint: '⌘X', run: () => store.closePane() },
      { id: 'pane.contents', group: 'Layout', label: 'Pane contents…', hint: '⌘J',
        run: () => store.setOverlay('panewidgets') },
      { id: 'sidebar', group: 'View', label: 'Toggle sidebar', hint: '⌘B', run: () => store.toggleSidebar() },
      { id: 'zen', group: 'View', label: 'Toggle zen mode', hint: '⌘⇧↩', run: () => store.toggleZen() },
      { id: 'theme', group: 'View', label: `Switch to ${store.theme === 'day' ? 'night' : 'day'} paper`,
        run: () => store.toggleTheme() },
      { id: 'widgets', group: 'View', label: 'Configure widgets…', run: () => store.setOverlay('widgets') },
      { id: 'font.up', group: 'View', label: 'Bigger text', hint: '⌘+', run: () => store.bumpFont(0.5) },
      { id: 'font.down', group: 'View', label: 'Smaller text', hint: '⌘-', run: () => store.bumpFont(-0.5) }
    ]

    const session = store.activeSession()
    if (session) {
      list.push(
        { id: 'steer', group: 'Agent', label: 'Interrupt and steer…', hint: '⌘↩',
          run: () => store.setOverlay('steer') },
        { id: 'interrupt', group: 'Agent', label: 'Interrupt agent', hint: '⌘.',
          run: () => window.paper.session.interrupt(session.id) },
        { id: 'restart', group: 'Agent', label: 'Restart session (keeps context)', hint: '⌘R',
          run: () => window.paper.session.restart(session.id) },
        { id: 'rename', group: 'Agent', label: 'Rename session…', hint: '⌘⇧R',
          run: () => store.setOverlay('rename') },
        { id: 'move', group: 'Agent', label: 'Move to machine…', hint: '⌘⇧P',
          run: () => store.setOverlay('move') }
      )
      if (session.host && session.host !== LOCAL_HOST) {
        list.push({ id: 'move.local', group: 'Agent', label: 'Move back to this Mac', hint: `from @${session.host}`,
          run: () => store.moveToMachine({ host: LOCAL_HOST }) })
      }
    }

    // Every machine gets its own launchers, and a direct move for the focused session.
    for (const m of store.machines) {
      const where = `@${m.alias}`
      const launch = (provider: 'claude' | 'codex' | 'shell', label: string): Command => {
        const gate = canLaunch(m, provider)
        return {
          id: `on.${m.alias}.${provider}`,
          group: 'Machines',
          label: `${label} on ${where}`,
          hint: gate.ok ? m.label : gate.reason,
          // A machine that cannot take it opens its details, where the reason and the fix are.
          run: () => (gate.ok ? store.newTab({ provider, host: m.alias }) : store.openMachines({ focus: m.alias }))
        }
      }
      list.push(launch('claude', 'New Claude'), launch('codex', 'New Codex'), launch('shell', 'New terminal'))
      if (session && session.host !== m.alias) {
        const gate = canLaunch(m, session.provider)
        list.push({
          id: `move.${m.alias}`, group: 'Machines', label: `Move session to ${where}`,
          hint: gate.ok ? 'keeps context' : gate.reason,
          run: () => (gate.ok ? store.moveToMachine({ host: m.alias }) : store.openMachines({ focus: m.alias }))
        })
      }
    }

    // Placing a widget straight from the palette skips the picker entirely.
    for (const w of PANE_WIDGETS) {
      list.push({
        id: `widget.${w.id}`,
        group: 'Place widget',
        label: w.name,
        hint: w.note,
        run: () => store.openWidget(w.id)
      })
    }

    // Jumping straight to an account is the fastest path for a switch.
    for (const a of store.accounts) {
      list.push({
        id: `acct.${a.id}`,
        group: 'Switch to',
        label: `${a.label} · ${a.provider === 'claude' ? 'Claude Code' : 'Codex'}`,
        hint: a.authed ? undefined : 'signed out',
        run: () => store.switchAccount(a.id)
      })
    }
    return list
  }, [store])

  const filtered = commands.filter((c) => matches(query, `${c.group} ${c.label}`))
  const active = filtered[Math.min(index, filtered.length - 1)]

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, filtered.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
    if (e.key === 'Enter' && active) { e.preventDefault(); close(); void active.run() }
  }

  let lastGroup = ''
  return (
    <Modal onClose={close}>
      <input
        className="palette-input mono"
        placeholder="Type a command…"
        value={query}
        autoFocus
        onChange={(e) => { setQuery(e.target.value); setIndex(0) }}
        onKeyDown={onKeyDown}
      />
      <div className="palette-list">
        {filtered.map((c, i) => {
          const header = c.group !== lastGroup ? c.group : null
          lastGroup = c.group
          return (
            <div key={c.id}>
              {header && <div className="label palette-group">{header}</div>}
              <button
                className={`palette-row ${c === active ? 'palette-active' : ''}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => { close(); void c.run() }}
              >
                <span>{c.label}</span>
                {c.hint && <span className="palette-hint mono">{c.hint}</span>}
              </button>
            </div>
          )
        })}
        {!filtered.length && <div className="palette-empty">No matching command.</div>}
      </div>
    </Modal>
  )
}
