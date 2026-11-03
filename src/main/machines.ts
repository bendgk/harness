/**
 * The machine registry: remote computers agents may ssh into or be moved to.
 *
 * CONTRACT STUB — signatures are fixed (other modules build against them);
 * bodies are implemented by the machines work stream.
 */
import { EventEmitter } from 'node:events'
import type { AgentProviderId, Machine, MachineProbe } from '@shared/types'

/** Emits 'update' with the full Machine[] whenever the registry or a probe changes. */
export const machineEvents = new EventEmitter()

export function listMachines(): Machine[] {
  throw new Error('not implemented')
}

export function getMachine(_alias: string): Machine | undefined {
  throw new Error('not implemented')
}

/** The allowlist check: throws unless `alias` is a registered machine. */
export function requireMachine(_alias: string): Machine {
  throw new Error('not implemented')
}

export interface MachineInput {
  alias: string
  label?: string
  note?: string
  defaultCwd?: string
}

/** Validate, register and probe. Registers even when the probe fails (the error is on `probe`). */
export async function addMachine(_input: MachineInput): Promise<Machine> {
  throw new Error('not implemented')
}

export function updateMachine(_alias: string, _patch: Partial<Omit<MachineInput, 'alias'>>): Machine {
  throw new Error('not implemented')
}

export async function removeMachine(_alias: string): Promise<void> {
  throw new Error('not implemented')
}

/** Probe over ssh (BatchMode). Reuses a cached probe younger than `maxAgeMs` (default 0 = always fresh). */
export async function probeMachine(_alias: string, _opts?: { maxAgeMs?: number }): Promise<MachineProbe> {
  throw new Error('not implemented')
}

/**
 * Gate for launching an agent on a machine: registered, reachable, and the
 * provider CLI plus tmux installed. Throws MachineFailure (src/main/ssh.ts)
 * with a human-actionable hint otherwise. Never tries to install or log in.
 */
export async function ensureReady(_alias: string, _provider: AgentProviderId | 'shell'): Promise<MachineProbe> {
  throw new Error('not implemented')
}

/** Host aliases from ~/.ssh/config (and its Includes), for the "Add machine" picker. */
export async function suggestMachines(): Promise<{ alias: string; hostname?: string; user?: string; registered: boolean }[]> {
  throw new Error('not implemented')
}

/**
 * Text appended to a local agent's system prompt so it understands
 * `@alias` mentions and how to work on (or move itself to) a machine.
 * `sessionId` is the Paper session the prompt is for.
 */
export function machineContextPrompt(_opts: { sessionId: string; host: string }): string {
  throw new Error('not implemented')
}
