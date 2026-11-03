/**
 * Remote session runtime: agents that live in tmux on another machine.
 *
 * A remote agent runs inside a tmux session on a private server socket
 * (`tmux -L paper`, started with `-f /dev/null` so the user's ~/.tmux.conf can
 * neither break nor observe it). Paper's pane is only an ssh client attached to
 * that session, so the agent keeps working when the link drops, Paper quits or
 * the Mac sleeps; Paper re-attaches when it can.
 *
 * Everything here goes through src/main/ssh.ts — the only module that spawns
 * ssh — and every value that reaches a remote command is POSIX-quoted.
 */
import { MARK_BEGIN, MARK_END, between, classify, loginCommand, remotePath, shq, sshRaw, sshScript, sshError, MachineFailure } from './ssh'
import type { MachineError, ProviderId } from '@shared/types'

/** The tmux socket name every Paper session lives on. Never the user's default server. */
export const TMUX = 'tmux -L paper'

/** What a Paper tmux session may be called. Checked before any name reaches a command. */
export const TMUX_NAME_RE = /^paper-[0-9a-f]{6,32}$/

/** `paper-<first 12 hex of the session id>`: stable across relaunches and handoffs. */
export function tmuxNameFor(sessionId: string): string {
  const hex = sessionId.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 12)
  return assertTmuxName(`paper-${hex}`)
}

export function assertTmuxName(name: unknown): string {
  if (typeof name !== 'string' || !TMUX_NAME_RE.test(name)) {
    throw new Error(`"${String(name)}" is not a Paper tmux session name`)
  }
  return name
}

/** `=name` makes tmux match the session exactly; a bare name is a prefix match. */
function target(name: string): string {
  return shq(`=${assertTmuxName(name)}`)
}

/** Commands that take a pane/window target (set-option, display-message) need `=name:` to match exactly. */
function sessionTarget(name: string): string {
  return shq(`=${assertTmuxName(name)}:`)
}

/** The @paper_* user options that let the machine itself say what is running on it. */
export interface RemoteTags {
  id?: string
  provider?: ProviderId
  native?: string
  cwd?: string
  title?: string
}

const TAG_KEYS = ['id', 'provider', 'native', 'cwd', 'title'] as const

/** Tag values are one line; tmux would keep a newline, the inventory parser would not. */
function tagValue(v: string): string {
  // One argv word to tmux; a trailing ';' (or '\\') would be read as a command separator.
  return v.replace(/[\r\n\t]+/g, ' ').slice(0, 400).replace(/[;\\]+$/, '')
}

function tagCommands(name: string, tags: RemoteTags): string[] {
  const out: string[] = []
  for (const k of TAG_KEYS) {
    const v = tags[k]
    if (v === undefined) continue
    out.push(`${TMUX} set-option -t ${sessionTarget(name)} @paper_${k} ${shq(tagValue(v))}`)
  }
  return out
}

export interface LaunchSpec {
  alias: string
  name: string
  cwd: string
  cols: number
  rows: number
  /** CLI looked up on the remote login PATH; null for the remote user's login shell. */
  bin: string | null
  args: string[]
  env: Record<string, string>
  tags: RemoteTags
  /** Attach to an existing session of this name instead of replacing it. */
  reattach: boolean
}

export interface LaunchResult {
  /** True when a live session was found and nothing was started. */
  reattached: boolean
  /** Physical working directory on the remote (what the CLI sees as its cwd). */
  cwd?: string
}

/**
 * The launcher script the tmux pane runs. tmux refuses commands longer than
 * ~16 KB ("command too long"), and a system prompt plus an initial brief can
 * exceed that, so the argv is written to a private file rather than passed on
 * tmux's command line. It deletes itself before exec'ing, so prompts do not
 * linger on the remote disk.
 */
function launcher(spec: LaunchSpec): string {
  const env = Object.entries(spec.env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `export ${k}=${shq(v)}`)
  return [
    '#!/bin/sh',
    'rm -f -- "$0"',
    ...env,
    `exec "$1" ${spec.args.map(shq).join(' ')}`,
    ''
  ].join('\n')
}

/**
 * Create the tmux session (or find it alive, for `reattach`). Runs under the
 * remote login shell so `claude`/`codex` resolve on the user's PATH; the
 * binary is resolved there and handed to the launcher as $1, so it does not
 * matter what PATH the (possibly older) tmux server has.
 */
