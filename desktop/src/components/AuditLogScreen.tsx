import { useState, useEffect, useCallback } from 'react'
import { ShieldCheck, Search, ChevronLeft, ChevronRight, Lock } from 'lucide-react'
import { formatDateTime } from '../utils/formatters'
import type { AuditLogRow } from '../vite-env'
import './AuditLogScreen.css'

interface Props { userId: number }

const PAGE = 50

/** Human labels for the action codes the services emit. Unknown codes fall
 *  through to the raw string rather than being hidden — a new sensitive action
 *  must never become invisible just because nobody added a translation. */
const ACTION_LABELS: Record<string, string> = {
    'sale.refund': 'Remboursement',
    'sale.exchange': 'Échange',
    'inventory.adjust': 'Ajustement de stock',
    'store.create': 'Magasin créé',
    'store.update': 'Magasin modifié',
    'store.deactivate': 'Magasin désactivé',
    'store.switch_device': 'Magasin du poste changé',
    'terminal.register': 'Caisse enregistrée',
    'user.set_stores': 'Magasins d’un employé modifiés',
    'permissions.change_role': 'Permissions d’un rôle modifiées',
    'permissions.change_limits': 'Plafonds d’un rôle modifiés',
}
const actionLabel = (a: string) => ACTION_LABELS[a] ?? a

const SEVERITIES = [
    { value: '', label: 'Toutes' },
    { value: 'info', label: 'Info' },
    { value: 'warning', label: 'Attention' },
    { value: 'critical', label: 'Critique' },
] as const

type Severity = typeof SEVERITIES[number]['value']

/** Pretty-print the JSON diff the service stores, as `champ: avant → après`. */
function renderDiff(oldValue: string | null, newValue: string | null): string {
    const parse = (v: string | null) => {
        if (!v) return null
        try { return JSON.parse(v) } catch { return null }
    }
    const before = parse(oldValue)
    const after = parse(newValue)
    if (!after && !before) return '—'

    const keys = Array.from(new Set([
        ...(before && typeof before === 'object' ? Object.keys(before) : []),
        ...(after && typeof after === 'object' ? Object.keys(after) : []),
    ]))
    if (!keys.length) return typeof after === 'string' ? after : JSON.stringify(after)

    return keys.map(k => {
        const b = before?.[k]
        const a = after?.[k]
        const fmt = (x: unknown) =>
            x === null || x === undefined ? '∅'
                : typeof x === 'object' ? JSON.stringify(x)
                    : String(x)
        return before && k in before ? `${k}: ${fmt(b)} → ${fmt(a)}` : `${k}: ${fmt(a)}`
    }).join('  ·  ')
}

/**
 * Journal d'audit.
 *
 * Read-only by construction: there is no edit and no delete anywhere in this
 * screen or in the service behind it. Anyone who can reach it needs `audit.view`,
 * which only an owner holds by default.
 */
