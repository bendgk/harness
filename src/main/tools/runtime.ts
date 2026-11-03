/**
 * Runs tools. The context is installed by app.ts on activation; the registry
 * itself (index.ts) stays pure so it can be loaded outside Electron.
 */
import { z } from 'zod'
import { TOOLS, findTool } from './index'
import type { ToolContext, ToolResult } from './types'

let context: ToolContext | null = null

export function setToolContext(ctx: ToolContext | null): void {
  context = ctx
}

export interface ToolManifestEntry {
  name: string
  title: string
  description: string
  group: string
  mutates: boolean
  inputSchema: unknown
}

export function toolManifest(group?: string): ToolManifestEntry[] {
  return TOOLS.filter((t) => !group || t.group === group).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    group: t.group,
    mutates: Boolean(t.mutates),
    inputSchema: z.toJSONSchema(z.object(t.input))
  }))
}

/** Validate arguments against the tool's schema and run it. Errors become results, not throws. */
export async function invokeTool(name: string, rawArgs: unknown): Promise<ToolResult> {
  if (name === '__manifest') {
    const group = (rawArgs as { group?: string } | undefined)?.group
    return { json: toolManifest(group) }
  }
  const tool = findTool(name)
  if (!tool) return { text: `Unknown tool "${name}". Known: ${TOOLS.map((t) => t.name).join(', ')}`, isError: true }
  if (!context) return { text: 'Tool context not installed (app bundle inactive?)', isError: true }
  const parsed = z.object(tool.input).safeParse(rawArgs ?? {})
  if (!parsed.success) return { text: `Invalid arguments for ${name}: ${parsed.error.message}`, isError: true }
  try {
    return await tool.handler(parsed.data, context)
  } catch (err) {
    return { text: (err as Error).stack || (err as Error).message || String(err), isError: true }
  }
}
