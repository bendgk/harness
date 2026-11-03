import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { LOCAL_HOST, type HostedAgent, type MachineError, type ProviderId, type SessionMeta } from '@shared/types'
import { ago, machineHealth } from '../lib/machines'
import { AliasChip, HealthDot } from './HostTag'
import { AgentChip, AgentNameEditor, agentHover, hideAgentCardNow } from './AgentTag'

type AgentState = 'working' | 'idle' | 'starting' | 'handoff' | 'exited' | 'detached'

/** One agent under a host: a live Paper session, a remote tmux session nobody here is attached to, or both. */
export interface TreeAgent {
  key: string
  sessionId?: string
  tmux?: string
  /** Agent callsign (never on shells): live meta first, else the machine's @paper_name tag. */
  name?: string
  provider?: ProviderId
  title: string
  cwd?: string
  state: AgentState
  activityAt?: number
  /** Shown in some tab already (click switches to it). */
  visible: boolean
}

export interface TreeHost {
  key: string
  host: string
  label?: string
  health: 'ok' | 'degraded' | 'error' | 'unknown'
  checkedAt?: number
  error?: MachineError
  agents: TreeAgent[]
}

const basename = (p?: string): string => (p ? p.replace(/\/+$/, '').split('/').pop() || p : '')

/**
 * The machines → agents tree, merged from two sources: live sessions in the
 * store (what this window is attached to) and each machine's inventory (what
 * is really running there, read from its tmux). The inventory is the truth
 * for remote hosts — an agent still running after Paper quit shows up as
 * "detached" until it is opened again.
 */
export function buildTree(s: ReturnType<typeof useStore.getState>): TreeHost[] {
  const shown = new Set<string>()
  for (const t of s.tabs) {
    const walk = (n: typeof t.root): void => {
      if (n.kind === 'leaf') { if (n.content.type === 'terminal' && n.content.sessionId) shown.add(n.content.sessionId) }
      else n.children.forEach(walk)
    }
    walk(t.root)
  }
  const sessions = Object.values(s.sessions)
  const fromSession = (m: SessionMeta, agent?: HostedAgent): TreeAgent => ({
    key: m.id,
    sessionId: m.id,
    tmux: m.remote?.tmux ?? agent?.tmux,
    name: m.provider === 'shell' ? undefined : m.name ?? agent?.name,
    provider: m.provider,
    title: m.title,
    cwd: m.cwd,
    state: m.status,
    activityAt: s.lastActivity[m.id] ?? agent?.activityAt ?? m.createdAt,
    visible: shown.has(m.id)
  })

  const local: TreeHost = {
    key: LOCAL_HOST,
    host: LOCAL_HOST,
    label: 'This Mac',
    health: 'ok',
    agents: sessions.filter((m) => !m.host || m.host === LOCAL_HOST).map((m) => fromSession(m))
  }

  const remotes = s.machines.map<TreeHost>((machine) => {
    const inv = s.inventory[machine.alias]
    const live = sessions.filter((m) => m.host === machine.alias)
    const agents: TreeAgent[] = []
    const claimed = new Set<string>()
    for (const m of live) {
      const agent = inv?.agents.find((a) => a.sessionId === m.id || (m.remote?.tmux && a.tmux === m.remote.tmux))
      if (agent) claimed.add(agent.tmux)
      agents.push(fromSession(m, agent))
    }
    for (const a of inv?.agents ?? []) {
      if (claimed.has(a.tmux)) continue
      // A live session of this Paper that the inventory names by id but not
      // by tmux would already be claimed; anything left is running unattended.
      const meta = a.sessionId ? s.sessions[a.sessionId] : undefined
      if (meta) continue
      agents.push({
        key: `${machine.alias}:${a.tmux}`,
        tmux: a.tmux,
        name: a.name,
        provider: a.provider,
        title: a.title || a.command || a.tmux,
        cwd: a.cwd,
        state: 'detached',
        activityAt: a.activityAt,
        visible: false
      })
    }
    const probeErr = machine.probe && !machine.probe.ok ? machine.probe.error : undefined
    const error = inv && !inv.ok ? inv.error ?? probeErr : probeErr
    return {
      key: machine.alias,
      host: machine.alias,
      label: machine.label,
      health: error ? 'error' : machineHealth(machine),
      checkedAt: inv?.at ?? machine.probe?.at,
      error,
      agents
    }
  })
  return [local, ...remotes]
}

const PROV_GLYPH: Record<ProviderId, string> = { claude: 'claude', codex: 'codex', shell: 'shell' }

