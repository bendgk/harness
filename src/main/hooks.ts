/**
 * The @mention hook: when the user's prompt to a Claude session names another
 * Paper agent (`@leonardo`) or a machine (`@g6e`), Claude Code's
 * `UserPromptSubmit` hook fetches a one-line-per-mention brief from Paper and
 * prints it, which Claude Code adds to the context before the model sees the
 * prompt. Verified on Claude Code 2.1.317: plain stdout on exit 0 becomes
 * context, and hooks given with `--settings <json>` are merged with the
 * user's, project and local hooks rather than replacing them.
 *
 * The script is POSIX sh with grep/sed/tr/sort/head/paste/curl only (no jq),
 * always exits 0, never blocks or alters the prompt, and prints nothing unless
 * a mention resolves. It never sees more than names: Paper decides what a name
 * means and what to say about it.
 *
 *   local:  GET $PAPER_MCP_URL/../agents/brief?names=a,b&from=$PAPER_SESSION   (loopback, open like /mcp)
 *   remote: GET <gateway url>/agents/brief, bearer token read with sed from the session's
 *           0600 MCP config (~/.paper/run/$PAPER_SESSION.json) and handed to curl on stdin
 *           (`-H @-`), so it is never in argv or the environment.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { PAPER_HOME } from './paths'
import { shq, upload } from './ssh'

export const MENTION_SCRIPT = `#!/bin/sh
# Paper @mention hook (Claude Code UserPromptSubmit). Prints a brief on the Paper
# agents/machines the prompt mentions; prints nothing otherwise. Always exits 0.
in=$(cat 2>/dev/null) || exit 0
# JSON escapes (\\n, \\t) would glue a mention to the letter before it.
names=$(printf '%s' "$in" | sed 's/\\\\[nrt]/ /g' \\
  | grep -oE '(^|[^A-Za-z0-9_@./-])@[A-Za-z][A-Za-z0-9._-]{1,63}' 2>/dev/null \\
  | sed 's/^[^@]*@//; s/[._-]*$//' | tr 'A-Z' 'a-z' | sort -u | head -n 8 | paste -sd, - 2>/dev/null)
[ -n "$names" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
if [ -n "\${PAPER_HOST:-}" ]; then
  cfg="$HOME/.paper/run/\${PAPER_SESSION:-none}.json"
  [ -r "$cfg" ] || exit 0
  url=$(sed -n 's/.*"url":"\\(http[^"]*\\)\\/mcp".*/\\1/p' "$cfg")
  tok=$(sed -n 's/.*"Bearer \\([A-Za-z0-9_-]*\\)".*/\\1/p' "$cfg")
  [ -n "$url" ] && [ -n "$tok" ] || exit 0
  printf 'Authorization: Bearer %s\\n' "$tok" | curl -fsS -m 2 -G -H @- \\
    --data-urlencode "names=$names" --data-urlencode "from=\${PAPER_SESSION:-}" "$url/agents/brief" 2>/dev/null
else
  base=\${PAPER_MCP_URL%/mcp}
  [ -n "$base" ] || exit 0
  curl -fsS -m 2 -G --data-urlencode "names=$names" --data-urlencode "from=\${PAPER_SESSION:-}" "$base/agents/brief" 2>/dev/null
fi
exit 0
`

/** Where the script lives on a machine, next to the session MCP configs (dir 0700). */
export const REMOTE_SCRIPT = '~/.paper/run/paper-mention.sh'

function settingsFor(command: string): string {
  return JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 5 }] }] } })
}

const localScript = (): string => join(PAPER_HOME, 'hooks', 'paper-mention.sh')

/** Write the local script if it is missing or stale (0700, atomic). */
function ensureLocalScript(): string {
  const path = localScript()
  let current = ''
  try { current = readFileSync(path, 'utf8') } catch { /* first time */ }
  if (current !== MENTION_SCRIPT) {
    mkdirSync(join(PAPER_HOME, 'hooks'), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${randomBytes(4).toString('hex')}`
    writeFileSync(tmp, MENTION_SCRIPT, { mode: 0o700 })
    chmodSync(tmp, 0o700)
    renameSync(tmp, path)
  }
  return path
}

/** `--settings` JSON for a local Claude session, or undefined if the script cannot be written. */
export function localHookSettings(): string | undefined {
  try {
    return settingsFor(`sh ${shq(ensureLocalScript())}`)
  } catch (err) {
    console.warn('[hooks] could not write the mention hook:', (err as Error).message)
    return undefined
  }
}

/** `--settings` JSON for a Claude session on a machine (the script is uploaded by `ensureRemoteScript`). */
export function remoteHookSettings(): string {
  return settingsFor('sh "$HOME/.paper/run/paper-mention.sh"')
}

/** Aliases whose script this process already uploaded (the script only changes with Paper's code). */
const uploaded = new Map<string, string>()

/** Upload the hook script to a machine, once per process and script version. Best effort. */
export async function ensureRemoteScript(alias: string): Promise<void> {
  if (uploaded.get(alias) === MENTION_SCRIPT) return
  const dir = join(PAPER_HOME, 'run')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `mention.${randomBytes(4).toString('hex')}.sh`)
  try {
    writeFileSync(tmp, MENTION_SCRIPT, { mode: 0o700 })
    await upload(alias, tmp, REMOTE_SCRIPT, { executable: true })
    uploaded.set(alias, MENTION_SCRIPT)
  } finally {
    rmSync(tmp, { force: true })
  }
}
