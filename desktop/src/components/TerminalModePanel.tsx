import { useState, useEffect, useCallback } from 'react'
import { Server, MonitorSmartphone, Wifi, WifiOff, AlertTriangle, Check } from 'lucide-react'
import './TerminalModePanel.css'

interface Props { userId: number }

type Mode = 'server' | 'client'

interface Status {
    mode: Mode
    serverUrl: string
    isClient: boolean
    connected: boolean
    lastError: string
}

/**
 * Serveur / poste client.
 *
 * The setting that decides where this box's data comes from, so it is stated in
 * full rather than hidden behind a toggle: on a client, EVERY figure on screen is
 * the server's, and if the server is unreachable the till stops selling instead of
 * answering from its own empty database.
 */
export function TerminalModePanel({ userId }: Props) {
    const [status, setStatus] = useState<Status | null>(null)
    const [mode, setMode] = useState<Mode>('server')
    const [serverUrl, setServerUrl] = useState('')
    const [token, setToken] = useState('')
    const [ownToken, setOwnToken] = useState('')
    const [localIp, setLocalIp] = useState('')
    const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const load = useCallback(async () => {
        const s = await window.electron.rpc.status()
        setStatus(s)
        setMode(s.mode)
        setServerUrl(s.serverUrl)
        // Only useful on a server, but harmless to read either way.
        window.electron?.getSyncToken?.().then(setOwnToken).catch(() => {})
        window.electron?.getLocalIP?.().then(setLocalIp).catch(() => {})
    }, [])

    useEffect(() => { load() }, [load])

    // A client's connection state is the single most important thing on this
    // screen, so it is re-probed while the panel is open rather than shown stale.
    useEffect(() => {
        if (!status?.isClient) return
        const t = setInterval(() => {
            window.electron.rpc.status().then(setStatus).catch(() => {})
        }, 15_000)
        return () => clearInterval(t)
    }, [status?.isClient])

    const runTest = async () => {
        setBusy(true); setTest(null)
        try {
            setTest(await window.electron.rpc.testConnection(serverUrl, token))
        } finally { setBusy(false) }
    }

    const save = async () => {
        if (mode === 'client' && (!serverUrl.trim() || !token.trim())) {
            setError('Adresse du serveur et jeton sont obligatoires en mode poste client.')
            return
        }
        setBusy(true); setError('')
        try {
            const res = await window.electron.rpc.setMode(mode, serverUrl.trim(), token.trim(), userId)
            if (!res.ok) { setError(res.message); return }
            await load()
        } finally { setBusy(false) }
    }

    return (
        <div className="tmp">
            <div className="tmp-head">
                <h3>Rôle de ce poste</h3>
                {status && (
                    <span className={`tmp-status ${status.isClient ? (status.connected ? 'online' : 'offline') : 'server'}`}>
                        {status.isClient
                            ? (status.connected ? <><Wifi size={14} /> En ligne</> : <><WifiOff size={14} /> Hors ligne</>)
                            : <><Server size={14} /> Serveur</>}
                    </span>
                )}
            </div>

            {status?.isClient && !status.connected && (
                <div className="tmp-alert" role="alert">
                    <AlertTriangle size={16} />
                    <div>
                        <strong>Serveur injoignable — la vente est impossible</strong>
                        <p>
                            Ce poste ne conserve aucune donnée : tout vient du serveur du magasin.
                            Rien n’est mis en file d’attente, car deux caisses vendant hors ligne
                            le même article finiraient par le vendre deux fois.
                            {status.lastError && ` (${status.lastError})`}
                        </p>
                    </div>
                </div>
            )}

            <div className="tmp-modes">
                <button className={`tmp-mode ${mode === 'server' ? 'active' : ''}`} onClick={() => setMode('server')}>
                    <Server size={18} />
                    <strong>PC serveur</strong>
                    <span>Contient la base de données du magasin et répond aux autres caisses.</span>
                </button>
                <button className={`tmp-mode ${mode === 'client' ? 'active' : ''}`} onClick={() => setMode('client')}>
                    <MonitorSmartphone size={18} />
                    <strong>Poste client</strong>
                    <span>N’a pas de base propre : lit et écrit sur le PC serveur du magasin.</span>
                </button>
            </div>

            {mode === 'server' ? (
                <div className="tmp-server-info">
                    <p>
                        Les autres caisses de ce magasin se connectent à ce PC avec l’adresse et le
                        jeton ci-dessous.
                    </p>
                    <div className="tmp-pair">
                        <label>
                            <span>Adresse de ce serveur</span>
                            <code>http://{localIp || '…'}:4000</code>
                        </label>
                        <label>
                            <span>Jeton d’appairage</span>
                            {/* Shown deliberately: it is the secret the other tills need, and
                                the owner has to be able to read it off this screen. */}
                            <code className="tmp-token">{ownToken || '…'}</code>
                        </label>
                    </div>
                </div>
            ) : (
                <div className="tmp-client-form">
                    <label>
                        <span>Adresse du PC serveur</span>
                        <input value={serverUrl} onChange={e => setServerUrl(e.target.value)}
                            placeholder="http://192.168.1.20:4000" />
                    </label>
                    <label>
                        <span>Jeton d’appairage</span>
                        <input value={token} onChange={e => setToken(e.target.value)}
                            placeholder="Copié depuis le PC serveur" />
                    </label>
                    <button className="tmp-ghost" onClick={runTest} disabled={busy || !serverUrl.trim() || !token.trim()}>
                        {busy ? 'Test…' : 'Tester la connexion'}
                    </button>
                    {test && (
                        <p className={`tmp-test ${test.ok ? 'ok' : 'bad'}`}>
                            {test.ok ? <Check size={14} /> : <AlertTriangle size={14} />} {test.message}
                        </p>
                    )}
                </div>
            )}

            {error && <p className="tmp-error"><AlertTriangle size={14} /> {error}</p>}

            <div className="tmp-actions">
                <button className="tmp-primary" onClick={save} disabled={busy}>
                    {busy ? 'Enregistrement…' : 'Enregistrer le rôle'}
                </button>
            </div>
        </div>
    )
}