export default function MachineTree(): JSX.Element {
  // Subscribing to the pieces buildTree reads keeps this re-rendering when any of them move.
  useStore((s) => s.sessions)
  useStore((s) => s.tabs)
  useStore((s) => s.inventory)
  useStore((s) => s.machines)
  useStore((s) => s.lastActivity)
  const collapsed = useStore((s) => s.treeCollapsed)
  const loading = useStore((s) => s.inventoryLoading)
  const toggle = useStore((s) => s.toggleTreeCollapsed)
  const refresh = useStore((s) => s.refreshInventory)
  const refreshAgents = useStore((s) => s.refreshAgents)
  const openMachines = useStore((s) => s.openMachines)
  const hasMachines = useStore((s) => s.machines.length > 0)
  const [, tick] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const tree = buildTree(useStore.getState())

  // Never stale: re-read the machines when the tree appears and whenever the
  // window comes back to the front (a laptop lid, another app) — that is
  // exactly when something may have changed behind Paper's back.
  useEffect(() => {
    void refresh(true)
    let last = Date.now()
    const onFocus = (): void => {
      if (Date.now() - last < 4000) return
      last = Date.now()
      void refresh(true)
    }
    window.addEventListener('focus', onFocus)
    const t = setInterval(() => tick((n) => n + 1), 5000)
    // What each agent is doing (hover cards, the dropdown): cheap, but no need to hurry.
    void refreshAgents(true)
    const slow = setInterval(() => { if (document.visibilityState === 'visible') void refreshAgents() }, 15_000)
    return () => { window.removeEventListener('focus', onFocus); clearInterval(t); clearInterval(slow) }
  }, [refresh, refreshAgents])

  // Arrow keys walk the visible rows; ← folds a host (or climbs to it), → unfolds.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>('[data-tree-row]') ?? [])]
    const i = rows.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    const row = rows[i]
    const hostKey = row.dataset.host!
    const isHost = row.dataset.treeRow === 'host'
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[Math.min(i + 1, rows.length - 1)].focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rows[Math.max(i - 1, 0)].focus() }
    else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (isHost && !collapsed.includes(hostKey)) toggle(hostKey)
      else if (!isHost) rows.find((r) => r.dataset.treeRow === 'host' && r.dataset.host === hostKey)?.focus()
    } else if (e.key === 'ArrowRight' && isHost) {
      e.preventDefault()
      if (collapsed.includes(hostKey)) toggle(hostKey)
      else if (rows[i + 1]?.dataset.host === hostKey) rows[i + 1].focus()
    }
  }

  return (
    <section className="side-section tree-section">
      <div className="side-head">
        <span className="label">Agents</span>
        {hasMachines && (
          <button
            className={`tree-refresh ${loading ? 'tree-refresh-on' : ''}`}
            title="Check every machine now"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void refresh(true)}
          >↻</button>
        )}
      </div>
      <div className="tree" role="tree" aria-label="Machines and their agents" ref={ref} onKeyDown={onKeyDown}>
        {tree.map((h) => <HostNode key={h.key} h={h} open={!collapsed.includes(h.key)} onToggle={() => toggle(h.key)} />)}
      </div>
      {!hasMachines && (
        <button className="tree-add" onMouseDown={(e) => e.preventDefault()} onClick={() => openMachines({ adding: true })}>
          + add a machine
        </button>
      )}
    </section>
  )
}

function HostNode({ h, open, onToggle }: { h: TreeHost; open: boolean; onToggle: () => void }): JSX.Element {
  const openMachines = useStore((s) => s.openMachines)
  const local = h.host === LOCAL_HOST
  const active = h.agents.filter((a) => a.state !== 'exited').length
  const working = h.agents.some((a) => a.state === 'working')
  const sub = h.error
    ? h.error.message
    : local ? undefined : h.checkedAt ? `checked ${ago(h.checkedAt)}` : 'not checked yet'
  return (
    <div className="tree-host" role="treeitem" aria-expanded={open} aria-label={local ? 'This Mac' : `@${h.host}`}>
      <button
        className={`tree-row tree-host-row ${h.error ? 'tree-host-err' : ''}`}
        data-tree-row="host"
        data-host={h.key}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggle}
        onDoubleClick={() => { if (!local) openMachines({ focus: h.host }) }}
        title={h.error ? `${h.error.message}\n${h.error.hint}` : local ? 'Sessions running on this Mac' : `${h.label ? `${h.label} · ` : ''}double-click for machine details`}
      >
        <span className={`tree-chev ${open ? 'tree-chev-open' : ''}`} aria-hidden="true">›</span>
        {local ? <span className="mdot mdot-local" /> : <HealthDot health={h.health} />}
        {local ? <span className="tree-host-name">This Mac</span> : <AliasChip alias={h.host} />}
        {!local && h.label && <span className="tree-host-label">{h.label}</span>}
        <span className={`tree-count mono ${working ? 'tree-count-busy' : ''}`} title={`${active} running`}>{active || ''}</span>
      </button>
      {sub && <div className={`tree-host-sub ${h.error ? 'tree-host-sub-err' : ''}`}>{sub}</div>}
      {open && (
        <div role="group" className="tree-children">
          {h.error && <div className="tree-hint">{h.error.hint}</div>}
          {h.agents.map((a) => <AgentRow key={a.key} a={a} host={h.host} />)}
          {!h.agents.length && !h.error && <div className="tree-none">{local ? 'no sessions' : 'no agents running'}</div>}
        </div>
      )}
    </div>
  )
}

