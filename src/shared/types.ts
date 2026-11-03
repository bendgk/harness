/** Shared contract between the main process and the renderer. */

/** `shell` is a plain login shell — no account, no transcript, no usage. */
export type ProviderId = 'claude' | 'codex' | 'shell'
export type AgentProviderId = 'claude' | 'codex'

/** A configured login. Each account owns an isolated CLI config home. */
export interface Account {
  id: string
  provider: AgentProviderId
  /** Human label, e.g. "work" or "personal". */
  label: string
  /** Absolute path to the isolated CLAUDE_CONFIG_DIR / CODEX_HOME. */
  home: string
  /** Free-form note, e.g. plan tier. */
  plan?: string
  /** Colour accent used in the UI (hex). */
  color?: string
  /** Last time we saw a live credential in this home. */
  lastAuthAt?: number
  /** Whether a credential file currently exists in the home. */
  authed?: boolean
  createdAt: number
}

export type SessionStatus =
  | 'starting'
  | 'idle'       // process alive, agent waiting for input
  | 'working'    // agent is producing output
  | 'exited'
  | 'handoff'    // mid account-switch

export interface SessionMeta {
  id: string
  title: string
  /** True once a model-generated title has replaced the placeholder. */
  titleIsAi: boolean
  provider: ProviderId
  accountId: string
  cwd: string
  status: SessionStatus
  /** Provider-native conversation id, used for resume/handoff. */
  nativeSessionId?: string
  /** Path of the transcript we are tailing for usage. */
  transcriptPath?: string
  createdAt: number
  /** Accounts this session has previously run under, oldest first. */
  lineage: { accountId: string; at: number; nativeSessionId?: string; host?: string }[]
  exitCode?: number
  /**
   * Where the CLI process runs: LOCAL_HOST, or the ssh alias of a registered
   * Machine. A local agent can still *work on* machines over ssh; this field
   * is only about where the agent itself lives.
   */
  host: string
  /** Remote sessions only: the tmux session on `host` that keeps the agent alive. */
  remote?: {
    tmux: string
    /** Transcript path on the remote machine, once known. */
    transcriptPath?: string
    /** Attach state of the local ssh client, separate from the agent's own status. */
    link: 'connecting' | 'attached' | 'reconnecting' | 'lost'
  }
  /** Set when this session was brought back after Paper restarted. */
  restoredAt?: number
}

/** Sentinel host for "this computer". Reserved: no Machine may use it as its alias. */
export const LOCAL_HOST = 'local'

/** Why talking to a machine failed, in terms a person can act on. */
export type MachineErrorKind =
  | 'auth'          // key rejected / no usable identity / agent empty
  | 'host-key'      // unknown or changed host key — never auto-accepted
  | 'dns'           // alias resolves to nothing
  | 'unreachable'   // refused / no route
  | 'timeout'
  | 'missing-tool'  // the CLI, tmux or a coreutil is not installed on the remote
  | 'not-logged-in' // the harness is installed but has no login on the remote
  | 'remote-dir'    // working directory does not exist on the remote
  | 'unknown'

export interface MachineError {
  kind: MachineErrorKind
  /** One-line summary, e.g. "g6e rejected the ssh key". */
  message: string
  /** What the human should do; Paper never tries to fix these itself. */
  hint: string
  /** Raw stderr tail, for the details disclosure. */
  detail?: string
}

/** Result of `ssh <alias>` capability probe. */
export interface MachineProbe {
  at: number
  ok: boolean
  error?: MachineError
  /** From `ssh -G`: what the alias actually points at. */
  target?: { hostname: string; user: string; port: number }
  os?: string
  /** Remote $HOME and the CLI homes the remote harnesses use. */
  home?: string
  claudeHome?: string
  codexHome?: string
  /** Version string (or path) per tool; absent means not installed. */
  tools: { claude?: string; codex?: string; tmux?: string }
  latencyMs?: number
}

/** A computer agents are allowed to ssh into, named by its ~/.ssh/config alias. */
export interface Machine {
  /** The ssh host alias, e.g. "g6e". Validated: [A-Za-z0-9_][A-Za-z0-9._-]*, never 'local'. */
  alias: string
  /** Optional display label; the alias is what agents and @mentions use. */
  label?: string
  /** Free-form note shown to agents, e.g. "8×L40S GPU box, repos in ~/work". */
  note?: string
  /** Default working directory on the remote for new sessions / handoffs. */
  defaultCwd?: string
  addedAt: number
  probe?: MachineProbe
}

