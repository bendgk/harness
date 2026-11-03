/**
 * The one place Paper talks ssh.
 *
 * Paper never holds keys, passwords or host keys of its own. Every connection
 * is the system `ssh` binary reading the user's ~/.ssh/config, known_hosts and
 * ssh-agent, so "can Paper reach g6e" means exactly "does `ssh g6e` work".
 * When it doesn't, we classify the failure and tell the human what to do — we
 * never accept a host key, add a key to the agent or retry with weaker options.
 *
 * Rules every caller relies on:
 * - An alias is validated before it reaches argv, and always follows `--`, so
 *   it can never be parsed as an ssh option (`-oProxyCommand=…`).
 * - Remote commands are POSIX-quoted with `shq`; nothing user-supplied is ever
 *   spliced into a remote command unquoted.
 * - Background work (probes, transfers, tmux control) is BatchMode, never
 *   forwards the agent, X11 or ports, and shares one multiplexed connection.
 * - Interactive sessions get their own connection with the user's own
 *   forwarding preferences (minus port forwards, which would collide), and the
 *   `~` escape disabled so typing "~." into an agent cannot drop the link.
 */
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PAPER_HOME } from './paths'
import { shellEnv } from './shell-env'
import { LOCAL_HOST, type MachineError, type MachineErrorKind } from '@shared/types'

// ---- aliases & quoting --------------------------------------------------------

/** Letters, digits, `_` first; then `.`, `_`, `-`. No `@`, no spaces, never a leading `-`. */
const ALIAS_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/

export function isValidAlias(alias: unknown): alias is string {
  return typeof alias === 'string' && ALIAS_RE.test(alias) && alias !== LOCAL_HOST
}

export function assertAlias(alias: unknown): string {
  if (!isValidAlias(alias)) {
    throw new Error(`"${String(alias)}" is not a valid ssh host alias (letters, digits, ".", "_", "-"; not "${LOCAL_HOST}")`)
  }
  return alias
}

