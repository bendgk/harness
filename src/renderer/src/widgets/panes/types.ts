import type { SessionStatus } from '@shared/types'

export interface PaneWidgetProps {
  paneId: string
  props: Record<string, unknown>
  /** Merged into the pane's stored props, so a widget keeps its state. */
  setProps: (props: Record<string, unknown>) => void
  /** State of the session that currently holds focus, for reactive widgets. */
  agentStatus: SessionStatus | 'none'
}

export interface PaneWidgetDef {
  id: string
  name: string
  note: string
  glyph: string
  component: (p: PaneWidgetProps) => JSX.Element
}
