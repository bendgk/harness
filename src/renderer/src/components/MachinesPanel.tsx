import { useEffect, useMemo, useRef, useState } from 'react'
import Modal from './Modal'
import { useStore, type TunnelState } from '../state/store'
import type { Machine } from '@shared/types'
import {
  ago, aliasProblem, machineHealth, missingTools, shortVersion, targetLabel
} from '../lib/machines'
import { AliasChip, HealthDot } from './HostTag'

type Suggestion = { alias: string; hostname?: string; user?: string; registered: boolean }

const HEALTH_TEXT = {
  ok: 'reachable',
  degraded: 'reachable, missing tools',
  error: 'unreachable',
  unknown: 'not tested yet'
}

/**
 * The machine registry: remote computers agents may run on or reach, named
 * by their ~/.ssh/config alias. Paper only ever *tests* access; when
 * something is wrong it says what the human needs to do, never does it.
 */
export default function MachinesPanel(): JSX.Element {
  const machines = useStore((s) => s.machines)
  const panel = useStore((s) => s.machinesPanel)
  const setPanel = useStore((s) => s.setMachinesPanel)
  const setOverlay = useStore((s) => s.setOverlay)
  const refreshMachines = useStore((s) => s.refreshMachines)
  const refreshGateway = useStore((s) => s.refreshGateway)
  const gateway = useStore((s) => s.gateway)

  useEffect(() => {
    void refreshMachines()
    void refreshGateway()
  }, [refreshMachines, refreshGateway])

  return (
    <Modal
      title="Machines"
      subtitle="Computers agents may run on, by ssh alias — Paper uses your ssh config and keys, and never changes them"
      onClose={() => setOverlay(null)}
      wide
    >
      <div className="mach-list">
        {machines.map((m) => (
          <MachineRow key={m.alias} m={m} tunnel={gateway?.tunnels.find((t) => t.alias === m.alias)} />
        ))}
        {!machines.length && !panel.adding && (
          <div className="mach-empty">
            <p className="mach-empty-title">No machines yet</p>
            <p className="sheet-note">
              Add a host from your <span className="mono">~/.ssh/config</span>. Agents here can then work on it with
              {' '}<span className="alias-chip mono">@alias</span>, you can launch agents on it, and move a session
              there and back with its conversation intact.
            </p>
          </div>
        )}
      </div>
      {panel.adding
        ? <AddMachine onDone={() => setPanel({ adding: false })} />
        : (
          <div className="mach-foot">
            <button className="ghost-btn wide" onClick={() => setPanel({ adding: true })}>+ add machine</button>
          </div>
        )}
    </Modal>
  )
}

