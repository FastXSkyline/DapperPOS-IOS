import { useState, useEffect, useMemo, useCallback } from 'react'
import {
    AlertTriangle, PackageX, Hourglass, Layers, Search,
    ArrowDownUp, Building2,
} from 'lucide-react'
import { formatCurrency, formatDateTime, formatDate } from '../utils/formatters'
import type { StockMovementRow } from '../vite-env'
import { useRetailEvents } from '../hooks/useRetailEvents'
import './StockScreen.css'

interface Props {
    userId: number
    /** null = every store combined (owner view). */
    storeId: number | null
}

type Tab = 'low' | 'out' | 'dead' | 'movements'

interface StockRow {
    product_id: number
    product_name: string
    variant_id: number | null
    size: string | null
    color: string | null
    sku: string | null
    store_id: number | null
    store_name: string | null
    quantity?: number
    min_stock_level?: number
    stock_value?: number
    unit_cost?: number
    last_sale_at?: string | null
}

const DEAD_WINDOWS = [30, 60, 90, 180] as const

const variantLabel = (r: { size: string | null; color: string | null }) =>
    [r.size, r.color].filter(Boolean).join(' · ') || '—'

/**
 * Stock — the owner's view of what is sitting in each shop.
 *
 * Every figure here is per store, because that is how stock physically exists:
 * a combined "42 in stock" is useless when 41 of them are in the wrong shop.
 * The store filter defaults to this terminal's store and can be widened to all.
 */
