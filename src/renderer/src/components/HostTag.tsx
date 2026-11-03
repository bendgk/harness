import { LOCAL_HOST, type SessionMeta } from '@shared/types'
import { useStore } from '../state/store'
import type { MachineHealth } from '../lib/machines'

/** The blue `@alias` chip — the one visual every machine reference shares. */
export function AliasChip({ alias, size, title, onClick }: {
  alias: string
  size?: 'sm' | 'md'
  title?: string
  onClick?: (e: React.MouseEvent) => void
}): JSX.Element {
  const cls = `alias-chip mono ${size === 'md' ? 'alias-md' : ''} ${onClick ? 'alias-click' : ''}`
  return onClick
    ? <button className={cls} title={title} onClick={onClick}>@{alias}</button>
    : <span className={cls} title={title}>@{alias}</span>
}

export function HealthDot({ health, busy, title }: { health: MachineHealth; busy?: boolean; title?: string }): JSX.Element {
  return <span className={`mdot mdot-${health} ${busy ? 'mdot-busy' : ''}`} title={title} />
}

const LINK_TEXT: Record<NonNullable<SessionMeta['remote']>['link'], string> = {
  connecting: 'connecting over ssh…',
  attached: 'attached',
  reconnecting: 'connection dropped — reconnecting…',
  lost: 'connection lost — the agent keeps running in tmux on the machine; restart (⌘R) to re-attach'
}

/**
 * Where a session runs. Local sessions show nothing (that is the default);
 * remote ones wear the blue tag, which also carries the ssh link state:
 * a pulse while (re)connecting, red when lost.
 */
export default function HostTag({ meta, onClick }: { meta: SessionMeta; onClick?: () => void }): JSX.Element | null {
  const machine = useStore((s) => s.machines.find((m) => m.alias === meta.host))
  if (!meta.host || meta.host === LOCAL_HOST) return null
  const link = meta.remote?.link ?? 'attached'
  const where = machine?.label ? `${machine.label} (@${meta.host})` : `@${meta.host}`
  const title = `Running on ${where} · ${LINK_TEXT[link]}${onClick ? ' — click for machine details' : ''}`
  return (
    <span className={`host-tag link-${link}`} title={title}>
      {link !== 'attached' && <span className="host-link" aria-hidden="true" />}
      <AliasChip
        alias={meta.host}
        onClick={onClick ? (e) => { e.stopPropagation(); onClick() } : undefined}
      />
    </span>
  )
}

/** A faint marker for sessions brought back after Paper restarted. */
export function RestoredHint({ meta }: { meta: SessionMeta }): JSX.Element | null {
  if (!meta.restoredAt) return null
  const at = new Date(meta.restoredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return <span className="restored-hint" title={`Re-attached after Paper restarted (${at})`}>restored</span>
}