export function AuditLogScreen({ userId }: Props) {
    const [rows, setRows] = useState<AuditLogRow[]>([])
    const [total, setTotal] = useState(0)
    const [page, setPage] = useState(0)
    const [actions, setActions] = useState<string[]>([])
    const [action, setAction] = useState('')
    const [severity, setSeverity] = useState<Severity>('')
    const [search, setSearch] = useState('')
    const [from, setFrom] = useState('')
    const [to, setTo] = useState('')
    const [loading, setLoading] = useState(true)
    const [denied, setDenied] = useState(false)
    const [expanded, setExpanded] = useState<number | null>(null)

    useEffect(() => {
        window.electron?.audit?.actions?.().then(setActions).catch(() => {})
    }, [])

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await window.electron.audit.query({
                action: action || undefined,
                severity: severity || undefined,
                search: search || undefined,
                from: from || undefined,
                // Dates arrive as YYYY-MM-DD; created_at carries a time, so an
                // unqualified upper bound would silently exclude the whole last day.
                to: to ? `${to} 23:59:59` : undefined,
                limit: PAGE,
                offset: page * PAGE,
            }, userId)

            if (!res.ok) {
                setDenied(res.code === 'PERMISSION_DENIED')
                setRows([]); setTotal(0)
                return
            }
            setDenied(false)
            setRows(res.data.rows)
            setTotal(res.data.total)
        } catch (e) {
            console.error('[Audit] query failed:', e)
        } finally {
            setLoading(false)
        }
    }, [action, severity, search, from, to, page, userId])

    useEffect(() => { load() }, [load])

    // Any filter change invalidates the current offset — staying on page 4 of a
    // result set that now has one page shows an empty table for no visible reason.
    useEffect(() => { setPage(0) }, [action, severity, search, from, to])

    if (denied) {
        return (
            <div className="audit-screen">
                <div className="audit-denied">
                    <Lock size={30} />
                    <h3>Accès refusé</h3>
                    <p>Le journal d’audit est réservé aux profils disposant de la permission « Consulter le journal d’audit ».</p>
                </div>
            </div>
        )
    }

    const lastPage = Math.max(0, Math.ceil(total / PAGE) - 1)

    return (
        <div className="audit-screen">
            <header className="audit-header">
                <div>
                    <h1>Journal d’audit</h1>
                    <p>
                        Trace des actions sensibles, avec la valeur avant et après. En lecture
                        seule : aucune entrée ne peut être modifiée ni supprimée depuis l’application.
                    </p>
                </div>
                <div className="audit-total">
                    <ShieldCheck size={15} />
                    {total.toLocaleString('fr-FR')} entrée{total > 1 ? 's' : ''}
                </div>
            </header>

            <section className="audit-filters">
                <div className="audit-search">
                    <Search size={15} />
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Rechercher (action, résumé, utilisateur)…"
                    />
                </div>
                <select value={action} onChange={e => setAction(e.target.value)} aria-label="Action">
                    <option value="">Toutes les actions</option>
                    {actions.map(a => <option key={a} value={a}>{actionLabel(a)}</option>)}
                </select>
                <select
                    value={severity}
                    aria-label="Gravité"
                    onChange={e => setSeverity(SEVERITIES.find(s => s.value === e.target.value)?.value ?? '')}
                >
                    {SEVERITIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
                <label className="audit-date">
                    <span>Du</span>
                    <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
                </label>
                <label className="audit-date">
                    <span>Au</span>
                    <input type="date" value={to} onChange={e => setTo(e.target.value)} />
                </label>
            </section>

            <section className="audit-panel">
                {loading ? (
                    <div className="audit-state">Chargement…</div>
                ) : rows.length === 0 ? (
                    <div className="audit-state empty">
                        <ShieldCheck size={28} />
                        <h3>Aucune entrée</h3>
                        <p>Les actions sensibles — remboursements, ajustements de stock, changements de permissions — apparaîtront ici.</p>
                    </div>
                ) : (
                    <table className="audit-table">
                        <thead>
                            <tr>
                                <th>Date</th><th>Utilisateur</th><th>Action</th>
                                <th>Objet</th><th>Magasin</th><th>Détail</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(r => (
                                <tr
                                    key={r.id}
                                    className={`sev-${r.severity} ${expanded === r.id ? 'expanded' : ''}`}
                                    onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                                >
                                    <td className="muted nowrap">{formatDateTime(r.created_at)}</td>
                                    <td>{r.user_name || '—'}</td>
                                    <td>
                                        <span className={`audit-badge ${r.severity}`}>{actionLabel(r.action)}</span>
                                    </td>
                                    <td className="muted">
                                        {r.entity_type ? `${r.entity_type}${r.entity_id ? ` #${r.entity_id}` : ''}` : '—'}
                                    </td>
                                    <td className="muted">{r.store_name || '—'}</td>
                                    <td className={expanded === r.id ? 'detail full' : 'detail'}>
                                        {r.summary || renderDiff(r.old_value, r.new_value)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>

            {total > PAGE && (
                <footer className="audit-pager">
                    <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>
                        <ChevronLeft size={16} /> Précédent
                    </button>
                    <span>Page {page + 1} / {lastPage + 1}</span>
                    <button disabled={page >= lastPage} onClick={() => setPage(p => p + 1)}>
                        Suivant <ChevronRight size={16} />
                    </button>
                </footer>
            )}
        </div>
    )
}
