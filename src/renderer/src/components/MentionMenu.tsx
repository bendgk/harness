import { LOCAL_HOST, type AgentSummary, type Machine } from '@shared/types'
import { machineHealth, targetLabel, toolsHint } from '../lib/machines'
import { AliasChip, HealthDot } from './HostTag'
import { AgentChip, agentHover, hideAgentCardNow } from './AgentTag'

interface Props {
  /** The Agents section, best first. Their rows come first in `index` order. */
  agents: AgentSummary[]
  machines: Machine[]
  index: number
  /** Shown for discovery only: no row is selected and keys go to the program. */
  passive?: boolean
  style?: React.CSSProperties
  /** Which way the menu opens from its anchor (drives the entry animation). */
  placement?: 'above' | 'below'
  /** Called with the agent name or machine alias to insert. */
  onPick: (target: string) => void
  onHover?: (i: number) => void
}

const ROW = 29
const AGENT_ROW_TALL = 41
const HEAD = 22
const FOOT = 26

/** How tall the menu will be, so a terminal can decide whether it fits above the token. */
export function menuHeight(agents: AgentSummary[], machines: number): number {
  const rows = agents.reduce((h, a) => h + (a.doing ? AGENT_ROW_TALL : ROW), 0) + machines * ROW
  return rows + (agents.length ? HEAD : 0) + (machines ? HEAD : 0) + FOOT + 8
}

/**
 * The @-mention dropdown: agents first (callsign, status, title, where, what
 * it is doing), then machines. One index runs through both sections, so ↑↓
 * walk straight from the last agent to the first machine. Not focusable, and
 * it swallows mousedown so a click never pulls focus out of the terminal or
 * field the user is typing in.
 */
export default function MentionMenu({
  agents, machines, index, passive, style, placement = 'below', onPick, onHover
}: Props): JSX.Element {
  const on = (i: number): boolean => !passive && i === index
  return (
    <div
      className={`mention-menu mention-${placement} fade-in`}
      style={style}
      role="listbox"
      aria-label="Mention an agent or machine"
      onMouseDown={(e) => e.preventDefault()}
      onMouseLeave={hideAgentCardNow}
      data-mention-menu
    >
      {agents.length > 0 && <div className="mention-head label">Agents</div>}
      {agents.map((a, i) => {
        const remote = a.host && a.host !== LOCAL_HOST
        return (
          <div
            key={`a:${a.name}`}
            role="option"
            aria-selected={on(i)}
            className={`mention-row mention-agent ${a.doing ? 'mention-tall' : ''} ${on(i) ? 'mention-on' : ''}`}
            onMouseEnter={(e) => { onHover?.(i); agentHover(a.name, 'right', '.mention-menu').onMouseEnter(e) }}
            onClick={() => { hideAgentCardNow(); onPick(a.name) }}
            data-agent={a.name}
          >
            <span className={`dot dot-${a.status}`} />
            <span className="mention-main">
              <span className="mention-line">
                <AgentChip name={a.name} card={false} />
                <span className="mention-sub">{a.title}</span>
                {remote && <AliasChip alias={a.host} />}
              </span>
              {a.doing && <span className="mention-doing">{a.doing}</span>}
            </span>
          </div>
        )
      })}
      {machines.length > 0 && <div className="mention-head label">Machines</div>}
      {machines.map((m, j) => {
        const i = agents.length + j
        const health = machineHealth(m)
        const sub = m.label || targetLabel(m) || m.probe?.target?.hostname
        return (
          <div
            key={`m:${m.alias}`}
            role="option"
            aria-selected={on(i)}
            className={`mention-row ${on(i) ? 'mention-on' : ''}`}
            onMouseEnter={() => { onHover?.(i); hideAgentCardNow() }}
            onClick={() => onPick(m.alias)}
          >
            <HealthDot health={health} />
            <span className="alias-chip mono">@{m.alias}</span>
            {sub && <span className="mention-sub">{sub}</span>}
            <span className="mention-tools mono">{toolsHint(m)}</span>
          </div>
        )
      })}
      <div className="mention-foot mono">
        {passive ? 'keep typing to pick an agent or machine' : '↑↓ choose · tab/↵ insert · esc dismiss'}
      </div>
    </div>
  )
}
