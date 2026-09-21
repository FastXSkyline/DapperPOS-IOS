import { useState, useEffect, useCallback, useMemo } from 'react'
import {
    LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
    XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { TrendingUp, TrendingDown, Minus, Building2, Info } from 'lucide-react'
import { formatCurrency, formatDateISO } from '../utils/formatters'
import type { AnalyticsSummary, StoreComparisonRow, Delta, Period } from '../vite-env'
import { useRetailEvents } from '../hooks/useRetailEvents'
import { TargetsPanel } from './TargetsPanel'
import './RetailReports.css'

interface Props {
    storeId: number | null
    userId: number
    /** Only an owner may set targets; the server enforces it too. */
    canManageTargets: boolean
}

/** Recharts needs resolved colours for SVG fills — kept in sync with tokens.css. */
const RAMP_LIGHT = ['#4F46E5', '#EA580C', '#0D9488', '#CA8A04', '#0EA5E9', '#65A30D', '#7C3AED', '#DB2777']
const RAMP_DARK = ['#6366F1', '#F97316', '#14B8A6', '#EAB308', '#0EA5E9', '#84CC16', '#8B5CF6', '#EC4899']

function useTheme() {
    const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark')
    useEffect(() => {
        const el = document.documentElement
        const obs = new MutationObserver(() => setDark(el.dataset.theme === 'dark'))
        obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
        return () => obs.disconnect()
    }, [])
    return {
        dark,
        ramp: dark ? RAMP_DARK : RAMP_LIGHT,
        // One ink for every SINGLE-series chart. Sizes, hours and store totals are
        // ordered or one-dimensional: giving each bar its own hue would imply an
        // identity the data does not have.
        ink: dark ? '#6366F1' : '#4F46E5',
        grid: dark ? 'rgba(255,255,255,0.07)' : '#EDEFF5',
        axis: dark ? '#6C7286' : '#9AA0AE',
        surface: dark ? '#171922' : '#FFFFFF',
    }
}

const PRESETS = [
    { key: 'today', label: "Aujourd'hui", days: 0 },
    { key: 'week', label: '7 jours', days: 7 },
    { key: 'month', label: '30 jours', days: 30 },
    { key: 'quarter', label: '90 jours', days: 90 },
    { key: 'year', label: '12 mois', days: 365 },
] as const

/** Start/end of a preset, plus the immediately preceding window of equal length —
 *  equal length on purpose, so a comparison never reports a fall that is only the
 *  calendar (28 days against 31). */
function windowsFor(days: number) {
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - days)
    const prevEnd = new Date(start)
    prevEnd.setDate(prevEnd.getDate() - 1)
    const prevStart = new Date(prevEnd)
    prevStart.setDate(prevStart.getDate() - days)
    return {
        current: { from: formatDateISO(start), to: `${formatDateISO(end)} 23:59:59` },
        previous: { from: formatDateISO(prevStart), to: `${formatDateISO(prevEnd)} 23:59:59` },
    }
}

function DeltaChip({ d, invert = false }: { d: Delta; invert?: boolean }) {
    if (d.percent === null) {
        return <span className="rr-delta none" title="Aucune donnée sur la période précédente">nouveau</span>
    }
    const up = d.percent > 0.05
    const down = d.percent < -0.05
    // `invert` for metrics where a rise is bad (returns): the arrow still shows the
    // direction, but the colour shows whether that direction is good.
    const good = invert ? down : up
    const Icon = up ? TrendingUp : down ? TrendingDown : Minus
    return (
        <span className={`rr-delta ${up || down ? (good ? 'good' : 'bad') : 'flat'}`}>
            <Icon size={13} />
            {d.percent > 0 ? '+' : ''}{d.percent.toFixed(1)} %
        </span>
    )
}

