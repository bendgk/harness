/**
 * The remote gateway: how agents running on other machines call Paper tools.
 *
 * Design (security first):
 * - A second HTTP listener on 127.0.0.1:<gatewayPort>, separate from the
 *   unauthenticated local MCP endpoint. The server object lives in a kernel
 *   slot (survives hot swaps); each generation swaps in its request handler.
 *   gatewayPort is persisted so it is stable across restarts.
 * - Every request must carry `Authorization: Bearer <token>`. Tokens are
 *   256-bit random, one per remote session, bound to {sessionId, host}.
 *   Only sha256(token) is stored locally (0600 file under PAPER_HOME); the
 *   token itself exists only in the remote agent's 0600 MCP config file.
 *   Compare in constant time. Unknown/revoked token → 401, no detail.
 * - Each registered machine gets one reverse tunnel, remote 127.0.0.1:<remotePort>
 *   → local 127.0.0.1:<gatewayPort>, over ssh (see ssh.ts). remotePort is
 *   persisted per machine so a remote agent's config stays valid across Paper
 *   restarts and reconnects; tunnels are supervised (backoff) and torn down
 *   on quit / machine removal.
 * - Tool scope for remote callers is a fixed allowlist (REMOTE_SCOPE), and
 *   session-scoped tools are pinned to the caller's own session id.
 *
 * Implementation notes:
 * - The tunnel is a dedicated foreground ControlMaster per machine (child of
 *   Paper, so its death is noticed at once), with the single forward added at
 *   runtime via `ssh -O forward`. See the tunnel block in ssh.ts for why that
 *   is the safe way around ClearAllForwardings.
 * - After every forward, the remote's listening sockets are checked: the port
 *   must be bound on loopback only. sshd `GatewayPorts yes` silently binds the
 *   wildcard address whatever we ask for; we cancel and report instead.
 * - If the persisted remote port is taken (by anything — possibly another user
 *   squatting on it to catch tokens), a new port is picked and every token for
 *   that machine is revoked: configs that point at the old port must not keep
 *   working. Remote sessions get fresh tokens when they are next provisioned.
 * - A tunnel only runs while some token for that machine exists.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { kernel } from './kernel'
import { PAPER_HOME } from './paths'
import { flush, getState, saveState } from './store'
import { getMachine, machineEvents, probeMachine, requireMachine, setMachineFields } from './machines'
import {
  MachineFailure, classify, muxControl, plainCommand, remotePath, reverseSpec, sshEnv, sshRaw, tunnelControlPath,
  tunnelMasterArgs, upload
} from './ssh'
import { handleMcpRequest, type McpScope } from './mcp'
import { TOOLS } from './tools'
import { invokeTool } from './tools/runtime'
import type { ToolDef, ToolResult } from './tools/types'
import { LOCAL_HOST, type Machine, type MachineError } from '@shared/types'

/**
 * Tools a remote agent may call. Anything else is refused as "not permitted".
 * `self` = the tool's `id` argument is forced to the caller's own session.
 * `remoteOnly` = `host` argument must be a registered machine, never LOCAL_HOST.
 */
export const REMOTE_SCOPE: Record<string, { self?: boolean; remoteOnly?: boolean }> = {
  paper_status: {},
  machines_list: {},
  machines_inventory: {},
  sessions_list: {},
  usage_get: { self: true },
  session_handoff: { self: true },
  session_spawn: { remoteOnly: true }
}

export interface TunnelState {
  alias: string
  remotePort: number
  state: 'down' | 'connecting' | 'up' | 'failed'
  error?: MachineError
  since: number
}

// ---- persistent runtime (kernel slot) -------------------------------------------

interface Tunnel {
  alias: string
  controlPath: string
  child: ChildProcess | null
  /** This generation's exit listener on `child`, so dispose can detach it. */
  onExit: ((code: number | null) => void) | null
  stderr: string
  info: TunnelState
  /** Set by stopTunnel: no more restarts. */
  stopped: boolean
  attempts: number
  retry: NodeJS.Timeout | null
  /** The connect attempt in progress, shared by concurrent ensureTunnel calls. */
  pending: Promise<TunnelState> | null
  /** Remote port this process last had forwarded successfully. */
  boundPort?: number
}

interface GatewaySlot {
  server: Server | null
  port: number | null
  listening: Promise<number> | null
  handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null
  tunnels: Map<string, Tunnel>
}

function slot(): GatewaySlot {
  return kernel().slot<GatewaySlot>('gateway', () => ({ server: null, port: null, listening: null, handler: null, tunnels: new Map() }))
}