function MachineRow({ m, tunnel }: { m: Machine; tunnel?: TunnelState }): JSX.Element {
  const panel = useStore((s) => s.machinesPanel)
  const setPanel = useStore((s) => s.setMachinesPanel)
  const probing = useStore((s) => !!s.probing[m.alias])
  const probe = useStore((s) => s.probeMachine)
  const remove = useStore((s) => s.removeMachine)
  const update = useStore((s) => s.updateMachine)
  const ref = useRef<HTMLDivElement>(null)
  const [details, setDetails] = useState(false)
  const [, tick] = useState(0)

  // "tested 4s ago" has to keep counting.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000)
    return () => clearInterval(t)
  }, [])

  // Arriving from a click on @alias: bring this machine into view once.
  const focused = panel.focus === m.alias
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  const health = machineHealth(m)
  const p = m.probe
  const editing = panel.editing === m.alias
  const confirming = panel.confirmRemove === m.alias
  const missing = p?.ok ? missingTools(m) : []
  const allowSelf = m.allowAgentHandoffToLocal !== false

  return (
    <div ref={ref} className={`mach-row ${focused ? 'mach-focus' : ''} mach-${health}`} data-alias={m.alias}>
      <div className="mach-top">
        <HealthDot health={health} busy={probing} title={probing ? 'Testing ssh…' : HEALTH_TEXT[health]} />
        <AliasChip alias={m.alias} size="md" />
        {m.label && <span className="mach-label">{m.label}</span>}
        <span className="mach-state">{probing ? 'testing…' : HEALTH_TEXT[health]}</span>
        <div className="mach-actions">
          <button
            className="ghost-btn tiny"
            disabled={probing}
            title="Run the ssh capability check again"
            onClick={() => void probe(m.alias)}
          >
            {probing ? <span className="mini-spin" /> : null}
            {probing ? 'testing' : 'test'}
          </button>
          <button
            className="ghost-btn tiny"
            onClick={() => setPanel({ editing: editing ? null : m.alias, confirmRemove: null })}
          >{editing ? 'close' : 'edit'}</button>
          <button
            className="ghost-btn tiny danger"
            onClick={() => setPanel({ confirmRemove: m.alias, editing: null })}
          >remove</button>
        </div>
      </div>

      <div className="mach-meta mono">
        {targetLabel(m) && <span title="What the alias resolves to (ssh -G)">{targetLabel(m)}</span>}
        {p?.os && <span>{p.os}</span>}
        {p?.latencyMs !== undefined && p.ok && <span title="Round trip of the probe">{p.latencyMs} ms</span>}
        <span className="mach-dim" title={p ? new Date(p.at).toLocaleString() : undefined}>
          {p ? `tested ${ago(p.at)}` : 'never tested'}
        </span>
      </div>

      {p?.ok && (
        <div className="mach-tools">
          {(['claude', 'codex', 'tmux'] as const).map((k) => (
            <span key={k} className={`tool ${p.tools[k] ? 'tool-yes' : 'tool-no'}`} title={p.tools[k] ?? `${k} not found on @${m.alias}`}>
              <span className="tool-mark">{p.tools[k] ? '✓' : '✗'}</span>
              <span className="tool-name">{k}</span>
              {p.tools[k] && <span className="tool-ver mono">{shortVersion(p.tools[k])}</span>}
            </span>
          ))}
          {tunnel && <TunnelBadge t={tunnel} />}
        </div>
      )}

      {missing.includes('tmux') && (
        <div className="mach-callout mach-warn">
          <span className="callout-msg">tmux is not installed on @{m.alias}</span>
          <span className="callout-hint">Remote sessions live in tmux so they survive disconnects. Install it there (e.g. <span className="mono">sudo apt install tmux</span>), then press test.</span>
        </div>
      )}
      {p?.ok && !p.tools.claude && !p.tools.codex && (
        <div className="mach-callout mach-warn">
          <span className="callout-msg">No agent CLI found on @{m.alias}</span>
          <span className="callout-hint">Install Claude Code or Codex there and sign in once over ssh. Agents here can still run commands on it.</span>
        </div>
      )}

      {p && !p.ok && p.error && (
        <div className="mach-callout mach-err" role="alert">
          <span className="callout-msg">{p.error.message}</span>
          <span className="callout-hint">{p.error.hint}</span>
          {p.error.detail && (
            <>
              <button className="callout-more" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
                {details ? '▾ hide details' : '▸ details'}
              </button>
              {details && <pre className="callout-detail mono">{p.error.detail}</pre>}
            </>
          )}
        </div>
      )}
      {tunnel?.state === 'failed' && p?.ok && tunnel.error && (
        <div className="mach-callout mach-warn">
          <span className="callout-msg">{tunnel.error.message}</span>
          <span className="callout-hint">{tunnel.error.hint}</span>
        </div>
      )}

      {(m.note || m.defaultCwd) && !editing && (
        <div className="mach-notes">
          {m.defaultCwd && <span className="mono" title="Default directory for new sessions and handoffs">⌂ {m.defaultCwd}</span>}
          {m.note && <span className="mach-note" title="Shown to agents">{m.note}</span>}
        </div>
      )}

      <label className="check mach-allow" title="When off, an agent running on this machine cannot hand its session back to this Mac by itself">
        <input
          type="checkbox"
          checked={allowSelf}
          onChange={(e) => void update(m.alias, { allowAgentHandoffToLocal: e.target.checked })}
        />
        Agents on this machine may move themselves to this Mac
      </label>

      {editing && <EditMachine m={m} onDone={() => setPanel({ editing: null })} />}

      {confirming && (
        <div className="mach-confirm fade-in">
          <span>Remove <span className="alias-chip mono">@{m.alias}</span>? Agents can no longer use it. Your ssh config is untouched.</span>
          <div className="mach-confirm-actions">
            <button className="ghost-btn tiny" autoFocus onClick={() => setPanel({ confirmRemove: null })}>keep</button>
            <button className="solid-btn tiny danger-solid" onClick={() => void remove(m.alias)}>remove</button>
          </div>
        </div>
      )}
    </div>
  )
}

function TunnelBadge({ t }: { t: TunnelState }): JSX.Element {
  const text = t.state === 'up' ? 'tunnel up' : t.state === 'connecting' ? 'tunnel connecting' : t.state === 'failed' ? 'tunnel failed' : 'tunnel down'
  const title = t.state === 'up'
    ? `Agents on this machine reach Paper's tools over a reverse ssh tunnel (remote port ${t.remotePort}), since ${new Date(t.since).toLocaleTimeString()}`
    : t.error ? `${t.error.message} — ${t.error.hint}` : `Reverse tunnel ${t.state}`
  return (
    <span className={`tunnel tunnel-${t.state}`} title={title}>
      <span className="tunnel-dot" />
      {text}
      {t.state === 'up' && <span className="mono tunnel-port">:{t.remotePort}</span>}
    </span>
  )
}