export async function launchRemote(spec: LaunchSpec): Promise<LaunchResult> {
  const { alias, name } = spec
  assertTmuxName(name)
  const cols = Math.max(20, Math.min(1000, Math.floor(spec.cols)))
  const rows = Math.max(5, Math.min(500, Math.floor(spec.rows)))
  const t = target(name)
  const resolveBin = spec.bin === null
    ? 'bin="${SHELL:-/bin/sh}"'
    : `bin=$(command -v ${shq(spec.bin)}) || exit 6`
  const script = [
    `if [ ${spec.reattach ? 1 : 0} = 1 ] && ${TMUX} has-session -t ${t} 2>/dev/null; then`,
    `  printf '%s\\nALIVE\\n%s\\n' ${MARK_BEGIN} ${MARK_END}; exit 0`,
    'fi',
    'command -v tmux >/dev/null 2>&1 || exit 5',
    `cd -- ${remotePath(spec.cwd)} >/dev/null 2>&1 || exit 4`,
    'cwd=$(pwd -P)',
    resolveBin,
    'umask 077',
    'mkdir -p "$HOME/.paper/run" || exit 7',
    `f="$HOME/.paper/run/${name}.sh"`,
    'cat > "$f" || exit 7',
    // The pane's TERM must have terminfo on the remote or the TUI degrades.
    'if infocmp tmux-256color >/dev/null 2>&1; then term=tmux-256color; else term=screen-256color; fi',
    // A relaunch replaces whatever ran under this name before.
    `${TMUX} kill-session -t ${t} 2>/dev/null`,
    // Options go in before the session exists: history-limit only applies to
    // new panes and default-terminal sets the TERM the CLI starts with. The
    // server is ours alone (-L paper), so global options touch nobody else.
    [
      `${TMUX} -f /dev/null start-server`,
      // ESC is Claude's interrupt; any escape-time delay makes it lag or merge with the next key.
      '\\; set-option -s escape-time 0',
      '\\; set-option -g history-limit 50000',
      '\\; set-option -g status off',
      '\\; set-option -g mouse off',
      '\\; set-option -g default-terminal "$term"',
      // True colour through to Paper, and no alternate screen on the outer
      // terminal so output scrolls into the pane's own scrollback.
      `\\; set-option -s terminal-overrides ${shq(',*:Tc:smcup@:rmcup@')}`,
      '\\; set-option -g remain-on-exit off',
      '\\; set-option -g window-size latest',
      '\\; set-option -g set-titles off',
      // Claude uses focus reports; tmux only forwards them when asked.
      '\\; set-option -g focus-events on',
      `\\; new-session -d -s ${shq(name)} -x ${cols} -y ${rows} -c "$cwd" -- /bin/sh "$f" "$bin"`
    ].join(' ') + ' || { rm -f "$f"; exit 8; }',
    ...tagCommands(name, { ...spec.tags }).map((c) => `${c} 2>/dev/null`),
    `printf '%s\\nLAUNCHED\\n%s\\n%s\\n' ${MARK_BEGIN} "$cwd" ${MARK_END}`
  ].join('\n')

  const run = await sshScript(alias, script, { input: launcher(spec), timeoutMs: 30_000 })
  const ssh = classify(alias, run)
  if (ssh) throw new MachineFailure(ssh)
  const fail = (kind: MachineError['kind'], message: string, hint: string): never => {
    throw new MachineFailure({ kind, message, hint, detail: run.stderr.trim().split('\n').slice(-6).join('\n') || undefined })
  }
  if (run.code === 4) {
    fail('remote-dir', `${spec.cwd} does not exist on ${alias}`, `Choose a directory that exists on ${alias}, or create it there first.`)
  }
  if (run.code === 5) fail('missing-tool', `tmux is not installed on ${alias}`, `Install tmux on ${alias} (e.g. \`sudo dnf install tmux\` or \`sudo apt install tmux\`), then retry.`)
  if (run.code === 6) {
    fail('missing-tool', `${spec.bin} is not on ${alias}'s login PATH`, `Install ${spec.bin} on ${alias} so \`ssh ${alias}\` then \`${spec.bin} --version\` works, then retry.`)
  }
  if (run.code !== 0) throw sshError(alias, run, 'starting tmux')
  const lines = between(run.stdout).split('\n')
  if (lines[0] === 'ALIVE') return { reattached: true }
  if (lines[0] !== 'LAUNCHED') throw sshError(alias, { ...run, code: run.code ?? 1 }, 'starting tmux (no confirmation)')
  return { reattached: false, cwd: lines[1] || spec.cwd }
}

/** The remote command an interactive pty runs to show the session. */
export function attachCommand(name: string): string {
  return loginCommand(`exec ${TMUX} attach-session -t ${target(name)}`)
}

export type RemoteState = { state: 'alive' } | { state: 'gone' } | { state: 'error'; error: MachineError }

/** Is the agent's tmux session still there? (BatchMode, over the shared background connection.) */
export async function remoteState(alias: string, name: string): Promise<RemoteState> {
  const script = `if ${TMUX} has-session -t ${target(name)} 2>/dev/null; then exit 0; else exit 3; fi`
  const run = await sshScript(alias, script, { timeoutMs: 20_000 })
  const err = classify(alias, run)
  if (err) return { state: 'error', error: err }
  if (run.code === 0) return { state: 'alive' }
  if (run.code === 3) return { state: 'gone' }
  return { state: 'error', error: sshError(alias, run, 'tmux has-session').info }
}