// ---- tokens ---------------------------------------------------------------------

interface TokenRecord {
  /** hex sha256 of the bearer token; the token itself is never stored here. */
  hash: string
  sessionId: string
  host: string
  issuedAt: number
}

const TOKENS_FILE = join(PAPER_HOME, 'gateway-tokens.json')
let tokens: TokenRecord[] = []

function loadTokens(): void {
  try {
    const parsed = JSON.parse(readFileSync(TOKENS_FILE, 'utf8')) as TokenRecord[]
    tokens = Array.isArray(parsed) ? parsed.filter((t) => /^[0-9a-f]{64}$/.test(t.hash) && t.sessionId && t.host) : []
  } catch {
    tokens = []
  }
}

function saveTokens(): void {
  mkdirSync(PAPER_HOME, { recursive: true })
  const tmp = `${TOKENS_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, TOKENS_FILE)
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest()

/** Constant-time over every record: no early exit, and only digests are compared. */
function authenticate(req: IncomingMessage): TokenRecord | null {
  const m = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(String(req.headers.authorization ?? ''))
  if (!m) return null
  const digest = sha256(m[1])
  let found: TokenRecord | null = null
  for (const t of tokens) {
    if (timingSafeEqual(Buffer.from(t.hash, 'hex'), digest)) found = t
  }
  // A token for a machine that has since been removed is dead too.
  return found && getMachine(found.host) ? found : null
}

function revokeWhere(pred: (t: TokenRecord) => boolean): TokenRecord[] {
  const gone = tokens.filter(pred)
  if (gone.length) {
    tokens = tokens.filter((t) => !pred(t))
    saveTokens()
  }
  return gone
}

// ---- scoped MCP -------------------------------------------------------------------

const REMOTE_INSTRUCTIONS = `Paper's gateway for agents running on a remote machine. You can see Paper's machines and
sessions, read your own usage, start sessions on registered machines, and move yourself with session_handoff
(your own session only; host "local" brings you back to the user's Mac when allowed).`

const refuse = (text: string): ToolResult => ({ text, isError: true })

/** Tools as remote callers see them: only the scope, and `id` optional where it is forced anyway. */
function scopedTools(): ToolDef[] {
  return TOOLS.filter((t) => REMOTE_SCOPE[t.name]).map((t) =>
    REMOTE_SCOPE[t.name].self && 'id' in t.input
      ? { ...t, input: { ...t.input, id: z.string().optional().describe('Always your own session; any other id is refused') } }
      : t
  ) as ToolDef[]
}

/** Enforce REMOTE_SCOPE for one caller. Exported for tests. */
export function scopedInvoke(caller: { sessionId: string; host: string }) {
  return async (name: string, raw: unknown): Promise<ToolResult> => {
    const rule = REMOTE_SCOPE[name]
    if (!rule) return refuse(`${name} is not permitted for remote agents.`)
    const args: Record<string, unknown> = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {}
    if (rule.self) {
      // Never retarget silently: a wrong id is a refusal, not a correction.
      if (args.id !== undefined && args.id !== caller.sessionId) {
        return refuse(`Remote agents may only act on their own session (${caller.sessionId}), not ${String(args.id)}.`)
      }
      args.id = caller.sessionId
    }
    if (rule.remoteOnly) {
      const host = args.host
      if (typeof host !== 'string' || host === LOCAL_HOST || !getMachine(host)) {
        return refuse(`From a remote machine, ${name} needs \`host\` set to a registered machine (not "${LOCAL_HOST}").`)
      }
    }
    if (name === 'session_handoff') {
      const host = typeof args.host === 'string' && args.host ? args.host : LOCAL_HOST
      if (host === LOCAL_HOST && getMachine(caller.host)?.allowAgentHandoffToLocal === false) {
        return refuse(
          `Handing off from ${caller.host} back to this Mac is disabled for agents on that machine ` +
          `(allowAgentHandoffToLocal is off). Ask the user to move the session from Paper.`
        )
      }
    }
    return invokeTool(name, args)
  }
}

async function handleGateway(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const caller = authenticate(req)
  if (!caller) {
    res.writeHead(401)
    res.end()
    return
  }
  if ((req.url ?? '/').split('?')[0] !== '/mcp') {
    res.writeHead(404)
    res.end()
    return
  }
  const scope: McpScope = { tools: scopedTools(), invoke: scopedInvoke(caller), instructions: REMOTE_INSTRUCTIONS, maxBody: 1024 * 1024 }
  await handleMcpRequest(req, res, scope)
}

// ---- listener ------------------------------------------------------------------------

/** Bind the gateway (once per process; the server survives hot swaps in the slot). */
function ensureListening(): Promise<number> {
  const s = slot()
  if (s.listening) return s.listening
  s.listening = new Promise<number>((resolve, reject) => {
    const server = createServer((req, res) => {
      const h = slot().handler
      if (!h) {
        res.writeHead(503)
        res.end()
        return
      }
      h(req, res).catch((err) => {
        console.error('[gateway] request failed', err)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
    const bind = (port: number, fallback: boolean): void => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && fallback) bind(0, false)
        else reject(err)
      })
      // Loopback only, always; remote agents reach it through their tunnel.
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address()
        const actual = typeof addr === 'object' && addr ? addr.port : port
        s.server = server
        s.port = actual
        if (getState().gatewayPort !== actual) {
          saveState({ gatewayPort: actual })
          flush()
        }
        console.log(`[gateway] listening on 127.0.0.1:${actual}`)
        resolve(actual)
      })
    }
    const saved = getState().gatewayPort
    bind(saved ?? 0, Boolean(saved))
  })
  s.listening.catch(() => { s.listening = null })
  return s.listening
}

