import Pet from '../Pet'
import type { PaneWidgetProps } from './types'

/** The ASCII desk pet, given a whole pane to live in. */
export default function DeskPet({ props, setProps, agentStatus }: PaneWidgetProps): JSX.Element {
  const name = (props.name as string) || 'Inky'
  return (
    <div className="pet-pane">
      <div className="pet-pane-inner">
        <Pet name={name} status={agentStatus} />
        <input
          className="pet-name-input mono"
          defaultValue={name}
          onBlur={(e) => setProps({ name: e.target.value.trim() || 'Inky' })}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          title="Name your pet"
        />
      </div>
    </div>
  )
}
