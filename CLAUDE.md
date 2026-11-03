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
   restarts or writes to sessions.
6. **Match the codebase's voice.** Two-space indent, no semicolons, single quotes, `type` imports, comments that
   explain *why* (the existing files are the style guide). Small focused modules; no new frameworks.

## Architecture

```
src/main/index.ts        KERNEL. Window, PTY registry (slots), MCP listener socket, log buffers, dev watcher,
                         hot loader. Changing it needs a restart. Keep it boring.
src/main/app.ts          HOT ENTRY. activate() attaches this generation to the kernel; dispose() detaches.
src/main/kernel.ts       The Kernel / HotModule contract and the kernel() accessor.
src/main/sessions.ts     SessionManager over node-pty. The session Map is a kernel slot; adopt()/detach() rebind
                         pty listeners across generations.
src/main/ipc.ts          IPC handlers (returns a disposer), event wiring, the usage/handoff/title services.
src/main/providers/      claude, codex, shell: argv/env planning, transcript parsing, transplant for handoff.
src/main/accounts.ts     Isolated CLI homes under ~/.paper/accounts/<id>; keychain import; identity display.
src/main/handoff.ts      Account switch and directory retarget with the conversation intact.
src/main/usage.ts        Transcript polling → UsageSnapshot (tracks in a kernel slot).
src/main/titles.ts       Tab naming: native ai-title, one-shot model call, keyword fallback.
src/main/store.ts        ~/.paper/state.json (tabs, defaults, widgets, recent dirs, accounts).
src/main/menu.ts         Application menu = the single source of shortcuts; sends `app:command` to the renderer.
src/main/mcp.ts          MCP server (Streamable HTTP, stateless) over the tool registry.
src/main/tools/          THE TOOL REGISTRY. types.ts (contract), app/sessions/ui/dev/state.ts (tools),
                         index.ts (list), runtime.ts (validate+invoke), context.ts (binds live services).
src/preload/index.ts     Typed bridge: window.paper.{session,accounts,dirs,usage,handoff,tools,on*}.
src/renderer/src/        React + zustand UI. state/store.ts is the app store (HMR-safe, exposed as
                         window.__paper); state/tree.ts is the pane-tree algebra; components/*, widgets/*.
src/shared/              Types and pricing used by both sides.
scripts/sync-tools.mjs   Regenerates the Tools section of this file from the registry.
```

Runtime data: `~/.paper/` (`state.json`, `accounts/<id>/`, `logs/`, `mcp.json`, `shots/`). Override with
`PAPER_HOME`.

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
| `src/main/index.ts` (kernel) | nothing until Electron restarts | die on restart | restart `npm run dev` |
| `electron.vite.config.ts`, `package.json` deps | nothing until restart | die on restart | restart |

A page reload (preload change, `ui_reload`, View ▸ Reload) is safe: `store.init()` keeps pane ↔ session links
whose session is still alive in main and empties only the dead ones.

### Working on Paper from inside Paper

The intended loop: run `npm run dev` once, open a Claude Code session in this repo inside that Paper, and edit.
Renderer and main-process changes land live in the very window you are sitting in; the session doing the editing
is unaffected because it is a kernel slot, not app-bundle state. Claude sessions spawned by Paper get
`--mcp-config ~/.paper/mcp.json` automatically, so the `paper` tools are already in your tool list.

Two cautions:

- A **kernel** change (`src/main/index.ts`) needs a restart, which kills every session in that instance — including
  yours. Test kernel changes in a second instance: `npm run dev:isolated` runs Paper with its own state dir
  (`~/.paper-dev`), Chromium profile, Vite port (5183) and MCP port (47820), so the two never collide. Point a
  client at it with `http://127.0.0.1:47820/mcp`.
- If the MCP port is taken, the kernel walks up to nine ports and writes the one it got into `~/.paper/mcp.json`.
  `paper_status` tells you which instance you reached (pid, home, mode); check it before trusting results.

## MCP server

- Endpoint: `http://127.0.0.1:47810/mcp` (override `PAPER_MCP_PORT`). `GET /health` returns JSON status.
- Transport: Streamable HTTP, stateless, JSON responses. Bound to loopback only; no auth (anything on your machine
  can already type into your terminals). Do not expose it beyond localhost.