/** POSIX single-quote a string so a remote `sh` sees it as one literal word. */
export function shq(s: string): string {
  return `'${String(s).split("'").join(`'\\''`)}'`
}

/**
 * A remote path as a shell word: a leading `~/` expands to the remote $HOME,
 * everything else is quoted literally. Use this, not `shq`, for remote paths.
 */
export function remotePath(p: string): string {
  if (p === '~') return '"$HOME"'
  if (p.startsWith('~/')) return `"$HOME"/${shq(p.slice(2))}`
  return shq(p)
}

/**
 * Wrap a POSIX script so it runs under the remote user's *login* shell — that
 * is where ~/.local/bin, nvm and friends put `claude` and `codex` on PATH.
 * sshd hands our command string to the user's shell with `-c`; we re-exec it
 * as a login shell with the script as one quoted argument.
 */
export function loginCommand(script: string): string {
  return `exec "\${SHELL:-/bin/sh}" -lc ${shq(script)}`
}

/** Run a script under plain `/bin/sh` — for byte-exact transfers, where login-shell chatter would corrupt stdout. */
export function plainCommand(script: string): string {
  return `exec /bin/sh -c ${shq(script)}`
}

// ---- connection options --------------------------------------------------------

let controlDirCache: string | null | undefined

/**
 * Directory for multiplexing sockets. sun_path is ~104 bytes on macOS and %C
 * expands to 40 hex characters, so a long PAPER_HOME falls back to /tmp —
 * only if that directory is ours, a real directory, and private.
 */
function controlDir(): string | null {
  if (controlDirCache !== undefined) return controlDirCache
  const candidates = [join(PAPER_HOME, 'ssh'), `/tmp/paper-ssh-${process.getuid?.() ?? 'user'}`]
  controlDirCache = null
  for (const dir of candidates) {
    if (dir.length + 1 + 40 > 100) continue
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const st = lstatSync(dir)
      const mine = process.getuid ? st.uid === process.getuid() : true
      if (st.isDirectory() && !st.isSymbolicLink() && mine && (st.mode & 0o077) === 0) {
        controlDirCache = dir
        break
      }
    } catch { /* try the next one */ }
  }
  return controlDirCache
}

const COMMON = [
  'ConnectTimeout=10',
  'ServerAliveInterval=15',
  'ServerAliveCountMax=3',
  // Port forwards from ~/.ssh/config would collide across parallel connections.
  'ClearAllForwardings=yes'
]

/** Options for Paper's own non-interactive work: probes, file transfer, tmux control. */
export function backgroundOptions(): string[] {
  const o = [
    ...COMMON,
    'BatchMode=yes',
    'ForwardAgent=no',
    'ForwardX11=no',
    'PermitLocalCommand=no',
    'RequestTTY=no'
  ]
  const dir = controlDir()
  if (dir) o.push('ControlMaster=auto', `ControlPath=${join(dir, '%C')}`, 'ControlPersist=120')
  else o.push('ControlMaster=no')
  return o.flatMap((x) => ['-o', x])
}

/**
 * Options for the long-lived connection that carries an agent's terminal.
 * BatchMode stays on: auth problems are surfaced by the probe with a hint,
 * not answered by a password prompt Paper might be typing into blindly.
 * ForwardAgent is left to the user's config on purpose — people rely on it
 * for `git push` from the remote, and it is their call per host.
 */
export function sessionOptions(): string[] {
  return [...COMMON, 'BatchMode=yes', 'ControlMaster=no', 'RequestTTY=force']
    .flatMap((x) => ['-o', x])
    .concat(['-e', 'none'])
}

/** Environment for the ssh binary: the login-shell env, so SSH_AUTH_SOCK matches the user's terminal. */
export function sshEnv(): Record<string, string> {
  return { ...shellEnv() }
}

/** argv (after the `ssh` binary) for an interactive pty: `ssh … -tt -- alias <command>`. */
export function interactiveArgs(alias: string, command: string): string[] {
  return [...sessionOptions(), '-tt', '--', assertAlias(alias), command]
}

// ---- reverse tunnels (gateway.ts) ------------------------------------------------
//
// Each machine's tunnel is its own ControlMaster, a supervised foreground
// `ssh -M -N` child of Paper, on a private control socket — separate from the
// shared background master, whose ControlPersist lifetime Paper does not own.
// The master carries ClearAllForwardings=yes like all background work, so no
// forward from ~/.ssh/config ever rides along; the single gateway forward is
// then added at runtime with `-O forward`, which ClearAllForwardings does not
// touch (it only filters forwards parsed from config and argv at startup).
//
// The `-O` mux client runs with `-F /dev/null` and a literal ControlPath: it
// only needs the socket, and without the user's config it cannot add their
// LocalForward/RemoteForward lines to our master either. The forward always
// names 127.0.0.1 on both ends; gateway.ts additionally verifies on the remote
// that the listener is loopback-only (sshd `GatewayPorts yes` would override
// the bind address) and cancels it otherwise.

/** Control socket for an alias's tunnel master, or null when no private dir is available. */
export function tunnelControlPath(alias: string): string | null {
  const dir = controlDir()
  if (!dir) return null
  const id = createHash('sha256').update(assertAlias(alias)).digest('hex').slice(0, 24)
  // ssh expands %-tokens in ControlPath; a literal % in PAPER_HOME must not be one.
  return join(dir, `t-${id}`).split('%').join('%%')
}

function assertPort(p: number): number {
  if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error(`invalid port ${p}`)
  return p
}

/** argv for the foreground tunnel master: authenticates once, forwards nothing until told to. */
export function tunnelMasterArgs(alias: string, controlPath: string): string[] {
  const o = [
    ...COMMON,
    'BatchMode=yes',
    'ForwardAgent=no',
    'ForwardX11=no',
    'PermitLocalCommand=no',
    'RequestTTY=no',
    'ControlMaster=yes',
    'ControlPersist=no',
    `ControlPath=${controlPath}`
  ]
  return [...o.flatMap((x) => ['-o', x]), '-N', '--', assertAlias(alias)]
}

/** The `-R` spec: remote loopback port → local loopback port, never a wildcard bind. */
export function reverseSpec(remotePort: number, localPort: number): string {
  return `127.0.0.1:${assertPort(remotePort)}:127.0.0.1:${assertPort(localPort)}`
}

/** Talk to a tunnel master: `check`, `forward`/`cancel` (with a -R spec) or `exit`. */
export function muxControl(
  alias: string,
  controlPath: string,
  op: 'check' | 'forward' | 'cancel' | 'exit',
  reverse?: string
): Promise<{ code: number; stderr: string }> {
  assertAlias(alias)
  const args = ['-F', '/dev/null', '-o', `ControlPath=${controlPath}`, '-o', 'BatchMode=yes', '-O', op]
  if (reverse) args.push('-R', reverse)
  args.push('--', alias)
  return new Promise((resolve) => {
    execFile('ssh', args, { env: sshEnv(), timeout: 15_000 }, (err, _stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 255) : 0
      resolve({ code, stderr: String(stderr) })
    })
  })
}

// ---- running commands ----------------------------------------------------------

export interface SshRun {
  /** Process exit code; 255 means ssh itself failed. null when killed by the timeout. */
  code: number | null
  stdout: Buffer
  stderr: string
  timedOut: boolean
  ms: number
}

export interface RunOptions {
  timeoutMs?: number
  /** Bytes for the remote command's stdin. */
  input?: Buffer | string
  /** Local file streamed to the remote command's stdin. */
  inputFile?: string
  /** Cap on collected stdout; the run fails past it rather than buffering without bound. */
  maxBytes?: number
}

/** Run `command` (already a remote shell string) on `alias` with background options. */
export function sshRaw(alias: string, command: string, opts: RunOptions = {}): Promise<SshRun> {
  assertAlias(alias)
  const started = Date.now()
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024
  return new Promise((resolve) => {
    const child = spawn('ssh', [...backgroundOptions(), '--', alias, command], {
      env: sshEnv(),
      stdio: [opts.input !== undefined || opts.inputFile ? 'pipe' : 'ignore', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    let outLen = 0
    let err = ''
    let timedOut = false
    let overflow = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      // A multiplexed client passes its stdio fds to the ControlMaster, which
      // keeps them open until the remote command ends — so killing the client
      // alone would not fire 'close'. Drop our ends to finish now.
      child.stdout?.destroy()
      child.stderr?.destroy()
    }, opts.timeoutMs ?? 20_000)

    child.stdout!.on('data', (b: Buffer) => {
      outLen += b.length
      if (outLen > maxBytes) { overflow = true; child.kill('SIGKILL'); return }
      out.push(b)
    })
    child.stderr!.on('data', (b: Buffer) => { if (err.length < 64_000) err += b.toString('utf8') })

    if (child.stdin) {
      child.stdin.on('error', () => { /* remote closed early; the exit code says why */ })
      if (opts.inputFile) {
        const file = createReadStream(opts.inputFile)
        file.on('error', (e) => {
          err += `\npaper: cannot read ${opts.inputFile}: ${e.message}`
          child.kill('SIGKILL')
        })
        file.pipe(child.stdin)
      } else {
        child.stdin.end(opts.input)
      }
    }

    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 255, stdout: Buffer.alloc(0), stderr: `paper: could not run ssh: ${e.message}`, timedOut, ms: Date.now() - started })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (overflow) err += `\npaper: remote output exceeded ${maxBytes} bytes`
      resolve({ code: overflow ? 1 : code, stdout: Buffer.concat(out), stderr: err, timedOut, ms: Date.now() - started })
    })
  })
}

/** Run a POSIX script under the remote login shell (so the user's PATH applies). */
export function sshScript(alias: string, script: string, opts: RunOptions = {}): Promise<SshRun> {
  return sshRaw(alias, loginCommand(script), opts)
}

/** Delimit probe output so login-shell chatter (motd, echo in .bashrc) cannot be mistaken for data. */
export const MARK_BEGIN = '__PAPER_BEGIN__'
export const MARK_END = '__PAPER_END__'

export function between(stdout: Buffer | string): string {
  const s = stdout.toString()
  const a = s.indexOf(MARK_BEGIN)
  const b = s.lastIndexOf(MARK_END)
  if (a < 0 || b < a) return ''
  return s.slice(a + MARK_BEGIN.length, b).replace(/^\r?\n/, '')
}

// ---- files -----------------------------------------------------------------------

/**
 * Write a local file to `dest` on the remote, atomically, private (umask 077),
 * creating parent directories. `dest` may start with `~/`.
 */
export async function upload(alias: string, localFile: string, dest: string): Promise<void> {
  const script = [
    'set -e',
    'umask 077',
    `p=${remotePath(dest)}`,
    'mkdir -p "$(dirname "$p")"',
    'cat > "$p.paper-part"',
    'mv -f "$p.paper-part" "$p"'
  ].join('\n')
  const run = await sshRaw(alias, plainCommand(script), { inputFile: localFile, timeoutMs: 120_000 })
  if (run.code !== 0) throw sshError(alias, run, `upload ${dest}`)
}

/**
 * Read a remote file, optionally from a byte offset (for tailing a transcript).
 * Returns null when the file does not exist.
 */
export async function download(alias: string, src: string, offset = 0): Promise<Buffer | null> {
  const start = Math.max(0, Math.floor(offset)) + 1
  const script = [`p=${remotePath(src)}`, '[ -f "$p" ] || exit 3', `exec tail -c +${start} "$p"`].join('\n')
  const run = await sshRaw(alias, plainCommand(script), { timeoutMs: 120_000 })
  if (run.code === 3) return null
  if (run.code !== 0) throw sshError(alias, run, `download ${src}`)
  return run.stdout
}

// ---- resolution ----------------------------------------------------------------

/** What an alias points at, straight from `ssh -G` (so Include, Match and wildcards all apply). */
export function resolveTarget(alias: string): Promise<{ hostname: string; user: string; port: number }> {
  assertAlias(alias)
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-G', '--', alias], { env: sshEnv(), timeout: 5000 }, (err, stdout) => {
      if (err) return reject(err)
      const get = (k: string): string => stdout.match(new RegExp(`^${k} (.*)$`, 'm'))?.[1]?.trim() ?? ''
      resolve({ hostname: get('hostname') || alias, user: get('user'), port: Number(get('port')) || 22 })
    })
  })
}

/** Close the shared background connection for an alias (e.g. after the machine is removed). */
export function closeMaster(alias: string): Promise<void> {
  assertAlias(alias)
  return new Promise((resolve) => {
    execFile('ssh', [...backgroundOptions(), '-O', 'exit', '--', alias], { env: sshEnv(), timeout: 5000 }, () => resolve())
  })
}

// ---- failures --------------------------------------------------------------------

/** Turn an ssh-level failure (exit 255, timeout) into something a person can act on; null if ssh itself was fine. */
export function classify(alias: string, run: SshRun): MachineError | null {
  if (!run.timedOut && run.code !== 255) return null
  const e = run.stderr
  const detail = e.trim().split('\n').slice(-6).join('\n') || undefined
  const mk = (kind: MachineErrorKind, message: string, hint: string): MachineError => ({ kind, message, hint, detail })

  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(e)) {
    return mk('host-key', `${alias}'s host key has CHANGED`,
      `This can mean the server was rebuilt — or that someone is intercepting the connection. Confirm with whoever runs ${alias}, then fix ~/.ssh/known_hosts yourself. Paper will never accept a changed key.`)
  }
  if (/Host key verification failed|No .* host key is known|host key for .* is unknown/i.test(e)) {
    return mk('host-key', `${alias}'s host key is not trusted yet`,
      `Run \`ssh ${alias}\` once in a terminal and verify the fingerprint. Paper never accepts host keys on your behalf.`)
  }
  if (/Permission denied|Too many authentication failures|no mutual signature|Authentication failed/i.test(e)) {
    return mk('auth', `${alias} rejected the ssh login`,
      `Paper uses your own ssh setup and never stores keys. Make \`ssh -o BatchMode=yes ${alias} true\` succeed in a terminal — usually by loading your key into the agent with \`ssh-add\` — then retry.`)
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(e)) {
    return mk('dns', `${alias} does not resolve`, `Check the Host/HostName entry for ${alias} in ~/.ssh/config, and your network or VPN.`)
  }
  if (run.timedOut || /timed out/i.test(e)) {
    return mk('timeout', `${alias} did not answer`, `The machine may be stopped, asleep, or behind a VPN or bastion you are not connected to.`)
  }
  if (/Connection refused|No route to host|Network is unreachable|Connection closed by|Connection reset/i.test(e)) {
    return mk('unreachable', `Could not connect to ${alias}`, `Is the machine running and sshd up? Check your network or VPN.`)
  }
  return mk('unknown', `ssh to ${alias} failed`, `Try \`ssh ${alias}\` in a terminal to see what is wrong.`)
}

