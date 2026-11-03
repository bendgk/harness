# Paper — agent guide

Paper is a matte, paper-feeling Electron terminal harness that runs **Claude Code**, **Codex** and plain shells in
tabs and split panes, with per-account CLI config homes, live usage from the CLIs' own transcripts, and account/
directory handoff that carries a conversation across. `README.md` is the product description; this file is the
engineering guide for agents (and people) working on Paper — often *from inside* Paper.

Paper is built to be an **MCP-native, agent-native harness**: it hot-reloads its own code while it runs, and it
serves an MCP server so any agent can inspect and drive it. You are expected to use both.

## Rules for every agent working here

1. **Keep this file current.** When you add, change or remove behaviour — a feature, a tool, an IPC channel, a
   shortcut, a state field, a dev workflow — update the relevant section of `CLAUDE.md` in the same change. If a
   future agent could be surprised by what you did, write it down here.
2. **Every capability gets a tool.** Anything the app can do should be reachable through the tool registry in
   `src/main/tools/`, not only through the UI. New IPC handler ⇒ new or extended tool. New UI state ⇒ visible in
   `ui_state`. New background service ⇒ a status tool. Other agents (and you, next session) test Paper through
   these tools, so a feature without one is untestable.
3. **Sync the tool docs automatically.** After touching `src/main/tools/**`, run `npm run tools:sync` — it
   regenerates the Tools section below from the registry. `npm run check` (typecheck + `tools:check`) fails when
   the docs are stale; run it before you call any change done.
4. **Verify through the running app, not by reasoning about it.** Use the MCP tools: `hot_wait` to confirm your
   edit compiled and activated, `ui_state` / `ui_dom` / `ui_screenshot` to see the result, `logs_main` /
   `ui_console` for errors, `session_*` to exercise sessions. Do not ask the user to rebuild or restart unless you
   changed the kernel (see *What reloads how*).
5. **Never break a live session.** Sessions live in kernel slots precisely so code changes cannot kill them. Do
   not move PTY handles or the session map out of `kernel().slot(...)`, and do not add work to `activate()` that
   restarts or writes to sessions. (The one exception, restore-after-restart, is guarded by a kernel-slot flag so it
   runs on the cold start only — see *Persistence & restore*.)
6. **Match the codebase's voice.** Two-space indent, no semicolons, single quotes, `type` imports, comments that
   explain *why* (the existing files are the style guide). Small focused modules; no new frameworks.

## Architecture

```
src/main/index.ts        KERNEL. Window, PTY registry (slots), MCP listener socket, log buffers, dev watcher,
                         hot loader. Changing it needs a restart. Keep it boring.
src/main/app.ts          HOT ENTRY. activate() attaches this generation to the kernel; dispose() detaches.
src/main/kernel.ts       The Kernel / HotModule contract and the kernel() accessor.
src/main/sessions.ts     SessionManager over node-pty. The session Map is a kernel slot; adopt()/detach() rebind
                         pty listeners across generations. Remote sessions: launch, link supervision, adopt.
src/main/remote.ts       tmux-on-a-machine commands (launch, has/kill-session, @paper_* tags, rollout discovery).
src/main/ipc.ts          IPC handlers (returns a disposer), event wiring, the usage/handoff/title services.
src/main/providers/      claude, codex, shell: argv/env planning, transcript parsing (incremental fold, see
                         transcript.ts; activity.ts distils what the agent is doing), transplant for handoff.
src/main/accounts.ts     Isolated CLI homes under ~/.paper/accounts/<id>; keychain import; identity display.
src/main/handoff.ts      Account switch, directory retarget and machine handoff with the conversation intact.
src/main/usage.ts        Transcript polling → UsageSnapshot (tracks in a kernel slot); mirrors remote transcripts.
src/main/titles.ts       Tab naming: native ai-title, one-shot model call, keyword fallback.
src/main/store.ts        ~/.paper/state.json (tabs, defaults, widgets, recent dirs, accounts, machines).
src/main/ssh.ts          The ONLY module that spawns ssh: alias validation, quoting, BatchMode/multiplexed options,
                         upload/download, failure classification. See *Machines*.
src/main/machines.ts     Machine registry (the allowlist), probe, ensureReady, ~/.ssh/config suggestions, the
                         agent system-prompt text, machine_exec, and the tmux inventory poller.
src/main/persist.ts      ~/.paper/sessions.json session registry + shell scrollback; restore-on-boot, orphan reaping.
src/main/menu.ts         Application menu = the single source of shortcuts; sends `app:command` to the renderer.
src/main/mcp.ts          MCP server (Streamable HTTP, stateless) over the tool registry; GET /agents/brief.
src/main/names.ts        Agent callsigns: the name pool, validation, pickName. See *Agent callsigns & awareness*.
src/main/agents.ts       agents_list / agent_info / agent_transcript / the @mention brief, from memory.
src/main/hooks.ts        The Claude UserPromptSubmit @mention hook (script + --settings JSON, local and remote).
src/main/tools/          THE TOOL REGISTRY. types.ts (contract), app/sessions/ui/dev/state/machines.ts (tools),
                         index.ts (list), runtime.ts (validate+invoke), context.ts (binds live services).
src/preload/index.ts     Typed bridge: window.paper.{session,accounts,dirs,usage,handoff,machines,tools,on*}.
src/renderer/src/        React + zustand UI. state/store.ts is the app store (HMR-safe, exposed as
                         window.__paper); state/tree.ts is the pane-tree algebra; components/*, widgets/*;
                         lib/machines.ts, lib/agents.ts, lib/term-mentions.ts, lib/dev-fakes.ts (see *Machines
                         in the UI* and *Agent callsigns in the UI*).
src/shared/              Types and pricing used by both sides.
scripts/sync-tools.mjs   Regenerates the Tools section of this file from the registry.
```

Runtime data: `~/.paper/` (`state.json`, `sessions.json`, `scrollback/<id>.log`, `accounts/<id>/`, `logs/`,
`mcp.json`, `shots/`, `ssh/` control sockets, `gateway-tokens.json`, `run/` scratch, `remote/<alias>/` transcript
mirrors, `hooks/paper-mention.sh`). Override with `PAPER_HOME`.

### The kernel / hot-bundle split

The main process is two bundles. `out/main/index.js` (kernel) is loaded once by Electron. It `require()`s
`out/main/app.js` (everything else) and calls `activate()`. In development the kernel runs an **esbuild watcher**
over `src/main/app.ts` (which transitively covers `src/main/**` and `src/shared/**`) and `src/preload/index.ts`;
on every successful build it disposes the old generation, purges the require cache and activates the new bundle.
Persistent objects (session map with pty handles, usage tracks, title attempts) live in **kernel slots** —
`kernel().slot('sessions', () => new Map())` — so they are handed unchanged to each generation.

If a new bundle throws on load or activation the kernel keeps (or rolls back to) the last working generation and
records the error in `hot_status`. Overlapping swaps are serialised.

### What reloads how

| You edit | What happens | Sessions | How to confirm |
|---|---|---|---|
| `src/renderer/**` | Vite HMR (React Fast Refresh; store state carried across) | untouched | `ui_state`, `ui_screenshot`, `ui_console` |
| `src/main/**` except `index.ts`, `src/shared/**` | esbuild rebuild → hot swap of the app bundle (~100 ms) | untouched, adopted by the new generation | `hot_wait`, then `hot_status`, `logs_main` |
| `src/preload/index.ts` | esbuild rebuild → renderer page reload | untouched; panes re-attach | `hot_wait` (target preload), `ui_state` |
| `src/main/index.ts` (kernel) | nothing until Electron restarts | local CLIs stop, then resume on relaunch | restart `npm run dev` |
| `electron.vite.config.ts`, `package.json` deps | nothing until restart | local CLIs stop, then resume on relaunch | restart |

A page reload (preload change, `ui_reload`, View ▸ Reload) is safe: `store.init()` keeps pane ↔ session links
whose session is still alive in main and empties only the dead ones.

### Persistence & restore

Sessions survive Paper restarts. `src/main/persist.ts` keeps `~/.paper/sessions.json` (0600, atomic tmp+rename):

```
{ version: 1, savedAt, pid, quitAt?,           // quitAt only after a graceful quit; absent = crash
  sessions: [{ meta: SessionMeta,              // full meta: id, provider, accountId, cwd, host, remote,
                                               //   nativeSessionId, transcriptPath, title, lineage, createdAt…
               wasWorking, lastActiveAt,       // status was `working` at the last write; last pty activity
               cols, rows, liveCwd? }] }       // liveCwd: shells only, the shell's own cwd via lsof
```

- **Writes** are derived from the live session table, coalesced ~200 ms after any `meta`/`closed` event (never
  starved by a busy pane), flushed synchronously in `dispose()` (hot swap) and first thing in `shutdown()` (quit).
  The quit flush also freezes writing, so the exits caused by quitting never reach disk. Nothing is written until
  the boot's restore has run, so an empty table can never overwrite the registry. An unreadable registry is moved
  aside to `sessions.json.corrupt-<ts>`.
- **Only `close()` forgets a session** (it emits `closed`; the record and its scrollback go). `disposeAll()` on quit
  keeps records: local CLIs get SIGTERM and ≤1.2 s grace (blocking — before-quit is synchronous) to flush their
  transcripts, then SIGKILL; a remote session's `kill()` only drops the local ssh client.
- **Restore** (`restoreOnce()` in `activate()`) runs on the *first* activation per Electron process only — the
  `kernel().slot('restore')` flag makes every hot swap skip it. The kernel activates before it creates the window,
  so the renderer's first `app:snapshot` already holds the restored ids and `store.init()` keeps panes bound to
  them. Per record (`meta.restoredAt` is set on all of them):
  - local agent with a transcript → `start({ resume })`; if `wasWorking` and `defaults.resumeNudge` (default true),
    once the CLI has sat idle ~2 s it is sent *"Paper restarted while you were working. Continue exactly where you
    left off."*
  - local agent never prompted (no transcript) → fresh start in the same cwd/account.
  - remote session → `start({ resume, reattach: true })`; the remote runtime rejoins tmux or relaunches. Never dropped here.
  - shell → new login shell in `liveCwd` (else `meta.cwd`, else `$HOME`), previous output from
    `~/.paper/scrollback/<id>.log` (≤200 KB, 0600, written ~1 s after output) replayed dimmed + "restored ·
    previous output above". Agents get no scrollback file: `--resume` redraws them, and it keeps secrets off disk.
  - already exited, account deleted, cwd gone, CLI missing → shown `exited` with a notice saying why; boot goes on.
  Status is never carried over: everything starts as `starting` (or `exited`) until the process reports.
