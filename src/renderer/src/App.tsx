import { useEffect, useState } from 'react'
import TabBar from './components/TabBar'
import PaneTree from './components/PaneTree'
import DragPreview from './components/DragPreview'
import Sidebar from './components/Sidebar'
import CommandPalette from './components/CommandPalette'
import CwdPalette from './components/CwdPalette'
import SwitchAccount from './components/SwitchAccount'
import AccountsPanel from './components/AccountsPanel'
import MachinesPanel from './components/MachinesPanel'
import MoveMachine from './components/MoveMachine'
import { AliasChip } from './components/HostTag'
import { AgentCard, AgentChip, AgentNameSheet } from './components/AgentTag'
import { LOCAL_HOST } from '@shared/types'
import {
  FindBar, HandoffOverlay, PaneWidgetSheet, RenameSheet, SteerSheet, Toast, WidgetSheet
} from './components/Sheets'
import { useStore } from './state/store'
import { leaves } from './state/tree'
import { shortPath } from './components/Pane'
import './styles/theme.css'
import './styles/app.css'
import './styles/machines.css'
import './styles/agents.css'

const api = window.paper

export default function App(): JSX.Element {
  const store = useStore()
  const [finding, setFinding] = useState(false)

  useEffect(() => {
    void store.init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Every shortcut arrives here as a named command from the application menu.
  useEffect(() => {
    return api.onCommand(({ command }) => {
      const s = useStore.getState()
      const session = s.activeSession()

      if (command.startsWith('tab.select.')) {
        const i = Number(command.split('.').pop())
        const tab = s.tabs[i]
        if (tab) s.selectTab(tab.id)
        return
      }

      switch (command) {
        case 'session.new': void s.newTab(); break
        case 'session.new.claude': void s.newTab({ provider: 'claude' }); break
        case 'session.new.codex': void s.newTab({ provider: 'codex' }); break
        case 'session.new.shell': void s.newTab({ provider: 'shell' }); break
        case 'session.cd': s.setOverlay('cwd'); break
        case 'session.newInFolder':
          void api.pickDirectory().then((dir) => { if (dir) void s.newTab({ cwd: dir }) })
          break
        case 'session.close': if (s.activeTabId) s.closeTab(s.activeTabId); break
        case 'session.restart': if (session) void api.session.restart(session.id); break
        case 'session.rename': s.setOverlay('rename'); break
        case 'agent.rename':
          if (session?.name && session.provider !== 'shell') s.beginRename(session.id, 'sheet')
          else s.notify('The focused session is not a named agent', 'warn')
          break
        case 'session.interrupt':
          if (session) { void api.session.interrupt(session.id); s.notify('Interrupted') }
          break
        case 'session.steer': s.setOverlay('steer'); break
        case 'session.find': setFinding(true); break
        case 'session.clear': window.dispatchEvent(new CustomEvent('paper:clear')); break
        case 'account.switch': s.setOverlay('switch'); break
        case 'accounts.open': s.setOverlay('accounts'); break
        case 'machines.open': if (s.overlay === 'machines') s.setOverlay(null); else s.openMachines(); break
        case 'session.moveMachine': s.setOverlay('move'); break
        case 'palette.open': s.setOverlay(s.overlay === 'palette' ? null : 'palette'); break
        case 'pane.split.row': void s.split('row'); break
        case 'pane.split.col': void s.split('col'); break
        case 'pane.close': s.closePane(); break
        case 'pane.contents': s.setOverlay('panewidgets'); break
        case 'pane.next': s.cyclePane(1); break
        case 'pane.prev': s.cyclePane(-1); break
        case 'tab.next': s.cycleTab(1); break
        case 'tab.prev': s.cycleTab(-1); break
        case 'sidebar.toggle': s.toggleSidebar(); break
        case 'widgets.toggle': s.setOverlay('widgets'); break
        case 'zen.toggle': s.toggleZen(); break
        case 'font.bigger': s.bumpFont(0.5); break
        case 'font.smaller': s.bumpFont(-0.5); break
        default: break
      }
    })
  }, [])

  const session = store.activeSession()

  if (!store.ready) {
    return (
      <div className="boot">
        <span className="boot-mark mono">paper</span>
      </div>
    )
  }

  return (
    <div className={`app ${store.zen ? 'app-zen' : ''}`}>
      {!store.zen && <TabBar />}
      <div className="body">
        <main className="canvas">
          {/*
            Every tab stays mounted. Unmounting would tear down its xterm and
            force a full scrollback replay on the way back, so switching tabs
            would flicker and lose scroll position. Hidden tabs keep their box
            so the terminals stay correctly sized.
          */}
          {store.tabs.map((t) => (
            <div
              key={t.id}
              className={
                `tab-layer ${t.id === store.activeTabId ? '' : 'tab-layer-hidden'}` +
                // With a single pane there is nothing to disambiguate, and a focus
                // rule under the tab bar would read as a tab underline.
                (leaves(t.root).length > 1 ? ' multi-pane' : '') +
                (store.dragging && t.id === store.activeTabId ? ' dragging' : '')
              }
              aria-hidden={t.id !== store.activeTabId}
            >
              {/* Only the visible tab may hold focus, or its hidden siblings
                  would steal the keyboard and typing would reach the wrong agent. */}
              <PaneTree node={t.root} focusedPaneId={t.id === store.activeTabId ? t.focusedPaneId : ''} />
              {t.id === store.activeTabId && <DragPreview />}
            </div>
          ))}
          {finding && <FindBar onClose={() => setFinding(false)} />}
        </main>
        {store.sidebarOpen && !store.zen && <Sidebar />}
      </div>

      {!store.zen && (
        <footer className="statusbar">
          <span className={`dot dot-${session?.status ?? 'idle'}`} />
          <span className="status-text">
            {session
              ? session.status === 'working' ? 'working'
                : session.status === 'handoff' ? 'handing off'
                : session.status === 'exited' ? 'exited'
                : session.status === 'starting' ? 'starting' : 'ready'
              : 'no session'}
          </span>
          {session && <span className="status-sep">·</span>}
          {session?.name && session.provider !== 'shell' && (
            <AgentChip
              name={session.name}
              card="right"
              title="Double-click to rename (⌘⌥R)"
              onDoubleClick={() => store.beginRename(session.id, 'sheet')}
            />
          )}
          {session && session.host && session.host !== LOCAL_HOST && (
            <AliasChip alias={session.host} onClick={() => store.openMachines({ focus: session.host })} title="Machine details (⌘⇧M)" />
          )}
          {session && <span className="status-dim mono">{shortPath(session.cwd)}</span>}
          <span className="status-grow" />
          <button className="status-btn" onClick={() => store.toggleTheme()}>
            {store.theme === 'day' ? 'day' : 'night'}
          </button>
          <span className="status-sep">·</span>
          <button className="status-btn" onClick={() => store.setOverlay('palette')}>⌘K</button>
        </footer>
      )}

      <HandoffOverlay />
      <Toast />
      {store.overlay === 'palette' && <CommandPalette />}
      {store.overlay === 'switch' && <SwitchAccount />}
      {store.overlay === 'accounts' && <AccountsPanel />}
      {store.overlay === 'steer' && <SteerSheet />}
      {store.overlay === 'rename' && <RenameSheet />}
      {store.overlay === 'widgets' && <WidgetSheet />}
      {store.overlay === 'panewidgets' && <PaneWidgetSheet />}
      {store.overlay === 'cwd' && <CwdPalette />}
      {store.overlay === 'machines' && <MachinesPanel />}
      {store.overlay === 'move' && <MoveMachine />}
      {store.overlay === 'agentName' && <AgentNameSheet />}
      <AgentCard />
    </div>
  )
}
