import { useState, useEffect, useCallback, useMemo } from 'react'
import {
    Search, ChevronRight, ArrowLeft, ClipboardList, TriangleAlert,
    Boxes, Sliders, PackageX, X, ArrowDownUp, Store as StoreIcon,
} from 'lucide-react'
import type { StockOverviewRow, StockState, StockMovementRow } from '../vite-env'
import { InventoryCountScreen } from './InventoryCountScreen'
import { LossesScreen } from './LossesScreen'
import { useRetailEvents } from '../hooks/useRetailEvents'
import { formatCurrency, formatAmount } from '../utils/formatters'
import { useLanguage } from '../LanguageContext'
import './InventoryScreen.css'

/* ---------------------------------------------------------------------------
   Inventaire.

   NOT a tab strip. The first version of this screen was three tabs — Stock,
   Inventaires, Pertes — each mounting a separate legacy screen, and it was
   wrong twice over:

     • Tabs hid the answer. "How is my stock?" is one question, and it was
       split across three panes you had to visit in turn and hold in your head.
     • The lists double-counted. Rupture, faible and dormant overlap (a variant
       at zero that has not sold in 90 days is all three), so the three tabs
       described the same garment three times and no total was true.

   What replaces it: ONE health bar over ONE table. `InventoryService.getOverview`
   assigns each stock line exactly one state, so the four numbers add up to the
   total and the bar is an honest picture of the shop. The legend chips are the
   filter — a state selector that also tells you how big each state is, which a
   tab cannot do.

   Counts and losses are still here, as DRILL-DOWNS (with a back arrow) rather
   than as siblings: they are things you go and DO after the overview told you
   something, not three equal views of the same data.

   Colour never carries a state alone — every chip and every row badge is
   labelled, because "amber vs red at arm's length on a shop floor" is not a
   distinction anyone should have to make.
   --------------------------------------------------------------------------- */

type Mode = 'overview' | 'counts' | 'losses'

const STATES: { id: StockState; key: string; tone: string; hintKey: string }[] = [
    { id: 'healthy', key: 'inv.healthy', tone: 'ok', hintKey: 'inv.healthyHint' },
    { id: 'low', key: 'inv.low', tone: 'warn', hintKey: 'inv.lowHint' },
    { id: 'out', key: 'inv.out', tone: 'bad', hintKey: 'inv.outHint' },
    { id: 'dead', key: 'inv.dead', tone: 'idle', hintKey: 'inv.deadHint' },
]

const DEAD_WINDOWS = [30, 60, 90, 180] as const

type SortKey = 'value' | 'quantity' | 'name' | 'urgency'

const SORTS: { id: SortKey; key: string }[] = [
    { id: 'urgency', key: 'inv.sortUrgent' },
    { id: 'value', key: 'inv.sortValue' },
    { id: 'quantity', key: 'inv.sortQty' },
    { id: 'name', key: 'inv.sortName' },
]

/** How badly one product needs attention. Ruptures first, then low stock, then
 *  dormant capital — and within a state, the biggest money first. */
const STATE_WEIGHT: Record<StockState, number> = { out: 3, low: 2, dead: 1, healthy: 0 }

const variantLabel = (r: { size: string | null; color: string | null }) =>
    [r.size, r.color].filter(Boolean).join(' · ')

interface ProductGroup {
    productId: number
    name: string
    category: string | null
    lines: StockOverviewRow[]
    quantity: number
    value: number
    worst: StockState
    /** Lines needing attention, for the badge on the collapsed row. */
    flagged: number
}

