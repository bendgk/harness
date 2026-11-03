/**
 * The remote gateway: how agents running on other machines call Paper tools.
 *
 * CONTRACT STUB — signatures are fixed; implemented by the machines work stream.
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
 */
import type { MachineError } from '@shared/types'

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

/** Bring the machine's reverse tunnel up (idempotent) and return its stable remote port. */
export async function ensureTunnel(_alias: string): Promise<TunnelState> {
  throw new Error('not implemented')
}

/**
 * Issue (or re-issue after a restart) the token for a remote session, upload
 * the agent's MCP config to the remote (0600, `~/.paper/run/<sessionId>.json`)
 * and return its remote path for `claude --mcp-config <path>`.
 * The config is `{"mcpServers":{"paper":{"type":"http","url":"http://127.0.0.1:<remotePort>/mcp","headers":{"Authorization":"Bearer <token>"}}}}`.
 */
export async function provisionRemoteSession(_sessionId: string, _alias: string): Promise<{ mcpConfigPath: string; remotePort: number }> {
  throw new Error('not implemented')
}

/** Revoke a session's token and delete its remote config (session closed or handed off elsewhere). */
export async function revokeRemoteSession(_sessionId: string): Promise<void> {
  throw new Error('not implemented')
}

/** Gateway + tunnel status for the `gateway_status` tool and the UI. */
export function gatewayStatus(): { port: number | null; tunnels: TunnelState[]; tokens: number } {
  throw new Error('not implemented')
}