export interface UsageSnapshot {
  sessionId: string
  provider: ProviderId
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  /** Estimated spend in USD for this session (API-equivalent pricing). */
  costUsd: number
  /** Tokens currently resident in the model's context window. */
  contextTokens: number
  contextWindow: number
  messages: number
  /** Provider-reported subscription limits, when available. */
  limits?: RateLimitWindow[]
  /** Credit balance, when the provider reports one. */
  credits?: { balance: number; unlimited: boolean }
  updatedAt: number
  /** Rolling per-minute token burn, newest last. */
  burn: number[]
}

export interface RateLimitWindow {
  name: string
  usedPercent: number
  windowMinutes: number
  resetsAt?: number
}

/** What a pane is showing. A pane is a slot, not necessarily a terminal. */
export type PaneContent =
  | {
      type: 'terminal'
      sessionId: string | null
      /** Directory a not-yet-started pane will open in. */
      cwd?: string
    }
  | { type: 'widget'; widget: string; props?: Record<string, unknown> }

export type PaneNode =
  | {
      kind: 'leaf'
      id: string
      content: PaneContent
      /** Legacy field from before panes could hold widgets; migrated on load. */
      sessionId?: string | null
    }
  | { kind: 'split'; id: string; dir: 'row' | 'col'; sizes: number[]; children: PaneNode[] }

/** Where a dragged pane lands relative to the pane it is dropped on. */
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface Tab {
  id: string
  /** Mirrors the focused session's title; user can pin an override. */
  title: string
  titleOverride?: string
  root: PaneNode
  focusedPaneId: string
  createdAt: number
}

export interface AppSnapshot {
  tabs: Tab[]
  activeTabId: string | null
  sessions: SessionMeta[]
  accounts: Account[]
  defaults: {
    provider: ProviderId
    cwd: string
    accountByProvider: Partial<Record<AgentProviderId, string>>
  }
  widgets: WidgetPrefs
  /** Directories opened recently, most recent first. */
  recentDirs: string[]
  machines: Machine[]
}

/** One completion candidate for the directory bar. */
export interface DirEntry {
  name: string
  path: string
  /** Whether the directory is the root of a git repository. */
  repo?: boolean
}

export interface DirComplete {
  /** The directory being listed. */
  base: string
  entries: DirEntry[]
  /** Longest prefix shared by all matches, for tab completion. */
  common: string
  /** Whether the typed path itself resolves to a directory. */
  exact: boolean
  resolved: string
}

export interface WidgetPrefs {
  enabled: string[]
  petName: string
}

export interface SpawnRequest {
  provider: ProviderId
  accountId?: string
  cwd?: string
  /** Resume an existing provider-native conversation. */
  resume?: string
  /** Initial prompt typed into the agent once it boots. */
  prompt?: string
  /** Where to run the CLI: LOCAL_HOST (default) or a registered machine alias. */
  host?: string
}

/** Moving a session to another computer (or back to this one). */
export interface MachineHandoffRequest {
  sessionId: string
  /** Target: LOCAL_HOST or a registered machine alias. */
  host: string
  /** Working directory on the target. Default: Machine.defaultCwd, else the same path, else the $HOME-relative equivalent. */
  cwd?: string
  /** Typed into the agent once it is running on the target, e.g. "continue the task". */
  continuePrompt?: string
}

/** One entry of the tool registry, as exposed to the UI and to `tools_list`. */
export interface ToolManifestEntry {
  name: string
  title: string
  description: string
  group: string
  mutates: boolean
  inputSchema: unknown
}

/** What a tool returns. `json` is structured data, `text` is prose, `image` is base64. */
export interface ToolResult {
  text?: string
  json?: unknown
  image?: { data: string; mimeType: string }
  isError?: boolean
}

/** Events pushed from main → renderer. */
export interface MainEvents {
  'pty:data': { sessionId: string; data: string }
  'pty:exit': { sessionId: string; exitCode: number }
  'session:update': SessionMeta
  'usage:update': UsageSnapshot
  'accounts:update': Account[]
  'handoff:progress': { sessionId: string; stage: string; detail?: string; done?: boolean; error?: string }
  'app:command': { command: string }
  'machines:update': Machine[]
  /** A new main-process app bundle was activated (hot reload). */
  'hot:update': { generation: number; at: number; tools: number }
}
