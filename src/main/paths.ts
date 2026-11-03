import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/** Everything Paper owns lives under ~/.paper so accounts survive reinstalls. */
export const PAPER_HOME = process.env.PAPER_HOME || join(homedir(), '.paper')
export const ACCOUNTS_DIR = join(PAPER_HOME, 'accounts')
export const STATE_FILE = join(PAPER_HOME, 'state.json')
export const LOG_DIR = join(PAPER_HOME, 'logs')

export function ensureDirs(): void {
  for (const d of [PAPER_HOME, ACCOUNTS_DIR, LOG_DIR]) mkdirSync(d, { recursive: true })
}

/** The user's real CLI homes, used to seed the first account of each provider. */
export const SYSTEM_CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
export const SYSTEM_CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex')

export function accountHome(id: string): string {
  return join(ACCOUNTS_DIR, id)
}

export function userDataFile(name: string): string {
  return join(app.getPath('userData'), name)
}
