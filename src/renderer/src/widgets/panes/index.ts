import AnalogClock from './AnalogClock'
import Calendar from './Calendar'
import Keys from './Keys'
import Companion from './Companion'
import DeskPet from './DeskPet'
import Notes from './Notes'
import Timer from './Timer'
import UsageBoard from './UsageBoard'
import type { PaneWidgetDef } from './types'

/** Everything a pane can hold besides a terminal. */
export const PANE_WIDGETS: PaneWidgetDef[] = [
  { id: 'companion', name: 'Companion', note: 'an ink friend who reacts to the agent', glyph: '◕', component: Companion },
  { id: 'clock', name: 'Analog clock', note: 'a printed clock face', glyph: '◷', component: AnalogClock },
  { id: 'notes', name: 'Notes', note: 'a ruled sheet that saves itself', glyph: '▤', component: Notes },
  { id: 'timer', name: 'Focus timer', note: 'a ring that empties while you work', glyph: '◔', component: Timer },
  { id: 'board', name: 'Usage board', note: 'every open session on one sheet', glyph: '▦', component: UsageBoard },
  { id: 'pet', name: 'Desk pet', note: 'the little ASCII creature', glyph: '◠', component: DeskPet },
  { id: 'calendar', name: 'Calendar', note: 'a month on paper, today circled', glyph: '▩', component: Calendar },
  { id: 'keys', name: 'Shortcuts', note: 'a reference card of the keys', glyph: '⌘', component: Keys }
]

export function paneWidget(id: string): PaneWidgetDef | undefined {
  return PANE_WIDGETS.find((w) => w.id === id)
}

export type { PaneWidgetDef, PaneWidgetProps } from './types'
