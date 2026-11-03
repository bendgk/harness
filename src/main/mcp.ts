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
import type { ToolResult } from './tools/types'

const INSTRUCTIONS = `Paper is a terminal harness that runs Claude Code, Codex and shell sessions in panes.
These tools inspect and drive the running app: list/read/type into sessions, read the renderer
store, evaluate JS in the window, screenshot it, run menu commands, and watch hot reloading.
Start with paper_status. Session ids come from sessions_list. After editing Paper's own source,
hot_wait tells you when the change is live; ui_state / ui_screenshot show the result.
If a tool you expect is missing from your list, call tools_list and use tools_invoke.`

function toContent(result: ToolResult): CallToolResult {
  const content: CallToolResult['content'] = []
  if (result.text !== undefined) content.push({ type: 'text', text: result.text })
  if (result.json !== undefined) content.push({ type: 'text', text: JSON.stringify(result.json, null, 2) })
  if (result.image) content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType })
  if (!content.length) content.push({ type: 'text', text: 'ok' })
  return { content, isError: result.isError }
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'paper', version: kernel().version }, { instructions: INSTRUCTIONS })
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: !tool.mutates, openWorldHint: false }
      },
      async (args: unknown) => toContent(await invokeTool(tool.name, args))
    )
  }
  return server
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return undefined
  return JSON.parse(text)
}

export function createMcpHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      // Stateless mode has no server-initiated stream to offer.
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
      res.end(JSON.stringify({ error: 'POST JSON-RPC to this endpoint' }))
      return
    }
    let body: unknown
    try {
      body = await readBody(req)
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `bad JSON: ${(err as Error).message}` }))
      return
    }
    // Be lenient with hand-written clients (curl) that omit the SSE accept.
    const accept = String(req.headers.accept || '')
    if (!accept.includes('text/event-stream')) req.headers.accept = 'application/json, text/event-stream'

    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }
}