- **Orphans.** Before resuming, `ps -axo pid=,command=` is scanned for a process running one of the registry's
  conversation ids *exactly* (`--session-id|--resume <id>` for Claude, `resume <id>` for Codex); one whose
  environment names a different `PAPER_SESSION` is spared. Matches get SIGTERM, ≤1.5 s, then SIGKILL, so two
  processes never write one transcript.
- **Observe it:** `sessions_persisted` (registry + this boot's restore report and reaped orphans), `sessions_list`
  (`restoredAt`), `logs_main { grep: '[persist]' }`, `state_set_defaults { resume_nudge }`.

| Event | Local agents | Remote agents | Shells |
|---|---|---|---|
| Hot swap / page reload | untouched | untouched | untouched |
| Paper quit (⌘Q, SIGTERM) | stop (SIGTERM); resumed on relaunch, same id/pane | keep running in tmux; reattached | stop; new shell + replayed output |
| Crash / SIGKILL of Paper | die with their pty; resumed + nudged if mid-turn | keep running; reattached | as quit, scrollback ≤1 s stale |
| Machine reboot | resumed from transcripts on next launch | tmux gone → relaunched with resume (remote runtime) | as quit |

### Working on Paper from inside Paper

The intended loop: run `npm run dev` once, open a Claude Code session in this repo inside that Paper, and edit.
Renderer and main-process changes land live in the very window you are sitting in; the session doing the editing
is unaffected because it is a kernel slot, not app-bundle state. Claude sessions spawned by Paper get Paper's MCP
server automatically (`--mcp-config` with inline JSON naming the endpoint and an `X-Paper-Session: <id>` header;
local Codex gets `-c mcp_servers.paper.url=…` + `http_headers`), so the `paper` tools are already in your tool list.

Two cautions:

- A **kernel** change (`src/main/index.ts`) needs a restart, which stops every local session in that instance —
  including yours. They come back (resumed) on relaunch, but the turn in flight is cut off. Test kernel changes in a second instance: `npm run dev:isolated` runs Paper with its own state dir
  (`~/.paper-dev`), Chromium profile, Vite port (5183) and MCP port (47820), so the two never collide. Point a
  client at it with `http://127.0.0.1:47820/mcp`.
- If the MCP port is taken, the kernel walks up to nine ports and writes the one it got into `~/.paper/mcp.json`.
  `paper_status` tells you which instance you reached (pid, home, mode); check it before trusting results.

## MCP server

- Endpoint: `http://127.0.0.1:47810/mcp` (override `PAPER_MCP_PORT`). `GET /health` returns JSON status.
- Transport: Streamable HTTP, stateless, JSON responses. Bound to loopback only; no auth (anything on your machine
  can already type into your terminals). Do not expose it beyond localhost.
- Connect: this repo's `.mcp.json` (for agents working on Paper from any terminal), `claude --mcp-config
  ~/.paper/mcp.json` (written at startup), or `PAPER_MCP_URL` in any session's environment. Paper's own agents get
  the endpoint inline plus `X-Paper-Session: <their session id>` (an identifier, not a credential), which is how
  `agents_list` marks the caller's row `self`. `PAPER_MCP=0` in Paper's environment disables the auto-attach (and the
  @mention hook).
- Besides `/mcp`, `GET /agents/brief?names=a,b&from=<session>` serves the @mention brief as plain text (the kernel
  forwards every path but `/health` to the app's `handleHttp`; `mcp.ts` routes it). It answers only when the `Host`
  header is loopback, so a DNS-rebound web page cannot read other agents' activity.
- Tool list caching: MCP clients fetch tools at connect time. A tool you add during a session is served immediately
  but your client will not list it until it reconnects (`/mcp` in Claude Code). Until then use
  `tools_list` + `tools_invoke`, which always see the live registry.
- The same registry is on `window.paper.tools.{list,invoke}` for the renderer and on IPC `tools:list` /
  `tools:invoke`.

## Machines

A **machine** is a remote computer named by its ssh host alias from `~/.ssh/config` (e.g. `g6e`). Agents run on this
Mac by default; with machines they can work on one over ssh, be launched on one, or be handed off to one and back.
`src/main/machines.ts` is the registry; `src/main/ssh.ts` is the only code that spawns `ssh`.

**Security model.** Paper is a thin layer over the user's own ssh setup and adds no trust of its own:
- System `ssh` only, reading the user's `~/.ssh/config`, `known_hosts` and ssh-agent. Paper stores no keys,
  passwords or host keys, runs no daemon on the remote, and uses only ssh, tmux and POSIX `sh` there.
- Paper's background ssh (probe, inventory, transfers, `machine_exec`) is `BatchMode=yes`, `ForwardAgent=no`, no X11
  or port forwards, multiplexed over one ControlMaster per host (`~/.paper/ssh/%C`, private dir, 120 s persist).
- Aliases are validated (`[A-Za-z0-9_][A-Za-z0-9._-]*`, never `local`) and always follow `--` in argv; remote
  commands are built with `shq` / `remotePath`, never by splicing unquoted input.
- Problems are **surfaced, never fixed**: auth, host-key, DNS, timeout, missing CLI/tmux and not-logged-in come back
  as a `MachineError { kind, message, hint, detail }` with an instruction for the human. Paper never runs
  `ssh-add`, never accepts or edits host keys, never touches `~/.ssh`, never installs anything remotely. Auth
  failures also say whether Paper's ssh-agent is empty or unreachable (`localAgentHint`).
- **The allowlist is a Paper policy, not a sandbox.** `requireMachine(alias)` gates everything *Paper* does or
  offers (launch, handoff, `machine_exec`, inventory, the machine list in agents' prompts). An agent has a shell and
  can run `ssh` to anything the user's ssh can reach; the allowlist tells agents what they may use and keeps Paper
  itself from touching other hosts. Do not describe it as more than that.
- Text that reaches agents' system prompts — machine labels/notes (settable by agents through tools) and strings
  the remote reports (OS, versions, paths, tmux titles) — is cut to one short printable line, so neither a note nor
  a compromised remote can inject a paragraph into every agent's prompt. Probe flags report only whether a
  credential file/env var *exists*, never its contents.

**Registry** (`state.json` → `machines`, flushed immediately on change): `addMachine` validates the alias, rejects
duplicates, resolves it with `ssh -G`, saves, then probes — it is registered even if the probe fails (the error is
on `probe`). `removeMachine` also closes the ControlMaster (tmux sessions on the remote are left alone). Every change
emits `machineEvents 'update'` → IPC `machines:update`.

**Probe** (`probeMachine`, cached on `Machine.probe`, `maxAgeMs` reuse, concurrent probes of one alias share one run):
one login-shell round trip (15 s cap) printing `key=value` lines between `MARK_BEGIN`/`MARK_END`: `uname -sr`,
`$HOME`, `${CLAUDE_CONFIG_DIR:-~/.claude}`, `${CODEX_HOME:-~/.codex}`, and for claude/codex/tmux the path on the
*login-shell* PATH plus `--version`/`-V` (each under `timeout 5` when available). Then a no-op over the warm
connection measures `latencyMs`. ssh failures go through `classify`.

**Login state** (`probe.auth`, best-effort, only `'no'` blocks): Claude is `yes` if `<claudeHome>/.credentials.json`
exists (where Linux Claude Code keeps its token), or `.claude.json` has `oauthAccount`, or `settings.json` has an
`apiKeyHelper`, or `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN`/Bedrock/Vertex is set in the
login env; otherwise `no` on Linux and `unknown` elsewhere (macOS keeps it in the keychain). Codex is `yes` with
`<codexHome>/auth.json` or `OPENAI_API_KEY`/`CODEX_API_KEY`, `unknown` if `config.toml` sets a
`credentials_store`, else `no`. These check the remote's *default* CLI homes.

**`ensureReady(alias, provider)`** — the launch/handoff gate: registered, probe ≤ 60 s old (a cached failure is
re-probed once), provider CLI + tmux present (`missing-tool`, hint names what to install and that it must be on the
login-shell PATH), not `not-logged-in`. Throws `MachineFailure` (`.info` is the MachineError).

**Inventory** (`inventory()`, `startInventory()` from `wireEvents`): the remote is the source of truth for which
agents exist. Per machine, one ssh reads `tmux -L paper list-sessions` (private socket; names `paper-*`; user
options `@paper_id/@paper_provider/@paper_native/@paper_cwd/@paper_name/@paper_title` — the title last, since it is
free text); "no server running" is an empty list. `cachedInventories()` is the last poll from memory (no ssh), used by
`agents_list` and callsign uniqueness.
`attached` = a live local session has `host === alias && remote.tmux === name` and its link is not `lost`. Polls
every 10 s while a Paper window is focused, 60 s otherwise, immediately on start, on window focus, on registry
change, and on `machineEvents.emit('poke', alias)` — **poke after any remote launch/close/handoff**. Machines whose
probe failed with `auth`/`host-key` are not polled (their error is still reported) until re-probed; an `auth`/`host-key`
failure during a poll is written to the probe for the same reason. `inventory({ refresh: true })` re-probes those
first. Results go out as `machineEvents 'inventory'` → IPC `machines:inventory`.

**Agent context** (`machineContextPrompt({ sessionId, host, name, agentTools })`, '' only for an unnamed local
session with no machines): a short block appended to agents' system prompts — where the agent runs, the registered
machines (alias, user@hostname, OS, CLIs, default cwd, note, probe status), how to use them (`ssh <alias> -- '<cmd>'`
non-interactively, `scp`/`rsync -az`, long jobs under `tmux new -d` / `nohup`), never to fix ssh or install anything,
and to call `session_handoff` with `id = $PAPER_SESSION` and `host` when asked to move. Every named agent also gets
`# Agents (from Paper)`: its own callsign ("You are @euclid in Paper"), that `@name` means another Paper agent, that a
brief may already be attached, and which tools to use (or that it has none: `agentTools` false). It is in every
prompt: keep it short. The prompt is fixed at launch, so a renamed agent learns its new name on its next start.

**Gateway** (`src/main/gateway.ts`) — how agents running *on* a machine call Paper tools (e.g. hand themselves back):
- A second HTTP listener, `127.0.0.1:<gatewayPort>` (persisted in `state.json`), separate from the open local MCP
  endpoint. The `http.Server` lives in kernel slot `gateway`; each generation installs its handler
  (`startGateway()` from `wireEvents`; `shutdownGateway()` on quit closes it and every tunnel).
- Every request needs `Authorization: Bearer <token>`; anything else is a bare `401`. Tokens are 256-bit, one per
  remote session, bound to `{sessionId, host}`. Only sha256 hashes are stored (`~/.paper/gateway-tokens.json`, 0600,
  atomic); comparison is constant-time over all records. The token exists only in the remote agent's MCP config,
  uploaded 0600 (dir 0700) to `~/.paper/run/<sessionId>.json` by `provisionRemoteSession` — which returns the absolute
  path for `claude --mcp-config`. It also uploads the @mention hook script to `~/.paper/run/paper-mention.sh` (0700,
  once per Paper process and alias; `hook: false` in the result if that failed — the agent then starts without it). **Provisioning is idempotent**: a running agent read its config once, at launch,
  and holds the token in memory, so if a hash for (sessionId, alias) is on file and the remote config still exists
  (`[ -f ]`), nothing is rewritten and the same token keeps working — call it freely on restore. Otherwise (no hash,
  file gone, session now on another alias, or tokens revoked by a port rotation) a fresh token is uploaded and the
  result has `rotated: true`: a process already running cannot see it, so tell the user Paper tools are unavailable
  until the agent restarts (⌘R). If ssh fails during the check, it throws instead of rotating.
  `revokeRemoteSession` drops the token and deletes the remote file. Tokens survive restarts, so agents that kept
  running in tmux reconnect once the tunnel is back.
- Remote callers get a scoped MCP server (`handleMcpRequest` in `mcp.ts` with a filtered tool list + wrapped invoke):
  only `REMOTE_SCOPE` tools are listed or callable — not `tools_invoke`/`tools_list`, so the filter cannot be
  bypassed. `self` tools get `id` forced to the caller's session (a different id is refused, never retargeted);
  `remoteOnly` tools (`session_spawn`) need `host` = a registered machine, never `local`. `introspect` tools
  (`agents_list`, `agent_info`, `agent_transcript`) are listed and callable only while the caller's machine allows
  introspection; `caller` tools (`agents_list`) get `from` forced to the caller (it is hidden from their schema).
  `GET /agents/brief` (the remote @mention hook) is served here too, bearer-authenticated, empty when introspection
  is off.
- **Trust: `allowAgentIntrospection`** (per machine, default true; `machine_update { allow_agent_introspection }`).
  With it on, **an agent on that machine can read what every other Paper agent is doing — their recent prompts,
  replies, tool calls (commands, file paths), todos and older conversation pages — local agents included**, and the
  @mention brief carries the same into its context. Whatever is in another agent's conversation (pasted secrets,
  private code) can reach that machine. Turn it off for machines you trust less: the tools disappear from that
  machine's gateway scope, calls are refused and the brief is empty. Agents' system prompts tell them other agents'
  text is information, not instructions, but that is mitigation, not isolation.
