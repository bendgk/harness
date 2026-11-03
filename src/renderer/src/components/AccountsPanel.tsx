import { useEffect, useState } from 'react'
import Modal from './Modal'
import { useStore } from '../state/store'
import type { AgentProviderId } from '@shared/types'

const api = window.paper

/** Account management: add, sign in, sign out, retire. Each has its own CLI home. */
export default function AccountsPanel(): JSX.Element {
  const accounts = useStore((s) => s.accounts)
  const defaults = useStore((s) => s.defaults)
  const setOverlay = useStore((s) => s.setOverlay)
  const refresh = useStore((s) => s.refreshAccounts)
  const notify = useStore((s) => s.notify)
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [provider, setProvider] = useState<AgentProviderId>('claude')
  const [adopt, setAdopt] = useState(false)
  const [importable, setImportable] = useState<Partial<Record<AgentProviderId, boolean>>>({})

  // Only offer to import a login that actually exists on this machine.
  useEffect(() => {
    void Promise.all(
      (['claude', 'codex'] as AgentProviderId[]).map(async (p) => [p, await api.accounts.systemLoginAvailable(p)] as const)
    ).then((pairs) => setImportable(Object.fromEntries(pairs)))
  }, [])

  const add = async (): Promise<void> => {
    const name = label.trim() || `account ${accounts.length + 1}`
    await api.accounts.create({ provider, label: name, adoptSystem: adopt })
    setLabel('')
    setAdding(false)
    await refresh()
    notify(adopt ? `Added ${name} from your system login` : `Added ${name} — sign in to use it`)
  }

  return (
    <Modal
      title="Accounts"
      subtitle="Each account keeps its own CLI config home, so logins never collide"
      onClose={() => setOverlay(null)}
      wide
    >
      <div className="acct-list">
        {accounts.map((a) => (
          <div key={a.id} className="acct-row">
            <span className="acct-swatch lg" style={{ background: a.color }} />
            <div className="acct-main">
              <div className="acct-name">
                {a.label}
                {defaults.accountByProvider[a.provider] === a.id && <span className="acct-badge">default</span>}
              </div>
              <div className="acct-sub mono">
                {a.provider === 'claude' ? 'Claude Code' : 'Codex'}
                {a.plan ? ` · ${a.plan}` : ''}
                {a.authed ? '' : ' · signed out'}
              </div>
            </div>
            <div className="acct-actions">
              {!a.authed && (
                <button className="ghost-btn tiny" onClick={async () => {
                  await api.accounts.login(a.id)
                  setOverlay(null)
                  notify(`Opened a sign-in session for ${a.label}`)
                }}>sign in</button>
              )}
              {!a.authed && importable[a.provider] && (
                <button
                  className="ghost-btn tiny"
                  title={a.provider === 'claude'
                    ? 'Copies your existing login out of the macOS Keychain (it will ask for approval)'
                    : 'Copies your existing Codex login'}
                  onClick={async () => {
                    const ok = await api.accounts.importSystemLogin(a.id)
                    await refresh()
                    notify(ok ? `Imported your system login into ${a.label}` : 'Could not read the system login', ok ? 'ok' : 'warn')
                  }}
                >import login</button>
              )}
              <button className="ghost-btn tiny" onClick={async () => {
                await api.accounts.setDefault(a.provider, a.id)
                notify(`${a.label} is the default ${a.provider} account`)
              }}>make default</button>
              <button className="ghost-btn tiny" onClick={async () => {
                const next = prompt('Rename account', a.label)
                if (next) { await api.accounts.rename(a.id, next); await refresh() }
              }}>rename</button>
              <button className="ghost-btn tiny" onClick={() => void api.revealHome(a.id)}>reveal</button>
              {a.authed && (
                <button className="ghost-btn tiny" onClick={async () => {
                  await api.accounts.signOut(a.id)
                  await refresh()
                  notify(`Signed ${a.label} out`)
                }}>sign out</button>
              )}
              <button className="ghost-btn tiny danger" onClick={async () => {
                if (!confirm(`Remove "${a.label}"? Its stored login and settings are deleted.`)) return
                await api.accounts.remove(a.id, true)
                await refresh()
              }}>remove</button>
            </div>
          </div>
        ))}
        {!accounts.length && <p className="sheet-note">No accounts yet.</p>}
      </div>

      {adding ? (
        <div className="acct-add fade-in">
          <div className="seg">
            {(['claude', 'codex'] as AgentProviderId[]).map((p) => (
              <button
                key={p}
                className={`seg-btn ${provider === p ? 'seg-on' : ''}`}
                onClick={() => setProvider(p)}
              >
                {p === 'claude' ? 'Claude Code' : 'Codex'}
              </button>
            ))}
          </div>
          <input
            className="text-input mono"
            placeholder="label — e.g. work, personal, max"
            value={label}
            autoFocus
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
          />
          {importable[provider] && (
            <label className="check">
              <input type="checkbox" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} />
              {provider === 'claude'
                ? 'copy my existing login from the Keychain (macOS will ask)'
                : 'copy my existing Codex login'}
            </label>
          )}
          <div className="acct-add-actions">
            <button className="ghost-btn" onClick={() => setAdding(false)}>cancel</button>
            <button className="solid-btn" onClick={() => void add()}>add account</button>
          </div>
        </div>
      ) : (
        <button className="ghost-btn wide" onClick={() => setAdding(true)}>+ add account</button>
      )}
    </Modal>
  )
}
