import { useStore } from '../state/store'
import { leaves } from '../state/tree'
import type { Tab } from '@shared/types'

/** The top rule: traffic-light inset, tabs, then a single new-session affordance. */
export default function TabBar(): JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const sessions = useStore((s) => s.sessions)
  const selectTab = useStore((s) => s.selectTab)
  const closeTab = useStore((s) => s.closeTab)
  const newTab = useStore((s) => s.newTab)
  const setOverlay = useStore((s) => s.setOverlay)

  const statusOf = (tab: Tab): string => {
    const metas = leaves(tab.root)
      .map((l) => (l.sessionId ? sessions[l.sessionId] : undefined))
      .filter(Boolean)
    if (metas.some((m) => m!.status === 'working')) return 'working'
    if (metas.some((m) => m!.status === 'handoff')) return 'handoff'
    if (metas.some((m) => m!.status === 'exited')) return 'exited'
    return 'idle'
  }

  const providerOf = (tab: Tab): string | undefined => {
    const pane = leaves(tab.root).find((l) => l.id === tab.focusedPaneId) ?? leaves(tab.root)[0]
    return pane?.sessionId ? sessions[pane.sessionId]?.provider : undefined
  }

  return (
    <div className="tabbar">
      <div className="tabbar-inset" />
      <div className="tabs">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          const provider = providerOf(tab)
          const paneCount = leaves(tab.root).length
          return (
            <div
              key={tab.id}
              className={`tab ${active ? 'tab-active' : ''}`}
              onClick={() => selectTab(tab.id)}
              onDoubleClick={() => { selectTab(tab.id); setOverlay('rename') }}
              title={`${tab.title}${paneCount > 1 ? ` · ${paneCount} panes` : ''}`}
            >
              <span className={`dot dot-${statusOf(tab)}`} />
              {provider && <span className={`prov-dot prov-${provider}`} />}
              <span className="tab-title">{tab.title}</span>
              {paneCount > 1 && <span className="tab-panes mono">{paneCount}</span>}
              <button
                className="tab-close"
                title="Close tab (⌘W)"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
              >
                ×
              </button>
            </div>
          )
        })}
        <button className="tab-new" title="New session (⌘N)" onClick={() => void newTab()}>+</button>
      </div>
      <div className="tabbar-drag" />
    </div>
  )
}
