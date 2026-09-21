import { useState, useEffect, useCallback } from 'react'
import { Target, Plus, Trash2, AlertTriangle, X } from 'lucide-react'
import { formatCurrency } from '../utils/formatters'
import type { TargetProgress, TargetScope, PeriodType, Store } from '../vite-env'
import './TargetsPanel.css'

interface Props {
    userId: number
    storeId: number | null
    /** Hides the editor for anyone who cannot set targets. The server enforces it too. */
    canEdit: boolean
}

const SCOPE_LABEL: Record<TargetScope, string> = {
    company: 'Entreprise', store: 'Magasin', employee: 'Vendeur',
}

/** First and last day of the current month, as YYYY-MM-DD. */
function thisMonth() {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    return { start: iso(start), end: iso(end) }
}

/**
 * Objectifs de vente.
 *
 * Every bar is drawn against a second marker: where the period should be if
 * progress were linear. A bar at 55 % means nothing on its own — it is excellent
 * on day 10 of a month and alarming on day 28.
 */
export function TargetsPanel({ userId, storeId, canEdit }: Props) {
    const [rows, setRows] = useState<TargetProgress[]>([])
    const [gap, setGap] = useState<number | null>(null)
    const [stores, setStores] = useState<Store[]>([])
    const [users, setUsers] = useState<{ id: number; name: string }[]>([])
    const [adding, setAdding] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const month = thisMonth()
    const [scope, setScope] = useState<TargetScope>('store')
    const [targetStore, setTargetStore] = useState<number | ''>(storeId ?? '')
    const [targetUser, setTargetUser] = useState<number | ''>('')
    const [amount, setAmount] = useState('')
    const [periodStart, setPeriodStart] = useState(month.start)
    const [periodEnd, setPeriodEnd] = useState(month.end)

    const load = useCallback(async () => {
        const [list, current, storeList] = await Promise.all([
            window.electron.target.list({ activeOnly: true }),
            window.electron.target.current(),
            window.electron.store.list(),
        ])
        setRows(list)
        setGap(current.storeGap)
        setStores(storeList)
        setUsers(await window.electron.user.getAll())
    }, [])

    useEffect(() => { load() }, [load])

    const save = async () => {
        const value = Number(amount)
        if (!Number.isFinite(value) || value <= 0) { setError('Montant invalide'); return }
        setBusy(true); setError('')
        try {
            const res = await window.electron.target.set({
                scope,
                storeId: scope === 'store' ? Number(targetStore) : null,
                userId: scope === 'employee' ? Number(targetUser) : null,
                periodType: 'month' as PeriodType,
                periodStart, periodEnd,
                targetAmount: value,
            }, userId)
            if (!res.ok) { setError(res.message); return }
            setAdding(false); setAmount('')
            await load()
        } finally { setBusy(false) }
    }

    const remove = async (id: number) => {
        const res = await window.electron.target.remove(id, userId)
        if (!res.ok) { setError(res.message); return }
        await load()
    }

    const label = (t: TargetProgress) =>
        t.scope === 'company' ? 'Entreprise'
            : t.scope === 'store' ? (t.store_name ?? `Magasin ${t.store_id}`)
                : (t.user_name ?? `Vendeur ${t.user_id}`)

    return (
        <section className="tgt">
            <div className="tgt-head">
                <h2><Target size={16} /> Objectifs en cours</h2>
                {canEdit && (
                    <button className="tgt-primary" onClick={() => setAdding(v => !v)}>
                        {adding ? <><X size={14} /> Annuler</> : <><Plus size={14} /> Nouvel objectif</>}
                    </button>
                )}
            </div>

            {error && <p className="tgt-error"><AlertTriangle size={14} /> {error}</p>}

            {/* Reported, never prevented: the owner may set stores deliberately short
                of the company figure, and the useful thing is to see it. */}
            {gap !== null && gap !== 0 && (
                <p className="tgt-gap">
                    Les objectifs magasins {gap > 0 ? 'dépassent' : 'sont inférieurs à'} l’objectif
                    entreprise de <strong>{formatCurrency(Math.abs(gap))}</strong>.
                </p>
            )}

            {adding && (
                <div className="tgt-form">
                    <label>
                        <span>Portée</span>
                        <select value={scope} onChange={e => setScope(e.target.value as TargetScope)}>
                            <option value="company">Entreprise</option>
                            <option value="store">Magasin</option>
                            <option value="employee">Vendeur</option>
                        </select>
                    </label>
                    {scope === 'store' && (
                        <label>
                            <span>Magasin</span>
                            <select value={targetStore} onChange={e => setTargetStore(Number(e.target.value) || '')}>
                                <option value="">Choisir…</option>
                                {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                        </label>
                    )}
                    {scope === 'employee' && (
                        <label>
                            <span>Vendeur</span>
                            <select value={targetUser} onChange={e => setTargetUser(Number(e.target.value) || '')}>
                                <option value="">Choisir…</option>
                                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                            </select>
                        </label>
                    )}
                    <label>
                        <span>Du</span>
                        <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} />
                    </label>
                    <label>
                        <span>Au</span>
                        <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} />
                    </label>
                    <label>
                        <span>Objectif (DA)</span>
                        <input type="number" min={1} value={amount} onChange={e => setAmount(e.target.value)}
                            placeholder="8000000" />
                    </label>
                    <button className="tgt-primary" onClick={save} disabled={busy}>
                        {busy ? 'Enregistrement…' : 'Enregistrer'}
                    </button>
                </div>
            )}

            {rows.length === 0 ? (
                <p className="tgt-empty">Aucun objectif en cours. Définissez-en un pour suivre la progression.</p>
            ) : (
                <ul className="tgt-list">
                    {rows.map(t => {
                        const behind = t.expectedPercent !== null && t.percent < t.expectedPercent - 5
                        const done = t.percent >= 100
                        return (
                            <li key={t.id} className={done ? 'done' : behind ? 'behind' : ''}>
                                <div className="tgt-row-head">
                                    <div>
                                        <strong>{label(t)}</strong>
                                        <span className="tgt-scope">{SCOPE_LABEL[t.scope]}</span>
                                    </div>
                                    <div className="tgt-figures">
                                        <strong>{formatCurrency(t.achieved)}</strong>
                                        <span>/ {formatCurrency(t.target_amount)}</span>
                                    </div>
                                </div>

                                <div className="tgt-bar">
                                    <i style={{ width: `${Math.min(100, t.percent)}%` }} />
                                    {/* Where the period should be. Without it a bar at 55 % is
                                        unreadable: excellent on day 10, alarming on day 28. */}
                                    {t.expectedPercent !== null && (
                                        <b className="tgt-pace" style={{ left: `${Math.min(100, t.expectedPercent)}%` }}
                                            title={`Rythme attendu : ${t.expectedPercent.toFixed(0)} %`} />
                                    )}
                                </div>

                                <div className="tgt-row-foot">
                                    <span>{t.percent.toFixed(0)} %</span>
                                    {t.remaining > 0
                                        ? <span>Reste {formatCurrency(t.remaining)}</span>
                                        : <span className="tgt-hit">Objectif atteint</span>}
                                    {t.daysLeft > 0 && <span>{t.daysLeft} j restants</span>}
                                    {behind && <span className="tgt-late">En retard sur le rythme</span>}
                                    {canEdit && (
                                        <button className="tgt-icon" onClick={() => remove(t.id)} aria-label="Supprimer">
                                            <Trash2 size={14} />
                                        </button>
                                    )}
                                </div>
                            </li>
                        )
                    })}
                </ul>
            )}
        </section>
    )
}
