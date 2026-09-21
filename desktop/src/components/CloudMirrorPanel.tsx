import { useState, useEffect, useCallback } from 'react'
import { CloudUpload, Check, AlertTriangle, RefreshCw } from 'lucide-react'
import { formatDateTime } from '../utils/formatters'
import './CloudMirrorPanel.css'

interface Props { userId: number }

interface Status {
    configured: boolean
    enabled: boolean
    url: string
    shopId: string
    entities: {
        entity: string
        last_id: number
        last_at: string | null
        last_success_at: string | null
        last_error: string | null
        rows_pushed: number
    }[]
    pendingTotal: Record<string, number>
}

const ENTITY_LABEL: Record<string, string> = {
    sales: 'Ventes', returns: 'Retours', products: 'Produits', stock: 'Stock',
}

/**
 * Miroir central (site web).
 *
 * One-way and downstream: the shop's SQLite stays the system of record and nothing
 * is ever read back. Said on screen, because an owner who believed this was a
 * two-way sync would eventually edit a price on the website and wonder why the till
 * disagreed.
 */
export function CloudMirrorPanel({ userId }: Props) {
    const [status, setStatus] = useState<Status | null>(null)
    const [url, setUrl] = useState('')
    const [shopId, setShopId] = useState('')
    const [secret, setSecret] = useState('')
    const [hasSecret, setHasSecret] = useState(false)
    const [enabled, setEnabled] = useState(false)
    const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
    const [result, setResult] = useState<string>('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const load = useCallback(async () => {
        const [s, cfg] = await Promise.all([
            window.electron.cloudMirror.status(),
            window.electron.cloudMirror.getConfig(),
        ])
        setStatus(s)
        setUrl(cfg.url); setShopId(cfg.shopId); setEnabled(cfg.enabled); setHasSecret(cfg.hasSecret)
    }, [])

    useEffect(() => { load() }, [load])

    const save = async () => {
        setBusy(true); setError('')
        try {
            const res = await window.electron.cloudMirror.setConfig({
                url: url.trim(),
                shopId: shopId.trim(),
                enabled,
                // Blank means "leave the stored key alone" — otherwise saving any
                // other field would silently wipe a secret the user cannot see.
                ...(secret.trim() ? { secret: secret.trim() } : {}),
            }, userId)
            if (!res.ok) { setError(res.message); return }
            setSecret('')
            await load()
        } finally { setBusy(false) }
    }

    const run = async () => {
        setBusy(true); setError(''); setResult('')
        try {
            const res = await window.electron.cloudMirror.run(userId)
            if (!res.ok) { setError(res.message); return }
            const sent = Object.entries(res.data.totals)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${n} ${ENTITY_LABEL[k] ?? k}`)
                .join(', ')
            setResult(sent ? `Envoyé : ${sent}.` : 'Rien de nouveau à envoyer.')
            await load()
        } finally { setBusy(false) }
    }

    const pending = status ? Object.values(status.pendingTotal).reduce((a, b) => a + b, 0) : 0

    return (
        <section className="cmp">
            <div className="cmp-head">
                <h3><CloudUpload size={16} /> Miroir central (site web)</h3>
                {status?.configured && (
                    <span className={`cmp-badge ${status.enabled ? 'on' : 'off'}`}>
                        {status.enabled ? 'Actif' : 'Inactif'}
                    </span>
                )}
            </div>

            <p className="cmp-note">
                Envoi <strong>à sens unique</strong> : les ventes, retours, produits et stocks partent
                vers la base PostgreSQL du site. Rien n’est relu — la base du magasin reste la
                référence. Une modification faite sur le site ne remontera jamais ici.
            </p>

            <div className="cmp-form">
                <label className="grow">
                    <span>Adresse du point d’entrée</span>
                    <input value={url} onChange={e => setUrl(e.target.value)}
                        placeholder="https://boutique.dz/api/dapper-push" />
                </label>
                <label>
                    <span>Identifiant boutique</span>
                    <input value={shopId} onChange={e => setShopId(e.target.value)} placeholder="dapper" />
                </label>
                <label>
                    <span>Clé partagée {hasSecret && <em>(enregistrée)</em>}</span>
                    <input type="password" value={secret} onChange={e => setSecret(e.target.value)}
                        placeholder={hasSecret ? 'Laisser vide pour conserver' : 'Clé du site'} />
                </label>
                <label className="cmp-check">
                    <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
                    <span>Activer l’envoi</span>
                </label>
            </div>

            <div className="cmp-actions">
                <button className="cmp-ghost" onClick={async () => setTest(await window.electron.cloudMirror.test())} disabled={busy}>
                    Tester
                </button>
                <button className="cmp-ghost" onClick={run} disabled={busy || !status?.configured}>
                    <RefreshCw size={14} className={busy ? 'spin' : ''} /> Envoyer maintenant
                </button>
                <button className="cmp-primary" onClick={save} disabled={busy}>
                    {busy ? 'Enregistrement…' : 'Enregistrer'}
                </button>
            </div>

            {test && (
                <p className={`cmp-msg ${test.ok ? 'ok' : 'bad'}`}>
                    {test.ok ? <Check size={14} /> : <AlertTriangle size={14} />} {test.message}
                </p>
            )}
            {result && <p className="cmp-msg ok"><Check size={14} /> {result}</p>}
            {error && <p className="cmp-msg bad"><AlertTriangle size={14} /> {error}</p>}

            {status && status.entities.length > 0 && (
                <table className="cmp-table">
                    <thead>
                        <tr>
                            <th>Données</th><th className="num">En attente</th>
                            <th className="num">Envoyées</th><th>Dernier envoi</th><th>Erreur</th>
                        </tr>
                    </thead>
                    <tbody>
                        {status.entities.map(e => (
                            <tr key={e.entity}>
                                <td>{ENTITY_LABEL[e.entity] ?? e.entity}</td>
                                {/* Pending tells "quiet" from "stuck": zero waiting with an old
                                    last-sent is a calm shop; a growing queue is a problem. */}
                                <td className={`num ${(status.pendingTotal[e.entity] ?? 0) > 0 ? 'waiting' : 'muted'}`}>
                                    {status.pendingTotal[e.entity] ?? 0}
                                </td>
                                <td className="num muted">{e.rows_pushed}</td>
                                <td className="muted">{e.last_success_at ? formatDateTime(e.last_success_at) : '—'}</td>
                                <td className="cmp-err">{e.last_error ?? ''}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {status?.configured && pending > 0 && (
                <p className="cmp-note">{pending} enregistrement(s) en attente d’envoi.</p>
            )}
        </section>
    )
}
