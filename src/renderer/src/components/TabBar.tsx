import { useStore } from '../state/store'
import { leafSession, leaves } from '../state/tree'
import { LOCAL_HOST, type SessionMeta, type Tab } from '@shared/types'

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
      .map((l) => { const sid = leafSession(l); return sid ? sessions[sid] : undefined })
      .filter(Boolean)
    if (metas.some((m) => m!.status === 'working')) return 'working'
    if (metas.some((m) => m!.status === 'handoff')) return 'handoff'
    if (metas.some((m) => m!.status === 'exited')) return 'exited'
    return 'idle'
  }

  const focusedMeta = (tab: Tab): SessionMeta | undefined => {
    const pane = leaves(tab.root).find((l) => l.id === tab.focusedPaneId) ?? leaves(tab.root)[0]
    const sid = pane ? leafSession(pane) : null
    return sid ? sessions[sid] : undefined
  }

  return (
    <div className="tabbar">
      <div className="tabbar-inset" />
      <div className="tabs">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          const meta = focusedMeta(tab)
          const provider = meta?.provider
          const remote = meta && meta.host && meta.host !== LOCAL_HOST ? meta : undefined
          const paneCount = leaves(tab.root).length
          const agentName = meta && meta.provider !== 'shell' ? meta.name : undefined
          return (
            <div
              key={tab.id}
              className={`tab ${active ? 'tab-active' : ''}`}
              onClick={() => selectTab(tab.id)}
              onDoubleClick={() => { selectTab(tab.id); setOverlay('rename') }}
              title={`${agentName ? `@${agentName} · ` : ''}${tab.title}${remote ? ` · on @${remote.host}` : ''}${paneCount > 1 ? ` · ${paneCount} panes` : ''}`}
            >
              <span className={`dot dot-${statusOf(tab)}`} />
              {provider && <span className={`prov-dot prov-${provider}`} />}
              {agentName && <span className="agent-chip tab-agent mono">@{agentName}</span>}
              <span className="tab-title">{tab.title}</span>
              {remote && (
                <span
                  className={`tab-host mono link-${remote.remote?.link ?? 'attached'}`}
                  title={remote.remote?.link === 'lost' ? `Connection to @${remote.host} lost` : `Running on @${remote.host}`}
                >@{remote.host}</span>
              )}
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
