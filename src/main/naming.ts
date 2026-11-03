import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { providerFor } from './providers'
import { agentEnv } from './shell-env'
import type { Account, ProviderId } from '@shared/types'

const TITLE_PROMPT =
  'Summarise the following coding request as a tab title of 2 to 4 words. ' +
  'Reply with the title only: no quotes, no punctuation, no preamble.\n\nRequest: '

/** Pull the first human turn out of either CLI's transcript format. */
export function firstUserPrompt(provider: ProviderId, path: string): string | undefined {
  if (!existsSync(path)) return undefined
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    let rec: any
    try { rec = JSON.parse(line) } catch { continue }

    if (provider === 'claude') {
      if (rec.type !== 'user' || rec.isSidechain) continue
      const content = rec.message?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ')
          : ''
      const clean = stripNoise(text)
      if (clean) return clean
    } else {
      const p = rec.payload
      const isUserTurn =
        (rec.type === 'response_item' && p?.type === 'message' && p?.role === 'user') ||
        (rec.type === 'event_msg' && p?.type === 'user_message')
      if (!isUserTurn) continue
      const text = typeof p.message === 'string'
        ? p.message
        : Array.isArray(p.content)
          ? p.content.map((c: any) => c.text ?? '').join(' ')
          : ''
      const clean = stripNoise(text)
      if (clean) return clean
    }
  }
  return undefined
}

/** Drop the machinery both CLIs inject around a real user turn. */
function stripNoise(text: string): string {
  const t = (text || '')
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return ''
  if (/^(caveat|system-reminder|<command|\[request interrupted)/i.test(t)) return ''
  return t.slice(0, 600)
}

/** Title-case a few words pulled straight from the prompt, as a safe fallback. */
export function heuristicTitle(text: string): string {
  const stop = new Set([
    'the','a','an','and','or','but','to','of','in','on','for','with','my','me','i','please','can','you',
    'it','is','are','this','that','be','do','make','so','if','at','as','we','need','want','just','now'
  ])
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w))
    .slice(0, 4)
  if (!words.length) return 'New session'
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
}

const MAX_TITLE_WORDS = 5

function sanitize(raw: string): string | undefined {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('{') && !l.startsWith('['))
    .pop()
  if (!line) return undefined
  const cleaned = line.replace(/^["'`\s]+|["'`.\s]+$/g, '').replace(/\s+/g, ' ')
  if (!cleaned || cleaned.length > 60) return undefined
  return cleaned.split(' ').slice(0, MAX_TITLE_WORDS).join(' ')
}

/**
 * Ask the same CLI that is running the session to name it. Cheap model, short
 * timeout — a tab title is never worth blocking or spending real money on.
 */
export function aiTitle(account: Account, prompt: string, timeoutMs = 25_000): Promise<string> {
  const provider = providerFor(account.provider)
  const plan = provider.oneShot({
    home: account.home,
    cwd: process.env.HOME || '/',
    prompt: TITLE_PROMPT + prompt
  })
  return new Promise((resolve, reject) => {
    execFile(
      plan.file,
      plan.args,
      { env: { ...agentEnv(), ...plan.env }, timeout: timeoutMs, maxBuffer: 1 << 20 },
      (err, stdout) => {
        const title = sanitize(stdout || '')
        if (title) return resolve(title)
        reject(err || new Error('no usable title'))
      }
    )
  })
}
