/**
 * Paper's MCP server. Streamable HTTP, stateless: every request gets a fresh
 * server+transport pair, which is what lets the kernel keep the socket open
 * across hot swaps — a request is served by whichever app generation is live.
 *
 * Connect from Claude Code with the project's .mcp.json, or `claude --mcp-config
 * ~/.paper/mcp.json` (sessions Paper spawns get that flag automatically).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { kernel } from './kernel'
import { TOOLS } from './tools'
import { invokeTool } from './tools/runtime'
import { brief } from './agents'
import type { ToolDef, ToolResult } from './tools/types'

/**
 * Which tools a request may see and how calls are run. The local endpoint
 * gets the whole registry; the remote gateway (gateway.ts) passes a filtered
 * list and an invoke that enforces its per-token rules.
 */
export interface McpScope {
  tools: ToolDef[]
  invoke: (name: string, args: unknown) => Promise<ToolResult>
  instructions?: string
  /** Reject request bodies larger than this (bytes). */
  maxBody?: number
}

const INSTRUCTIONS = `Paper is a terminal harness that runs Claude Code, Codex and shell sessions in panes.
These tools inspect and drive the running app: list/read/type into sessions, read the renderer
store, evaluate JS in the window, screenshot it, run menu commands, and watch hot reloading.
Start with paper_status. Session ids come from sessions_list. After editing Paper's own source,
hot_wait tells you when the change is live; ui_state / ui_screenshot show the result.
Agents have callsigns ("@euclid"): agents_list shows every agent and what it is doing; agent_info digs in.
If a tool you expect is missing from your list, call tools_list and use tools_invoke.`

function toContent(result: ToolResult): CallToolResult {
  const content: CallToolResult['content'] = []
  if (result.text !== undefined) content.push({ type: 'text', text: result.text })
  if (result.json !== undefined) content.push({ type: 'text', text: JSON.stringify(result.json, null, 2) })
  if (result.image) content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType })
  if (!content.length) content.push({ type: 'text', text: 'ok' })
  return { content, isError: result.isError }
}

function buildServer(scope: McpScope): McpServer {
  const server = new McpServer({ name: 'paper', version: kernel().version }, { instructions: scope.instructions ?? INSTRUCTIONS })
  for (const tool of scope.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: !tool.mutates, openWorldHint: false }
      },
      async (args: unknown) => toContent(await scope.invoke(tool.name, args))
    )
  }
  return server
}

async function readBody(req: IncomingMessage, maxBody = Infinity): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBody) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return undefined
  return JSON.parse(text)
}

const FULL_SCOPE: McpScope = { get tools() { return TOOLS }, invoke: invokeTool }

/** Tools that take `from` = the calling session, filled in when the caller is known. */
const CALLER_TOOLS = new Set(['agents_list'])

/**
 * The local endpoint's scope for one request. Paper's own agents send
 * `X-Paper-Session` (their MCP config says so; it is an identifier, not a
 * credential — anything on this machine can reach this endpoint anyway), which
 * lets `agents_list` mark the caller's own row.
 */
function localScope(req: IncomingMessage): McpScope {
  const caller = String(req.headers['x-paper-session'] ?? '')
  if (!/^[0-9a-f-]{8,64}$/i.test(caller)) return FULL_SCOPE
  return {
    tools: FULL_SCOPE.tools,
    invoke: (name, args) => {
      if (!CALLER_TOOLS.has(name)) return invokeTool(name, args)
      const a: Record<string, unknown> = args && typeof args === 'object' ? { ...(args as Record<string, unknown>) } : {}
      if (a.from === undefined) a.from = caller
      return invokeTool(name, a)
    }
  }
}

export function createMcpHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    // The kernel forwards everything but /health here, so the brief is routed without a kernel change.
    if ((req.url ?? '/').split('?')[0] === BRIEF_PATH) {
      // Loopback only, and no DNS-rebound page: the brief carries other agents' words.
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(req.headers.host ?? ''))) {
        res.writeHead(403)
        res.end()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      serveBrief(req, res, url.searchParams.get('from') ?? undefined)
      return
    }
    return handleMcpRequest(req, res, localScope(req))
  }
}

/** `GET /agents/brief?names=a,b&from=<session>`: what the @mention hook prints. Plain text; empty when nothing resolves. */
export const BRIEF_PATH = '/agents/brief'

export function serveBrief(req: IncomingMessage, res: ServerResponse, from?: string): void {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const names = (url.searchParams.get('names') ?? '').split(',').map((n) => n.trim()).filter(Boolean).slice(0, 16)
  let text = ''
  try { text = brief(names, from) } catch (err) { console.warn('[mcp] brief failed', err) }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text ? `${text}\n` : '')
}

/** Serve one stateless MCP request over `scope`. */
export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, scope: McpScope): Promise<void> {
  if (req.method !== 'POST') {
    // Stateless mode has no server-initiated stream to offer.
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
    res.end(JSON.stringify({ error: 'POST JSON-RPC to this endpoint' }))
    return
  }
  let body: unknown
  try {
    body = await readBody(req, scope.maxBody)
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `bad JSON: ${(err as Error).message}` }))
    return
  }
  // Be lenient with hand-written clients (curl) that omit the SSE accept.
  const accept = String(req.headers.accept || '')
  if (!accept.includes('text/event-stream')) req.headers.accept = 'application/json, text/event-stream'

  const server = buildServer(scope)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}
