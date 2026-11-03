import type { PaneWidgetProps } from './types'

const GROUPS: { title: string; keys: [string, string][] }[] = [
  { title: 'Sessions', keys: [
    ['⌘N', 'new tab'], ['⌘⇧N', 'new in folder'], ['⌘X', 'kill pane'], ['⌘W', 'close tab'] ] },
  { title: 'Agent', keys: [
    ['⌘.', 'interrupt'], ['⌘↩', 'interrupt and steer'], ['⌘R', 'restart, keep context'], ['⌘P', 'switch account'] ] },
  { title: 'Layout', keys: [
    ['⌘D', 'split right'], ['⌘⇧D', 'split down'], ['⌘J', 'pane contents'], ['⌘[ ⌘]', 'focus pane'] ] },
  { title: 'View', keys: [
    ['⌘K', 'command palette'], ['⌘B', 'sidebar'], ['⌘F', 'find'], ['⌘⇧↩', 'zen'] ] }
]

/** A reference card, for the shortcuts that are worth knowing by hand. */
export default function Keys(_p: PaneWidgetProps): JSX.Element {
  return (
    <div className="keys">
      {GROUPS.map((g) => (
        <div key={g.title} className="keys-group">
          <div className="label">{g.title}</div>
          {g.keys.map(([k, v]) => (
            <div key={k} className="keys-row">
              <kbd className="kbd mono">{k}</kbd>
              <span className="keys-desc">{v}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
