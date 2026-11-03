/**
 * Reading JSONL transcripts in pieces: bytes in, records folded into a
 * provider's TranscriptState, the trailing partial line carried to the next
 * read. Splitting on the byte 0x0A is safe in UTF-8 (it never occurs inside a
 * multi-byte character), so a chunk boundary can never corrupt a record.
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import type { Provider, TranscriptState } from './types'

const CHUNK = 4 * 1024 * 1024

/**
 * Fold every complete line of `carry + chunk` into `state` and return the
 * incomplete tail (empty buffer when the chunk ended on a newline). With
 * `final`, the tail is parsed too — for a whole-file read that will not continue.
 */
export function foldChunk(provider: Provider, state: TranscriptState, carry: Buffer | null, chunk: Buffer, final = false): Buffer {
  const buf = carry && carry.length ? Buffer.concat([carry, chunk]) : chunk
  let start = 0
  for (let nl = buf.indexOf(10, start); nl !== -1; nl = buf.indexOf(10, start)) {
    foldLine(provider, state, buf.toString('utf8', start, nl))
    start = nl + 1
  }
  if (final) {
    if (start < buf.length) foldLine(provider, state, buf.toString('utf8', start))
    return Buffer.alloc(0)
  }
  // Copy, so a small tail does not pin a 4 MB chunk in memory.
  return Buffer.from(buf.subarray(start))
}

function foldLine(provider: Provider, state: TranscriptState, line: string): void {
  if (!line) return
  let rec: unknown
  try { rec = JSON.parse(line) } catch { return }
  if (rec && typeof rec === 'object') provider.fold(state, rec)
}

/**
 * Read `path` from `offset` up to `size` (at most `budget` bytes), folding as it
 * goes. Returns the new offset and carry; the caller keeps both for next time.
 */
export function readFrom(
  provider: Provider,
  state: TranscriptState,
  path: string,
  at: { offset: number; carry: Buffer | null },
  size: number,
  budget = Infinity
): { offset: number; carry: Buffer | null; read: number } {
  let { offset, carry } = at
  let read = 0
  const fd = openSync(path, 'r')
  try {
    while (offset < size && read < budget) {
      const n = Math.min(CHUNK, size - offset, budget - read)
      const buf = Buffer.allocUnsafe(n)
      const got = readSync(fd, buf, 0, n, offset)
      if (!got) break
      offset += got
      read += got
      carry = foldChunk(provider, state, carry, got === n ? buf : buf.subarray(0, got))
    }
  } finally {
    closeSync(fd)
  }
  return { offset, carry, read }
}

/** The whole file at once (handoff, rebinding, older transcript pages). */
export function readWhole(provider: Provider, path: string, keep?: number): TranscriptState {
  const state = provider.newState(keep)
  if (!existsSync(path)) return state
  const at = readFrom(provider, state, path, { offset: 0, carry: null }, Number.MAX_SAFE_INTEGER)
  if (at.carry && at.carry.length) foldChunk(provider, state, at.carry, Buffer.alloc(0), true)
  return state
}

/** Fold an in-memory tail (e.g. the last 512 KB of a remote transcript). `partial` drops the cut-off first line. */
export function foldTail(provider: Provider, buf: Buffer, partial: boolean, keep?: number): TranscriptState {
  const state = provider.newState(keep)
  let body = buf
  if (partial) {
    const nl = buf.indexOf(10)
    body = nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1)
  }
  foldChunk(provider, state, null, body, true)
  return state
}