export function StockScreen({ storeId }: Props) {
    const [stores, setStores] = useState<{ id: number; name: string; code: string }[]>([])
    const [scope, setScope] = useState<number | null>(storeId)
    const [tab, setTab] = useState<Tab>('low')
    const [deadDays, setDeadDays] = useState<number>(90)
    const [search, setSearch] = useState('')
    const [loading, setLoading] = useState(true)

    const [low, setLow] = useState<StockRow[]>([])
    const [out, setOut] = useState<StockRow[]>([])
    const [dead, setDead] = useState<StockRow[]>([])
    const [movements, setMovements] = useState<StockMovementRow[]>([])
    const [value, setValue] = useState<{ total_quantity: number; total_cost_value: number; total_retail_value: number } | null>(null)

    useEffect(() => {
        window.electron?.store?.list?.().then(setStores).catch(() => {})
    }, [])

    // Re-read whenever the store scope or the dead-stock window changes. All five
    // reads go together so the KPI row can never describe a different scope than
    // the table under it.
    const load = useCallback(async () => {
        setLoading(true)
        try {
            const s = scope ?? undefined
            const [l, o, d, m, v] = await Promise.all([
                window.electron.inventory.lowStock(s),
                window.electron.inventory.outOfStock(s),
                window.electron.inventory.deadStock(scope, deadDays),
                window.electron.inventory.movements(scope, undefined, undefined, 200),
                window.electron.inventory.value(s),
            ])
            setLow(l); setOut(o); setDead(d); setMovements(m); setValue(v)
        } catch (e) {
            console.error('[Stock] load failed:', e)
        } finally {
            setLoading(false)
        }
    }, [scope, deadDays])

    useEffect(() => { load() }, [load])

    // `scope` null = the owner's all-stores view, which wants every shop's traffic.
    useRetailEvents(['inventory.updated', 'count.applied', 'transfer.received'], load, { storeId: scope })

    const filter = <T extends { product_name?: string; sku?: string | null; size?: string | null; color?: string | null }>(rows: T[]) => {
        const q = search.trim().toLowerCase()
        if (!q) return rows
        return rows.filter(r =>
            (r.product_name ?? '').toLowerCase().includes(q) ||
            (r.sku ?? '').toLowerCase().includes(q) ||
            (r.size ?? '').toLowerCase().includes(q) ||
            (r.color ?? '').toLowerCase().includes(q))
    }

    const deadValue = useMemo(() => dead.reduce((s, r) => s + (r.stock_value ?? 0), 0), [dead])

    const scopeName = scope === null
        ? 'Tous les magasins'
        : stores.find(s => s.id === scope)?.name ?? '—'

    const tabs: { key: Tab; label: string; count: number; icon: typeof AlertTriangle }[] = [
        { key: 'low', label: 'Stock bas', count: low.length, icon: AlertTriangle },
        { key: 'out', label: 'Rupture', count: out.length, icon: PackageX },
        { key: 'dead', label: 'Stock dormant', count: dead.length, icon: Hourglass },
        { key: 'movements', label: 'Mouvements', count: movements.length, icon: ArrowDownUp },
    ]

    return (
        <div className="stock-screen">
            <header className="stock-header">
                <div>
                    <h1>Stock</h1>
                    <p>{scopeName} — chaque quantité appartient à un magasin et à une taille/couleur précise.</p>
                </div>
                <div className="stock-scope">
                    <Building2 size={15} />
                    <select
                        value={scope === null ? 'all' : scope}
                        aria-label="Magasin"
                        onChange={e => setScope(e.target.value === 'all' ? null : Number(e.target.value))}
                    >
                        <option value="all">Tous les magasins</option>
                        {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                </div>
            </header>

            <section className="stock-kpis">
                <article className="stock-kpi">
                    <span>Quantité en stock</span>
                    <strong>{(value?.total_quantity ?? 0).toLocaleString('fr-FR')}</strong>
                </article>
                <article className="stock-kpi">
                    {/* Cost, not retail: this is what the shop has tied up, which is the
                        figure that matters for cash flow. Retail sits beside it so the two
                        are never confused for one another. */}
                    <span>Valeur au prix d’achat</span>
                    <strong>{formatCurrency(value?.total_cost_value ?? 0)}</strong>
                </article>
                <article className="stock-kpi">
                    <span>Valeur au prix de vente</span>
                    <strong>{formatCurrency(value?.total_retail_value ?? 0)}</strong>
                </article>
                <article className="stock-kpi alert">
                    <span>Valeur dormante ({deadDays} j)</span>
                    <strong>{formatCurrency(deadValue)}</strong>
                </article>
            </section>

            <nav className="stock-tabs">
                {tabs.map(({ key, label, count, icon: Icon }) => (
                    <button
                        key={key}
                        className={`stock-tab ${tab === key ? 'active' : ''}`}
                        onClick={() => setTab(key)}
                    >
                        <Icon size={15} />
                        {label}
                        <span className="stock-tab-count">{count}</span>
                    </button>
                ))}

                <div className="stock-search">
                    <Search size={15} />
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Filtrer (article, SKU, taille, couleur)…"
                    />
                </div>

                {tab === 'dead' && (
                    <div className="stock-window">
                        {DEAD_WINDOWS.map(d => (
                            <button
                                key={d}
                                className={deadDays === d ? 'active' : ''}
                                onClick={() => setDeadDays(d)}
                            >{d} j</button>
                        ))}
                    </div>
                )}
            </nav>

            {loading ? (
                <div className="stock-state">Chargement…</div>
            ) : (
                <section className="stock-panel">
                    {tab === 'low' && (
                        filter(low).length === 0
                            ? <Empty icon={<Layers size={28} />} title="Aucun article sous son seuil"
                                     body="Définissez un stock minimum sur une fiche produit pour être alerté ici." />
                            : (
                                <table className="stock-table">
                                    <thead>
                                        <tr>
                                            <th>Article</th><th>Taille · Couleur</th><th>SKU</th>
                                            <th>Magasin</th><th className="num">Stock</th>
                                            <th className="num">Minimum</th><th className="num">Manque</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filter(low).map((r, i) => {
                                            const gap = (r.min_stock_level ?? 0) - (r.quantity ?? 0)
                                            return (
                                                <tr key={`${r.product_id}-${r.variant_id}-${r.store_id}-${i}`}>
                                                    <td>{r.product_name}</td>
                                                    <td className="muted">{variantLabel(r)}</td>
                                                    <td className="muted mono">{r.sku || '—'}</td>
                                                    <td className="muted">{r.store_name || '—'}</td>
                                                    <td className="num warn">{r.quantity ?? 0}</td>
                                                    <td className="num muted">{r.min_stock_level ?? 0}</td>
                                                    <td className="num">{gap > 0 ? `−${gap}` : '0'}</td>
                                                </tr>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            )
                    )}

                    {tab === 'out' && (
                        filter(out).length === 0
                            ? <Empty icon={<PackageX size={28} />} title="Aucune rupture"
                                     body="Toutes les tailles et couleurs référencées ont du stock dans ce périmètre." />
                            : (
                                <table className="stock-table">
                                    <thead>
                                        <tr><th>Article</th><th>Taille · Couleur</th><th>SKU</th><th>Magasin</th></tr>
                                    </thead>
                                    <tbody>
                                        {filter(out).map((r, i) => (
                                            <tr key={`${r.product_id}-${r.variant_id}-${r.store_id}-${i}`}>
                                                <td>{r.product_name}</td>
                                                <td className="muted">{variantLabel(r)}</td>
                                                <td className="muted mono">{r.sku || '—'}</td>
                                                <td className="muted">{r.store_name || '—'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )
                    )}

                    {tab === 'dead' && (
                        filter(dead).length === 0
                            ? <Empty icon={<Hourglass size={28} />} title="Rien ne dort"
                                     body={`Tout ce qui est en stock s’est vendu au moins une fois depuis ${deadDays} jours.`} />
                            : (
                                <table className="stock-table">
                                    <thead>
                                        <tr>
                                            <th>Article</th><th>Taille · Couleur</th><th>Magasin</th>
                                            <th className="num">Quantité</th><th className="num">Valeur</th>
                                            <th>Dernière vente</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filter(dead).map((r, i) => (
                                            <tr key={`${r.product_id}-${r.variant_id}-${r.store_id}-${i}`}>
                                                <td>{r.product_name}</td>
                                                <td className="muted">{variantLabel(r)}</td>
                                                <td className="muted">{r.store_name || '—'}</td>
                                                <td className="num">{r.quantity ?? 0}</td>
                                                <td className="num">{formatCurrency(r.stock_value ?? 0)}</td>
                                                {/* Never sold at all is the worst kind of dead stock, so it is
                                                    named rather than left as an empty cell. */}
                                                <td className={r.last_sale_at ? 'muted' : 'never'}>
                                                    {r.last_sale_at ? formatDate(r.last_sale_at) : 'Jamais vendu'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )
                    )}

                    {tab === 'movements' && (
                        movements.length === 0
                            ? <Empty icon={<ArrowDownUp size={28} />} title="Aucun mouvement"
                                     body="Chaque vente, retour, réception ou ajustement laissera une trace ici." />
                            : (
                                <table className="stock-table">
                                    <thead>
                                        <tr>
                                            <th>Date</th><th>Article</th><th>Taille · Couleur</th>
                                            <th>Magasin</th><th>Motif</th><th>Par</th><th className="num">Delta</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {movements.map(m => (
                                            <tr key={m.id}>
                                                <td className="muted">{formatDateTime(m.created_at)}</td>
                                                <td>{m.product_name || `#${m.product_id}`}</td>
                                                <td className="muted">{variantLabel({ size: m.size ?? null, color: m.color ?? null })}</td>
                                                <td className="muted">{m.store_name || '—'}</td>
                                                <td className="muted">{m.reason || m.movement_type}</td>
                                                <td className="muted">{m.user_name || '—'}</td>
                                                <td className={`num ${m.quantity < 0 ? 'neg' : 'pos'}`}>
                                                    {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )
                    )}
                </section>
            )}
        </div>
    )
}

function Empty({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
    return (
        <div className="stock-state empty">
            {icon}
            <h3>{title}</h3>
            <p>{body}</p>
        </div>
    )
}
