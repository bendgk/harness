import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { Meter, Spark, toneFor } from '../widgets/Meter'
import Pet from '../widgets/Pet'
import { elapsed, pct, tokens, until, usd, windowLabel } from '../lib/format'
import { shortPath } from './Pane'
import type { ProviderId } from '@shared/types'

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

/** The right margin of the page: everything the current session is spending. */
export default function Sidebar(): JSX.Element {
  const session = useStore((s) => s.activeSession())
  const usage = useStore((s) => (session ? s.usage[session.id] : undefined))
  const account = useStore((s) => s.accounts.find((a) => a.id === session?.accountId))
  const widgets = useStore((s) => s.widgets)
  const setOverlay = useStore((s) => s.setOverlay)
  const sessions = useStore((s) => s.sessions)
  const allUsage = useStore((s) => s.usage)
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
      {session ? (
        <>
          <Section title="Session" aside={elapsed(session.createdAt)}>
            <div className="side-title">{session.title}</div>
            <Row k="harness" v={PROVIDER_NAME[session.provider]} />
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

          {on('limits') && usage?.limits?.length && (
            <Section title="Plan limits">
              {usage.limits.map((l, i) => (
                <div key={i} className="limit">
                  <div className="limit-head">
                    <span className="limit-name">{windowLabel(l.windowMinutes)}</span>
                    <span className="limit-val mono">{pct(l.usedPercent)}</span>
                  </div>
                  <Meter value={l.usedPercent} tone={toneFor(l.usedPercent)} />
                  <div className="limit-reset mono">resets in {until(l.resetsAt)}</div>
                </div>
              ))}
              {usage.credits && (
                <Row k="credits" v={usage.credits.unlimited ? '∞' : usage.credits.balance.toFixed(0)} dim />
              )}
            </Section>
          )}
        </>
      ) : (
        <Section title="Session">
          <p className="side-empty">No active session.</p>
        </Section>
      )}

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
