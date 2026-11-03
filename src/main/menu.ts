import { app, Menu, BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/** Menu items are the single source of truth for shortcuts; the renderer just listens. */
export function buildMenu(send: (command: string) => void): void {
  const cmd = (label: string, accelerator: string, command: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send(command)
  })

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Paper',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        cmd('Accounts…', 'Cmd+,', 'accounts.open'),
        cmd('Machines…', 'Cmd+Shift+M', 'machines.open'),
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Session',
      submenu: [
        cmd('New Session', 'Cmd+N', 'session.new'),
        cmd('New Session in Folder…', 'Cmd+Shift+N', 'session.newInFolder'),
        cmd('New Claude Session', 'Cmd+Alt+C', 'session.new.claude'),
        cmd('New Codex Session', 'Cmd+Alt+X', 'session.new.codex'),
        cmd('New Terminal', 'Cmd+Alt+T', 'session.new.shell'),
        { type: 'separator' },
        cmd('Change Directory…', 'Cmd+L', 'session.cd'),
        cmd('Switch Account…', 'Cmd+P', 'account.switch'),
        cmd('Move to Machine…', 'Cmd+Shift+P', 'session.moveMachine'),
        cmd('Rename Session…', 'Cmd+Shift+R', 'session.rename'),
        cmd('Rename Agent…', 'Cmd+Alt+R', 'agent.rename'),
        cmd('Restart Session', 'Cmd+R', 'session.restart'),
        { type: 'separator' },
        cmd('Interrupt Agent', 'Cmd+.', 'session.interrupt'),
        cmd('Steer Agent…', 'Cmd+Return', 'session.steer'),
        { type: 'separator' },
        cmd('Close Session', 'Cmd+W', 'session.close')
      ]
    },
    {
      label: 'View',
      submenu: [
        cmd('Command Palette…', 'Cmd+K', 'palette.open'),
        { type: 'separator' },
        cmd('Split Right', 'Cmd+D', 'pane.split.row'),
        cmd('Split Down', 'Cmd+Shift+D', 'pane.split.col'),
        cmd('Pane Contents…', 'Cmd+J', 'pane.contents'),
        cmd('Kill Pane', 'Cmd+X', 'pane.close'),
        cmd('Close Pane', 'Cmd+Shift+W', 'pane.close'),
        cmd('Focus Next Pane', 'Cmd+]', 'pane.next'),
        cmd('Focus Previous Pane', 'Cmd+[', 'pane.prev'),
        { type: 'separator' },
        cmd('Toggle Sidebar', 'Cmd+B', 'sidebar.toggle'),
        cmd('Toggle Widgets', 'Cmd+Shift+B', 'widgets.toggle'),
        cmd('Zen Mode', 'Cmd+Shift+Return', 'zen.toggle'),
        { type: 'separator' },
        cmd('Bigger Text', 'Cmd+Plus', 'font.bigger'),
        cmd('Smaller Text', 'Cmd+-', 'font.smaller'),
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'reload' }
      ]
    },
    {
      label: 'Tabs',
      submenu: [
        cmd('Next Tab', 'Ctrl+Tab', 'tab.next'),
        cmd('Previous Tab', 'Ctrl+Shift+Tab', 'tab.prev'),
        ...Array.from({ length: 9 }, (_, i) =>
          cmd(`Tab ${i + 1}`, `Cmd+${i + 1}`, `tab.select.${i}`)
        )
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        cmd('Find in Session…', 'Cmd+F', 'session.find'),
        cmd('Clear Scrollback', 'Cmd+Shift+K', 'session.clear')
      ]
    },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export function sendCommand(command: string): void {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send('app:command', { command })
}

export { app }