export function RetailReports({ storeId, userId, canManageTargets }: Props) {
    const theme = useTheme()
    const [preset, setPreset] = useState<number>(30)
    const [scope, setScope] = useState<number | null>(storeId)
    const [stores, setStores] = useState<{ id: number; name: string }[]>([])
    const [loading, setLoading] = useState(true)

    const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
    const [comparison, setComparison] = useState<Record<string, Delta> | null>(null)
    const [byDay, setByDay] = useState<{ day: string; revenue: number; transactions: number }[]>([])
    const [bySize, setBySize] = useState<{ label: string; units: number; revenue: number }[]>([])
    const [byColor, setByColor] = useState<{ label: string; hex: string | null; units: number; revenue: number }[]>([])
    const [byHour, setByHour] = useState<{ hour: number; transactions: number; revenue: number; items: number }[]>([])
    const [storeRows, setStoreRows] = useState<StoreComparisonRow[]>([])
    const [storeMetric, setStoreMetric] = useState<'netRevenue' | 'grossProfit' | 'transactions' | 'avgBasket'>('netRevenue')
    const [staff, setStaff] = useState<any[]>([])
    const [mix, setMix] = useState<{ newCustomers: number; returningCustomers: number; totalCustomers: number; walkInSales: number } | null>(null)
    const [topVariants, setTopVariants] = useState<{ product_name: string; size: string; color: string; units: number; revenue: number }[]>([])

    const windows = useMemo(() => windowsFor(preset), [preset])
    const period: Period = useMemo(
        () => ({ ...windows.current, storeId: scope }),
        [windows, scope])

    useEffect(() => {
        window.electron?.store?.list?.().then(setStores).catch(() => {})
    }, [])

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const [s, cmp, day, size, color, hour, storesCmp, staffRows, mixRow, variants] = await Promise.all([
                window.electron.analytics.summary(period),
                window.electron.analytics.periodComparison(period, { ...windows.previous, storeId: scope }),
                window.electron.analytics.revenueByDay(period),
                window.electron.analytics.bySize(period),
                window.electron.analytics.byColor(period),
                window.electron.analytics.byHour(period),
                window.electron.analytics.storeComparison(windows.current),
                window.electron.analytics.employees(period),
                window.electron.analytics.customerMix(period),
                window.electron.analytics.topVariants(period, 10),
            ])
            setSummary(s)
            setComparison(cmp as unknown as Record<string, Delta>)
            setByDay(day); setBySize(size); setByColor(color); setByHour(hour)
            setStoreRows(storesCmp)
            setStaff(staffRows)
            setMix(mixRow)
            setTopVariants(variants)
        } catch (e) {
            console.error('[Reports] load failed:', e)
        } finally {
            setLoading(false)
        }
    }, [period, windows, scope])

    useEffect(() => { load() }, [load])

    // Longer debounce than the operational screens: a report is a summary, and
    // recomputing eight aggregate queries on every till keystroke is waste.
    useRetailEvents(['sale.created', 'sale.returned', 'inventory.updated'], load, { storeId: scope, delay: 1500 })

    const staffRevenue = staff.reduce((n, r) => n + (r.revenue || 0), 0)
    const colorTotal = byColor.reduce((n, c) => n + c.units, 0)
    const sizeTotal = bySize.reduce((n, s) => n + s.units, 0)

    const tooltipStyle = {
        background: theme.surface,
        border: `1px solid ${theme.grid}`,
        borderRadius: 8,
        fontSize: 12,
        color: theme.dark ? '#F2F3F7' : '#14161F',
    }

    if (loading && !summary) return <div className="rr-screen"><div className="rr-state">Chargement…</div></div>

    return (
        <div className="rr-screen">
            <header className="rr-header">
                <div>
                    <h1>Rapports</h1>
                    <p>
                        Comparé à la période précédente de même durée. « Bénéfice brut » = CA net −
                        coût d’achat : les charges ne sont pas déduites.
                    </p>
                </div>
                <div className="rr-filters">
                    <div className="rr-presets">
                        {PRESETS.map(p => (
                            <button key={p.key} className={preset === p.days ? 'active' : ''}
                                onClick={() => setPreset(p.days)}>{p.label}</button>
                        ))}
                    </div>
                    <div className="rr-scope">
                        <Building2 size={15} />
                        <select value={scope === null ? 'all' : scope}
                            onChange={e => setScope(e.target.value === 'all' ? null : Number(e.target.value))}>
                            <option value="all">Tous les magasins</option>
                            {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    </div>
                </div>
            </header>

            {/* KPI row. Each headline carries its change against the previous window —
                a number with no baseline cannot be acted on. */}
            <section className="rr-kpis">
                <article className="rr-kpi">
                    <span>CA net</span>
                    <strong>{formatCurrency(summary?.netRevenue ?? 0)}</strong>
                    {comparison && <DeltaChip d={comparison.revenue} />}
                    <em>brut {formatCurrency(summary?.grossRevenue ?? 0)} − retours {formatCurrency(summary?.returnsValue ?? 0)}</em>
                </article>
                <article className="rr-kpi">
                    <span>Bénéfice brut</span>
                    <strong>{formatCurrency(summary?.grossProfit ?? 0)}</strong>
                    {comparison && <DeltaChip d={comparison.grossProfit} />}
                    <em>marge {(summary?.grossMargin ?? 0).toFixed(1)} %</em>
                </article>
                <article className="rr-kpi">
                    <span>Ventes</span>
                    <strong>{(summary?.transactions ?? 0).toLocaleString('fr-FR')}</strong>
                    {comparison && <DeltaChip d={comparison.transactions} />}
                    <em>{(summary?.itemsSold ?? 0).toLocaleString('fr-FR')} articles</em>
                </article>
                <article className="rr-kpi">
                    <span>Panier moyen</span>
                    <strong>{formatCurrency(summary?.avgBasket ?? 0)}</strong>
                    {comparison && <DeltaChip d={comparison.avgBasket} />}
                </article>
                <article className="rr-kpi">
                    <span>Retours / échanges</span>
                    <strong>{(summary?.returnsCount ?? 0)}</strong>
                    {comparison && <DeltaChip d={comparison.returnsValue} invert />}
                    <em>{(summary?.returnRate ?? 0).toFixed(1)} % des ventes</em>
                </article>
            </section>

            {/* Says out loud when part of the margin is an estimate, rather than
                presenting a guess with the same authority as a measurement. */}
            {(summary?.estimatedCostLines ?? 0) > 0 && (
                <div className="rr-caveat">
                    <Info size={15} />
                    {summary!.estimatedCostLines} ligne(s) de vente n’ont pas de coût d’achat figé
                    (ventes antérieures à cette version). Leur marge est estimée au coût actuel et
                    bougera si le prix d’achat change.
                </div>
            )}

            <TargetsPanel userId={userId} storeId={scope} canEdit={canManageTargets} />

            <div className="rr-grid">
                <section className="rr-card wide">
                    <h2>Évolution du chiffre d’affaires</h2>
                    {byDay.length === 0 ? <p className="rr-empty">Aucune vente sur la période.</p> : (
                        <ResponsiveContainer width="100%" height={240}>
                            <LineChart data={byDay} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                                <CartesianGrid stroke={theme.grid} vertical={false} />
                                <XAxis dataKey="day" tick={{ fontSize: 11, fill: theme.axis }}
                                    tickLine={false} axisLine={{ stroke: theme.grid }}
                                    tickFormatter={d => d.slice(5)} />
                                <YAxis tick={{ fontSize: 11, fill: theme.axis }} tickLine={false}
                                    axisLine={false} width={64}
                                    tickFormatter={v => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} />
                                <Tooltip contentStyle={tooltipStyle}
                                    formatter={(v: number | undefined) => [formatCurrency(v ?? 0), 'CA']} />
                                {/* One series, one ink, no legend — the title names it. */}
                                <Line type="monotone" dataKey="revenue" stroke={theme.ink}
                                    strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                            </LineChart>
                        </ResponsiveContainer>
                    )}
                </section>

                <section className="rr-card">
                    <h2>Ventes par taille</h2>
                    {bySize.length === 0 ? <p className="rr-empty">Aucune vente par taille.</p> : (
                        <>
                            {/* Ordered by the size scale, never by value: sorting by units
                                would destroy the only thing this chart is for — seeing
                                WHERE in the range demand sits. */}
                            <ResponsiveContainer width="100%" height={210}>
                                <BarChart data={bySize} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
                                    <CartesianGrid stroke={theme.grid} vertical={false} />
                                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: theme.axis }}
                                        tickLine={false} axisLine={{ stroke: theme.grid }} />
                                    <YAxis tick={{ fontSize: 11, fill: theme.axis }} tickLine={false} axisLine={false} width={36} />
                                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: theme.grid }}
                                        formatter={(v: number | undefined) => [`${v ?? 0} article(s)`, 'Vendus']} />
                                    <Bar dataKey="units" fill={theme.ink} radius={[4, 4, 0, 0]} maxBarSize={38} />
                                </BarChart>
                            </ResponsiveContainer>
                            <table className="rr-mini">
                                <tbody>
                                    {bySize.map(s => (
                                        <tr key={s.label}>
                                            <td>{s.label}</td>
                                            <td className="num">{s.units}</td>
                                            <td className="num muted">
                                                {sizeTotal ? ((s.units / sizeTotal) * 100).toFixed(0) : 0} %
                                            </td>
                                            <td className="num">{formatCurrency(s.revenue)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </>
                    )}
                </section>

                <section className="rr-card">
                    <h2>Ventes par couleur</h2>
                    {byColor.length === 0 ? <p className="rr-empty">Aucune vente par couleur.</p> : (
                        <>
                            {/* The category IS a colour, so the swatch is the honest encoding.
                                It is never the only one: every slice is also named with its
                                share in the legend below, and white gets a ring so it does
                                not vanish on a white card. */}
                            <ResponsiveContainer width="100%" height={190}>
                                <PieChart>
                                    <Pie data={byColor} dataKey="units" nameKey="label"
                                        cx="50%" cy="50%" innerRadius={52} outerRadius={78} paddingAngle={2}>
                                        {byColor.map((c, i) => (
                                            <Cell key={c.label}
                                                fill={c.hex ?? theme.ramp[Math.min(i, theme.ramp.length - 1)]}
                                                stroke={theme.surface} strokeWidth={2} />
                                        ))}
                                    </Pie>
                                    <Tooltip contentStyle={tooltipStyle}
                                        formatter={(v: number | undefined, n) => [`${v ?? 0} article(s)`, n]} />
                                </PieChart>
                            </ResponsiveContainer>
                            <ul className="rr-legend">
                                {byColor.slice(0, 8).map((c, i) => (
                                    <li key={c.label}>
                                        <i style={{ background: c.hex ?? theme.ramp[Math.min(i, theme.ramp.length - 1)] }} />
                                        <span>{c.label}</span>
                                        <b>{colorTotal ? ((c.units / colorTotal) * 100).toFixed(0) : 0} %</b>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </section>

                <section className="rr-card wide">
                    <h2>Heures de forte affluence</h2>
                    {/* All 24 hours, including the empty ones — omitting the quiet hours
                        closes the gap and makes a slow afternoon look busy. */}
                    <ResponsiveContainer width="100%" height={190}>
                        <BarChart data={byHour} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                            <CartesianGrid stroke={theme.grid} vertical={false} />
                            <XAxis dataKey="hour" tick={{ fontSize: 10, fill: theme.axis }}
                                tickLine={false} axisLine={{ stroke: theme.grid }}
                                tickFormatter={h => `${String(h).padStart(2, '0')}h`} interval={1} />
                            <YAxis tick={{ fontSize: 11, fill: theme.axis }} tickLine={false} axisLine={false} width={36} />
                            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: theme.grid }}
                                labelFormatter={h => `${String(h).padStart(2, '0')}h00`}
                                formatter={(v: number | undefined) => [`${v ?? 0} vente(s)`, 'Transactions']} />
                            <Bar dataKey="transactions" fill={theme.ink} radius={[4, 4, 0, 0]} maxBarSize={22} />
                        </BarChart>
                    </ResponsiveContainer>
                </section>

                {/* Performance de chaque vendeur. The service and the IPC for this
                    existed from the start and nothing rendered them, so the figure
                    an owner asks for most often — who actually sells — was
                    unreachable. Attribution follows the SALE, so a return is charged
                    to whoever made the original sale. */}
                <section className="rr-card wide">
                    <div className="rr-card-head">
                        <h2>Performance des vendeurs</h2>
                    </div>
                    {staff.length === 0 ? <p className="rr-empty">Aucune vente sur la période.</p> : (
                        <table className="rr-table">
                            <thead>
                                <tr>
                                    <th>Vendeur</th>
                                    <th className="num">Ventes</th>
                                    <th className="num">Articles</th>
                                    <th className="num">CA</th>
                                    <th className="num">Panier moyen</th>
                                    <th className="num">Remises</th>
                                    <th className="num">Retours traités</th>
                                    <th className="num">Part du CA</th>
                                </tr>
                            </thead>
                            <tbody>
                                {staff.map(r => (
                                    <tr key={r.user_id}>
                                        <td>{r.user_name}</td>
                                        <td className="num">{r.transactions}</td>
                                        <td className="num muted">{r.items_sold}</td>
                                        <td className="num">{formatCurrency(r.revenue)}</td>
                                        <td className="num">{formatCurrency(r.avg_basket)}</td>
                                        <td className="num muted">{formatCurrency(r.discounts)}</td>
                                        <td className="num muted">{r.returns_handled}</td>
                                        <td className="num">
                                            {staffRevenue ? Math.round((r.revenue / staffRevenue) * 100) : 0} %
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </section>

                {/* Nouveaux vs fidèles. "New" means the customer's FIRST EVER sale,
                    not their first in this window — otherwise a long-standing
                    customer looks new every time the window is short. */}
                <section className="rr-card">
                    <div className="rr-card-head">
                        <h2>Nouveaux clients et fidèles</h2>
                    </div>
                    {!mix || mix.totalCustomers === 0 ? (
                        <p className="rr-empty">Aucun client identifié sur la période.</p>
                    ) : (
                        <>
                            <ResponsiveContainer width="100%" height={190}>
                                <PieChart>
                                    <Pie
                                        data={[
                                            { label: 'Nouveaux', value: mix.newCustomers },
                                            { label: 'Fidèles', value: mix.returningCustomers },
                                        ]}
                                        dataKey="value"
                                        nameKey="label"
                                        cx="50%" cy="50%"
                                        innerRadius={52} outerRadius={78} paddingAngle={2}
                                    >
                                        <Cell fill={theme.ramp[0]} stroke={theme.surface} strokeWidth={2} />
                                        <Cell fill={theme.ramp[1]} stroke={theme.surface} strokeWidth={2} />
                                    </Pie>
                                    <Tooltip
                                        contentStyle={tooltipStyle}
                                        formatter={(v: number | undefined, n) => [`${v ?? 0} client(s)`, n]}
                                    />
                                </PieChart>
                            </ResponsiveContainer>
                            <ul className="rr-legend">
                                <li>
                                    <i style={{ background: theme.ramp[0] }} />
                                    <span>Nouveaux clients</span><b>{mix.newCustomers}</b>
                                </li>
                                <li>
                                    <i style={{ background: theme.ramp[1] }} />
                                    <span>Clients fidèles</span><b>{mix.returningCustomers}</b>
                                </li>
                            </ul>
                            {/* Counted apart, never folded into "new": an anonymous
                                counter sale is not a customer you acquired. */}
                            <p className="rr-caveat" style={{ marginTop: 12 }}>
                                <Info size={14} />
                                {mix.walkInSales} vente(s) au comptoir sans client identifié.
                            </p>
                        </>
                    )}
                </section>

                {/* Which SIZE and COLOUR actually moves — the question a clothing
                    shop reorders on. */}
                <section className="rr-card">
                    <div className="rr-card-head">
                        <h2>Variantes les plus vendues</h2>
                    </div>
                    {topVariants.length === 0 ? <p className="rr-empty">Aucune vente par variante.</p> : (
                        <table className="rr-mini">
                            <tbody>
                                {topVariants.map((v, i) => (
                                    <tr key={i}>
                                        <td>{v.product_name}</td>
                                        <td className="muted">{[v.size, v.color].filter(Boolean).join(' · ')}</td>
                                        <td className="num">{v.units}</td>
                                        <td className="num muted">{formatCurrency(v.revenue)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </section>

                <section className="rr-card wide">
                    <div className="rr-card-head">
                        <h2>Comparaison des magasins</h2>
                        <div className="rr-metric">
                            {([
                                ['netRevenue', 'CA net'], ['grossProfit', 'Bénéfice'],
                                ['transactions', 'Ventes'], ['avgBasket', 'Panier moyen'],
                            ] as const).map(([k, label]) => (
                                <button key={k} className={storeMetric === k ? 'active' : ''}
                                    onClick={() => setStoreMetric(k)}>{label}</button>
                            ))}
                        </div>
                    </div>

                    {/* One metric at a time, one ink. Two metrics of different scale on
                        one chart would need two y-axes, which is the single worst thing
                        a chart can do — two charts or a toggle instead. */}
                    <ResponsiveContainer width="100%" height={Math.max(120, storeRows.length * 52)}>
                        <BarChart data={storeRows} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 4 }}>
                            <CartesianGrid stroke={theme.grid} horizontal={false} />
                            <XAxis type="number" tick={{ fontSize: 11, fill: theme.axis }} tickLine={false}
                                axisLine={false}
                                tickFormatter={v => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} />
                            <YAxis type="category" dataKey="storeName" width={96}
                                tick={{ fontSize: 12, fill: theme.axis }} tickLine={false} axisLine={false} />
                            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: theme.grid }}
                                formatter={(v: number | undefined) => [
                                    storeMetric === 'transactions' ? String(v ?? 0) : formatCurrency(v ?? 0),
                                    'Valeur',
                                ]} />
                            <Bar dataKey={storeMetric} fill={theme.ink} radius={[0, 4, 4, 0]} maxBarSize={30} />
                        </BarChart>
                    </ResponsiveContainer>

                    {/* The table is the point for a back office: every metric at once,
                        which no single chart can honestly show. */}
                    <table className="rr-table">
                        <thead>
                            <tr>
                                <th>Magasin</th><th className="num">CA net</th><th className="num">Bénéfice</th>
                                <th className="num">Marge</th><th className="num">Ventes</th>
                                <th className="num">Panier</th><th className="num">Retours</th>
                                <th className="num">Nouveaux</th><th className="num">Fidèles</th>
                                <th className="num">Stock</th>
                            </tr>
                        </thead>
                        <tbody>
                            {storeRows.map(r => (
                                <tr key={r.storeId}>
                                    <td>{r.storeName}</td>
                                    <td className="num">{formatCurrency(r.netRevenue)}</td>
                                    <td className="num">{formatCurrency(r.grossProfit)}</td>
                                    <td className="num muted">{r.grossMargin.toFixed(1)} %</td>
                                    <td className="num">{r.transactions}</td>
                                    <td className="num">{formatCurrency(r.avgBasket)}</td>
                                    <td className="num muted">{r.returnsCount}</td>
                                    <td className="num">{r.newCustomers}</td>
                                    <td className="num">{r.returningCustomers}</td>
                                    <td className="num muted">{formatCurrency(r.stockValue)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            </div>
        </div>
    )
}
