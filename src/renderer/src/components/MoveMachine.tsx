import { useState } from 'react'
import Modal from './Modal'
import MentionField from './MentionField'
import { useStore } from '../state/store'
import { LOCAL_HOST, type Machine } from '@shared/types'
import { canLaunch, machineHealth, toolsHint } from '../lib/machines'
import { AliasChip, HealthDot } from './HostTag'

interface Option {
  host: string
  machine?: Machine
  ok: boolean
  reason?: string
}

/**
 * "Move to machine…": the SwitchAccount sheet's sibling for computers. The
 * agent is stopped, its transcript carried to the target and resumed there
 * (in tmux, for a machine), so the conversation continues where it stopped.
 */
export default function MoveMachine(): JSX.Element {
  const session = useStore((s) => s.activeSession())
  const machines = useStore((s) => s.machines)
  const setOverlay = useStore((s) => s.setOverlay)
  const move = useStore((s) => s.moveToMachine)
  const [index, setIndex] = useState<number | null>(null)
  const [cwd, setCwd] = useState('')
  const [prompt, setPrompt] = useState('')
  const close = (): void => setOverlay(null)

  if (!session) {
    return (
      <Modal title="Move to machine" onClose={close}>
        <p className="sheet-note sheet-pad">Open a session first.</p>
      </Modal>
    )
  }

  const here = session.host ?? LOCAL_HOST
  const options: Option[] = [
    { host: LOCAL_HOST, ok: here !== LOCAL_HOST, reason: here === LOCAL_HOST ? 'already here' : undefined },
    ...machines.map((m) => {
      const gate = canLaunch(m, session.provider)
      return {
        host: m.alias, machine: m,
        ok: m.alias !== here && gate.ok,
        reason: m.alias === here ? 'already here' : gate.reason
      }
    })
  ]
  // Start on the first place the session can actually go.
  const first = Math.max(0, options.findIndex((o) => o.ok))
  const at = index ?? first
  const active = options[at]

  const step = (delta: number): void => {
    let i = at
    for (let n = 0; n < options.length; n++) {
      i = (i + delta + options.length) % options.length
      if (options[i].ok) { setIndex(i); return }
    }
  }

  const go = (o: Option | undefined = active): void => {
    if (!o?.ok) return
    void move({ host: o.host, cwd: cwd.trim() || undefined, continuePrompt: prompt.trim() || undefined })
  }

  const onListKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1) }
    if (e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
    if (e.key === 'Enter') { e.preventDefault(); go() }
  }

  const target = active?.machine
  // The default chain main applies: machine default dir → same path → the ~-relative equivalent.
  const placeholder = target?.defaultCwd
    ? `default: ${target.defaultCwd} (machine default)`
    : 'default: same path, else the same under ~'

  return (
    <Modal
      title="Move to machine"
      subtitle={`${session.title} · now on ${here === LOCAL_HOST ? 'this Mac' : `@${here}`}`}
      onClose={close}
    >
      <div className="switch-list" tabIndex={0} onKeyDown={onListKey} autoFocus role="listbox" aria-label="Target machine">
        {options.map((o, i) => (
          <button
            key={o.host}
            role="option"
            aria-selected={i === at}
            aria-disabled={!o.ok}
            // The list is one tab stop (arrow keys inside); Tab goes on to the fields.
            tabIndex={-1}
            className={`switch-row ${i === at && o.ok ? 'switch-active' : ''} ${o.ok ? '' : 'switch-off'}`}
            onMouseEnter={() => { if (o.ok) setIndex(i) }}
            onClick={() => (o.ok ? go(o) : undefined)}
            title={o.reason}
          >
            {o.machine ? <HealthDot health={machineHealth(o.machine)} /> : <span className="mdot mdot-local" />}
            <span className="switch-label">
              {o.machine
                ? <span className="move-name"><AliasChip alias={o.host} />{o.machine.label && <span>{o.machine.label}</span>}</span>
                : <span className="move-name">This Mac</span>}
              <span className="switch-prov">
                {o.machine ? (o.machine.probe?.ok ? `${o.machine.probe.os ?? ''}${o.machine.probe.os ? ' · ' : ''}${toolsHint(o.machine)}` : toolsHint(o.machine)) : 'local'}
              </span>
            </span>
            {o.host === here
              ? <span className="switch-mode mode-here">current</span>
              : o.ok
                ? session.provider === 'shell'
                  ? <span className="switch-mode mode-here">fresh shell</span>
                  : <span className="switch-mode mode-exact">full context</span>
                : <span className="switch-warn">{o.reason}</span>}
          </button>
        ))}
        {!machines.length && (
          <p className="sheet-note move-none">
            No machines registered yet.{' '}
            <button className="link-btn" onClick={() => useStore.getState().openMachines({ adding: true })}>Add one (⌘⇧M)</button>
          </p>
        )}
      </div>

      <div className="move-fields">
        <label className="field field-wide">
          <span className="label">Directory on {active?.host === LOCAL_HOST ? 'this Mac' : `@${active?.host ?? '…'}`}</span>
          <input
            className="text-input mono"
            value={cwd}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go() } }}
          />
        </label>
        <label className="field field-wide">
          <span className="label">Continue with (optional)</span>
          <MentionField
            name="move-continue"
            selfSessionId={session.id}
            value={prompt}
            onChange={setPrompt}
            placeholder="e.g. continue the sweep — typed in once it is running"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go() } }}
          />
        </label>
      </div>

      <footer className="sheet-foot">
        <span className="sheet-note">
          {session.provider === 'shell'
            ? 'A terminal has no conversation to carry — a fresh shell opens on the target.'
            : 'The conversation moves intact: the agent is stopped, its transcript copied across and resumed there.'}
        </span>
        <button className="solid-btn" disabled={!active?.ok} onClick={() => go()}>move</button>
      </footer>
    </Modal>
  )
}
