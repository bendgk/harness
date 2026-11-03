# Paper

A matte, paper-feeling terminal workspace for **Claude Code** and **Codex**.

Paper is not another agent harness — it is a wrapper around the two CLIs you
already use. It keeps their sessions alive in real PTYs, renders them on the
GPU, and adds the things the terminal cannot: many accounts at once, tabs that
name themselves, live usage in the margin, and moving a running conversation
from one login to another without losing its context.

```bash
npm install     # also rebuilds node-pty against Electron
npm run dev     # live-reload development
npm run build && npm start
```

Requires `claude` and/or `codex` on your PATH.

## The idea

| | |
|---|---|
| **Harness** | Real `claude` / `codex` processes in a PTY. Paper never proxies the model. |
| **Accounts** | Each login gets an isolated CLI config home under `~/.paper/accounts/<id>`. |
| **Handoff** | Switch a live session to another account with its history intact. |
| **Usage** | Read from the CLIs' own transcripts, so the numbers are theirs, not a guess. |
| **Panes** | Split, drag to rearrange, and fill with an agent, a plain shell, *or* a widget. |

Nothing starts on its own. A new tab, a new split and a freshly emptied pane all
open the same chooser — Claude Code, Codex, a plain terminal, or a widget — so no
session is ever spawned, and no quota spent, without you asking for it. The
chooser also shows the directory it will start in, one click from changing it.

## Accounts

