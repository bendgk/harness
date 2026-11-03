import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { Meter, Spark, toneFor } from '../widgets/Meter'
import Pet from '../widgets/Pet'
import { elapsed, pct, tokens, until, usd, windowLabel } from '../lib/format'
import { shortPath } from './Pane'
import { LOCAL_HOST, type PlanUsage, type PlanWindow, type ProviderId } from '@shared/types'
import MachineTree from './MachineTree'
import { AliasChip } from './HostTag'
import { AgentChip, AgentNameEditor } from './AgentTag'

const PROVIDER_NAME: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  shell: 'Terminal'
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return (
    <section className="side-section">
      <div className="side-head">
        <span className="label">{title}</span>
        {aside && <span className="side-aside mono">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

function Row({ k, v, dim }: { k: string; v: string; dim?: boolean }): JSX.Element {
  return (
    <div className={`row ${dim ? 'row-dim' : ''}`}>
      <span className="row-k">{k}</span>
      <span className="row-v mono">{v}</span>
    </div>
  )
}

/**
 * Which windows to show, in `/usage` order. A model-scoped week (e.g. Fable)
 * only appears once it has been used — at 0% it is noise; the session and the
 * all-models week always show.
 */
export function visibleWindows(p: PlanUsage): PlanWindow[] {
  const order = { session: 0, weekly: 1, weekly_scoped: 2 } as const
  return p.windows
    .filter((w) => w.kind !== 'weekly_scoped' || w.percent > 0)
    .sort((a, b) => order[a.kind] - order[b.kind])
}

/** "resets 2:20 PM" today, "resets Thu 12:00 AM" later — the way `/usage` says it, in local time. */
function resetsText(at?: number): string {
  if (!at) return ''
  // The endpoint reports e.g. 03:59:59.86 for a 04:00 reset; say the minute it means.
  const d = new Date(Math.round(at / 60_000) * 60_000)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const sameDay = d.toDateString() === new Date().toDateString()
  return `resets ${sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`} · in ${until(at)}`
}

/**
 * Plan usage — what `/usage` shows: current session, current week, and a
 * scoped week once it is in use. The focused session's account leads (or the
 * default Claude account when a terminal is focused); other accounts follow
 * as one compact line each, so every login's headroom is visible at a glance.
 */
function PlanSection({ focusedAccountId }: { focusedAccountId?: string }): JSX.Element | null {
  const plan = useStore((s) => s.plan)
  const accounts = useStore((s) => s.accounts)
  const defaults = useStore((s) => s.defaults)
  const refreshPlan = useStore((s) => s.refreshPlan)
  const [busy, setBusy] = useState(false)
  const withPlan = accounts.filter((a) => plan[a.id])
  if (!withPlan.length) return null
  const leadId =
    (focusedAccountId && plan[focusedAccountId] ? focusedAccountId : undefined) ??
    (defaults.accountByProvider.claude && plan[defaults.accountByProvider.claude] ? defaults.accountByProvider.claude : undefined) ??
    withPlan[0].id
  const lead = plan[leadId]
  const leadAccount = accounts.find((a) => a.id === leadId)
  const others = withPlan.filter((a) => a.id !== leadId)
  const refresh = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try { await refreshPlan() } finally { setBusy(false) }
  }
  return (
    <Section
      title="Plan usage"
      aside={
        <button className={`plan-refresh ${busy ? 'busy' : ''}`} onClick={() => void refresh()} title="Refresh from Anthropic">
          {leadAccount?.label ?? 'account'}{lead.stale ? ' · stale' : ''} ↻
        </button>
      }
    >
      {visibleWindows(lead).map((w) => (
        <div key={w.kind + w.label} className="limit">
          <div className="limit-head">
            <span className="limit-name">{w.label}</span>
            <span className="limit-val mono">{pct(w.percent)}</span>
          </div>
          <Meter value={w.percent} tone={toneFor(w.percent)} />
          {w.resetsAt && <div className="limit-reset mono">{resetsText(w.resetsAt)}</div>}
        </div>
      ))}
      {lead.error && <p className="plan-error">{lead.error}</p>}
      {others.map((a) => {
        const p = plan[a.id]
        const shown = visibleWindows(p)
        return (
          <Row
            key={a.id}
            k={a.label}
            v={p.ok || p.stale ? shown.map((w) => pct(w.percent)).join(' · ') : 'unavailable'}
            dim
          />
        )
      })}
    </Section>
  )
}

/** The right margin of the page: everything the current session is spending. */
export default function Sidebar(): JSX.Element {
  const session = useStore((s) => s.activeSession())
  const usage = useStore((s) => (session ? s.usage[session.id] : undefined))
  const account = useStore((s) => s.accounts.find((a) => a.id === session?.accountId))
  const widgets = useStore((s) => s.widgets)
  const setOverlay = useStore((s) => s.setOverlay)
  const openMachines = useStore((s) => s.openMachines)
  const sessions = useStore((s) => s.sessions)
  const allUsage = useStore((s) => s.usage)
  const beginRename = useStore((s) => s.beginRename)
  const editingName = useStore((s) => !!session && s.renaming?.where === 'side' && s.renaming.sessionId === session.id)
  const [, tick] = useState(0)

  // Relative times ("resets in 2h") need a heartbeat to stay honest.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  // A plain terminal has no context window, no tokens and no plan limits;
  // showing those rows as blanks would only invite the question.
  const isAgent = session ? session.provider !== 'shell' : false
  const on = (id: string): boolean => widgets.enabled.includes(id) && isAgent
  const ctxPct = usage && usage.contextWindow ? (usage.contextTokens / usage.contextWindow) * 100 : 0

  const totals = Object.values(allUsage).reduce(
    (acc, u) => ({ cost: acc.cost + u.costUsd, tok: acc.tok + u.totalTokens }),
    { cost: 0, tok: 0 }
  )

  return (
    <aside className="sidebar">
      <MachineTree />

      {session ? (
        <>
          <Section title="Session" aside={elapsed(session.createdAt)}>
            <div className="side-title">{session.title}</div>
            {isAgent && session.name && (
              editingName ? (
                <div className="row side-name-edit">
                  <span className="row-k">name</span>
                  <AgentNameEditor where="side" sessionId={session.id} />
                </div>
              ) : (
                <div className="row side-name">
                  <span className="row-k">name</span>
                  <span className="row-v side-name-v">
                    <AgentChip
                      name={session.name}
                      title="Other agents and you can mention it as this — double-click to rename"
                      onDoubleClick={() => beginRename(session.id, 'side')}
                    />
                    <button className="side-rename" title="Rename this agent" onClick={() => beginRename(session.id, 'side')}>rename</button>
                  </span>
                </div>
              )
            )}
            <Row k="harness" v={PROVIDER_NAME[session.provider]} />
            {session.host && session.host !== LOCAL_HOST ? (
              <button
                className="side-folder"
                title={`Runs on @${session.host}${session.remote ? ` in tmux ${session.remote.tmux}` : ''} — click for machine details`}
                onClick={() => openMachines({ focus: session.host })}
              >
                <span className="row-k">host</span>
                <span className={`row-v side-host link-${session.remote?.link ?? 'attached'}`}>
                  {session.remote && session.remote.link !== 'attached' && <span className="side-link mono">{session.remote.link}</span>}
                  <AliasChip alias={session.host} />
                </span>
              </button>
            ) : (
              <Row k="host" v="this Mac" dim />
            )}
            {isAgent && <Row k="account" v={account?.label ?? '—'} />}
            {usage?.model && <Row k="model" v={usage.model.replace('claude-', '')} />}
            <button
              className="side-folder"
              title="Change directory (⌘L)"
              onClick={() => setOverlay('cwd')}
            >
              <span className="row-k">folder</span>
              <span className="row-v mono">{shortPath(session.cwd)}</span>
            </button>
            {isAgent && session.lineage.length > 1 && (
              <Row k="handoffs" v={String(session.lineage.length - 1)} dim />
            )}
          </Section>

          {on('context') && (
            <Section title="Context" aside={usage ? pct(ctxPct) : '—'}>
              <Meter value={ctxPct} tone={toneFor(ctxPct)} />
              <Row
                k="resident"
                v={usage ? `${tokens(usage.contextTokens)} / ${tokens(usage.contextWindow)}` : '—'}
              />
            </Section>
          )}

          {on('usage') && (
            <Section title="Tokens" aside={usage ? usd(usage.costUsd) : '—'}>
              <Row k="input" v={usage ? tokens(usage.inputTokens) : '—'} />
              <Row k="output" v={usage ? tokens(usage.outputTokens) : '—'} />
              <Row k="cache read" v={usage ? tokens(usage.cacheReadTokens) : '—'} dim />
              <Row k="cache write" v={usage ? tokens(usage.cacheWriteTokens) : '—'} dim />
              {!!usage?.reasoningTokens && <Row k="thinking" v={tokens(usage.reasoningTokens)} dim />}
              <div className="side-rule" />
              <Row k="total" v={usage ? tokens(usage.totalTokens) : '—'} />
              <Row k="turns" v={usage ? String(usage.messages) : '—'} dim />
            </Section>
          )}

          {on('burn') && usage && usage.burn.length > 2 && (
            <Section title="Burn" aside={`${tokens(usage.burn[usage.burn.length - 1] ?? 0)}/s`}>
              <Spark data={usage.burn} />
            </Section>
          )}
        </>
      ) : (
        <Section title="Session">
          <p className="side-empty">No active session.</p>
        </Section>
      )}

      {/* Plan usage is about the account, not the pane: it shows even when a terminal is focused. */}
      {widgets.enabled.includes('limits') && <PlanSection focusedAccountId={isAgent ? session?.accountId : undefined} />}

      <div className="side-spacer" />

      {widgets.enabled.includes('pet') && (
        <Section title="Desk">
          <Pet name={widgets.petName} status={session?.status ?? 'none'} />
        </Section>
      )}

      <Section title="All sessions" aside={usd(totals.cost)}>
        <Row k="open" v={String(Object.keys(sessions).length)} />
        <Row k="tokens" v={tokens(totals.tok)} dim />
        <button className="ghost-btn tiny wide" onClick={() => setOverlay('widgets')}>
          configure widgets
        </button>
      </Section>

      {widgets.enabled.includes('clock') && <Clock />}
    </aside>
  )
}

function Clock(): JSX.Element {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="clock mono">
      {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </div>
  )
}
