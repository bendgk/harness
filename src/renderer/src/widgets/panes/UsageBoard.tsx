import { useStore } from '../../state/store'
import { Meter, Spark, toneFor } from '../Meter'
import { tokens, usd } from '../../lib/format'
import type { PaneWidgetProps } from './types'

/** Every open session on one sheet — the ledger view of the whole workspace. */
export default function UsageBoard(_p: PaneWidgetProps): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const usage = useStore((s) => s.usage)
  const accounts = useStore((s) => s.accounts)

  const rows = Object.values(sessions)
  const totals = rows.reduce(
    (acc, m) => {
      const u = usage[m.id]
      return { cost: acc.cost + (u?.costUsd ?? 0), tok: acc.tok + (u?.totalTokens ?? 0) }
    },
    { cost: 0, tok: 0 }
  )

  return (
    <div className="board">
      <div className="board-head">
        <span className="label">Sessions</span>
        <span className="board-total mono">{usd(totals.cost)} · {tokens(totals.tok)}</span>
      </div>
      {rows.length === 0 && <p className="board-empty">Nothing running.</p>}
      <div className="board-rows">
        {rows.map((m) => {
          const u = usage[m.id]
          const ctx = u && u.contextWindow ? (u.contextTokens / u.contextWindow) * 100 : 0
          const account = accounts.find((a) => a.id === m.accountId)
          return (
            <div key={m.id} className="board-row">
              <div className="board-row-head">
                <span className={`dot dot-${m.status}`} />
                <span className="board-name">{m.title}</span>
                <span className={`prov-tag prov-${m.provider}`}>{m.provider === 'claude' ? 'CC' : 'CX'}</span>
                <span className="board-acct mono">{account?.label ?? '—'}</span>
                <span className="board-cost mono">{u ? usd(u.costUsd) : '—'}</span>
              </div>
              <Meter value={ctx} tone={toneFor(ctx)} />
              <div className="board-meta mono">
                {u ? `${tokens(u.contextTokens)} / ${tokens(u.contextWindow)} context · ${u.messages} turns` : 'no activity yet'}
              </div>
              {u && u.burn.length > 2 && <Spark data={u.burn} height={18} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