Paper gives every account its own config home and points the CLI at it with
`CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Those homes are genuinely separate: a fresh
home reports *"Not logged in"* even when your default login exists, which is
what makes several subscriptions usable side by side.

Signing in, per account:

- **Sign in** opens a session in that home and runs `/login` for you.
- **Import login** copies an existing login in. Codex stores its login in a
  file, so this is a copy. Claude keeps the *default* login in the macOS
  Keychain, so Paper lifts it into the home's `.credentials.json` — macOS will
  ask you to approve that read, which is the only time Paper touches a secret.

Paper also scrubs `CLAUDE_CODE_*`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and
friends from the environment it hands to an agent. An inherited key would
override the account's login and quietly run a session as the wrong identity;
an inherited child-session marker turns transcript saving off, which would break
both usage tracking and handoff.

## Handoff (⌘P)

Switching account mid-session:

1. the agent is interrupted and the process closed so the CLI flushes its transcript,
2. the transcript is transplanted into the target account's config home,
3. the CLI is relaunched with `--resume <id>` / `codex resume <id>`.

The conversation comes back whole — every message, tool result and file edit —
under the new login. Paper records the lineage, so a session remembers every
account it has run under.

Switching **across harnesses** (Claude ⇄ Codex) cannot transplant a transcript,
because the formats differ. Paper distils the conversation into a written brief
and opens the new agent with it. The switcher labels which you are getting:
*full context* or *brief handoff*.

## Directories

⌘L opens the location bar: `cd`, with the ergonomics of a shell rather than a
file dialog. Tab completes the shared prefix the way a shell does, the faint
remainder sits inline ahead of the cursor, ↑↓ walk the matches, and ↵ goes.
Repositories are marked, `~` and `..` work, and a path that is already a
directory is pinned to the top as **open here** — so "type a path, press Enter"
lands exactly where you asked. With the bar empty it offers recent directories.
The path in a pane header and in the sidebar are both buttons onto it.

What ↵ does depends on what is running, and the bar says so before you press it:

- a **terminal** is simply sent `cd`, as anywhere else;
- an **agent** cannot change directory once launched, so its conversation is
  carried into the new directory exactly the way it is carried between accounts —
  transplant the transcript, relaunch with resume. It comes back standing
  somewhere else, remembering everything;
- an **empty pane** just remembers the directory for whatever starts in it.

## Panes

Split with ⌘D / ⌘⇧D — a new pane inherits the working directory of the pane it
came from, so staying in one project takes no setup. Drag any pane by its header
to rearrange: dropping on an
edge docks the pane there, dropping in the middle swaps the two panes. Drag the
hairline between panes to resize. ⌘X closes a pane — except the last one in a
tab, which empties back to the chooser rather than taking the tab with it.

While you drag, Paper runs the move against the real layout tree and draws the
**actual result** — every pane in its final position, captioned, with the moving
one picked out in accent. That shows what a highlighted drop target cannot: the
siblings resizing to make room, the space the pane is leaving closing up, and a
centre drop marking *both* panes of a swap. Move between edges and the wireframe
glides into each new arrangement, and dragging back over where you started holds
the preview rather than blanking it — "nothing moves" is an answer too, marked
**stays**. Edge bands scale with the pane and are clamped at both ends, so a wide
pane keeps a big centre target and a narrow one stays dockable; in a corner, the
edge you are proportionally deeper into wins.

A pane does not have to be a terminal. ⌘J, the ◫ button in a pane header, or the
command palette will put a widget in it instead:

| | |
|---|---|
| **Terminal** | Not a widget — a pane can also hold a plain login shell, with no account, transcript or usage attached to it. |
| **Companion** | Kumo, drawn in SVG, watches the agent — focused while it works, expectant when it is your turn, asleep when nothing runs. She follows the cursor and blinks on her own. |
| **Analog clock** | A printed clock face; click the time to drop the second hand. |
| **Notes** | A ruled sheet that saves itself into the layout. |
| **Focus timer** | A ring that empties while you work. |
| **Usage board** | Every open session, its context and its spend, on one sheet. |
| **Desk pet** | The little ASCII creature, given room to live. |
| **Calendar** | A month on paper, today circled. |
| **Shortcuts** | A reference card of the keys. |

Widgets keep their own state — a note's text, a pet's name, a timer's end — in
the pane itself, so they survive a restart along with the layout.

## Naming

Tabs name themselves, preferring, in order: a title the CLI wrote itself
(Claude Code emits `ai-title`), a title Paper asks that same CLI to write with a
cheap one-shot call, then keywords from your first prompt. The keyword title
lands instantly so a tab is never sitting there called "Claude". Rename by hand
(⌘⇧R) and auto-naming stops for that tab.

## Usage

Parsed from the transcripts each CLI already writes: tokens in/out, cache reads
and writes, thinking tokens, turn count, resident context against the model's
window, and an API-equivalent cost. Codex additionally reports plan limits and
credit balance, which Paper shows as windows with reset times.

Cost is labelled *equivalent* on purpose: on a subscription you are not billed
per token, so it is a weight, not an invoice.

## Keys

| | | | |
|---|---|---|---|
| ⌘N | new session | ⌘K | command palette |
| ⌘⇧N | new session in folder… | ⌘P | switch account |
| ⌘⌥C / ⌘⌥X | new Claude / Codex session | ⌘, | accounts |
| ⌘⌥T | new terminal | ⌘L | change directory… |
| ⌘D / ⌘⇧D | split right / down | ⌘X | kill pane |
| ⌘J | pane contents… | drag header | move pane |
| ⌘[ / ⌘] | focus pane | ⌘⇧W | close pane |
| ⌘1…9 | select tab | ⌃⇥ | next tab |
| ⌘. | interrupt agent | ⌘↩ | interrupt and steer… |
| ⌘R | restart (keeps context) | ⌘⇧R | rename |
| ⌘B | sidebar | ⌘⇧↩ | zen mode |
| ⌘F | find | ⌘± | text size |

**⌘↩ (steer)** is the one worth knowing: it interrupts the agent mid-turn and
submits a new instruction on the same conversation, so redirecting costs you
nothing of what it has already learned.

## Developing — and letting agents develop it

Paper is built to be worked on from inside itself. `npm run dev` gives you a
window whose code reloads as you save: the renderer through Vite HMR, the main
process through a kernel/hot-bundle split that swaps new code in without
restarting Electron — so the agent session doing the editing keeps running.

Paper also serves an **MCP server** (`http://127.0.0.1:47810/mcp`) that lets any
agent inspect and drive the running app: list and read sessions, type into
them, read the UI store, evaluate JS in the window, take screenshots, run menu
commands, and watch the hot reloader. Claude sessions spawned by Paper get it
attached automatically; this repo's `.mcp.json` attaches it for anyone working
on Paper from elsewhere.

`CLAUDE.md` is the engineering guide: architecture, what reloads how, the full
tool list (generated from the registry by `npm run tools:sync`), and the rules
every agent working here follows.

## Layout

```
src/main/index.ts   kernel — window, PTY registry, MCP listener, hot loader (restart to change)
src/main/app.ts     hot bundle — everything else in main; rebuilt and swapped on save
src/main/tools/     the tool registry the MCP server (and the UI) call into
src/main/           providers (claude, codex), PTY sessions, accounts, handoff, usage, titles
src/preload/        typed IPC bridge
src/renderer/       React UI — tabs, pane tree, terminals, sidebar
src/renderer/src/widgets/panes/   what a pane can hold besides a terminal
src/shared/         types and pricing shared across both sides
```

State lives in `~/.paper/state.json`; accounts in `~/.paper/accounts/<id>`;
the advertised MCP endpoint in `~/.paper/mcp.json`.