function EditMachine({ m, onDone }: { m: Machine; onDone: () => void }): JSX.Element {
  const update = useStore((s) => s.updateMachine)
  const [label, setLabel] = useState(m.label ?? '')
  const [cwd, setCwd] = useState(m.defaultCwd ?? '')
  const [note, setNote] = useState(m.note ?? '')
  const save = async (): Promise<void> => {
    await update(m.alias, { label: label.trim() || undefined, defaultCwd: cwd.trim() || undefined, note: note.trim() || undefined })
    onDone()
  }
  const onKey = (e: React.KeyboardEvent): void => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void save() } }
  return (
    <div className="mach-edit fade-in">
      <label className="field">
        <span className="label">Label</span>
        <input className="text-input" value={label} placeholder="e.g. GPU box" autoFocus onChange={(e) => setLabel(e.target.value)} onKeyDown={onKey} />
      </label>
      <label className="field">
        <span className="label">Default directory</span>
        <input className="text-input mono" value={cwd} placeholder="~ — used for new sessions and handoffs" onChange={(e) => setCwd(e.target.value)} onKeyDown={onKey} />
      </label>
      <label className="field field-wide">
        <span className="label">Note for agents</span>
        <input className="text-input" value={note} placeholder="e.g. 8×L40S, repos in ~/work, use conda env ml" onChange={(e) => setNote(e.target.value)} onKeyDown={onKey} />
      </label>
      <div className="acct-add-actions field-wide">
        <button className="ghost-btn" onClick={onDone}>cancel</button>
        <button className="solid-btn" onClick={() => void save()}>save</button>
      </div>
    </div>
  )
}

function AddMachine({ onDone }: { onDone: () => void }): JSX.Element {
  const machines = useStore((s) => s.machines)
  const add = useStore((s) => s.addMachine)
  const probing = useStore((s) => s.probing)
  const setPanel = useStore((s) => s.setMachinesPanel)
  const [alias, setAlias] = useState('')
  const [label, setLabel] = useState('')
  const [touched, setTouched] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null)

  useEffect(() => { void useStore.getState().suggestMachines().then(setSuggestions) }, [])

  const clean = alias.trim().replace(/^@/, '')
  const problem = aliasProblem(clean, machines.map((m) => m.alias))
  const busy = !!probing[clean]
  const visible = useMemo(
    () => (suggestions ?? []).filter((s) => !clean || s.alias.toLowerCase().includes(clean.toLowerCase())),
    [suggestions, clean]
  )

  const submit = async (pick?: string): Promise<void> => {
    const a = pick ?? clean
    setTouched(true)
    if (aliasProblem(a, machines.map((m) => m.alias))) return
    const m = await add({ alias: a, label: label.trim() || undefined })
    if (m) { onDone(); setPanel({ focus: m.alias }) }
  }

  return (
    <div className="acct-add mach-add fade-in">
      <div className="mach-add-line">
        <div className={`alias-input ${touched && problem ? 'alias-input-bad' : ''}`}>
          <span className="alias-at mono">@</span>
          <input
            className="mono"
            placeholder="ssh alias, e.g. g6e"
            value={alias}
            autoFocus
            spellCheck={false}
            onChange={(e) => { setAlias(e.target.value); setTouched(true) }}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          />
        </div>
        <input
          className="text-input mach-add-label"
          placeholder="label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
        />
      </div>
      <div className={`mach-valid ${touched && problem ? 'mach-valid-bad' : ''}`}>
        {busy ? 'Testing ssh access…' : touched && problem ? problem : 'Paper runs `ssh <alias>` in batch mode — it never asks for passwords or accepts host keys for you.'}
      </div>

      <div className="label picker-group">From ~/.ssh/config</div>
      <div className="mach-suggest">
        {suggestions === null && <span className="sheet-note">reading ssh config…</span>}
        {suggestions !== null && !visible.length && (
          <span className="sheet-note">{!suggestions.length ? 'No Host entries found in ~/.ssh/config.' : problem ? 'No alias matches.' : 'No alias matches — you can still add it by name.'}</span>
        )}
        {visible.map((s) => (
          <button
            key={s.alias}
            className={`suggest-chip ${s.registered ? 'suggest-added' : ''}`}
            disabled={s.registered || busy}
            title={s.registered ? `@${s.alias} is already registered` : `Add and test @${s.alias}`}
            onClick={() => { setAlias(s.alias); void submit(s.alias) }}
          >
            <span className="alias-chip mono">@{s.alias}</span>
            {(s.user || s.hostname) && <span className="suggest-host mono">{s.user ? `${s.user}@` : ''}{s.hostname}</span>}
            {s.registered && <span className="suggest-tag">added</span>}
            {!s.registered && probing[s.alias] && <span className="mini-spin" />}
          </button>
        ))}
      </div>

      <div className="acct-add-actions">
        <button className="ghost-btn" onClick={onDone}>cancel</button>
        <button className="solid-btn" disabled={busy || !!problem} onClick={() => void submit()}>
          {busy ? 'testing…' : 'add & test'}
        </button>
      </div>
    </div>
  )
}