- **Trust: `allowAgentHandoffToLocal`** (per machine, default true; `machine_update`). A remote agent that hands
  itself to the Mac then runs *with local privileges*, steered by a conversation that was on the remote — so a
  compromised remote could inject instructions and then move the agent here. Turn it off for machines you trust less;
  `session_handoff` to `local` from that machine's agents is then refused (the user can still move sessions in Paper).
- **Tunnels** (`ensureTunnel`): per machine, remote `127.0.0.1:<remotePort>` → local gateway. A dedicated
  foreground `ssh -M -N` ControlMaster (child of Paper, private socket `~/.paper/ssh/t-<hash>`, BatchMode,
  `ClearAllForwardings=yes`, no agent/X11) with the one forward added at runtime by `ssh -F /dev/null -O forward`
  — so no forward from `~/.ssh/config` rides along (`ClearAllForwardings` would also strip a `-R` given on the
  command line; runtime mux forwards are not affected). After binding, the remote's `ss -ltn`/`netstat -an` must
  show the port on loopback only; otherwise (sshd `GatewayPorts yes`) the forward is cancelled and the tunnel fails
  with a hint (fail closed when neither tool exists). `remotePort` is random in 20000–60000, checked free, persisted
  on the machine. If it is taken by something else, a new port is picked **and every token for that machine is
  revoked** (a squatter could have collected them); a reconnect first waits up to a minute for sshd to release our
  own stale forward. Supervision: master exit → backoff (1 s … 60 s) → new master + re-forward; auth/host-key
  failures stop retrying. A stale control socket is removed before a new master starts. Tunnels run only while the
  machine has live tokens; removal of the machine stops its tunnel and revokes its tokens. `gateway_status` shows it.

**IPC**: `machines:list|suggest|add|update|remove|probe|inventory` (preload `window.paper.machines.*`), events
`machines:update` and `machines:inventory`. Tools: the *Machines* group below; `machine_exec` is how tests and
other agents drive a remote through Paper.

Testing machine code: `machines.ts` imports `electron` and `./sessions`; bundle scratch tests with esbuild, aliasing
`electron` to a fake (`{ app: { getPath, on, off }, BrowserWindow: { getAllWindows: () => [] } }`) and `./sessions`
to a stub with `list()`, and set `PAPER_HOME` to a scratch dir (it also isolates the ControlMaster, which matters
when testing auth failures — a warm master would still authenticate).

## Remote sessions & machine handoff

A session whose `meta.host` is a machine alias runs its CLI **in tmux on that machine**; Paper's pane is only an ssh
client attached to it. `src/main/remote.ts` holds the tmux/ssh commands, `sessions.ts` the runtime (`startRemote`,
link supervision), `handoff.ts` the moves (`toMachine`), `usage.ts` the transcript mirror.

**Launch** (`start()` with `host !== 'local'` → `startRemote`, async; status `starting`, `remote.link` `connecting`,
progress as dim notices in the pane): `ensureReady(alias, provider)` → for Claude, the gateway (`ensureTunnel`,
`provisionRemoteSession`; failure → a notice "Paper tools unavailable", the agent still starts) → the provider's
`remotePlan()` (argv only: no local `CLAUDE_CONFIG_DIR`, no local `--mcp-config`; Claude gets `--session-id`/`--resume`,
`--mcp-config <remote 0600 gateway config>`, `--append-system-prompt <machine context>`) → one login-shell ssh
(`launchRemote`) that:
- checks `cd <cwd>` (exit 4 → `remote-dir`), `tmux` (5) and the CLI (6) on the login PATH (`missing-tool`),
- writes the argv to a private launcher `~/.paper/run/<name>.sh` (umask 077, via stdin; it `rm`s itself before
  `exec`). tmux refuses commands over ~16 KB ("command too long"), and prompts/briefs can exceed that,
- runs `tmux -L paper -f /dev/null start-server ; set -s escape-time 0 ; set -g history-limit 50000 ; status off ;
  mouse off ; default-terminal tmux-256color|screen-256color (whichever has terminfo there) ; set -s
  terminal-overrides ',*:Tc:smcup@:rmcup@' ; remain-on-exit off ; window-size latest ; set-titles off ;
  focus-events on ; new-session -d -s paper-<12 hex of id> -x C -y R -c <physical cwd> -- /bin/sh <launcher> <bin>`.
  Options go in before the session exists (history-limit and default-terminal only apply to new panes).
  `escape-time 0` because ESC is Claude's interrupt; `smcup@/rmcup@` so output scrolls into Paper's own scrollback.
  `-L paper` + `-f /dev/null`: a private server the user's tmux config can neither break nor see.
- tags the session with `@paper_id/@paper_provider/@paper_native/@paper_cwd/@paper_title/@paper_name` (title and
  native id are re-tagged on change via `patchMeta`, the callsign by `setName`/backfill), so the machine itself says
  what runs there (inventory, adopt).
- prints the physical cwd (`pwd -P`), which becomes `meta.cwd` (Claude slugs its project dir from it).

Then the local pty is `ssh <sessionOptions> -tt -- <alias> exec $SHELL -lc 'exec tmux -L paper attach-session -t
=<name>'` (`interactiveArgs`; own connection, BatchMode, `-e none`, no port forwards). `-t =name` is an exact match
(bare names are prefixes); `set-option`/`display-message` need `=name:`. Resize goes through ssh to tmux;
`write`/`interrupt` go through the pty as for local sessions. Env inside: `COLORTERM`, `PAPER_SESSION`, `PAPER_HOST`
(never the gateway token — that lives only in the 0600 config file).

**What survives what.**

| Event | Remote agent | Paper side |
|---|---|---|
| ssh link drops / Mac sleeps | keeps running in tmux | `has-session` check → re-attach at once; repeated drops back off 1 s → 30 s (jittered), `link: reconnecting` |
| auth / host-key failure while reconnecting | keeps running | `link: lost`, hint in the pane, no retries; ⌘R / `session_restart` re-attaches |
| Paper quits or crashes (`disposeAll`, `kill`) | keeps running | only the local ssh client dies; restore (persist.ts) calls `start({ resume, reattach: true })` |
| agent exits (`/exit`) | tmux session ends (`remain-on-exit off`) | `has-session` = gone → status `exited`; ⌘R relaunches with resume |
| user closes the session (`close`, `session_close`) | `tmux kill-session` + gateway token revoked | record dropped |
| ⌘R on an attached session | killed and relaunched with `--resume` (same tmux name) | — |

`start({ reattach: true })`: attach if `tmux has-session` says alive, else relaunch resuming the conversation (a
Claude `--resume` of a transcript that does not exist yet becomes `--session-id <same id>`). Async work outlives hot
swaps safely: continuations go through the live manager (`kernel slot sessions.live`), reconnect timers are cleared in
`detach()` and re-armed in `adopt()`, and `RemoteLink.gen` cancels stale launches after kill/restart/handoff.
`machines:adopt` / `machine_adopt { alias, tmux }` bring a `paper-*` tmux session found on a machine (no live session
attached) into Paper from its tags (reusing `@paper_id` when free) and re-attach. Every launch, close, handoff and
re-attach emits `machineEvents 'poke'`.

