import type { Machine } from '@shared/types'
import { machineHealth, targetLabel, toolsHint } from '../lib/machines'
import { HealthDot } from './HostTag'

interface Props {
  machines: Machine[]
  index: number
  /** Shown for discovery only: no row is selected and keys go to the program. */
  passive?: boolean
  style?: React.CSSProperties
  /** Which way the menu opens from its anchor (drives the entry animation). */
  placement?: 'above' | 'below'
  onPick: (alias: string) => void
  onHover?: (i: number) => void
}

/**
 * The @-mention dropdown. Not focusable, and it swallows mousedown so a click
 * never pulls focus out of the terminal or field the user is typing in.
 */
export default function MentionMenu({ machines, index, passive, style, placement = 'below', onPick, onHover }: Props): JSX.Element {
  const foot = (
    <div className="mention-foot mono">
      {passive ? 'keep typing to pick a machine' : '↑↓ choose · tab/↵ insert · esc dismiss'}
    </div>
  )
  return (
    <div
      className={`mention-menu mention-${placement} fade-in`}
      style={style}
      role="listbox"
      aria-label="Machines"
      onMouseDown={(e) => e.preventDefault()}
      data-mention-menu
    >
      <div className="mention-head label">Machines</div>
      {machines.map((m, i) => {
        const health = machineHealth(m)
        const sub = m.label || targetLabel(m) || m.probe?.target?.hostname
        return (
          <div
            key={m.alias}
            role="option"
            aria-selected={!passive && i === index}
            className={`mention-row ${!passive && i === index ? 'mention-on' : ''}`}
            onMouseEnter={() => onHover?.(i)}
            onClick={() => onPick(m.alias)}
          >
            <HealthDot health={health} />
            <span className="alias-chip mono">@{m.alias}</span>
            {sub && <span className="mention-sub">{sub}</span>}
            <span className="mention-tools mono">{toolsHint(m)}</span>
          </div>
        )
      })}
      {foot}
    </div>
  )
}
