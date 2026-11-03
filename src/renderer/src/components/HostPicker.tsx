import { LOCAL_HOST } from '@shared/types'
import { useStore } from '../state/store'
import { canLaunch, machineHealth } from '../lib/machines'
import { HealthDot } from './HostTag'

/**
 * "Where it runs": This Mac, or one of the registered machines. A machine
 * whose last ssh test failed stays listed but disabled, with the reason on
 * hover, so it is obvious why it cannot be picked rather than missing.
 */
export default function HostPicker({ value, onChange }: { value: string; onChange: (host: string) => void }): JSX.Element | null {
  const machines = useStore((s) => s.machines)
  const openMachines = useStore((s) => s.openMachines)

  // With nothing registered there is no choice to make; EmptyPane offers "add" instead.
  if (!machines.length) return null

  return (
    <div className="host-picker" role="radiogroup" aria-label="Where it runs">
      <span className="host-picker-label label">on</span>
      <button
        role="radio"
        aria-checked={value === LOCAL_HOST}
        className={`host-opt ${value === LOCAL_HOST ? 'host-opt-on' : ''}`}
        onClick={() => onChange(LOCAL_HOST)}
        title="Run on this Mac"
      >
        This Mac
      </button>
      {machines.map((m) => {
        const gate = canLaunch(m)
        const on = value === m.alias
        return (
          <button
            key={m.alias}
            role="radio"
            aria-checked={on}
            aria-disabled={!gate.ok}
            className={`host-opt host-opt-remote ${on ? 'host-opt-on' : ''} ${gate.ok ? '' : 'host-opt-off'}`}
            title={gate.ok ? `Run on ${m.label ? `${m.label} — ` : ''}@${m.alias}` : `${gate.reason} — open Machines to fix`}
            onClick={() => (gate.ok ? onChange(m.alias) : openMachines({ focus: m.alias }))}
          >
            <HealthDot health={machineHealth(m)} />
            <span className="mono">@{m.alias}</span>
          </button>
        )
      })}
    </div>
  )
}
