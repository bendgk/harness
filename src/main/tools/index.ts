/**
 * Every tool Paper exposes. Add a tool to one of the group files (or a new
 * group file) and list it here; then run `npm run tools:sync` so CLAUDE.md
 * describes it. `npm run check` fails if the docs drift.
 */
import { appTools } from './app'
import { sessionTools } from './sessions'
import { uiTools } from './ui'
import { devTools } from './dev'
import { stateTools } from './state'
import type { ToolDef } from './types'

export const TOOLS: ToolDef[] = [
  ...appTools,
  ...sessionTools,
  ...uiTools,
  ...devTools,
  ...stateTools
] as unknown as ToolDef[]

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name)
}

export type { ToolDef, ToolContext, ToolResult, ToolGroup } from './types'