// ---- remote listeners ------------------------------------------------------------

const LISTENERS_SCRIPT = [
  'PATH="$PATH:/usr/sbin:/sbin"',
  'if command -v ss >/dev/null 2>&1; then ss -ltn',
  'elif command -v netstat >/dev/null 2>&1; then netstat -an',
  "else echo '!none'; fi"
].join('\n')

/** Listening TCP sockets as port → local addresses, from `ss -ltn` or `netstat -an` (Linux or BSD/macOS). Exported for tests. */
export function parseListeners(text: string): Map<number, string[]> | null {
  if (text.includes('!none')) return null
  const out = new Map<number, string[]>()
  for (const line of text.split('\n')) {
    if (!/LISTEN/i.test(line)) continue
    for (const tok of line.trim().split(/\s+/).slice(1)) {
      const m = /^(.*)[:.](\d+)$/.exec(tok)
      if (!m) continue
      const port = Number(m[2])
      const addr = m[1].replace(/^\[|\]$/g, '').replace(/%.*$/, '')
      out.set(port, [...(out.get(port) ?? []), addr])
      break // the first address:port on a line is the local one
    }
  }
  return out
}

function isLoopback(addr: string): boolean {
  return addr.startsWith('127.') || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === 'localhost'
}

async function remoteListeners(alias: string): Promise<Map<number, string[]>> {
  const run = await sshRaw(alias, plainCommand(LISTENERS_SCRIPT), { timeoutMs: 15_000 })
  const failure = classify(alias, run)
  if (failure) throw new MachineFailure(failure)
  const parsed = parseListeners(run.stdout.toString('utf8'))
  if (!parsed) {
    // Fail closed: without a way to see the bind address we cannot rule out GatewayPorts=yes.
    throw new MachineFailure({
      kind: 'missing-tool',
      message: `${alias} has neither \`ss\` nor \`netstat\``,
      hint: `Paper checks that its tunnel on ${alias} listens on loopback only and needs one of them (iproute2 or net-tools). Paper never installs anything.`
    })
  }
  return parsed
}

async function pickRemotePort(alias: string, avoid: Set<number>): Promise<number> {
  const taken = await remoteListeners(alias)
  for (let i = 0; i < 100; i++) {
    const p = randomInt(20000, 60001)
    if (!taken.has(p) && !avoid.has(p)) return p
  }
  throw new Error(`could not find a free port on ${alias}`)
}

// ---- tunnels -----------------------------------------------------------------------

const MAX_BACKOFF_MS = 60_000

function setInfo(t: Tunnel, patch: Partial<TunnelState>): void {
  t.info = { ...t.info, ...patch, since: patch.state && patch.state !== t.info.state ? Date.now() : t.info.since }
}

function tunnelFor(alias: string): Tunnel {
  const s = slot()
  let t = s.tunnels.get(alias)
  if (!t) {
    const controlPath = tunnelControlPath(alias)
    if (!controlPath) throw new Error('No private directory for ssh control sockets (see ssh.ts controlDir)')
    t = {
      alias, controlPath, child: null, onExit: null, stderr: '', stopped: false, attempts: 0, retry: null, pending: null,
      info: { alias, remotePort: getMachine(alias)?.remotePort ?? 0, state: 'down', since: Date.now() }
    }
    s.tunnels.set(alias, t)
  }
  return t
}