/** End the agent: tmux sends SIGHUP to the pane's process group. */
export async function killRemote(alias: string, name: string): Promise<void> {
  const run = await sshScript(alias, `${TMUX} kill-session -t ${target(name)} 2>/dev/null; exit 0`, { timeoutMs: 20_000 })
  if (run.code !== 0) throw sshError(alias, run, 'tmux kill-session')
}

/** Update @paper_* options on a live session (best effort; the session may be gone). */
export async function setTags(alias: string, name: string, tags: RemoteTags): Promise<void> {
  const cmds = tagCommands(name, tags)
  if (!cmds.length) return
  await sshScript(alias, cmds.map((c) => `${c} 2>/dev/null`).join('\n') + '\nexit 0', { timeoutMs: 20_000 })
}

/** Read a session's @paper_* options. Throws when the session does not exist. */
export async function readTags(alias: string, name: string): Promise<RemoteTags> {
  const t = target(name)
  const script = [
    `${TMUX} has-session -t ${t} 2>/dev/null || exit 3`,
    `printf '%s\\n' ${MARK_BEGIN}`,
    ...TAG_KEYS.map((k) => `printf '%s=' ${k}; ${TMUX} display-message -p -t ${sessionTarget(name)} ${shq(`#{@paper_${k}}`)}`),
    `printf '%s\\n' ${MARK_END}`
  ].join('\n')
  const run = await sshScript(alias, script, { timeoutMs: 20_000 })
  if (run.code === 3) throw new Error(`No tmux session ${name} on ${alias}`)
  if (run.code !== 0) throw sshError(alias, run, 'reading tmux options')
  const tags: Record<string, string> = {}
  for (const line of between(run.stdout).split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0 && line.slice(eq + 1)) tags[line.slice(0, eq)] = line.slice(eq + 1).trim()
  }
  return tags as RemoteTags
}

/** Does a file exist on the remote? */
export async function remoteFileExists(alias: string, path: string): Promise<boolean> {
  const run = await sshRaw(alias, `exec /bin/sh -c ${shq(`[ -f ${remotePath(path)} ]`)}`, { timeoutMs: 20_000 })
  const err = classify(alias, run)
  if (err) throw new MachineFailure(err)
  return run.code === 0
}

/**
 * Resolve a working directory on the remote: the first candidate that exists,
 * as a physical absolute path, or undefined when none does.
 */
export async function resolveRemoteDir(alias: string, candidates: string[]): Promise<string | undefined> {
  if (!candidates.length) return undefined
  const script = [
    `printf '%s\\n' ${MARK_BEGIN}`,
    ...candidates.map((c) => `if [ -d ${remotePath(c)} ]; then (cd -- ${remotePath(c)} >/dev/null 2>&1 && pwd -P) && { printf '%s\\n' ${MARK_END}; exit 0; }; fi`),
    `printf '%s\\n' ${MARK_END}`
  ].join('\n')
  const run = await sshRaw(alias, `exec /bin/sh -c ${shq(script)}`, { timeoutMs: 20_000 })
  if (run.code !== 0) throw sshError(alias, run, 'checking directories')
  return between(run.stdout).split('\n')[0]?.trim() || undefined
}

/**
 * Codex names its own rollout, so on a remote we look for it: newest
 * `rollout-*.jsonl` under `<codexHome>/sessions` touched since the launch,
 * skipping files other sessions own. A known id matches by file name.
 */
export async function findRemoteRollout(
  alias: string,
  codexHome: string,
  sinceMs: number,
  nativeId: string | undefined,
  exclude: ReadonlySet<string>
): Promise<string | undefined> {
  const minutes = Math.max(1, Math.ceil((Date.now() - sinceMs) / 60_000) + 1)
  const pattern = nativeId && /^[0-9a-zA-Z-]+$/.test(nativeId) ? `rollout-*${nativeId}.jsonl` : 'rollout-*.jsonl'
  const age = nativeId ? '' : ` -mmin -${minutes}`
  const script = [
    `root=${remotePath(`${codexHome.replace(/\/+$/, '')}/sessions`)}`,
    `printf '%s\\n' ${MARK_BEGIN}`,
    `[ -d "$root" ] && find "$root" -type f -name ${shq(pattern)}${age} -exec ls -t {} + 2>/dev/null`,
    `printf '%s\\n' ${MARK_END}`
  ].join('\n')
  const run = await sshRaw(alias, `exec /bin/sh -c ${shq(script)}`, { timeoutMs: 20_000 })
  if (run.code !== 0 && classify(alias, run)) throw sshError(alias, run, 'finding the codex rollout')
  return between(run.stdout).split('\n').map((l) => l.trim()).filter(Boolean).find((p) => !exclude.has(p))
}

/** `YYYY/MM/DD` as Codex lays out its sessions folder. */
export function codexDayPath(d = new Date()): string {
  return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('/')
}