- Connect: this repo's `.mcp.json` (for agents working on Paper from any terminal), `claude --mcp-config
  ~/.paper/mcp.json` (written at startup; Paper adds it to its own Claude sessions), or `PAPER_MCP_URL` in any
  session's environment. `PAPER_MCP=0` in Paper's environment disables the auto-attach.
- Tool list caching: MCP clients fetch tools at connect time. A tool you add during a session is served immediately
  but your client will not list it until it reconnects (`/mcp` in Claude Code). Until then use
  `tools_list` + `tools_invoke`, which always see the live registry.
- The same registry is on `window.paper.tools.{list,invoke}` for the renderer and on IPC `tools:list` /
  `tools:invoke`.

## Tools

<!-- tools:begin (generated by `npm run tools:sync`; do not edit by hand) -->

31 tools, served as `mcp__paper__<name>`. Read-only tools are marked; the rest change state.

### Instance

Identify the instance and reach every tool.

#### `paper_status` · read-only

Health of the running Paper instance: version, pid, uptime, dev/prod mode, hot-reload generation, MCP endpoint, window bounds and how many sessions are alive. Call this first to confirm you are talking to the right instance.

_No parameters._

#### `tools_list` · read-only

The manifest of every Paper tool with its JSON-schema input, including tools added since your MCP client connected. Use with tools_invoke to call a tool your client has not loaded yet.

| param | type | | description |
|---|---|---|---|
| `group` | "app" \| "sessions" \| "ui" \| "dev" \| "state" | optional | Only tools in this group |

#### `tools_invoke`

Call any Paper tool by name with a JSON argument object. Reaches tools registered after your client connected (after a hot reload added one), without reconnecting the MCP server.

| param | type | | description |
|---|---|---|---|
| `name` | string | required | Tool name, e.g. "sessions_list" |
| `args` | object | optional | Arguments for that tool |

### Sessions

The PTY sessions Paper runs: agents and shells.

#### `sessions_list` · read-only

Every live session (agent or shell) with id, provider, account, cwd, status (starting/working/idle/exited/handoff), title and usage totals. Session ids are what every other session_* tool takes.

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

Start a Claude Code, Codex or shell session. `where` controls the UI: "tab" opens a new tab, "pane" fills the focused pane, "headless" runs it without a pane (still inspectable via session_read). Returns the session meta.

| param | type | | description |
|---|---|---|---|
| `provider` | "claude" \| "codex" \| "shell" | required | Which harness to run |
| `cwd` | string | optional | Working directory; defaults to the app default |
| `account_id` | string | optional | Account to run under (accounts_list); default account otherwise |
| `prompt` | string | optional | Initial prompt typed into an agent, or a command for a shell |
| `where` | "tab" \| "pane" \| "headless" | default `"tab"` | Where the session appears |

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

Relaunch the CLI in place, resuming the same conversation (⌘R).

| param | type | | description |
|---|---|---|---|
| `id` | string | required | Session id (from sessions_list) |

#### `session_close`

Kill the process and forget the session. The pane showing it (if any) reports it as exited.

| param | type | | description |
|---|---|---|---|
| `id` | string | required | Session id (from sessions_list) |

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

Dispatch one of the application-menu commands exactly as its shortcut would (⌘K = palette.open, ⌘D = pane.split.row...). Known: session.new, session.new.claude, session.new.codex, session.new.shell, session.newInFolder, session.cd, session.close, session.restart, session.rename, session.interrupt, session.steer, session.find, session.clear, account.switch, accounts.open, palette.open, pane.split.row, pane.split.col, pane.close, pane.contents, pane.next, pane.prev, tab.next, tab.prev, tab.select.0, sidebar.toggle, widgets.toggle, zen.toggle, font.bigger, font.smaller (tab.select.N for N in 0..8).

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

What Paper has saved to ~/.paper/state.json: saved tabs and pane layouts, defaults (provider, cwd, default account per provider), widget prefs and recent directories. Accounts are listed via accounts_list.

| param | type | | description |
|---|---|---|---|
| `path` | string | optional | Dot path into the state, e.g. "defaults.cwd" |

#### `state_set_defaults`

Change the default provider, working directory, or pinned account per provider for new sessions.

| param | type | | description |
|---|---|---|---|
| `provider` | "claude" \| "codex" \| "shell" | optional |  |
| `cwd` | string | optional | Absolute directory |
| `account_by_provider` | object | optional | e.g. {"claude": "<account id>"} |

#### `accounts_list` · read-only

Configured logins per provider: id, label, isolated config home, whether a credential is present, and the identity/plan if readable.

_No parameters._

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

## Gotchas

- `ipcMain.handle` throws on a duplicate channel; `registerIpc` removes first, but if you register a channel
  outside it, dispose it yourself or the next hot swap fails to activate (and rolls back).
- `executeJavaScript` results must be JSON-serialisable; `ctx.evalInRenderer` serialises for you and turns
  functions into `"[function]"`.
- The Claude provider pins `--session-id` so the transcript path is known up front; Codex names its own rollout
  file, so `usage` polls until it appears. Handoff relies on both transcripts being flushed on SIGTERM.
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
- `ui_eval` decides expression vs statement form by parsing in main; if your snippet uses `return`, it is run as a
  statement body. A thrown error in the page comes back as the tool error with the last renderer console lines.
