/**
 * The tool registry contract.
 *
 * A tool is defined once, here, and is then reachable from every surface:
 * the MCP server (`mcp__paper__<name>` in Claude Code), the renderer via
 * `window.paper.tools.invoke`, and other tools via `ctx.invoke`. Adding a
 * capability to Paper means adding a tool; nothing else needs wiring.
 *
 * Tool modules must stay pure: import only `zod` and *types*. Behaviour comes
 * through `ToolContext`, so `scripts/sync-tools.mjs` can load the registry in
 * plain Node to regenerate the tool table in CLAUDE.md.
 */
import type { z, ZodRawShape } from 'zod'
import type { BrowserWindow } from 'electron'
import type { Kernel } from '../kernel'
import type { SessionManager } from '../sessions'
import type { UsageTracker } from '../usage'
import type { TitleService } from '../titles'
import type { HandoffService } from '../handoff'
import type { Persisted } from '../store'
import type { Account, AgentSummary, Machine, MachineInventory, MachineProbe, SessionMeta } from '@shared/types'
import type { ExecResult, MachineInput } from '../machines'
import type { TunnelState } from '../gateway'
import type { RestoreReport, SessionRegistry } from '../persist'

export type ToolGroup = 'app' | 'sessions' | 'ui' | 'dev' | 'state' | 'machines' | 'agents'

/** Agent callsigns and cross-agent awareness (src/main/agents.ts). */
export interface AgentService {
  list(opts: { host?: string; includeExited?: boolean; from?: string }): AgentSummary[]
  info(nameOrId: string, opts: { turns?: number; maxChars?: number }): Promise<string>
  transcript(nameOrId: string, opts: { before?: number; limit?: number }): Promise<string>
  rename(nameOrId: string, name: string): SessionMeta
}

/** The machine registry (src/main/machines.ts) as tools see it. Every alias-taking call enforces the allowlist. */
export interface MachineService {
  list(): Machine[]
  add(input: MachineInput): Promise<Machine>
  update(alias: string, patch: Partial<Omit<MachineInput, 'alias'>>): Machine
  remove(alias: string): Promise<void>
  probe(alias: string, opts?: { maxAgeMs?: number }): Promise<MachineProbe>
  suggest(): Promise<{ alias: string; hostname?: string; user?: string; registered: boolean }[]>
  exec(alias: string, command: string, opts?: { cwd?: string; timeoutMs?: number; maxBytes?: number }): Promise<ExecResult>
  inventory(opts?: { refresh?: boolean; alias?: string }): Promise<MachineInventory[]>
  /** The remote-agent gateway (gateway.ts): listener port, per-machine tunnels, live token count. */
  gateway(): { port: number | null; tunnels: TunnelState[]; tokens: number }
}

export interface ToolResult {
  /** Plain text for the caller. */
  text?: string
  /** Structured data; serialised as pretty JSON for the caller. */
  json?: unknown
  /** A picture, e.g. a screenshot. */
  image?: { data: string; mimeType: string }
  isError?: boolean
}

export interface ToolContext {
  kernel: Kernel
  sessions: SessionManager
  usage: UsageTracker
  titles: TitleService
  handoff: HandoffService
  machines: MachineService
  agents: AgentService
  getState(): Persisted
  saveState(patch: Partial<Persisted>): void
  accounts(): Account[]
  /** The on-disk session registry (~/.paper/sessions.json) and the last boot's restore report. */
  persistence: {
    path: string
    read(): SessionRegistry | null
    report(): RestoreReport | null
  }
  window(): BrowserWindow | null
  /** Run a menu command in the renderer, exactly as the keystroke would. */
  command(name: string): void
  /** Evaluate JavaScript in the renderer's main world and return its JSON value. */
  evalInRenderer<T = unknown>(code: string): Promise<T>
  /** Call another tool by name. */
  invoke(name: string, args: unknown): Promise<ToolResult>
}

export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  /** snake_case; becomes `mcp__paper__<name>`. */
  name: string
  title: string
  description: string
  group: ToolGroup
  input: S
  /** True when the tool changes state; read-only tools are marked as such for clients. */
  mutates?: boolean
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult> | ToolResult
}

export function defineTool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def
}
