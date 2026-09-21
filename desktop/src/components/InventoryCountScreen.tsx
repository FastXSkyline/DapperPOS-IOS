import { useState, useEffect, useCallback, useRef } from 'react'
import {
    ClipboardList, Play, Check, X, AlertTriangle, Search,
    ScanLine, RotateCcw,
} from 'lucide-react'
import { formatCurrency, formatDateTime } from '../utils/formatters'
import type { CountRow, CountItemRow, CountTotals, CountScope } from '../vite-env'
import './InventoryCountScreen.css'

interface Props {
    userId: number
    storeId: number | null
}

type Detail = CountRow & { items: CountItemRow[]; totals: CountTotals }
type Filter = 'all' | 'uncounted' | 'differences'

const variantLabel = (l: { size: string | null; color: string | null }) =>
    [l.size, l.color].filter(Boolean).join(' · ') || '—'

/**
 * Inventaire.
 *
 * Nothing here touches live stock until "Appliquer". The count is a document that
 * records what was physically found; applying it is a separate, separately
 * permissioned act — counting is clerical, applying moves money.
 */
export function InventoryCountScreen({ userId, storeId }: Props) {
    const [detail, setDetail] = useState<Detail | null>(null)
    const [history, setHistory] = useState<CountRow[]>([])
    const [categories, setCategories] = useState<{ id: number; name: string }[]>([])
    const [filter, setFilter] = useState<Filter>('all')
    const [search, setSearch] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [result, setResult] = useState<{ adjusted: number; netUnits: number; netValue: number } | null>(null)

    // starting a session
    const [scope, setScope] = useState<CountScope>('full')
    const [categoryId, setCategoryId] = useState<number | ''>('')

    // Local, uncommitted keystrokes. The line is written on blur/Enter so a partial
    // number ("1" on the way to "12") never lands as a real count.
    const [drafts, setDrafts] = useState<Record<number, string>>({})
    const scanRef = useRef<HTMLInputElement>(null)

    const load = useCallback(async () => {
        const store = storeId ?? 1
        const [open, list, cats] = await Promise.all([
            window.electron.inventoryCount.open(store),
            window.electron.inventoryCount.list(store, 30),
            window.electron.category.getAll(),
        ])
        setDetail(open as Detail | null)
        setHistory(list)
        setCategories(cats as { id: number; name: string }[])
    }, [storeId])

    useEffect(() => { load() }, [load])

    const refresh = async (f: Filter = filter) => {
        if (!detail) return
        setDetail(await window.electron.inventoryCount.get(detail.id, f) as Detail)
    }

    const start = async () => {
        setBusy(true); setError(''); setResult(null)
        try {
            const res = await window.electron.inventoryCount.start({
                storeId: storeId ?? 1, userId, scope,
                categoryId: scope === 'category' ? Number(categoryId) : null,
            })
            if (!res.ok) { setError(res.message); return }
            await load()
        } finally { setBusy(false) }
    }

    const commit = async (item: CountItemRow, raw: string) => {
        const trimmed = raw.trim()
        if (trimmed === '') return
        const n = Number(trimmed)
        if (!Number.isFinite(n) || n < 0) { setError('Quantité invalide'); return }

        const res = await window.electron.inventoryCount.countLine(item.id, n, userId)
        if (!res.ok) { setError(res.message); return }
        setError('')
        setDrafts(d => { const next = { ...d }; delete next[item.id]; return next })
        await refresh()
    }

    const clear = async (item: CountItemRow) => {
        await window.electron.inventoryCount.clearLine(item.id, userId)
        setDrafts(d => { const next = { ...d }; delete next[item.id]; return next })
        await refresh()
    }

    const act = async (
        fn: () => Promise<{ ok: true; data: unknown } | { ok: false; code: string; message: string }>,
    ) => {
        setBusy(true); setError('')
        try {
            const res = await fn()
            if (!res.ok) { setError(res.message); return null }
            return res.data
        } finally { setBusy(false) }
    }

    const apply = async () => {
        if (!detail) return
        const data = await act(() => window.electron.inventoryCount.apply(detail.id, userId))
        if (data) {
            setResult(data as { adjusted: number; netUnits: number; netValue: number })
            await load()
        }
    }

    const setFilterAndReload = async (f: Filter) => {
        setFilter(f)
        if (detail) setDetail(await window.electron.inventoryCount.get(detail.id, f) as Detail)
    }

    /** Barcode field: resolve to a line in the open count and focus its input. */
    const onScan = async (code: string) => {
        if (!detail || !code.trim()) return
        const hit = detail.items.find(i => i.sku === code.trim())
        if (!hit) { setError(`Aucune ligne pour « ${code} » dans cet inventaire`); return }
        setError('')
        setSearch(hit.product_name)
        requestAnimationFrame(() => {
            document.getElementById(`count-input-${hit.id}`)?.focus()
        })
    }

    const visible = detail?.items.filter(i => {
        const q = search.trim().toLowerCase()
        if (!q) return true
        return i.product_name.toLowerCase().includes(q)
            || (i.sku ?? '').toLowerCase().includes(q)
            || variantLabel(i).toLowerCase().includes(q)
    }) ?? []

    const progress = detail
        ? Math.round((detail.totals.counted / Math.max(1, detail.totals.lines)) * 100)
        : 0

    return (
        <div className="cnt-screen">
            <header className="cnt-header">
                <div>
                    <h1>Inventaire</h1>
                    <p>
                        Rien n’est modifié tant que l’inventaire n’est pas appliqué. L’écart est
                        mesuré au moment où chaque ligne est comptée, pas au début de la session —
                        les ventes faites pendant le comptage ne sont donc pas prises pour des pertes.
                    </p>
                </div>
            </header>

            {error && (
                <div className="cnt-error" role="alert"><AlertTriangle size={16} /> <span>{error}</span></div>
            )}

            {result && (
                <div className="cnt-result" role="status">
                    <Check size={17} />
                    <div>
                        <strong>Inventaire appliqué — {result.adjusted} ajustement(s)</strong>
                        <p>
                            Écart net {result.netUnits > 0 ? '+' : ''}{result.netUnits} article(s),
                            soit {formatCurrency(result.netValue)} au prix d’achat.
                        </p>
                    </div>
                    <button onClick={() => setResult(null)} aria-label="Fermer"><X size={15} /></button>
                </div>
            )}

            {!detail && (
                <section className="cnt-panel">
                    <h2>Démarrer un inventaire</h2>
                    <div className="cnt-start">
                        <label>
                            <span>Portée</span>
                            <select value={scope} onChange={e => setScope(e.target.value as CountScope)}>
                                <option value="full">Tout le magasin</option>
                                <option value="category">Une catégorie</option>
                            </select>
                        </label>
                        {scope === 'category' && (
                            <label>
                                <span>Catégorie</span>
                                <select value={categoryId} onChange={e => setCategoryId(Number(e.target.value) || '')}>
                                    <option value="">Choisir…</option>
                                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                </select>
                            </label>
                        )}
                        <button className="cnt-primary" onClick={start}
                            disabled={busy || (scope === 'category' && !categoryId)}>
                            <Play size={15} /> {busy ? 'Préparation…' : 'Démarrer'}
                        </button>
                    </div>
                </section>
            )}

            {detail && (
                <section className="cnt-panel">
                    <div className="cnt-panel-head">
                        <div>
                            <h2>{detail.count_number}</h2>
                            <div className="cnt-meta">
                                <span>{detail.store_name}</span>
                                <span>{detail.category_name ?? 'Tout le magasin'}</span>
                                <span>Démarré {formatDateTime(detail.started_at)}</span>
                                {detail.started_by_name && <span>par {detail.started_by_name}</span>}
                            </div>
                        </div>
                        <div className="cnt-progress">
                            <div className="cnt-bar"><i style={{ width: `${progress}%` }} /></div>
                            <span>{detail.totals.counted} / {detail.totals.lines} comptées</span>
                        </div>
                    </div>

                    <div className="cnt-summary">
                        <div>
                            <span>Écarts</span>
                            <strong>{detail.totals.with_difference}</strong>
                        </div>
                        <div>
                            <span>Écart net</span>
                            <strong className={detail.totals.net_difference < 0 ? 'neg' : detail.totals.net_difference > 0 ? 'pos' : ''}>
                                {detail.totals.net_difference > 0 ? '+' : ''}{detail.totals.net_difference}
                            </strong>
                        </div>
                        <div>
                            <span>Valeur de l’écart</span>
                            <strong className={detail.totals.net_value < 0 ? 'neg' : ''}>
                                {formatCurrency(detail.totals.net_value)}
                            </strong>
                        </div>
                    </div>

                    <div className="cnt-toolbar">
                        <div className="cnt-scan">
                            <ScanLine size={16} />
                            <input
                                ref={scanRef}
                                placeholder="Scanner un code-barres…"
                                onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                        onScan((e.target as HTMLInputElement).value)
                                        ;(e.target as HTMLInputElement).value = ''
                                    }
                                }}
                            />
                        </div>
                        <div className="cnt-search">
                            <Search size={15} />
                            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filtrer…" />
                        </div>
                        <div className="cnt-filters">
                            {([['all', 'Toutes'], ['uncounted', 'Non comptées'], ['differences', 'Écarts']] as const)
                                .map(([k, label]) => (
                                    <button key={k} className={filter === k ? 'active' : ''}
                                        onClick={() => setFilterAndReload(k)}>{label}</button>
                                ))}
                        </div>
                    </div>

                    <div className="cnt-table-wrap">
                        <table className="cnt-table">
                            <thead>
                                <tr>
                                    <th>Article</th><th>Taille · Couleur</th><th>SKU</th>
                                    <th className="num">Attendu</th><th className="num">Compté</th>
                                    <th className="num">Écart</th><th />
                                </tr>
                            </thead>
                            <tbody>
                                {visible.length === 0 ? (
                                    <tr><td colSpan={7} className="muted cnt-none">Aucune ligne à afficher.</td></tr>
                                ) : visible.map(item => {
                                    const counted = item.counted_qty !== null
                                    const diff = item.difference ?? 0
                                    return (
                                        <tr key={item.id} className={counted ? (diff === 0 ? 'ok' : 'diff') : ''}>
                                            <td>{item.product_name}</td>
                                            <td className="muted">{variantLabel(item)}</td>
                                            <td className="muted mono">{item.sku || '—'}</td>
                                            {/* Blank until counted: showing the system figure first
                                                anchors the counter to it and defeats the count. */}
                                            <td className="num muted">{counted ? item.expected_qty : '—'}</td>
                                            <td className="num">
                                                <input
                                                    id={`count-input-${item.id}`}
                                                    className="cnt-qty"
                                                    type="number"
                                                    min={0}
                                                    inputMode="numeric"
                                                    placeholder="—"
                                                    value={drafts[item.id] ?? (counted ? String(item.counted_qty) : '')}
                                                    onChange={e => setDrafts(d => ({ ...d, [item.id]: e.target.value }))}
                                                    onBlur={e => commit(item, e.target.value)}
                                                    onKeyDown={e => {
                                                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                                                    }}
                                                />
                                            </td>
                                            <td className={`num ${diff < 0 ? 'neg' : diff > 0 ? 'pos' : 'muted'}`}>
                                                {counted ? (diff > 0 ? `+${diff}` : diff) : '—'}
                                            </td>
                                            <td className="num">
                                                {counted && (
                                                    <button className="cnt-icon" onClick={() => clear(item)} aria-label="Effacer">
                                                        <RotateCcw size={14} />
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>

                    {detail.totals.counted < detail.totals.lines && (
                        <div className="cnt-note">
                            <AlertTriangle size={15} />
                            {detail.totals.lines - detail.totals.counted} ligne(s) non comptée(s). Elles
                            seront <strong>ignorées</strong> lors de l’application — jamais mises à zéro.
                        </div>
                    )}

                    <footer className="cnt-actions">
                        <button className="cnt-ghost" disabled={busy}
                            onClick={() => act(() => window.electron.inventoryCount.cancel(detail.id, userId, 'annulé')).then(load)}>
                            Annuler l’inventaire
                        </button>
                        <button className="cnt-primary" onClick={apply}
                            disabled={busy || detail.totals.counted === 0}>
                            <Check size={16} /> {busy ? 'Application…' : 'Appliquer au stock'}
                        </button>
                    </footer>
                </section>
            )}

            <section className="cnt-panel">
                <h2><ClipboardList size={16} /> Historique</h2>
                {history.length === 0 ? (
                    <p className="cnt-empty">Aucun inventaire enregistré.</p>
                ) : (
                    <table className="cnt-table">
                        <thead>
                            <tr>
                                <th>N°</th><th>Portée</th><th>État</th>
                                <th className="num">Comptées</th><th className="num">Écart net</th>
                                <th className="num">Valeur</th><th>Démarré</th>
                            </tr>
                        </thead>
                        <tbody>
                            {history.map(c => (
                                <tr key={c.id}>
                                    <td className="mono">{c.count_number}</td>
                                    <td className="muted">{c.category_name ?? 'Tout le magasin'}</td>
                                    <td><span className={`cnt-badge ${c.status}`}>{c.status}</span></td>
                                    <td className="num">{c.counted_lines ?? 0} / {c.line_count ?? 0}</td>
                                    <td className={`num ${(c.net_difference ?? 0) < 0 ? 'neg' : ''}`}>
                                        {(c.net_difference ?? 0) > 0 ? '+' : ''}{c.net_difference ?? 0}
                                    </td>
                                    <td className="num muted">{formatCurrency(c.net_value ?? 0)}</td>
                                    <td className="muted">{formatDateTime(c.started_at)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    )
}