**Usage on remotes.** `usage.ts` mirrors the remote transcript into `~/.paper/remote/<alias>/<nativeId>.jsonl`
(0600, dirs 0700) with `download(alias, path, offset = cache size)` — only new bytes cross the wire — every 4 s while
working, 20 s idle, and only while `link === 'attached'`. `meta.transcriptPath` points at the mirror, so the
UsageTracker, titles and naming work unchanged; `meta.remote.transcriptPath` is the path on the machine (Claude:
`<claudeHome>/projects/<slug(cwd)>/<id>.jsonl`; Codex: newest `rollout-*.jsonl` under `<codexHome>/sessions` since
launch, excluding others' — found by `findRemoteRollout`, its uuid becomes `nativeSessionId`). `reconcile()` (ps)
skips remote sessions — their local pid is ssh.

**Machine handoff** (`HandoffService.toMachine`, IPC `handoff:machine`, tool `session_handoff`): local→remote,
remote→local, remote→remote (relayed through a local 0600 temp file, deleted after).
1. *Preflight, source untouched*: the source machine is reachable (`ensureReady`), the target is ready (`ensureReady`
   / local CLI + account), and the target directory resolves: `req.cwd` → `machine.defaultCwd` → the same absolute
   path → the `$HOME`-relative equivalent (`/Users/me/work/x` → `~/work/x`) → else `remote-dir` "pick a directory".
   New remote sessions without a directory use the same chain but end in `~` instead of failing.
2. Interrupt, mark `handoff`, stop the source (local: SIGTERM; remote: `tmux kill-session` + revoke its token).
3. Final transcript: local file, or a full `download` of the remote one.
4. Transplant: local → the account home under `projectSlug(targetCwd)` (provider `transplant`); remote → `upload`
   to `<claudeHome>/projects/<slug>/<id>.jsonl` or `<codexHome>/sessions/YYYY/MM/DD/<rollout name>`. A remote
   target's local mirror is seeded with the same bytes.
5. Relaunch on the target with resume; `meta.host/cwd/remote/lineage(host)` updated; notice
   `↪ handed off to @alias · context preserved`. `continuePrompt` is passed as the CLI's **initial prompt argument**,
   not typed: a resumed Claude may first show "trust this folder?" (default *No, exit*) and keystrokes would answer it.
6. Any failure after step 2 rolls back: kill whatever started on the target, restore meta, relaunch the source where it
   was with resume, and report. Progress goes out on `handoff:progress` naming the target (`@g6e` / `this Mac`); a
   failure's `error` is `"<message>\n<hint>"`.
Shell sessions just get a fresh shell in the target directory. `retarget` of a remote agent is a handoff within that
machine; `switchAccount` refuses remote sessions (they use the machine's own login).

**Self-handoff.** An agent moving itself (`session_handoff` with its own `$PAPER_SESSION`, locally or through the
gateway) must not be killed inside its own tool call. If the session is `working` (or `starting`) the tool returns
"scheduled" at once and `scheduleToMachine` waits for 2.5 s of `idle` (10 min cap, then reports), then runs the move
with a default continue prompt ("You have been handed off to … in {cwd}. Continue the task …"; `{cwd}` is filled in
after the directory is resolved). From a machine with `allowAgentHandoffToLocal: false`, moving to `local` is refused.

**Codex and Paper tools.** Local Codex gets Paper's MCP server with `-c mcp_servers.paper.url="<url>"` and
`-c mcp_servers.paper.http_headers={"X-Paper-Session"="<id>"}` (no token locally; verified on codex-cli 0.163 with
`codex -c … mcp get paper --json` → `streamable_http`). It has no @mention hook, so it relies on the prompt and the
agent tools. Remote Codex runs without Paper tools: its HTTP MCP auth takes the bearer token from argv
(`-c …http_headers`) or an env var (`bearer_token_env_var`/`env_http_headers`), and the token must be in neither;
`http_headers_helper` exists in codex 0.163 but not in 0.144 (g6e). Codex *does* get the machine context, via
`-c developer_instructions=<JSON string>` (verified on 0.144 and 0.163; a JSON string is a valid TOML basic string).

**Testing remote code.** Scratch-bundle `remote.ts` with esbuild (`--alias:electron=<fake> --alias:@shared=./src/shared
--external:node-pty`) and point it at a real machine; for live tests run an isolated instance with its own
`PAPER_HOME`/ports and `SSH_AUTH_SOCK` in its env, drive it over MCP, and clean up `tmux -L paper` sessions,
`~/.paper/run/*` and uploaded transcripts on the machine afterwards.

## Agent callsigns & awareness

Every **root agent** session (Claude Code / Codex; never shells, never subagents — those live inside the CLI
process and are not Paper sessions) has a short callsign on `SessionMeta.name` (`euclid`, `hermes`, `leonardo`),
so the user can write "what is @leonardo doing?" in any agent and that agent finds out — on this Mac or any machine.

**Names** (`src/main/names.ts`: `NAME_POOL`, `isValidAgentName` = `/^[a-z][a-z0-9]{1,15}$/` and not `local`,
`normaliseAgentName`, `pickName(taken)`; the session side is in `sessions.ts`):
- `spawn()` names every agent: `req.name` if valid and free, else `pickName`. `takenNames(self)` = other live
  agents' names + machine aliases (lowercased) + agents seen in machines' inventories (`@paper_name`; the session's
  own tmux session excluded) + `local` + names `persist.ts` reserved during restore.
- **Backfill**: `adopt()` names agents from a generation that predates callsigns (a hot swap; remote ones are
  re-tagged); `insert()` names restored records that have none (restore reserves every record's name first, so a
  backfill never takes a later record's) and replaces a name that now clashes; `adoptRemote` keeps the `@paper_name`
  tag when it is free.
- Names are on meta, so they follow account/directory/machine handoff, ⌘R and Paper restarts (sessions.json).
- **Rename**: IPC `session:setName` / tool `agent_rename` → `setName`: validated, unique against agents and machine
  aliases, emits `session:update`, re-tags a remote's `@paper_name` and pokes the inventory once the tag is written.
  Errors are human-readable ("@g6e is a machine; …", "@x is already another agent's callsign.").
- **Machine collision**: `addMachine` registering an alias equal to a live agent's name renames the *agent*
  (`yieldNameTo`) with a pane notice "renamed @x → @y: @x is now a machine" — machines come from `~/.ssh/config`,
  which the user changes less easily.
- Remote launches tag `@paper_name`; `parseInventory` reads it into `HostedAgent.name`.

**Activity index** (`providers/activity.ts`, `providers/transcript.ts`, `usage.ts`). The UsageTracker already
tailed each transcript for usage; it now reads **incrementally**: a `Cursor` per session (kernel slot
`usage.cursors`: path, inode, byte offset, the partial last line as `carry`, and the provider's folded
`TranscriptState`) and only bytes past the offset are read and folded (`provider.fold(state, record)`; split on
0x0A, which is UTF-8 safe). A shrunk/replaced/other file or a changed `state.v` (bump the provider's
`STATE_VERSION` whenever the state or `Activity` shape changes) restarts from 0. Reads are capped at 48 MB per tick
across sessions, so a 200 MB first read takes a few ticks instead of freezing main; usage is emitted once caught up.
The same pass keeps, per session, `Activity`: `lastPrompt` (real user words only — not tool results, `isMeta`,
command wrappers, `<bash-stdout>`, or Paper's own restart/handoff prompts, which are kept as `paper` turns),
`lastReply`, `lastTool` (`Bash: npm test`, `Edit src/x.ts`, `mcp paper.agents_list`), todos (Claude `TodoWrite`
and `TaskCreate`/`TaskUpdate`, Codex `update_plan`), recently edited files, cwd/branch, `lastActiveAt`, and a ring
of the last 240 condensed turns with stable `seq` numbers. Claude sidechain (subagent) records are skipped. Remote
agents' transcripts are mirrored locally while attached, so they are indexed the same way.

**Tools** (group *Agents* below; `src/main/agents.ts`): `agents_list` is pure memory, O(sessions) (≈1 ms round
trip over MCP): live named agents + detached agents from the cached inventory (tmux tags only; `sessionId` = the
tag's `@paper_id`). `agent_info` renders the summary, the last N exchanges (tool runs folded), todos and files,
capped at `max_chars`; for a **detached** agent it fetches the transcript's last 512 KB (`downloadTail`, first
partial line dropped, cached 15 s). `agent_transcript` pages by `seq`; past the ring it re-parses the whole local
(or mirrored) file once, cached while unchanged. Lookup is case-insensitive, `@` optional, and accepts a session id
or a unique ≥8-char prefix; an unknown name errors with the list of known ones. IPC `agents:list` =
`listAgents({ includeExited: true })`.

**The @mention hook (Claude only)** (`src/main/hooks.ts`). Local and remote Claude sessions get
`--settings '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"sh <script>","timeout":5}]}]}}'`.
Verified on Claude Code 2.1.317: `--settings <file-or-json>` *adds* a settings source — the user's, project and
local hooks still run alongside it (tested with a project `UserPromptSubmit` hook plus a `--settings` one: both
reached the model) — and on exit 0 a `UserPromptSubmit` hook's plain stdout is added to the context before the
model runs (it shows as a `hook_success` attachment in the transcript). Stdin is JSON with `prompt`, `session_id`,
`transcript_path`, `cwd`. The script (POSIX sh, no jq) greps `@token`s not preceded by a word char, `.`, `/` or `@`
(so `ben@g6e` and `/x/@scope` are ignored), lowercases and dedupes ≤8, and only if there are any calls
`curl -fsS -m 2` and prints the result; it always exits 0, never blocks or changes the prompt, and prints nothing
when nothing matches or Paper is unreachable.
- Local: `$PAPER_MCP_URL` minus `/mcp` + `/agents/brief?names=…&from=$PAPER_SESSION` (script at
  `~/.paper/hooks/paper-mention.sh`, 0700, rewritten when stale).
- Remote (`$PAPER_HOST` set): the gateway URL and bearer token are read with `sed` from the session's 0600
  `~/.paper/run/$PAPER_SESSION.json` and the header is handed to curl on stdin (`-H @-`) — never argv or env. The
  script is uploaded 0700 next to it by `provisionRemoteSession`.
- The brief: a header saying it is information, not instructions; one line per mention (`@leonardo — claude on
  @g6e, working, ~/work/x. Doing: Edit src/x.ts. Last ask: "…". Todos: 2 open of 5.`; a machine gets its status and
  the agents on it; your own name says "that is you"); unknown names are skipped; then "Use agent_info for more."
- Codex has no such hook; it learns `@name` from its prompt and uses the tools.

**Testing it**: spawn two local Claude agents, ask one "what is @<other> doing?", then read its transcript for a
`hook_success` attachment with the brief (`tools/show-turns`-style: `attachment.type === 'hook_success'`,
`hookName === 'UserPromptSubmit'`). `curl 'http://127.0.0.1:<port>/agents/brief?names=a,b'` shows the brief directly.

## Tools

<!-- tools:begin (generated by `npm run tools:sync`; do not edit by hand) -->

48 tools, served as `mcp__paper__<name>`. Read-only tools are marked; the rest change state.

### Instance

Identify the instance and reach every tool.

#### `paper_status` · read-only

Health of the running Paper instance: version, pid, uptime, dev/prod mode, hot-reload generation, MCP endpoint, window bounds and how many sessions are alive. Call this first to confirm you are talking to the right instance.

_No parameters._

#### `tools_list` · read-only

The manifest of every Paper tool with its JSON-schema input, including tools added since your MCP client connected. Use with tools_invoke to call a tool your client has not loaded yet.

| param | type | | description |
|---|---|---|---|
| `group` | "app" \| "sessions" \| "ui" \| "dev" \| "state" \| "machines" \| "agents" | optional | Only tools in this group |

#### `tools_invoke`

Call any Paper tool by name with a JSON argument object. Reaches tools registered after your client connected (after a hot reload added one), without reconnecting the MCP server.

| param | type | | description |
|---|---|---|---|
| `name` | string | required | Tool name, e.g. "sessions_list" |
| `args` | object | optional | Arguments for that tool |

### Sessions

The PTY sessions Paper runs: agents and shells.

#### `sessions_list` · read-only

Every live session (agent or shell) with id, provider, account, host ("local" or the machine alias it runs on), cwd, status (starting/working/idle/exited/handoff), link (remote sessions: connecting/attached/reconnecting/lost), title and usage totals. `restoredAt` is set on sessions brought back after Paper restarted. Session ids are what every other session_* tool takes.

_No parameters._

#### `sessions_persisted` · read-only

The on-disk session registry (~/.paper/sessions.json) that brings sessions back after Paper restarts: one record per session with its full meta, wasWorking (mid-turn at the last write), lastActiveAt and terminal size, plus quitAt when the last run quit cleanly. `restore` is what this boot did with each record (resumed/fresh/reattached/shell/exited/failed, whether a continuation nudge was sent) and any orphaned CLI processes it terminated. Holds no secrets.

_No parameters._

#### `session_read` · read-only

The tail of a session's terminal output. ANSI escapes are stripped by default so you can read what the agent or shell printed. Use `lines` for the last N lines, or `raw` for the exact byte stream.

| param | type | | description |
|---|---|---|---|
| `id` | string | required | Session id (from sessions_list) |
| `lines` | integer | default `80` | How many trailing lines to return |
| `raw` | boolean | default `false` | Return the raw pty stream with escapes intact |
| `max_bytes` | integer | default `60000` | Hard cap on returned bytes |

#### `session_spawn`

Start a Claude Code, Codex or shell session, on this computer or on a registered machine (`host`). On a machine the agent runs in tmux there and keeps working if Paper disconnects or quits. `where` controls the UI: "tab" opens a new tab, "pane" fills the focused pane, "headless" runs it without a pane (still inspectable via session_read). Returns the session meta (a remote session starts as status "starting", link "connecting").

| param | type | | description |
|---|---|---|---|
| `provider` | "claude" \| "codex" \| "shell" | required | Which harness to run |
| `cwd` | string | optional | Working directory; defaults to the app default (on a machine: its default directory, else ~) |
| `account_id` | string | optional | Account to run under (accounts_list); default account otherwise |
| `prompt` | string | optional | Initial prompt typed into an agent, or a command for a shell |
| `where` | "tab" \| "pane" \| "headless" | default `"tab"` | Where the session appears |
| `host` | string | default `"local"` | Where the agent runs: "local" (this computer) or a registered machine alias, e.g. "g6e" |

#### `session_write`

Send keystrokes to a session's pty, as if typed. `enter` appends a carriage return to submit. For an agent mid-turn prefer session_steer; for a shell this is how you run a command.

| param | type | | description |
|---|---|---|---|
| `id` | string | required | Session id (from sessions_list) |
| `text` | string | required | Text to type. Control characters are passed through (e.g. "\u0003" for Ctrl-C). |
| `enter` | boolean | default `true` | Press Enter after the text |

#### `session_steer`

Interrupt the agent if it is working, then submit a new prompt on the same conversation (the ⌘↩ flow).

| param | type | | description |
|---|---|---|---|
| `id` | string | required | Session id (from sessions_list) |
| `prompt` | string | required | The new instruction |

#### `session_interrupt`

Send the provider's interrupt sequence (ESC for agents, Ctrl-C for shells) without ending the session.

| param | type | | description |
|---|---|---|---|
| `id` | string | required | Session id (from sessions_list) |

#### `session_restart`

Relaunch the CLI in place, resuming the same conversation (⌘R). For a session on a machine whose link dropped or failed, this reconnects to the still-running agent instead, relaunching (with resume) only if it is gone.

| param | type | | description |
|---|---|---|---|
| `id` | string | required | Session id (from sessions_list) |

#### `session_close`

Kill the process and forget the session. For a session on a machine this ends the agent there too (its tmux session). The pane showing it (if any) reports it as exited.

| param | type | | description |
|---|---|---|---|
| `id` | string | required | Session id (from sessions_list) |

#### `session_handoff`

Hand a session off to a registered machine, or back to this computer (host "local"), with the conversation fully intact: the target is checked first, then the agent is stopped, its transcript moved and resumed there by id. If anything fails the session is resumed where it was. An agent may move ITSELF (id = $PAPER_SESSION): while the session is working the call returns "scheduled" at once and the move happens when the current turn ends, then `continue_prompt` (default: a note to carry on with the task) is typed into the resumed agent. A shell just opens a fresh shell on the target.

| param | type | | description |
|---|---|---|---|
| `id` | string | required | Session id (from sessions_list) |
| `host` | string | required | Where the agent runs: "local" (this computer) or a registered machine alias, e.g. "g6e" |
| `cwd` | string | optional | Directory on the target. Default: the machine's default, else the same path, else the same path under $HOME |
| `continue_prompt` | string | optional | Typed into the agent once it is running on the target |

#### `machine_adopt`

Bring an agent that is running in tmux on a registered machine (a "paper-*" session, e.g. from a Paper that restarted or another computer) into this Paper as a live session, re-attaching to it without restarting it. Returns the session meta.

| param | type | | description |
|---|---|---|---|
| `alias` | string | required | Registered machine alias |
| `tmux` | string | required | The tmux session name on that machine, e.g. "paper-1a2b3c4d5e6f" |

#### `session_wait` · read-only

Block until the session is idle or exited (an agent finished its turn), or the timeout passes. Returns the final status and the last lines of output, so "send a prompt, wait, read the answer" is one call.

| param | type | | description |
|---|---|---|---|
| `id` | string | required | Session id (from sessions_list) |
| `timeout_ms` | integer | default `60000` | Give up after this long |
| `settle_ms` | integer | default `1500` | Require this much quiet before declaring idle |
| `lines` | integer | default `30` | Trailing lines to return |

#### `usage_get` · read-only

Token, cost, context-window and rate-limit figures Paper has parsed from the CLI transcript. Omit id for all sessions.

| param | type | | description |
|---|---|---|---|
| `id` | string | optional | Session id; all sessions when omitted |

#### `plan_usage` · read-only

What Claude Code's /usage shows, for every account: current session, current week (all models) and any model-scoped week (e.g. Fable), each with percent used and reset time. Claude numbers come from Anthropic's usage endpoint with the account's own login; Codex numbers from its transcripts. Cached ~1 min; `refresh` asks again.

| param | type | | description |
|---|---|---|---|
| `refresh` | boolean | default `false` | Ask the provider again instead of using the cached numbers |

### Renderer

What is on screen, and driving it.

#### `ui_state` · read-only

The renderer's store (tabs, pane tree, sessions as the UI sees them, overlay, theme, drag state, toast...). This is the truth about what is on screen. `path` narrows to one branch, e.g. "tabs" or "overlay".

| param | type | | description |
|---|---|---|---|
| `path` | string | optional | Dot path into the state, e.g. "tabs.0.root" |

#### `ui_eval`

Run JavaScript in the renderer window (main world, where React runs) and return its JSON-serialisable result. Expressions and statement bodies both work; async is awaited. `window.__paper.store` is the zustand store, so `window.__paper.store.getState().setOverlay("palette")` drives the UI directly.

| param | type | | description |
|---|---|---|---|
| `code` | string | required | JavaScript source to run |

#### `ui_screenshot` · read-only

Capture the Paper window as PNG. Returns the image and the path it was saved to under ~/.paper/shots. Use it to see what a user would see after a change.

| param | type | | description |
|---|---|---|---|
| `max_width` | integer | default `1400` | Downscale so the image is at most this wide |
| `save` | boolean | default `true` | Also write the PNG to disk |

#### `ui_console` · read-only

Recent console output from the renderer (errors, warnings, React messages). Newest last.

| param | type | | description |
|---|---|---|---|
| `limit` | integer | default `100` | How many entries |
| `level` | "error" \| "warning" \| "info" \| "debug" | optional | Only this level |
| `grep` | string | optional | Only entries containing this text |
| `clear` | boolean | default `false` | Empty the buffer after reading |

#### `ui_command`

Dispatch one of the application-menu commands exactly as its shortcut would (⌘K = palette.open, ⌘D = pane.split.row...). Known: session.new, session.new.claude, session.new.codex, session.new.shell, session.newInFolder, session.cd, session.close, session.restart, session.rename, session.interrupt, session.steer, session.find, session.clear, session.moveMachine, agent.rename, account.switch, accounts.open, machines.open, palette.open, pane.split.row, pane.split.col, pane.close, pane.contents, pane.next, pane.prev, tab.next, tab.prev, tab.select.0, sidebar.toggle, widgets.toggle, zen.toggle, font.bigger, font.smaller (tab.select.N for N in 0..8).

| param | type | | description |
|---|---|---|---|
| `command` | string | required | Command id, e.g. "pane.split.row" |

#### `ui_dom` · read-only

A compact outline of the rendered DOM under a selector: tag, id, classes, short text, and bounding box. Use it to find something to ui_click or to check that a component rendered.

| param | type | | description |
|---|---|---|---|
| `selector` | string | default `"#root"` | CSS selector for the root of the outline |
| `depth` | integer | default `3` | How many levels below the root to include |
| `max_nodes` | integer | default `200` | Stop after this many nodes |

#### `ui_click`

Click the first element matching a CSS selector (optionally the first whose text contains `text`). Dispatches a real click event, so React handlers run.

| param | type | | description |
|---|---|---|---|
| `selector` | string | required | CSS selector, e.g. "button.ghost-btn" |
| `text` | string | optional | Only match an element whose textContent contains this |

#### `ui_type`

Send real keyboard input to the window through Electron, hitting whatever is focused — an input in a sheet, the command palette, a terminal. `text` is typed character by character; `key` presses one named key (Enter, Escape, Tab, Backspace, ArrowDown, ...) with optional modifiers. Use it to test focus and keyboard flows the way a user experiences them, then ui_eval `document.activeElement` to see where focus ended up.

| param | type | | description |
|---|---|---|---|
| `text` | string | optional | Characters to type |
| `key` | string | optional | A named key to press after `text`, e.g. "Enter" or "Escape" |
| `modifiers` | "cmd" \| "shift" \| "alt" \| "ctrl"[] | default `[]` | Held while pressing `key` |
| `delay_ms` | integer | default `8` | Pause between characters |

#### `ui_reload`

Full page reload of the renderer. Vite HMR normally makes this unnecessary; use it after a preload change or when the UI is wedged. Live sessions survive and re-attach to their panes.

_No parameters._

#### `ui_window`

Ensure the Paper window exists and is in front. On macOS closing the window leaves the app (and its MCP server) running with no window, and every ui_* tool then fails with "No window" — call this first to get one back.

_No parameters._

#### `ui_notify`

Show a toast in the Paper window, the same one the app uses for its own notices.

| param | type | | description |
|---|---|---|---|
| `text` | string | required | Message |
| `tone` | "ok" \| "warn" | default `"ok"` |  |

### Hot reload & logs

Live code loading and diagnostics.

#### `hot_status` · read-only

State of live code reloading: current app-bundle generation, whether the dev watcher is on, the last error, and recent build results for the main-process (app) and preload bundles. The renderer reloads through Vite HMR separately.

| param | type | | description |
|---|---|---|---|
| `builds` | integer | default `5` | How many recent builds to include |

#### `hot_wait` · read-only

After editing src/main, src/preload or src/shared, wait for the watcher to rebuild and activate the change. Resolves with the build result and the new generation, or the compile errors, so you know your edit is live before testing it.

| param | type | | description |
|---|---|---|---|
| `since` | number | optional | Epoch ms; wait for a build newer than this (default: 20s ago) |
| `timeout_ms` | integer | default `20000` | Give up after this long |

#### `hot_reload`

Re-activate the main-process app bundle from disk ("app"), reload the renderer page ("renderer"), or both. The watcher normally does this for you on save; use it after building by hand or to recover from a failed activation.

| param | type | | description |
|---|---|---|---|
| `target` | "app" \| "renderer" \| "both" | default `"app"` |  |

#### `logs_main` · read-only

Recent console output from the Electron main process (kernel, sessions, hot reload, MCP). Newest last.

| param | type | | description |
|---|---|---|---|
| `limit` | integer | default `100` |  |
| `level` | "log" \| "info" \| "warn" \| "error" \| "debug" | optional |  |
| `grep` | string | optional | Only entries containing this text |

### Persisted state

What survives a restart.

#### `state_get` · read-only

What Paper has saved to ~/.paper/state.json: saved tabs and pane layouts, defaults (provider, cwd, default account per provider, resumeNudge), widget prefs and recent directories. Accounts are listed via accounts_list.

| param | type | | description |
|---|---|---|---|
| `path` | string | optional | Dot path into the state, e.g. "defaults.cwd" |

#### `state_set_defaults`

Change the default provider, working directory, or pinned account per provider for new sessions, and whether agents that were mid-turn when Paper died get a continuation prompt after the restart (resume_nudge).

| param | type | | description |
|---|---|---|---|
| `provider` | "claude" \| "codex" \| "shell" | optional |  |
| `cwd` | string | optional | Absolute directory |
| `account_by_provider` | object | optional | e.g. {"claude": "<account id>"} |
| `resume_nudge` | boolean | optional | After a restart, tell agents that were working to continue where they left off (default true) |

#### `accounts_list` · read-only

Configured logins per provider: id, label, isolated config home, whether a credential is present, and the identity/plan if readable.

_No parameters._

### Machines

Remote computers (ssh host aliases) agents may work on or move to.

#### `machines_list` · read-only

Registered remote machines (the allowlist agents may ssh into or be moved to): alias, label, note, default cwd, and the last probe — target user@hostname, OS, remote $HOME and CLI homes, installed claude/codex/tmux versions, best-effort login state, latency, or the classified error (kind + hint for the human).

_No parameters._

#### `machines_suggest` · read-only

Host aliases found in ~/.ssh/config (and its Includes) that could be registered, with hostname/user from `ssh -G` and whether each is already registered. Wildcard and negated patterns are skipped; named aliases come before bare IPs.

_No parameters._

#### `machine_add`

Register an ssh host alias as a Paper machine, then probe it. The alias must already work with the system ssh (~/.ssh/config, known_hosts, ssh-agent); Paper stores no keys. The machine is registered even if the probe fails — the error and its fix-it hint are on `probe`.

| param | type | | description |
|---|---|---|---|
| `alias` | string | required | ssh host alias, e.g. "g6e" (letters, digits, ".", "_", "-"; not "local") |
| `label` | string | optional | Display label |
| `note` | string | optional | One line shown to agents, e.g. "8xL40S GPU box, repos in ~/work" |
| `default_cwd` | string | optional | Default working directory on the machine (absolute or ~/...) |

#### `machine_update`

Change a registered machine's label, note, default working directory, whether its agents may hand themselves back to this Mac, or whether they may look at other agents. Pass "" to clear a text field.

| param | type | | description |
|---|---|---|---|
| `alias` | string | required | Registered machine alias (its ~/.ssh/config Host name), e.g. "g6e" |
| `label` | string | optional | Display label |
| `note` | string | optional | One line shown to agents |
| `default_cwd` | string | optional | Default working directory on the machine (absolute or ~/...) |
| `allow_agent_handoff_to_local` | boolean | optional | Whether agents running on this machine may move themselves back to this Mac through the gateway (default true) |
| `allow_agent_introspection` | boolean | optional | Whether agents running on this machine may list the other Paper agents and read what they are doing, including their recent conversation, through the gateway (agents_list/agent_info/agent_transcript and the @mention brief; default true) |

#### `machine_remove`

Unregister a machine and close Paper's shared ssh connection to it. Agents already running there in tmux are not killed.

| param | type | | description |
|---|---|---|---|
| `alias` | string | required | Registered machine alias (its ~/.ssh/config Host name), e.g. "g6e" |

#### `machine_probe`

Check a registered machine over ssh (BatchMode, one round trip): reachability, OS, $HOME, CLI homes, claude/codex/tmux on the login-shell PATH with versions, login state, latency. Failures come back classified (auth, host-key, dns, unreachable, timeout) with a hint for the human — Paper never fixes ssh itself.

| param | type | | description |
|---|---|---|---|
| `alias` | string | required | Registered machine alias (its ~/.ssh/config Host name), e.g. "g6e" |
| `max_age_ms` | integer | default `0` | Reuse a cached probe younger than this; 0 = always ask the machine |

#### `machine_exec`

Run a shell command on a registered machine under its login shell (ssh BatchMode, no tty, no stdin) and return stdout, stderr and the exit code. Refuses unregistered aliases. Output past max_bytes keeps the tail. For long jobs start them detached (`tmux new -d -s name ...` or nohup) and poll.

| param | type | | description |
|---|---|---|---|
| `alias` | string | required | Registered machine alias (its ~/.ssh/config Host name), e.g. "g6e" |
| `command` | string | required | POSIX shell command, run as-is by the remote login shell |
| `cwd` | string | optional | Directory to run in (absolute or ~/...) |
| `timeout_ms` | integer | default `60000` | Kill the command after this long |
| `max_bytes` | integer | default `100000` | Cap on returned stdout and stderr each |

#### `machines_inventory` · read-only

What is actually running on each registered machine, read from the machine itself: Paper's tmux sessions (`tmux -L paper`, names paper-*) with Paper session id, provider, conversation id, cwd, title, activity, and whether a local session is attached (unattached ones are adoptable). Polled in the background; `refresh` reads every machine now.

| param | type | | description |
|---|---|---|---|
| `refresh` | boolean | default `false` | Ask the machines now instead of returning the last poll |
| `alias` | string | optional | Only this machine |

#### `gateway_status` · read-only

The remote-agent gateway: the loopback port remote agents reach Paper on (through per-machine reverse ssh tunnels), each tunnel's state (down/connecting/up/failed, with a classified error) and remote port, and how many session tokens are live.

_No parameters._

### Agents

Agent callsigns (@name) and what each agent is doing, across this Mac and every machine.

#### `agents_list` · read-only

Every named Paper agent (Claude Code / Codex root sessions; subagents and shells are not listed), on this Mac and on every machine, attached or detached: callsign, host, provider, status, cwd, title, what it is doing now, its last ask/reply, last tool call and open todos. Pure memory and cheap — call it whenever "@name" comes up. Your own row has `self: true`. Use agent_info for one agent in depth.

| param | type | | description |
|---|---|---|---|
| `host` | string | optional | Only agents running here: "local" or a machine alias |
| `include_exited` | boolean | default `false` | Also list agents whose process has exited |
| `from` | string | optional | Your own session id ($PAPER_SESSION) to mark your row; Paper fills it in for its agents |

#### `agent_info` · read-only

One agent in depth: status, host, cwd and branch, what it is doing, its last ask and reply, its todo list, files it edited, and its recent exchanges condensed (user asks, agent replies, tool calls as one-liners), oldest first. Works for agents on machines too (a detached one is read from the tail of its transcript there). Output is capped at `max_chars`; agent_transcript pages further back.

| param | type | | description |
|---|---|---|---|
| `name` | string | required | Agent callsign, e.g. "leonardo" or "@leonardo" (case-insensitive), or a session id |
| `turns` | integer | default `6` | How many recent exchanges (a user ask and what followed) to include |
| `max_chars` | integer | default `4000` | Hard cap on the output |

#### `agent_transcript` · read-only

Older condensed turns of an agent's conversation (user / agent / tool / paper lines, numbered #seq), `limit` at a time, ending before turn `before` (default: the newest). Each page says what `before` to pass for the next one.

| param | type | | description |
|---|---|---|---|
| `name` | string | required | Agent callsign, e.g. "leonardo" or "@leonardo" (case-insensitive), or a session id |
| `before` | integer | optional | Return turns numbered below this (from a previous page or agent_info) |
| `limit` | integer | default `30` | Turns per page |

#### `agent_rename`

Give a live agent a different callsign: 2–16 lowercase letters/digits starting with a letter, not "local", and not already an agent's callsign or a machine alias. The name follows the session through handoffs and restarts; on a machine it is also written to the tmux session's @paper_name tag.

| param | type | | description |
|---|---|---|---|
| `name_or_id` | string | required | Agent callsign, e.g. "leonardo" or "@leonardo" (case-insensitive), or a session id |
| `new_name` | string | required | The new callsign, e.g. "hypatia" |

<!-- tools:end -->

### Adding a tool

1. Pick the group file in `src/main/tools/` (`app`, `sessions`, `ui`, `dev`, `state`) or add one and import it in
   `index.ts`.
2. `defineTool({ name, title, description, group, input: { ...zod shape... }, mutates, handler })`. Names are
   `snake_case`. Describe every parameter with `.describe()` and give defaults with `.default()` — the description
   is what the calling agent sees. Set `mutates: true` for anything that changes state.
3. Reach behaviour only through `ToolContext` (`ctx.sessions`, `ctx.kernel`, `ctx.evalInRenderer`, `ctx.invoke`,
   …). Tool modules import only `zod` and types, so the registry loads in plain Node for doc generation. Need a new
   service? Add it to `ToolContext` in `types.ts` and bind it in `context.ts`.
4. Save. The watcher rebuilds; `hot_wait` confirms. Call it with `tools_invoke` (your client's list is stale).
5. `npm run tools:sync`, then `npm run check`.

### Adding any other feature — checklist

- Renderer behaviour → also expose what an agent needs to observe it (`ui_state` covers the store; use a tool if
  the state is not in the store).
- New IPC channel → register it in `registerIpc` via `handle()` (so it is disposed on hot swap), add it to the
  preload API, and mirror it as a tool.
- New long-lived object in main → keep it in a kernel slot if it must survive a swap, and stop its timers in the
  `dispose()` path (`wireEvents` returns that disposer).
- New menu command → `menu.ts` (shortcut) + `App.tsx` switch + `ui_command`'s known list in `tools/ui.ts`.
- New persisted field → `Persisted` in `store.ts`, `AppSnapshot` in `shared/types.ts`, `state_get` shows it.
- Update this file, run `npm run check`.

## Machines in the UI

Remote computers are registered by **ssh host alias** (`Machine`, `src/shared/types.ts`). Agents run on this Mac by
default; a session can instead run *on* a machine (`SessionMeta.host` = alias, kept alive in tmux there), and can
be moved between machines with its conversation intact. The renderer side:

| Piece | File | What it does |
|---|---|---|
| Store slice | `state/store.ts` | `machines`, `probing`, `inventory`, `inventoryLoading`, `machinesPanel`, `paneHost`, `mention`, `lastActivity`, `treeCollapsed`, `gateway`, `devFakes` (and the agent fields below) — all in `ui_state`. Actions: `addMachine`/`updateMachine`/`removeMachine`/`probeMachine`, `openMachines({focus, adding})`, `moveToMachine`, `refreshInventory(force)`, `adoptAgent`, `revealSession`, `refreshGateway`. |
| Helpers | `lib/machines.ts` | alias validation (`ALIAS_RE`, never `local`), health (`ok`/`degraded`/`error`/`unknown`), `canLaunch`, mention ranking (alias prefix → alias substring → label/hostname for ≥2 chars), `mentionRegex`, `completionKeys`, `cleanIpcError`, `splitHint`. |
| Machines panel | `components/MachinesPanel.tsx` | ⌘⇧M (`machines.open`). Status dot, blue `@alias`, label, `user@host`, OS, tool versions ✓/✗, latency, "tested …", reverse-tunnel state (from the `gateway_status` tool via `tools.invoke`), the "agents may move themselves to this Mac" toggle (`allowAgentHandoffToLocal`), test / edit / inline remove confirm (never `window.confirm`). Errors show `message`, the `hint` prominently, and `detail` behind a disclosure. Add: free alias with validation + `machines.suggest()` chips. |
| Agents tree | `components/MachineTree.tsx` | Top of the sidebar: This Mac + each machine (status dot, active count, "checked 4s ago", inline error with hint) and the agents under each. Remote rows merge live store sessions (`host === alias`) with the machine's `inventory` (the truth: tmux sessions found there); one running there but not attached here shows **detached**. Click: switch to its tab → else open a new tab attached → else `machines.adopt` and open a new tab. Always a tab, never a split. Refreshes `inventory(true)` on mount and on window focus; folds persist in localStorage `paper:tree-collapsed`; ↑↓←→ walk/fold. |
| Where it runs | `components/HostPicker.tsx` (in `EmptyPane`) | "on This Mac / @alias" chips; machines whose probe failed (or that lack tmux) are disabled with the reason as tooltip. Choice lives in `paneHost[paneId]`; a split inherits its pane's host. Remote spawns pass `host` and `cwd = machine.defaultCwd` (else none — main picks). |
| Move sheet | `components/MoveMachine.tsx` | ⌘⇧P (`session.moveMachine`): This Mac + machines, target directory (placeholder states the default chain: machine default → same path → `~`-relative), optional "continue with" (mention-aware), calls `handoff.toMachine`. |
| Badges | `components/HostTag.tsx` | `AliasChip` (the one blue tag style; agents have the violet `AgentChip`, see below), `HostTag` in pane headers (pulse while connecting/reconnecting, red when lost, tooltip explains), `@alias` in tabs and the status bar, `RestoredHint` for `restoredAt`. |
| Handoff overlay | `Sheets.tsx` `HandoffOverlay` | Machine-handoff failures stay up as a card (message, **hint**, "session unchanged", dismiss) instead of a 3 s toast. A handoff this window did not start (`handoff.initiator === 'agent'`, i.e. the agent called `session_handoff`) reads "‹title› is moving itself to @g6e · ‹stage›"; the target is inferred from `@alias` / "this Mac" in the stage text. |
| Palette | `CommandPalette.tsx` | Manage/Add machine, Move to machine…, Move back to this Mac, and per machine "New Claude / New Codex / New terminal on @alias", "Move session to @alias" (a machine that cannot take it opens its details instead). |

### Agent callsigns in the UI

Every root agent session (Claude Code / Codex — never shells, never subagents) has a callsign on `SessionMeta.name`
(e.g. `euclid`, picked by main from `src/main/names.ts`); detached remote agents carry it on `HostedAgent.name`
(`@paper_name`). `agents.list()` (`AgentSummary[]`) adds what each is doing. The renderer never invents names.

| Piece | File | What it does |
|---|---|---|
| Helpers | `lib/agents.ts` | `AGENT_NAME_RE` (mirrors `isValidAgentName`: `/^[a-z][a-z0-9]{1,15}$/`, not `local`), `agentNameProblem` (regex + unique against other agents **and** machine aliases — both answer to `@`), `agentSummaries(state)` (live sessions win for name/status/title, the `agents` cache adds doing/prompt/todos, inventory adds detached ones — so it works before main serves `agents:list` and between polls), `knownAgentNames`, `rankAgents` (name prefix → substring → title for ≥2 chars; then working → starting → idle → detached → exited; then most recent), `mentionTargets` (≤6 agents then machines, the pane's own agent excluded). |
| Store | `state/store.ts` | `agents` (last `agents.list()`), `agentsAt`, `agentsSource` (`main` / `fake` / `fallback` = handler missing, names from sessions + inventory only), `renaming` (`{sessionId, where: tree\|side\|sheet, current, draft, error, saving}`), `agentCard` (hover card: name + anchor rect). Actions: `refreshAgents(force)` (1.5 s throttle), `goToAgent(name)` (its tab → new tab → adopt from inventory by tmux → new tab, exactly like the tree), `beginRename` / `setRenameDraft` (live validation) / `commitRename` (`session.setName`; its thrown message lands in `renaming.error`) / `cancelRename`, `showAgentCard` / `hideAgentCard`. `mention.agents` = how many leading `mention.matches` are agent names. |
| Chip, card, editor | `components/AgentTag.tsx` | `AgentChip` (violet `@name`, always a span so it fits inside row buttons), `agentHover(name, side, clearOf?)` (350 ms dwell, instant when a card is already up), `AgentCard` (portalled, `role=tooltip`, `pointer-events: none`, never focusable; hides on any mousedown/keydown/blur: doing, last ask, open todos, host/cwd, last active), `AgentNameEditor` (`@` + lowercase field, ↩ save, Esc cancel, blur cancels inline; afterwards `paper:refocus` gives the keyboard back to the focused terminal), `AgentNameSheet` (overlay `agentName`). |
| Where names show | Pane header, tab, SESSION card (`name` row: double-click or hover "rename" → inline editor), status bar | Shells show none. Header/status-bar chip: double-click → rename sheet. |
| Tree | `components/MachineTree.tsx` | Each agent row leads with its chip, then the title; detached ones show the inventory's name (outlined chip). Rename: double-click the chip, the hover pencil, or F2 → inline editor in the row (detached agents cannot be renamed until opened). Polls `refreshAgents` every 15 s while visible. |
| Palette / menu | `CommandPalette.tsx`, `menu.ts` | "Go to @name" for every other agent (status/host in the hint), "Rename agent @name…" for the focused one; **⌘⌥R** = `agent.rename` (menu → App.tsx switch → `ui_command` list). |
| Colour | `styles/theme.css` `--agent*`, `styles/agents.css`, `MENTION_COLORS` in `TerminalPane.tsx` | Agents violet `#6a48a8` on `#ebe5f5` (night `#c4b0f2` on `#261f36`), the sibling of the machine blue `#2a5fae`/`#e1e9f5` (night `#9cc3f3`/`#1d2836`): same ink weight and wash depth. |

### @-mention autocomplete (terminal and Paper's inputs)

- **Terminal** (`TerminalPane.tsx` + `lib/term-mentions.ts`). `MentionTracker` watches the keystrokes xterm is about
  to send (`onData`): `@` opens a token only at start of input or after whitespace; `[A-Za-z0-9._-]` extends it;
  Backspace shrinks (deleting the `@` ends it); space, Enter, control chars, escape sequences (arrows), pastes, a
  mouse click and blur end it. While the token matches ≥1 agent or machine, `mention` is set in the store and the
  dropdown renders with two sections, **Agents** (dot — pulsing when working —, `@name`, title, `@host` if remote,
  a faint line of `doing`; hover → agent card) then **Machines**; one index runs through both. Opening it calls
  `refreshAgents()`. A bare `@` is **passive** (shown, but takes no keys — in Claude Code `@` is also the file picker).
  Once a character is typed, `attachCustomKeyEventHandler` claims ↑ ↓ Tab ↩ Esc (preventDefault + return false,
  and the keypress/keyup twins are swallowed too, or Enter's keypress would still send `\r`); every other key
  passes through untouched. Accepting writes the rest of the name/alias plus a space straight to the pty
  (`completionKeys`: just the tail for a prefix match, otherwise backspaces and the full alias), so the CLI's own
  picker sees `@g6e ` and closes. In a plain shell's alternate screen (vim, less) it stays off.
- **Anchoring.** Agent TUIs park the real cursor away from their input box, so `locateToken` finds the typed
  `@query` in the viewport (nearest the cursor) and falls back to the cursor. Cell size = `.xterm-screen` rect /
  cols×rows. The menu is a DOM sibling of `.term-host` in `.pane-body`, placed **above** the token's line (Claude
  draws its picker below) and flipped below near the top; re-placed on `onWriteParsed` via rAF. It is not
  focusable and prevents mousedown, so xterm keeps focus.
- **Blue and violet tags.** `MentionHighlighter.setTargets(aliases, names)` paints registered `@alias`es blue and
  agent `@name`s violet (`MentionKind`, colour per kind; word boundary: not after a word char, so
  `ben@g6e` is left alone; a trailing `.` is punctuation) with xterm decorations (`registerMarker` +
  `registerDecoration`, opaque `#RRGGBB` per theme) over the **viewport only**, rescanning at most every 60 ms after
  writes/scroll/resize, keeping unchanged decorations so redraws do not flicker. Decorations need markers, which
  exist only on the normal buffer — and **Claude Code (2.1.x) draws its whole UI on the alternate screen** — so
  there the highlighter lays a `.paper-mention-overlay` of cell-aligned tags (tinted box, alias re-drawn one char
  per cell, `data-mention=agent|machine`) over `.xterm-screen` instead, `pointer-events: none`. A link provider
  (all buffers) makes the tags clickable: a machine → Machines panel focused on it; an agent → `goToAgent`. Remote Claude panes are on the normal buffer (tmux runs with
  `smcup@:rmcup@`), so they get real decorations.
- **Closed sessions.** main broadcasts `session:closed` whenever a session is forgotten (UI close, `session_close`,
  an agent, handoff cleanup); the store drops it and unbinds its panes, so the tree and tabs never show ghosts.
- **Paper's inputs** (`components/MentionField.tsx`): steer (⌘↩) and "continue with". A transparent-ink
  textarea/input over a mirror that paints the text with `.mention-hl` (machines) / `.mention-hl-agent` tags
  (box-shadow, never padding, so glyphs stay aligned); same dropdown, portalled to `body`; `selfSessionId` keeps the
  session being steered/moved out of the Agents section. `Modal` ignores Esc while the target is inside
  `[data-mention-open="true"]`, so Esc closes the menu, not the sheet.

### Dev fakes (renderer-only stand-in for main's machine handlers)

`lib/dev-fakes.ts` serves an in-memory registry (`g6e` ok, `a100` missing tmux, `lab` auth error), suggestions,
probes, inventory with two detached agents, adopt, `handoff.toMachine` with staged progress, a fake gateway status,
and "remote" sessions that are really local shells with `host`/`remote` decorated in the renderer. It is inert
unless `import.meta.env.DEV` **and** `localStorage['paper:fake-machines'] === '1'`:

```
ui_eval { code: "localStorage.setItem('paper:fake-machines','1'); location.reload()" }   # on
ui_eval { code: "localStorage.removeItem('paper:fake-machines'); location.reload()" }    # off
```

With it on, `window.__paperFakes` also has `setLink(sessionId, 'lost')` and `selfHandoff(sessionId, host)` (an
agent-initiated move) for exercising those states. `ui_state.devFakes` says whether it is active.

Agent callsigns in the fakes: every agent session and every dressed remote session gets a name from a small pool
(unless main already set one); the detached g6e agents are `@hypatia` and `@noether`; `agents.list` (with made-up
`doing`/prompts/todos) and `session.setName` (main's rules) are served. `agentify(sessionId, { status: 'working',
name: 'euclid', title })` dresses a local shell up as a named Claude agent, so the names UI can be exercised
without spending quota:

```
session_spawn { provider: 'shell' }  →  ui_eval { code: "__paperFakes.agentify('<id>', { status: 'working', name: 'euclid' })" }
```

## Verifying a change — recipes

Renderer edit:
```
ui_screenshot                      # or ui_dom { selector: '.tabbar' } for structure without pixels
ui_console { level: 'error' }      # React/Vite errors surface here
ui_state { path: 'overlay' }
```

Main-process edit:
```
hot_wait                           # { build: { ok, errors }, generation }
logs_main { grep: '[hot]' }        # activation log, or the stack of a failed activate()
paper_status                       # generation, lastError
```

Exercise a session end to end:
```
session_spawn { provider: 'shell', where: 'tab', prompt: 'echo hello from $TERM_PROGRAM' }
session_wait { id }                # -> status idle, tail shows the output
session_write { id, text: 'pwd' }
session_read { id, lines: 20 }
session_close { id }
```

Drive the UI like a user:
```
ui_command { command: 'pane.split.row' }
ui_click { selector: 'button.ghost-btn', text: 'Terminal' }
ui_eval { code: "window.__paper.store.getState().tabs.length" }
```

## Commands

| | |
|---|---|
| `./start.sh` | Installs deps if missing/stale, then `npm run dev`; `./start.sh --prod` builds and runs `npm start` |
| `npm run dev` | Electron + Vite dev server with hot reload (renderer HMR, main/preload hot swap) |
| `npm run dev:isolated` | A second, independent dev instance (own state, profile, ports) |
| `npm run build` / `npm start` | Production build (kernel + app bundles) and preview |
| `npm run typecheck` | `tsc` for main/preload and renderer |
| `npm run tools:sync` / `tools:check` | Regenerate / verify the Tools section of this file |
| `npm run check` | typecheck + tools:check — run before finishing any change |
| `npm run rebuild` | Rebuild node-pty against Electron (after Electron upgrades) |

## Plan usage (the `/usage` numbers)

`src/main/plan.ts` gives every account the figures Claude Code's `/usage` shows: **current session**, **current
week (all models)** and any **model-scoped week** (e.g. Fable). Claude transcripts carry no rate-limit data, so
for Claude accounts Paper asks the endpoint `/usage` itself uses, `GET https://api.anthropic.com/api/oauth/usage`
(header `anthropic-beta: oauth-2025-04-20`), and maps its `limits[]` (`session`, `weekly_all`, `weekly_scoped`
with `scope.model.display_name`) onto `PlanWindow`s; the older `five_hour`/`seven_day` fields are the fallback.
Codex accounts use the windows their own transcripts report (from the usage snapshots).

- **Credentials.** The token is read fresh per request from where Claude Code keeps it — the macOS Keychain item
  `Claude Code-credentials` for the default home, `Claude Code-credentials-<sha256(home)[:8]>` for an account home,
  else `<home>/.credentials.json` — used for that one request and dropped. It is never cached, logged, sent to the
  renderer, or sent anywhere but Anthropic. Only percentages, reset times and labels leave the module.
- **Never refresh.** A refresh rotates the refresh token and would sign the running Claude Code out. An expired
  token is reported ("use this account in a session and it renews itself").
- **Cadence.** Polled every 60 s while a window is focused, 5 min otherwise; a 429 backs that account off 5 min; a
  transient failure keeps the last good numbers with `stale: true`. Cached in a kernel slot across hot swaps.
- **Surfaces.** IPC `plan:list` (`refresh` arg) + push `plan:update`; preload `usage.plan()` / `onPlan`; store
  `plan` keyed by account id; tool `plan_usage`. The sidebar widget id is still `limits` (so existing prefs keep
  it on), shown as **Plan usage**: the focused session's account leads (default Claude account when a terminal is
  focused), other accounts get one compact line. A scoped week shows only once it is above 0%; the session and the
  all-models week always show. Reset times are local, rounded to the minute ("resets Wed 11:00 PM · in 1d 10h").

## Gotchas

- **Terminal queries are not kept for replay.** `sessions.ts` strips DA/DSR/XTVERSION/DECRQM/OSC-colour *queries*
  from the scrollback buffer (they still reach the pane live). A re-attaching pane replays the buffer into a fresh
  xterm, which would answer every old query again, and the answers arrive as typed input — tmux queries on every
  attach, so a remote shell got `1;2c0;276;0c` at its prompt after each page reload.
- `session_write` sends text and `\r` in one write; a long line arrives at Claude's TUI as a *paste* and the Enter is
  swallowed into it. Use `session_steer` (text, pause, Enter) to submit prompts.
- `ipcMain.handle` throws on a duplicate channel; `registerIpc` removes first, but if you register a channel
  outside it, dispose it yourself or the next hot swap fails to activate (and rolls back).
- `executeJavaScript` results must be JSON-serialisable; `ctx.evalInRenderer` serialises for you and turns
  functions into `"[function]"`.
- The Claude provider pins `--session-id` so the transcript path is known up front; Codex names its own rollout
  file, so `usage` polls until it appears. Handoff relies on both transcripts being flushed on SIGTERM.
- **Symlinked directories.** Claude slugs its project folder from the *physical* cwd (`/tmp/x` → `-private-tmp-x` on
  macOS), so `projectDir` resolves `realpath` first; without it a session started in a symlinked dir never found its
  transcript (no usage, no title, no activity).
- **⌘R before the first prompt.** A local agent with no transcript yet restarts fresh instead of `--resume` (which
  would fail with "No conversation found").
- **Transcript binding.** Claude writes its transcript only after the first prompt. `findTranscript` with a pinned id
  must return "not yet", never fall back to "newest `.jsonl` in the folder" — that once bound each new tab to the
  busy tab before it (wrong title, usage, and ⌘R/handoff resuming the wrong conversation). Fallback scans (Codex)
  take `exclude` = transcripts other live sessions already own. On every hot swap `usageTracker.reconcile()`
  re-reads each live Claude process's `--session-id`/`--resume` from `ps` and rebinds drifted sessions (logged as
  `[usage] rebound …` in `logs_main`).
- Agents spawned by Paper have `CLAUDE_CODE_*`, `ANTHROPIC_*`, `OPENAI_*` scrubbed from their environment
  (`shell-env.ts`) so an outer session cannot leak identity or disable transcripts. Do not add exceptions.
- `zod` is v4: use `z.record(z.string(), …)` (two arguments) and `z.toJSONSchema`.
- In dev, React StrictMode mounts `TerminalPane` twice. xterm 5.5 then logs exactly one
  `TypeError: Cannot read properties of undefined (reading 'dimensions')` from its Viewport animation frame on the
  first, already-disposed instance each time a terminal mounts. It is harmless, dev-only, and not something to
  chase when it shows up in `ui_console`; a different stack is a real bug.
- **Focus stealing.** Never call `.focus()` from an effect that can re-run while the user is typing. Sheets get
  their initial focus from `autoFocus` on the input (or from `Modal`, once, on open); `Modal` keeps `onClose` in a
  ref precisely so a per-render callback cannot re-trigger anything. Test keyboard flows with `ui_type` and check
  `document.activeElement` afterwards — an input that loses the caret on the second character is this bug.
- `ui_type { key }` takes **Electron** key names: `Down`, `Up`, `Left`, `Right`, `Tab`, `Enter`, `Escape`,
  `Backspace`. `ArrowDown` arrives in the page as `key: ''` and silently does nothing.
- An app-level `keydown` listener in the capture phase on `window` (like `Modal`'s Esc) runs before any field's
  own handler. A field that wants a key first must be excluded by the listener (see `data-mention-open`).
- `ui_eval` decides expression vs statement form by parsing in main; if your snippet uses `return`, it is run as a
  statement body. A thrown error in the page comes back as the tool error with the last renderer console lines.
