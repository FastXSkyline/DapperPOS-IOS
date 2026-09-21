import { useState, useEffect, useCallback, useMemo } from 'react'
import { Search, Receipt as ReceiptIcon, Store as StoreIcon } from 'lucide-react'
import type { ReceiptData } from '../../shared/types'
import { ReceiptPreview } from './ReceiptPreview'
import { ReturnsScreen } from './ReturnsScreen'
import { SettlementScreen } from './SettlementScreen'
import { useRetailEvents } from '../hooks/useRetailEvents'
import { formatCurrency } from '../utils/formatters'
import { useLanguage } from '../LanguageContext'
import './SalesScreen.css'

type Tab = 'history' | 'returns' | 'settlement'

const TABS: { id: Tab; key: string }[] = [
    { id: 'history', key: 'sale2.tabSales' },
    { id: 'returns', key: 'sale2.tabReturns' },
    { id: 'settlement', key: 'sale2.tabSettle' },
]

interface SaleRow {
    id: number
    transaction_number: string
    completed_at: string | null
    created_at: string
    customer_name: string | null
    user_id: number
    store_id: number | null
    total_amount: number
    discount_amount: number
    debt_status: string | null
}

/** Day boundary as the DB stores it. `created_at` is a local 'YYYY-MM-DD HH:MM:SS'
 *  string, so the filter has to compare in the same shape rather than in UTC —
 *  comparing against an ISO instant is how a shop in Algiers loses the first hour
 *  of every day from "aujourd'hui". */