function watchChild(t: Tunnel): void {
  if (!t.child || t.onExit) return
  const child = t.child
  t.onExit = (code) => {
    t.onExit = null
    if (t.child === child) t.child = null
    if (t.stopped) {
      setInfo(t, { state: 'down', error: undefined })
      return
    }
    const failure = classify(t.alias, { code: code ?? 255, stdout: Buffer.alloc(0), stderr: t.stderr, timedOut: false, ms: 0 })
    // Auth and host-key problems need a human; retrying would only hammer the host.
    if (failure && (failure.kind === 'auth' || failure.kind === 'host-key')) {
      setInfo(t, { state: 'failed', error: failure })
      return
    }
    const dropped: MachineError = { kind: 'unknown', message: `tunnel to ${t.alias} dropped`, hint: 'Paper is reconnecting.', detail: t.stderr.trim() || undefined }
    scheduleRetry(t, failure && failure.kind !== 'unknown' ? failure : dropped)
  }
  child.once('exit', t.onExit)
}

function scheduleRetry(t: Tunnel, error: MachineError): void {
  if (t.stopped || t.retry) return
  const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** t.attempts)
  t.attempts++
  setInfo(t, { state: 'connecting', error })
  t.retry = setTimeout(() => {
    t.retry = null
    void connect(t).catch(() => {})
  }, delay)
}

async function waitForMaster(t: Tunnel): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (!t.child) throw new Error('master exited')
    if ((await muxControl(t.alias, t.controlPath, 'check')).code === 0) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('master did not come up')
}