export function InventoryScreen({ userId, storeId }: { userId: number; storeId: number | null }) {
    const { t } = useLanguage()
    const [mode, setMode] = useState<Mode>('overview')
    const [rows, setRows] = useState<StockOverviewRow[]>([])
    const [movements, setMovements] = useState<StockMovementRow[]>([])
    const [stores, setStores] = useState<{ id: number; name: string; code: string }[]>([])
    const [scope, setScope] = useState<number | null>(storeId)
    const [deadDays, setDeadDays] = useState<number>(90)
    const [search, setSearch] = useState('')
    const [category, setCategory] = useState<string>('all')
    const [filter, setFilter] = useState<StockState | null>(null)
    const [sort, setSort] = useState<SortKey>('urgency')
    const [expanded, setExpanded] = useState<Set<number>>(new Set())
    const [adjusting, setAdjusting] = useState<StockOverviewRow | null>(null)
    const [losing, setLosing] = useState<StockOverviewRow | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        window.electron?.store?.list?.().then(setStores).catch(() => {})
    }, [])

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const [o, m] = await Promise.all([
                window.electron.inventory.overview(scope, deadDays),
                window.electron.inventory.movements(scope, undefined, undefined, 40),
            ])
            setRows(o)
            setMovements(m)
        } catch (e) {
            console.error('[Inventaire] load failed:', e)
        } finally {
            setLoading(false)
        }
    }, [scope, deadDays])

    useEffect(() => { load() }, [load])
    useRetailEvents(['inventory.updated', 'sale.created', 'sale.returned'], load, { storeId: scope, delay: 700 })

    /* ---- Aggregates. All from `rows`, so the bar and the table always agree. -- */
    const counts = useMemo(() => {
        const c: Record<StockState, number> = { healthy: 0, low: 0, out: 0, dead: 0 }
        for (const r of rows) c[r.state]++
        return c
    }, [rows])

    const totals = useMemo(() => rows.reduce((t, r) => ({
        quantity: t.quantity + (r.quantity > 0 ? r.quantity : 0),
        cost: t.cost + (r.quantity > 0 ? r.stock_value : 0),
        retail: t.retail + (r.quantity > 0 ? r.quantity * r.unit_price : 0),
        idle: t.idle + (r.state === 'dead' ? r.stock_value : 0),
    }), { quantity: 0, cost: 0, retail: 0, idle: 0 }), [rows])

    const categories = useMemo(() => {
        const set = new Set<string>()
        for (const r of rows) if (r.category_name) set.add(r.category_name)
        return Array.from(set).sort((a, b) => a.localeCompare(b, 'fr'))
    }, [rows])

    /* ---- Filter, then group by product. --------------------------------------
       A product is shown when ANY of its lines matches; the expanded matrix then
       shows only the matching lines, so a filter never claims a garment is in
       rupture across the board when one size is. */
    const groups = useMemo(() => {
        const q = search.trim().toLowerCase()
        const kept = rows.filter(r => {
            if (filter && r.state !== filter) return false
            if (category !== 'all' && r.category_name !== category) return false
            if (!q) return true
            return r.product_name.toLowerCase().includes(q)
                || (r.sku || '').toLowerCase().includes(q)
                || (r.barcode || '').toLowerCase().includes(q)
                || variantLabel(r).toLowerCase().includes(q)
        })

        const byProduct = new Map<number, ProductGroup>()
        for (const r of kept) {
            let g = byProduct.get(r.product_id)
            if (!g) {
                g = {
                    productId: r.product_id, name: r.product_name, category: r.category_name,
                    lines: [], quantity: 0, value: 0, worst: 'healthy', flagged: 0,
                }
                byProduct.set(r.product_id, g)
            }
            g.lines.push(r)
            if (r.quantity > 0) { g.quantity += r.quantity; g.value += r.stock_value }
            if (STATE_WEIGHT[r.state] > STATE_WEIGHT[g.worst]) g.worst = r.state
            if (r.state !== 'healthy') g.flagged++
        }

        const list = Array.from(byProduct.values())
        list.sort((a, b) => {
            switch (sort) {
                case 'name': return a.name.localeCompare(b.name, 'fr')
                case 'quantity': return b.quantity - a.quantity
                case 'value': return b.value - a.value
                default:
                    // Urgency first, money as the tie-break within a state.
                    return STATE_WEIGHT[b.worst] - STATE_WEIGHT[a.worst] || b.value - a.value
            }
        })
        return list
    }, [rows, search, category, filter, sort])

    const toggle = (id: number) => setExpanded(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
    })

    /* ---- Drill-downs --------------------------------------------------------- */
    if (mode !== 'overview') {
        return (
            <div className="el-page inv">
                <div className="el-page-head">
                    <button className="el-btn el-btn--ghost inv-back" onClick={() => { setMode('overview'); load() }}>
                        <ArrowLeft size={16} /> {t('nav.inventory')}
                    </button>
                    <div>
                        <h1 className="el-page-title">
                            {mode === 'counts' ? t('inv.physical') : t('inv.lossesFull')}
                        </h1>
                    </div>
                </div>
                {mode === 'counts'
                    ? <InventoryCountScreen userId={userId} storeId={storeId} />
                    : <LossesScreen userId={userId} />}
            </div>
        )
    }

    const totalLines = rows.length || 1

    return (
        <div className="el-page inv">
            <div className="el-page-head">
                <div>
                    <h1 className="el-page-title">{t('nav.inventory')}</h1>
                    <p className="el-page-sub">
                        {t('inv.subtitle')}
                    </p>
                </div>
                <div className="el-page-actions">
                    <select
                        className="el-pill"
                        value={scope === null ? 'all' : scope}
                        onChange={e => setScope(e.target.value === 'all' ? null : Number(e.target.value))}
                        aria-label={t('ui.store')}
                    >
                        <option value="all">{t('ui.allStores')}</option>
                        {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <button className="el-btn el-btn--secondary" onClick={() => setMode('losses')}>
                        <TriangleAlert size={15} /> {t('inv.losses')}
                    </button>
                    <button className="el-btn el-btn--primary" onClick={() => setMode('counts')}>
                        <ClipboardList size={15} /> {t('inv.physical')}
                    </button>
                </div>
            </div>

            {/* ---- Money on the shelves ---- */}
            <div className="el-grid el-grid--stats">
                <div className="el-stat">
                    <span className="el-stat-label">{t('ui2.stockValue')}</span>
                    <span className="el-stat-value">{formatCurrency(totals.cost)}</span>
                    <span className="el-stat-foot">
                        <span className="el-stat-note">{t('inv.atCost')}</span>
                    </span>
                </div>
                <div className="el-stat">
                    <span className="el-stat-label">{t('inv.shelfValue')}</span>
                    <span className="el-stat-value">{formatCurrency(totals.retail)}</span>
                    <span className="el-stat-foot">
                        <span className="el-stat-note">{t('inv.atRetail')}</span>
                    </span>
                </div>
                <div className="el-stat">
                    <span className="el-stat-label">{t('inv.itemsInStock')}</span>
                    <span className="el-stat-value">{formatAmount(totals.quantity)}</span>
                    <span className="el-stat-foot">
                        <span className="el-stat-note">{rows.length} {t('inv.refsTracked')}</span>
                    </span>
                </div>
                <div className={`el-stat ${totals.idle > 0 ? 'inv-stat-idle' : ''}`}>
                    <span className="el-stat-label">{t('inv.idleCapital')}</span>
                    <span className="el-stat-value">{formatCurrency(totals.idle)}</span>
                    <span className="el-stat-foot">
                        <span className="el-stat-note">{t('inv.noSaleSince')} {deadDays} {t('inv.days')}</span>
                    </span>
                </div>
            </div>

            {/* ---- The health bar. One picture of the shop; the legend is the filter. */}
            <section className="el-card inv-health">
                <div className="el-card-head">
                    <h2 className="el-card-title">{t('inv.health')}</h2>
                    <div className="el-card-actions">
                        <select
                            className="el-pill"
                            value={deadDays}
                            onChange={e => setDeadDays(Number(e.target.value))}
                            aria-label={t('inv.dead')}
                        >
                            {DEAD_WINDOWS.map(d => <option key={d} value={d}>{t('inv.dormantWin')} {d} {t('inv.days')}</option>)}
                        </select>
                        {filter && (
                            <button className="el-btn el-btn--ghost" onClick={() => setFilter(null)}>
                                <X size={14} /> {t('inv.showAll')}
                            </button>
                        )}
                    </div>
                </div>

                <div className="inv-bar" role="img"
                    aria-label={STATES.map(s => `${t(s.key)} ${counts[s.id]}`).join(', ')}>
                    {STATES.map(s => counts[s.id] > 0 && (
                        <button
                            key={s.id}
                            className={`inv-bar-seg is-${s.tone} ${filter && filter !== s.id ? 'is-dim' : ''}`}
                            style={{ flexGrow: counts[s.id] }}
                            onClick={() => setFilter(filter === s.id ? null : s.id)}
                            title={`${t(s.key)} — ${counts[s.id]} ${t('inv.lines')}`}
                            aria-label={t(s.key)}
                        />
                    ))}
                </div>

                <div className="inv-legend">
                    {STATES.map(s => (
                        <button
                            key={s.id}
                            className={`inv-legend-chip is-${s.tone} ${filter === s.id ? 'is-on' : ''}`}
                            onClick={() => setFilter(filter === s.id ? null : s.id)}
                            title={t(s.hintKey)}
                        >
                            <i />
                            <span>{t(s.key)}</span>
                            <strong>{counts[s.id]}</strong>
                            <small>{Math.round((counts[s.id] / totalLines) * 100)} %</small>
                        </button>
                    ))}
                </div>
            </section>

            <div className="inv-body">
                <div className="inv-main">
                    <div className="inv-toolbar">
                        <label className="el-search inv-search">
                            <Search size={15} />
                            <input
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                placeholder={t('inv.searchPh')}
                                aria-label={t('inv.searchPh')}
                            />
                        </label>
                        <select className="el-pill" value={category}
                            onChange={e => setCategory(e.target.value)} aria-label={t('ui.category')}>
                            <option value="all">{t('inv.allCats')}</option>
                            {categories.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <select className="el-pill" value={sort}
                            onChange={e => setSort(e.target.value as SortKey)} aria-label={t('inv.sort')}>
                            {SORTS.map(s => <option key={s.id} value={s.id}>{t(s.key)}</option>)}
                        </select>
                    </div>

                    <div className="el-card el-card--pad0">
                        <div className="el-table-wrap">
                            <table className="el-table inv-table">
                                <thead>
                                    <tr>
                                        <th className="inv-col-x" />
                                        <th>{t('ui2.product')}</th>
                                        <th>{t('ui.category')}</th>
                                        <th>{t('inv.state')}</th>
                                        <th className="num">{t('ui2.inStock')}</th>
                                        <th className="num">{t('ui.value')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {groups.map(g => {
                                        const open = expanded.has(g.productId)
                                        const tone = STATES.find(s => s.id === g.worst)!
                                        return [
                                            <tr
                                                key={g.productId}
                                                className="is-clickable inv-row"
                                                onClick={() => toggle(g.productId)}
                                            >
                                                <td className="inv-col-x">
                                                    <ChevronRight
                                                        size={15}
                                                        className={`inv-chev ${open ? 'is-open' : ''}`}
                                                    />
                                                </td>
                                                <td>
                                                    <span className="el-cell-product">
                                                        <span className="el-thumb"><Boxes size={16} /></span>
                                                        <span>{g.name}</span>
                                                    </span>
                                                </td>
                                                <td className="muted">{g.category || '—'}</td>
                                                <td>
                                                    <span className={`el-chip el-chip--${tone.tone === 'idle' ? 'neutral' : tone.tone}`}>
                                                        {t(tone.key)}
                                                    </span>
                                                    {g.flagged > 0 && g.worst !== 'healthy' && (
                                                        <span className="inv-flagged">
                                                            {g.flagged}/{g.lines.length} {t('inv.lines')}
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="num strong">{formatAmount(g.quantity)}</td>
                                                <td className="num">{formatCurrency(g.value)}</td>
                                            </tr>,
                                            open && (
                                                <tr key={`${g.productId}-x`} className="inv-expand-row">
                                                    <td colSpan={6}>
                                                        <VariantMatrix
                                                            lines={g.lines}
                                                            multiStore={scope === null && stores.length > 1}
                                                            onAdjust={setAdjusting}
                                                            onLoss={setLosing}
                                                        />
                                                    </td>
                                                </tr>
                                            ),
                                        ]
                                    })}
                                </tbody>
                            </table>

                            {!loading && groups.length === 0 && (
                                <div className="el-empty">
                                    <span className="el-empty-icon"><PackageX size={22} /></span>
                                    <strong>
                                        {filter || search || category !== 'all'
                                            ? t('inv.noMatch')
                                            : t('inv.noStock')}
                                    </strong>
                                    <span>
                                        {filter || search || category !== 'all'
                                            ? t('inv.noMatchHint')
                                            : t('inv.noStockHint')}
                                    </span>
                                </div>
                            )}
                            {loading && <div className="el-empty">{t('ui.loading')}</div>}
                        </div>

                        {groups.length > 0 && (
                            <div className="el-table-foot">
                                {groups.length} {t('inv.articles')}
                                {filter && ` · ${t('inv.filteredOn')} « ${t(STATES.find(s => s.id === filter)!.key)} »`}
                            </div>
                        )}
                    </div>
                </div>

                {/* ---- The ledger, always visible. An adjustment you just made shows
                        up here immediately, which is the only way to be sure it
                        landed on the line you meant. ---- */}
                <aside className="inv-rail">
                    <section className="el-card el-card--pad0">
                        <div className="el-card-head el-card-head--ruled">
                            <h2 className="el-card-title">{t('inv.recentMoves')}</h2>
                            <div className="el-card-actions">
                                <ArrowDownUp size={14} color="var(--text-tertiary)" />
                            </div>
                        </div>
                        <ul className="inv-moves">
                            {movements.slice(0, 24).map(m => (
                                <li key={m.id}>
                                    <span className={`inv-move-qty ${m.quantity < 0 ? 'is-out' : 'is-in'}`}>
                                        {m.quantity > 0 ? '+' : ''}{formatAmount(m.quantity)}
                                    </span>
                                    <span className="inv-move-text">
                                        <strong>{m.product_name}</strong>
                                        <small>
                                            {[m.size, m.color].filter(Boolean).join(' · ')}
                                            {m.reason ? ` — ${m.reason}` : ''}
                                        </small>
                                    </span>
                                    <span className="inv-move-meta">
                                        {m.store_name && <span><StoreIcon size={10} />{m.store_name}</span>}
                                        <small>{(m.created_at || '').slice(5, 16).replace('-', '/')}</small>
                                    </span>
                                </li>
                            ))}
                            {movements.length === 0 && (
                                <li className="inv-moves-empty">{t('inv.noMoves')}</li>
                            )}
                        </ul>
                    </section>
                </aside>
            </div>

            {adjusting && (
                <AdjustDialog
                    line={adjusting}
                    userId={userId}
                    onClose={() => setAdjusting(null)}
                    onDone={() => { setAdjusting(null); load() }}
                />
            )}
            {losing && (
                <LossDialog
                    line={losing}
                    userId={userId}
                    onClose={() => setLosing(null)}
                    onDone={() => { setLosing(null); load() }}
                />
            )}
        </div>
    )
}

/* ------------------------------------------------------------------------- */

/** The size×colour lines behind one garment. This is the clothing-specific view
 *  a generic stock list cannot give: "18 in stock" is useless when 16 of them
 *  are XXL. */
function VariantMatrix({ lines, multiStore, onAdjust, onLoss }: {
    lines: StockOverviewRow[]
    multiStore: boolean
    onAdjust: (r: StockOverviewRow) => void
    onLoss: (r: StockOverviewRow) => void
}) {
    const { t } = useLanguage()
    return (
        <div className="inv-matrix">
            <table>
                <thead>
                    <tr>
                        <th>{t('ui2.size')} · {t('ui2.color')}</th>
                        <th>{t('ui2.sku')}</th>
                        {multiStore && <th>{t('ui.store')}</th>}
                        <th className="num">{t('nav.inventory')}</th>
                        <th className="num">{t('ui2.threshold')}</th>
                        <th className="num">{t('ui.value')}</th>
                        <th>{t('inv.lastOut')}</th>
                        <th aria-label="Actions" />
                    </tr>
                </thead>
                <tbody>
                    {lines.map(l => {
                        const tone = STATES.find(s => s.id === l.state)!
                        return (
                            <tr key={`${l.variant_id ?? 0}-${l.store_id ?? 0}`}>
                                <td>
                                    <span className={`inv-dot is-${tone.tone}`} title={t(tone.key)} />
                                    {variantLabel(l) || <span className="muted">{t('inv.simpleItem')}</span>}
                                </td>
                                <td className="muted mono">{l.sku || '—'}</td>
                                {multiStore && <td className="muted">{l.store_name || '—'}</td>}
                                <td className={`num strong ${l.quantity <= 0 ? 'is-zero' : ''}`}>
                                    {formatAmount(l.quantity)}
                                </td>
                                <td className="num muted">{l.min_stock_level || '—'}</td>
                                <td className="num">{formatCurrency(l.stock_value)}</td>
                                <td className="muted">
                                    {l.last_sale_at ? l.last_sale_at.slice(0, 10).split('-').reverse().join('/') : t('inv.never')}
                                </td>
                                <td className="num inv-matrix-actions">
                                    <button className="el-btn el-btn--ghost" onClick={() => onAdjust(l)}>
                                        <Sliders size={13} /> {t('inv.adjust')}
                                    </button>
                                    <button
                                        className="el-btn el-btn--ghost"
                                        onClick={() => onLoss(l)}
                                        disabled={l.quantity <= 0}
                                        title={l.quantity <= 0 ? t('inv.declareLoss') : undefined}
                                    >
                                        <TriangleAlert size={13} /> {t('inv.loss')}
                                    </button>
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}

/* ------------------------------------------------------------------------- */

function AdjustDialog({ line, userId, onClose, onDone }: {
    line: StockOverviewRow
    userId: number
    onClose: () => void
    onDone: () => void
}) {
    const { t } = useLanguage()
    const [qty, setQty] = useState(String(line.quantity))
    const [reason, setReason] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const next = Number(qty)
    const delta = Number.isFinite(next) ? next - line.quantity : 0

    const submit = async () => {
        if (!Number.isFinite(next) || next < 0) { setError('Quantité invalide.'); return }
        setBusy(true); setError('')
        try {
            const res = await window.electron.inventory.adjust({
                storeId: line.store_id ?? undefined,
                productId: line.product_id,
                variantId: line.variant_id,
                newQuantity: next,
                reason: reason.trim() || 'Ajustement manuel',
                userId,
            })
            if (!res.ok) { setError(res.message); return }
            onDone()
        } finally { setBusy(false) }
    }

    return (
        <div className="el-modal-overlay" onClick={onClose}>
            <div className="el-modal inv-dialog" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
                <div className="el-modal-head">
                    <h2>{t('inv.adjustStock')}</h2>
                    <button className="el-icon-btn el-modal-x" onClick={onClose} aria-label={t('ui.close')}>
                        <X size={18} />
                    </button>
                </div>
                <div className="el-modal-body">
                    <p className="inv-dialog-target">
                        <strong>{line.product_name}</strong>
                        <span>{variantLabel(line) || t('inv.simpleItem')}{line.store_name ? ` — ${line.store_name}` : ''}</span>
                    </p>

                    <div className="inv-dialog-grid">
                        <label className="el-field">
                            <span className="el-label">{t('inv.currentStock')}</span>
                            <input className="el-input tabular" value={formatAmount(line.quantity)} disabled />
                        </label>
                        <label className="el-field">
                            <span className="el-label">{t('inv.countedStock')}</span>
                            <input
                                className="el-input tabular"
                                type="number" min="0" step="1" autoFocus
                                value={qty}
                                onChange={e => { setQty(e.target.value); setError('') }}
                            />
                        </label>
                    </div>

                    {delta !== 0 && (
                        <p className={`inv-delta ${delta > 0 ? 'is-in' : 'is-out'}`}>
                            {delta > 0 ? '+' : ''}{formatAmount(delta)} pièce(s) —{' '}
                            {formatCurrency(Math.abs(delta) * line.unit_cost)} de {delta > 0 ? 'stock ajouté' : 'stock retiré'}
                        </p>
                    )}

                    <label className="el-field">
                        <span className="el-label">{t('ui.reason')}</span>
                        <input
                            className="el-input"
                            value={reason}
                            onChange={e => setReason(e.target.value)}
                            placeholder={t('inv.motifPh')}
                        />
                        {/* The movement ledger and the audit row both keep this. An
                            adjustment without a reason is indistinguishable from theft
                            when someone looks back in six months. */}
                        <span className="el-hint">{t('inv.auditNote')}</span>
                    </label>

                    {error && <span className="el-error-text">{error}</span>}
                </div>
                <div className="el-modal-foot">
                    <button className="el-btn el-btn--secondary" onClick={onClose}>{t('ui.cancelBtn')}</button>
                    <span className="el-spacer" />
                    <button className="el-btn el-btn--primary" onClick={submit} disabled={busy || delta === 0}>
                        {busy ? t('inv.saving') : t('inv.apply')}
                    </button>
                </div>
            </div>
        </div>
    )
}

const LOSS_REASONS = [
    { id: 'theft', key: 'inv.theft' },
    { id: 'damage', key: 'inv.damage' },
    { id: 'stain', key: 'inv.stain' },
    { id: 'expired', key: 'inv.expired' },
    { id: 'lost', key: 'inv.lost' },
    { id: 'other', key: 'inv.other' },
] as const

function LossDialog({ line, userId, onClose, onDone }: {
    line: StockOverviewRow
    userId: number
    onClose: () => void
    onDone: () => void
}) {
    const { t } = useLanguage()
    const [qty, setQty] = useState('1')
    const [reason, setReason] = useState<typeof LOSS_REASONS[number]['id']>('damage')
    const [notes, setNotes] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const n = Number(qty)
    const cost = Number.isFinite(n) ? n * line.unit_cost : 0

    const submit = async () => {
        if (!Number.isFinite(n) || n <= 0) { setError('Quantité invalide.'); return }
        if (n > line.quantity) { setError(`Seulement ${formatAmount(line.quantity)} en stock.`); return }
        setBusy(true); setError('')
        try {
            const res = await window.electron.loss.record({
                productId: line.product_id,
                variantId: line.variant_id,
                quantity: n,
                reason,
                notes: notes.trim() || undefined,
                userId,
            })
            if (!res?.success) { setError(res?.error || 'Enregistrement impossible.'); return }
            onDone()
        } finally { setBusy(false) }
    }

    return (
        <div className="el-modal-overlay" onClick={onClose}>
            <div className="el-modal inv-dialog" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
                <div className="el-modal-head">
                    <h2>{t('inv.declareLoss')}</h2>
                    <button className="el-icon-btn el-modal-x" onClick={onClose} aria-label={t('ui.close')}>
                        <X size={18} />
                    </button>
                </div>
                <div className="el-modal-body">
                    <p className="inv-dialog-target">
                        <strong>{line.product_name}</strong>
                        <span>{variantLabel(line) || t('inv.simpleItem')}{line.store_name ? ` — ${line.store_name}` : ''}</span>
                    </p>

                    <div className="inv-dialog-grid">
                        <label className="el-field">
                            <span className="el-label">{t('inv.lostQty')}</span>
                            <input
                                className="el-input tabular"
                                type="number" min="1" max={line.quantity} step="1" autoFocus
                                value={qty}
                                onChange={e => { setQty(e.target.value); setError('') }}
                            />
                        </label>
                        <label className="el-field">
                            <span className="el-label">{t('inv.motifReq')}</span>
                            <select className="el-select" value={reason}
                                onChange={e => setReason(e.target.value as typeof reason)}>
                                {LOSS_REASONS.map(r => <option key={r.id} value={r.id}>{t(r.key)}</option>)}
                            </select>
                        </label>
                    </div>

                    <p className="inv-delta is-out">
                        {t('inv.lossCost')} : {formatCurrency(cost)} — {t('inv.stockRemoved')}
                    </p>

                    <label className="el-field">
                        <span className="el-label">{t('inv.details')}</span>
                        <textarea className="el-textarea" value={notes}
                            onChange={e => setNotes(e.target.value)}
                            placeholder={t('inv.lossPh')} />
                    </label>

                    {error && <span className="el-error-text">{error}</span>}
                </div>
                <div className="el-modal-foot">
                    <button className="el-btn el-btn--secondary" onClick={onClose}>{t('ui.cancelBtn')}</button>
                    <span className="el-spacer" />
                    <button className="el-btn el-btn--danger" onClick={submit} disabled={busy}>
                        {busy ? t('inv.saving') : t('inv.saveLoss')}
                    </button>
                </div>
            </div>
        </div>
    )
}