function AgentRow({ a, host }: { a: TreeAgent; host: string }): JSX.Element {
  const reveal = useStore((s) => s.revealSession)
  const adopt = useStore((s) => s.adoptAgent)
  const beginRename = useStore((s) => s.beginRename)
  const editing = useStore((s) => !!a.sessionId && s.renaming?.where === 'tree' && s.renaming.sessionId === a.sessionId)
  const [busy, setBusy] = useState(false)
  // Only a live session can be renamed; a detached one is opened first.
  const rename = a.name && a.sessionId && a.state !== 'detached'
    ? (e: React.MouseEvent): void => { e.stopPropagation(); hideAgentCardNow(); beginRename(a.sessionId!, 'tree') }
    : undefined
  const activate = async (): Promise<void> => {
    if (a.sessionId) return reveal(a.sessionId)
    if (!a.tmux || busy) return
    setBusy(true)
    try { await adopt(host, a.tmux) } finally { setBusy(false) }
  }
  const what = a.state === 'detached'
    ? `Running on @${host}, not open in Paper — click to attach in a new tab`
    : a.visible ? 'Click to switch to its tab' : 'Not in any tab — click to open it in a new tab'
  if (editing && a.sessionId) {
    return (
      <div className={`tree-row tree-agent tree-agent-${a.state} tree-agent-editing`} role="treeitem" data-host={host}>
        <span className={`dot dot-${a.state}`} />
        <span className="tree-agent-main">
          <AgentNameEditor where="tree" sessionId={a.sessionId} />
          <span className="tree-agent-meta mono">{a.title}</span>
        </span>
      </div>
    )
  }
  return (
    <button
      className={`tree-row tree-agent tree-agent-${a.state} ${a.visible ? '' : 'tree-agent-hidden'}`}
      role="treeitem"
      data-tree-row="agent"
      data-host={host === LOCAL_HOST ? LOCAL_HOST : host}
      data-agent={a.name}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void activate()}
      onKeyDown={(e) => { if (e.key === 'F2' && rename) { e.preventDefault(); beginRename(a.sessionId!, 'tree') } }}
      title={`${a.name ? `@${a.name} · ` : ''}${a.title}${a.cwd ? ` — ${a.cwd}` : ''}\n${what}${rename ? '\nDouble-click the name (or F2) to rename' : ''}`}
    >
      <span className={`dot dot-${a.state === 'detached' ? 'detached' : a.state}`} />
      <span className="tree-agent-main">
        <span className="tree-agent-line">
          {a.name && (
            <span className="tree-agent-name" {...agentHover(a.name, 'left', '.sidebar')} onDoubleClick={rename}>
              <AgentChip name={a.name} card={false} />
            </span>
          )}
          <span className="tree-agent-title">{a.title}</span>
        </span>
        <span className="tree-agent-meta mono">
          {a.provider && <span className={`prov-dot prov-${PROV_GLYPH[a.provider]}`} />}
          {basename(a.cwd)}
          {a.activityAt && <span className="tree-agent-when">{ago(a.activityAt)}</span>}
        </span>
      </span>
      {rename && (
        <span className="tree-rename" role="button" aria-label={`Rename @${a.name}`} title="Rename (F2)" onClick={rename}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 8.5 L2 6.4 L6.6 1.8 L8.2 3.4 L3.6 8 Z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /></svg>
        </span>
      )}
      {busy ? <span className="mini-spin" /> : a.state === 'detached' && <span className="tree-tag">detached</span>}
    </button>
  )
}