function dayCutoff(daysBack: number): string {
    const d = new Date()
    d.setDate(d.getDate() - daysBack)
    d.setHours(0, 0, 0, 0)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 00:00:00`
}

const PRESETS = [
    { key: 0, tk: 'ui.today' },
    { key: 7, tk: 'ui.days7' },
    { key: 30, tk: 'ui.days30' },
    { key: 90, tk: 'ui.days90' },
] as const

/**
 * Ventes — what was sold, by whom, in which shop.
 *
 * The register the shop actually reaches for: a customer comes back with a
 * garment and the first question is always "when did you buy it". Returns and
 * settlements sit beside it as tabs because they are what you DO with a row you
 * just found.
 */
export function SalesScreen({ userId, storeId }: { userId: number; storeId: number | null }) {
    const { t } = useLanguage()
    const [tab, setTab] = useState<Tab>('history')
    const [rows, setRows] = useState<SaleRow[]>([])
    const [users, setUsers] = useState<Record<number, string>>({})
    const [stores, setStores] = useState<{ id: number; name: string }[]>([])
    const [scope, setScope] = useState<number | null>(storeId)
    const [days, setDays] = useState<number>(7)
    const [search, setSearch] = useState('')
    const [loading, setLoading] = useState(true)
    const [receipt, setReceipt] = useState<ReceiptData | null>(null)

    useEffect(() => {
        window.electron?.user?.getAll?.()
            .then((us: any[]) => setUsers(Object.fromEntries(us.map(u => [u.id, u.name]))))
            .catch(() => {})
        window.electron?.store?.list?.().then(setStores).catch(() => {})
    }, [])

    const load = useCallback(async () => {
        setLoading(true)
        try {
            // 500 is the working set a shop scrolls, not a page size — the filters
            // below narrow it client-side, which keeps the period buttons instant.
            setRows(await window.electron.transaction.getRecent(500) as unknown as SaleRow[])
        } catch (e) {
            console.error('[Ventes] load failed:', e)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])
    useRetailEvents(['sale.created', 'sale.returned'], load, { storeId: scope, delay: 600 })

    const storeName = useMemo(
        () => Object.fromEntries(stores.map(s => [s.id, s.name])),
        [stores],
    )

    const filtered = useMemo(() => {
        const cutoff = dayCutoff(days)
        const q = search.trim().toLowerCase()
        return rows.filter(r => {
            const when = r.completed_at || r.created_at
            if (when < cutoff) return false
            if (scope !== null && r.store_id !== scope) return false
            if (!q) return true
            return (
                r.transaction_number?.toLowerCase().includes(q) ||
                (r.customer_name || '').toLowerCase().includes(q) ||
                (users[r.user_id] || '').toLowerCase().includes(q)
            )
        })
    }, [rows, days, scope, search, users])

    const totals = useMemo(() => ({
        count: filtered.length,
        revenue: filtered.reduce((n, r) => n + (r.total_amount || 0), 0),
        basket: filtered.length ? filtered.reduce((n, r) => n + (r.total_amount || 0), 0) / filtered.length : 0,
    }), [filtered])

    const openReceipt = async (id: number) => {
        try {
            setReceipt(await window.electron.receipt.fromTransaction(id))
        } catch (e) {
            console.error('[Ventes] receipt failed:', e)
            alert(t('sale2.ticketMissing'))
        }
    }

    return (
        <div className="el-page sales-screen">
            <div className="el-tabs">
                {TABS.map(x => (
                    <button
                        key={x.id}
                        className={`el-tab ${tab === x.id ? 'active' : ''}`}
                        onClick={() => setTab(x.id)}
                    >
                        {t(x.key)}
                    </button>
                ))}
            </div>

            {tab === 'returns' && <ReturnsScreen userId={userId} storeId={storeId} />}
            {tab === 'settlement' && <SettlementScreen />}

            {tab === 'history' && (
                <>
                    <div className="el-grid el-grid--stats">
                        <div className="el-stat">
                            <span className="el-stat-label">{t('sale2.tabSales')}</span>
                            <span className="el-stat-value">{totals.count}</span>
                            <span className="el-stat-foot"><span className="el-stat-note">{t('sale2.onPeriod')}</span></span>
                        </div>
                        <div className="el-stat">
                            <span className="el-stat-label">{t('dash.revenue')}</span>
                            <span className="el-stat-value">{formatCurrency(totals.revenue)}</span>
                            <span className="el-stat-foot"><span className="el-stat-note">{t('sale2.ttcCashed')}</span></span>
                        </div>
                        <div className="el-stat">
                            <span className="el-stat-label">{t('dash.avgBasket')}</span>
                            <span className="el-stat-value">{formatCurrency(totals.basket)}</span>
                            <span className="el-stat-foot"><span className="el-stat-note">{t('sale2.perTicket')}</span></span>
                        </div>
                    </div>

                    <div className="sales-filters">
                        <div className="el-segmented">
                            {PRESETS.map(p => (
                                <button
                                    key={p.key}
                                    className={`el-seg ${days === p.key ? 'active' : ''}`}
                                    onClick={() => setDays(p.key)}
                                >
                                    {t(p.tk)}
                                </button>
                            ))}
                        </div>

                        <label className="el-search sales-search">
                            <Search size={15} />
                            <input
                                type="text"
                                placeholder={t('sale2.searchPh')}
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                aria-label={t('sale2.searchPh')}
                            />
                        </label>

                        <select
                            className="el-pill"
                            value={scope === null ? 'all' : scope}
                            onChange={e => setScope(e.target.value === 'all' ? null : Number(e.target.value))}
                            aria-label={t('ui.store')}
                        >
                            <option value="all">{t('ui.allStores')}</option>
                            {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    </div>

                    <div className="el-card el-card--pad0">
                        <div className="el-table-wrap">
                            <table className="el-table">
                                <thead>
                                    <tr>
                                        <th>{t('sale2.ticketNo')}</th>
                                        <th>{t('ui.date')}</th>
                                        <th>{t('ui2.client')}</th>
                                        <th>{t('ui2.seller')}</th>
                                        <th>{t('ui.store')}</th>
                                        <th className="num">{t('pos2.discount')}</th>
                                        <th className="num">{t('ui.total')}</th>
                                        <th>{t('sale2.payment')}</th>
                                        <th aria-label={t('ui.actionsCol')} />
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map(r => {
                                        const when = (r.completed_at || r.created_at || '').replace('T', ' ')
                                        const unpaid = r.debt_status === 'unpaid' || r.debt_status === 'partial'
                                        return (
                                            <tr key={r.id}>
                                                <td className="strong">{r.transaction_number}</td>
                                                <td className="muted">{when.slice(0, 16)}</td>
                                                <td>{r.customer_name || <span className="muted">{t('sale2.counter')}</span>}</td>
                                                <td className="muted">{users[r.user_id] || '—'}</td>
                                                <td className="muted">
                                                    {r.store_id != null && storeName[r.store_id] ? (
                                                        <span className="sales-store"><StoreIcon size={13} />{storeName[r.store_id]}</span>
                                                    ) : '—'}
                                                </td>
                                                <td className="num muted">
                                                    {r.discount_amount > 0 ? `−${formatCurrency(r.discount_amount)}` : '—'}
                                                </td>
                                                <td className="num strong">{formatCurrency(r.total_amount)}</td>
                                                <td>
                                                    <span className={`el-chip ${unpaid ? 'el-chip--warn' : 'el-chip--ok'}`}>
                                                        {unpaid ? (r.debt_status === 'partial' ? t('sale2.partial') : t('sale2.credit')) : t('sale2.paid')}
                                                    </span>
                                                </td>
                                                <td className="num">
                                                    <button
                                                        className="el-icon-btn"
                                                        onClick={() => openReceipt(r.id)}
                                                        title={t('sale2.viewTicket')}
                                                        aria-label={`Ticket ${r.transaction_number}`}
                                                    >
                                                        <ReceiptIcon size={16} />
                                                    </button>
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>

                            {!loading && filtered.length === 0 && (
                                <div className="el-empty">
                                    <span className="el-empty-icon"><ReceiptIcon size={22} /></span>
                                    <strong>{t('sale2.noSales')}</strong>
                                    <span>{t('sale2.noSalesHint')}</span>
                                </div>
                            )}
                            {loading && <div className="el-empty">{t('ui.loading')}</div>}
                        </div>

                        {filtered.length > 0 && (
                            <div className="el-table-foot">
                                {filtered.length} {t('ui.salesLabel')}
                                <span className="el-page-actions el-money">
                                    {t('ui.total')} {formatCurrency(totals.revenue)}
                                </span>
                            </div>
                        )}
                    </div>
                </>
            )}

            {receipt && (
                <ReceiptPreview
                    data={receipt}
                    onClose={() => setReceipt(null)}
                    onPrint={async () => { await window.electron.receipt.print(receipt) }}
                />
            )}
        </div>
    )
}
