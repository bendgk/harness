import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, dirname, basename } from 'node:path'
import type { DirComplete, DirEntry } from '@shared/types'

/** Expand `~`, resolve `..`, and interpret relative input against `from`. */
export function resolvePath(input: string, from: string): string {
  let text = input.trim()
  if (!text) return from
  if (text === '~') return homedir()
  if (text.startsWith('~/')) text = join(homedir(), text.slice(2))
  return isAbsolute(text) ? resolve(text) : resolve(from, text)
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

/** Longest shared prefix, so Tab behaves the way a shell's Tab behaves. */
function commonPrefix(names: string[]): string {
  if (!names.length) return ''
  let prefix = names[0]
  for (const name of names.slice(1)) {
    let i = 0
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++
    prefix = prefix.slice(0, i)
    if (!prefix) break
  }
  return prefix
}

/**
 * Directory completion for the location bar.
 *
 * The input is split the way a shell splits it: everything up to the last
 * separator is the directory to list, the remainder is the fragment to match.
 * A trailing slash therefore lists the directory's contents rather than
 * re-matching its own name.
 */
export function completeDir(input: string, from: string, limit = 60): DirComplete {
  const text = input.trim()
  const endsWithSep = text.endsWith('/')
  const head = endsWithSep ? text : text.slice(0, text.lastIndexOf('/') + 1)
  const fragment = endsWithSep ? '' : text.slice(text.lastIndexOf('/') + 1)

  const base = text === '' ? from : resolvePath(head || './', from)
  const resolved = resolvePath(text || '.', from)

  let names: string[] = []
  if (isDir(base)) {
    try {
      names = readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name)
        .filter((n) => !n.startsWith('.') || fragment.startsWith('.'))
        .filter((n) => isDir(join(base, n)))
    } catch {
      names = []
    }
  }

  const lower = fragment.toLowerCase()
  const starts = names.filter((n) => n.toLowerCase().startsWith(lower))
  // Fall back to a looser match so a half-remembered name still finds its folder.
  const contains = lower
    ? names.filter((n) => !starts.includes(n) && n.toLowerCase().includes(lower))
    : []
  const ordered = [...starts.sort(sortNames), ...contains.sort(sortNames)].slice(0, limit)

  const entries: DirEntry[] = ordered.map((name) => ({
    name,
    path: join(base, name),
    repo: existsSync(join(base, name, '.git'))
  }))

  return {
    base,
    entries,
    common: starts.length ? commonPrefix(starts) : '',
    exact: isDir(resolved),
    resolved
  }
}

function sortNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

/** Label a directory for display: `~/work/harness`. */
export function prettyPath(p: string): string {
  const home = homedir()
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p
}

export function dirInfo(p: string): { exists: boolean; repo: boolean; name: string; parent: string } {
  return {
    exists: isDir(p),
    repo: existsSync(join(p, '.git')),
    name: basename(p) || p,
    parent: dirname(p)
  }
}