async function connect(t: Tunnel): Promise<TunnelState> {
  if (t.pending) return t.pending
  t.pending = (async (): Promise<TunnelState> => {
    t.stopped = false
    const alias = t.alias
    requireMachine(alias)
    const gport = await ensureListening()
    setInfo(t, { state: 'connecting' })

    if (!t.child || t.child.exitCode !== null) {
      // A master left behind by a Paper that crashed still owns our socket (and maybe our port): end it first.
      if ((await muxControl(alias, t.controlPath, 'check')).code === 0) {
        await muxControl(alias, t.controlPath, 'exit')
        await new Promise((r) => setTimeout(r, 500))
      }
      // A master that was killed leaves its socket file behind, and a new `ssh -M` that finds it
      // "disables multiplexing" and runs on without one. The path is ours, in a private dir.
      rmSync(t.controlPath.split('%%').join('%'), { force: true })
      t.stderr = ''
      const child = spawn('ssh', tunnelMasterArgs(alias, t.controlPath), { env: sshEnv(), stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr!.on('data', (b: Buffer) => { if (t.stderr.length < 16_000) t.stderr += b.toString('utf8') })
      child.on('error', (e) => { t.stderr += `\npaper: could not run ssh: ${e.message}` })
      t.child = child
      watchChild(t)
    }
    try {
      await waitForMaster(t)
    } catch {
      // If the master exited, its exit listener has already recorded "failed" (auth, host key) or
      // scheduled a backed-off retry. If it is merely slow, end it and let that listener retry.
      if (t.child) t.child.kill('SIGTERM')
      return t.info
    }

    let rport = getMachine(alias)?.remotePort
    const tried = new Set<number>()
    let rotations = 0
    let staleWaits = 0
    for (;;) {
      if (!rport) {
        rport = await pickRemotePort(alias, tried)
        if (getMachine(alias)?.remotePort) {
          // The old port is gone: anything still pointing at it must stop working.
          const gone = revokeWhere((x) => x.host === alias)
          if (gone.length) console.warn(`[gateway] ${alias}: remote port changed, revoked ${gone.length} token(s)`)
        }
        setMachineFields(alias, { remotePort: rport })
      }
      tried.add(rport)
      setInfo(t, { remotePort: rport })
      const fwd = await muxControl(alias, t.controlPath, 'forward', reverseSpec(rport, gport))
      if (fwd.code === 0) break
      if (/port forwarding failed|address already in use/i.test(fwd.stderr)) {
        // Reconnecting after a dropped link: sshd may still hold *our* old forward until it notices
        // the dead connection. Give it a minute before treating the port as taken by someone else.
        if (rport === t.boundPort && staleWaits < 4) {
          staleWaits++
          await new Promise((r) => setTimeout(r, 15_000))
          continue
        }
        if (rotations++ < 3) {
          rport = undefined
          continue
        }
      }
      throw new MachineFailure({ kind: 'unknown', message: `could not open Paper's tunnel on ${alias}`, hint: 'See details.', detail: fwd.stderr.trim() || undefined })
    }

    // sshd may have ignored our 127.0.0.1 (GatewayPorts yes). Check what actually listens.
    const addrs = (await remoteListeners(alias)).get(rport) ?? []
    if (!addrs.length || !addrs.every(isLoopback)) {
      await muxControl(alias, t.controlPath, 'cancel', reverseSpec(rport, gport))
      const error: MachineError = addrs.length
        ? {
            kind: 'unknown',
            message: `${alias} exposed Paper's tunnel beyond loopback (${addrs.join(', ')})`,
            hint: `sshd on ${alias} appears to have \`GatewayPorts yes\`. Set it to \`no\` or \`clientspecified\` in sshd_config there. Paper will not run its gateway on a public port.`
          }
        : { kind: 'unknown', message: `Paper's tunnel on ${alias} is not listening`, hint: 'See details.' }
      stopTunnel(alias)
      setInfo(t, { state: 'failed', error })
      return t.info
    }
    t.attempts = 0
    t.boundPort = rport
    setInfo(t, { state: 'up', error: undefined })
    return t.info
  })()
    .catch((err: unknown) => {
      const info = (err as { info?: MachineError }).info
      setInfo(t, { state: 'failed', error: info ?? { kind: 'unknown', message: (err as Error).message, hint: 'See details.' } })
      return t.info
    })
    .finally(() => { t.pending = null })
  return t.pending
}

/** Bring the machine's reverse tunnel up (idempotent) and return its stable remote port. */
export async function ensureTunnel(alias: string): Promise<TunnelState> {
  requireMachine(alias)
  const t = tunnelFor(alias)
  if (t.info.state === 'up' && t.child && t.child.exitCode === null) return t.info
  if (t.retry) { clearTimeout(t.retry); t.retry = null }
  return connect(t)
}

/** Tear a tunnel down: cancel the forward, end the master. Remote port stays persisted. */
function stopTunnel(alias: string): void {
  const t = slot().tunnels.get(alias)
  if (!t) return
  t.stopped = true
  if (t.retry) { clearTimeout(t.retry); t.retry = null }
  if (t.child && t.child.exitCode === null) {
    void muxControl(alias, t.controlPath, 'exit')
    const child = t.child
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM') }, 1500)
  }
  setInfo(t, { state: 'down' })
}

// ---- provisioning -----------------------------------------------------------------

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const runFile = (sessionId: string): string => `~/.paper/run/${sessionId}.json`

async function absoluteRunFile(alias: string, sessionId: string): Promise<string> {
  let home = getMachine(alias)?.probe?.home
  if (!home) home = (await probeMachine(alias, { maxAgeMs: 24 * 3600_000 })).home
  return home ? `${home}/.paper/run/${sessionId}.json` : runFile(sessionId)
}

/**
 * Make sure a remote session has a working token, and return its MCP config
 * path for `claude --mcp-config <path>` plus the tunnel's remote port.
 *
 * Idempotent across Paper restarts: a running agent read its config once, at
 * launch, and holds that token in memory — so when a hash for (sessionId,
 * alias) is still on file *and* the remote config still exists, nothing is
 * rewritten and the same token keeps working (only the tunnel is ensured).
 * Otherwise (no hash, file gone, session moved to another machine, or tokens
 * revoked by a port rotation) a fresh token is issued and uploaded (0600,
 * atomic) and `rotated` is true: a process that is already running cannot see
 * it and needs a restart to regain Paper tools.
 * The config is `{"mcpServers":{"paper":{"type":"http","url":"http://127.0.0.1:<remotePort>/mcp","headers":{"Authorization":"Bearer <token>"}}}}`.
 */
export async function provisionRemoteSession(
  sessionId: string,
  alias: string
): Promise<{ mcpConfigPath: string; remotePort: number; rotated: boolean }> {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`invalid session id ${sessionId}`)
  requireMachine(alias)
  // Tunnel first: if it has to move to a new port, it revokes this machine's tokens, which forces a rotation below.
  const tunnel = await ensureTunnel(alias)
  const remotePort = getMachine(alias)?.remotePort
  if (!remotePort) throw new MachineFailure(tunnel.error ?? { kind: 'unknown', message: `no tunnel port for ${alias}`, hint: 'See gateway_status.' })

  if (tokens.some((t) => t.sessionId === sessionId && t.host === alias)) {
    const run = await sshRaw(alias, plainCommand(`[ -f ${remotePath(runFile(sessionId))} ]`), { timeoutMs: 15_000 })
    // Cannot tell (ssh failed): refuse rather than rotate a token a live agent may still be using.
    const failure = classify(alias, run)
    if (failure) throw new MachineFailure(failure)
    if (run.code === 0) return { mcpConfigPath: await absoluteRunFile(alias, sessionId), remotePort, rotated: false }
  }

  revokeWhere((t) => t.sessionId === sessionId)
  const token = randomBytes(32).toString('base64url')
  tokens.push({ hash: sha256(token).toString('hex'), sessionId, host: alias, issuedAt: Date.now() })
  saveTokens()

  const config = { mcpServers: { paper: { type: 'http', url: `http://127.0.0.1:${remotePort}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }
  const dir = join(PAPER_HOME, 'run')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `${sessionId}.${randomBytes(4).toString('hex')}.json`)
  try {
    writeFileSync(tmp, JSON.stringify(config), { mode: 0o600 })
    await upload(alias, tmp, runFile(sessionId))
  } catch (err) {
    revokeWhere((t) => t.sessionId === sessionId)
    throw err
  } finally {
    rmSync(tmp, { force: true })
  }

  return { mcpConfigPath: await absoluteRunFile(alias, sessionId), remotePort, rotated: true }
}

/** Revoke a session's token and delete its remote config (session closed or handed off elsewhere). */
export async function revokeRemoteSession(sessionId: string): Promise<void> {
  const gone = revokeWhere((t) => t.sessionId === sessionId)
  for (const host of new Set(gone.map((t) => t.host))) {
    if (getMachine(host) && SESSION_ID_RE.test(sessionId)) {
      await sshRaw(host, plainCommand(`rm -f ${remotePath(runFile(sessionId))}`), { timeoutMs: 10_000 }).catch(() => {})
    }
    // No remote sessions left there: nothing needs the tunnel.
    if (!tokens.some((t) => t.host === host)) stopTunnel(host)
  }
}

/** Gateway + tunnel status for the `gateway_status` tool and the UI. */
export function gatewayStatus(): { port: number | null; tunnels: TunnelState[]; tokens: number } {
  const s = slot()
  return { port: s.port, tunnels: [...s.tunnels.values()].map((t) => t.info), tokens: tokens.length }
}

// ---- lifecycle -----------------------------------------------------------------------

/**
 * Attach this generation: install the handler, (re)bind the listener, adopt
 * tunnel masters started by an earlier generation, and bring tunnels up for
 * machines that still have remote sessions (tokens survive restarts, so their
 * agents reconnect once the tunnel is back). Returns the hot-swap disposer.
 */
export function startGateway(): () => void {
  const s = slot()
  loadTokens()
  s.handler = handleGateway
  void ensureListening().catch((err) => console.error('[gateway] listener failed', err))

  for (const t of s.tunnels.values()) {
    if (t.child && t.child.exitCode === null) watchChild(t)
    else if (!t.stopped && t.info.state !== 'failed') scheduleRetry(t, { kind: 'unknown', message: 'tunnel lost during reload', hint: 'Paper will reconnect.' })
  }
  for (const host of new Set(tokens.map((t) => t.host))) {
    if (getMachine(host) && !s.tunnels.get(host)?.child) void ensureTunnel(host).catch(() => {})
  }

  const onMachines = (machines: Machine[]): void => {
    const live = new Set(machines.map((m) => m.alias))
    for (const alias of [...s.tunnels.keys()]) {
      if (!live.has(alias)) {
        stopTunnel(alias)
        s.tunnels.delete(alias)
      }
    }
    revokeWhere((t) => !live.has(t.host))
  }
  machineEvents.on('update', onMachines)

  return () => {
    machineEvents.off('update', onMachines)
    for (const t of s.tunnels.values()) {
      if (t.child && t.onExit) t.child.off('exit', t.onExit)
      t.onExit = null
      if (t.retry) { clearTimeout(t.retry); t.retry = null }
    }
  }
}

/** App is quitting: close every tunnel and the listener. Tokens stay (agents reconnect after restart). */
export function shutdownGateway(): void {
  const s = slot()
  for (const alias of s.tunnels.keys()) stopTunnel(alias)
  for (const t of s.tunnels.values()) if (t.child && t.child.exitCode === null) t.child.kill('SIGTERM')
  s.server?.close()
  s.server = null
  s.listening = null
  s.handler = null
}