/** An Error carrying a MachineError, for callers that throw. */
export class MachineFailure extends Error {
  constructor(public readonly info: MachineError) {
    super(`${info.message}. ${info.hint}`)
  }
}

export function sshError(alias: string, run: SshRun, what: string): MachineFailure {
  return new MachineFailure(
    classify(alias, run) ?? {
      kind: 'unknown',
      message: `${what} on ${alias} failed (exit ${run.code})`,
      hint: 'See details.',
      detail: run.stderr.trim().split('\n').slice(-6).join('\n') || undefined
    }
  )
}

/**
 * An extra sentence for auth failures: is the local ssh-agent empty or absent?
 * (A passphrase-protected key that was never `ssh-add`ed is the usual cause.)
 */
export function localAgentHint(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('ssh-add', ['-l'], { env: sshEnv(), timeout: 3000 }, (err, stdout, stderr) => {
      const code = (err as (Error & { code?: number }) | null)?.code
      if (!err) return resolve(undefined)
      if (code === 1 || /no identities/i.test(String(stdout))) {
        return resolve('The ssh-agent Paper sees holds no keys. If your key has a passphrase, load it with `ssh-add <key>` in a terminal.')
      }
      if (code === 2 || /could not open a connection/i.test(String(stderr))) {
        return resolve('Paper cannot reach an ssh-agent (SSH_AUTH_SOCK from your login shell). Start one or launch Paper from a shell where ssh works.')
      }
      resolve(undefined)
    })
  })
}
