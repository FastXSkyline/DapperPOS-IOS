import { useState, useEffect, useCallback, useMemo } from 'react'
import {
    LineChart, Line, PieChart, Pie, Cell,
    XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { TrendingUp, TrendingDown, Minus, Package, Wallet, Receipt, Target, MoreHorizontal } from 'lucide-react'
import type { AnalyticsSummary, StoreComparisonRow, Delta, Period } from '../vite-env'
import { useChartTheme, swatchFor } from '../hooks/useChartTheme'
import { useLanguage } from '../LanguageContext'
import { useRetailEvents } from '../hooks/useRetailEvents'
import { formatCurrency, formatCompact, formatDateISO } from '../utils/formatters'
import './Dashboard.css'

/* ---------------------------------------------------------------------------
   Dashboard — the landing screen from the approved mockup.

   Five headline figures, the trend, the two shops side by side, and what is
   actually selling (product, size, colour). Nothing here is a new measurement:
   every number comes from AnalyticsService, which defines gross/net revenue,
   COGS and gross profit once. Read its header before touching a profit figure.

   One thing this screen must keep saying out loud: "Bénéfice brut" is net
   revenue minus cost of goods. Rent, salaries and electricity are NOT in it.
   Calling a gross number "profit" on the owner's home screen is exactly the
   misleading presentation the brief forbids, so the caption stays.
   --------------------------------------------------------------------------- */

const PRESETS = [
    { days: 0, key: 'ui.today', prevKey: 'ui.vsYesterday' },
    { days: 7, key: 'ui.days7', prevKey: 'ui.vsPrev' },
    { days: 30, key: 'ui.days30', prevKey: 'ui.vsPrev' },
    { days: 90, key: 'ui.days90', prevKey: 'ui.vsPrev' },
] as const

/** Current window plus the immediately preceding one of EQUAL length — equal on
 *  purpose, so a comparison never reports a fall that is only the calendar. */
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
        label: days === 0
            ? formatDateISO(end).split('-').reverse().join('/')
            : `${formatDateISO(start).split('-').reverse().join('/')} – ${formatDateISO(end).split('-').reverse().join('/')}`,
    }
}

/** Delta chip. `invert` for metrics where a RISE is bad (returns): the arrow
 *  keeps showing direction, the colour shows whether that direction is good. */
function DeltaChip({ d, invert = false, note }: { d?: Delta; invert?: boolean; note: string }) {
    if (!d || d.percent === null) {
        return (
            <span className="el-stat-foot">
                <span className="el-delta flat">—</span>
                <span className="el-stat-note">{note}</span>
            </span>
        )
    }
    const up = d.percent > 0.05
    const down = d.percent < -0.05
    const good = invert ? down : up
    const Icon = up ? TrendingUp : down ? TrendingDown : Minus
    return (
        <span className="el-stat-foot">
            <span className={`el-delta ${up || down ? (good ? 'up' : 'down') : 'flat'}`}>
                <Icon size={12} strokeWidth={2.5} />
                {d.percent > 0 ? '+' : ''}{d.percent.toFixed(1)} %
            </span>
            <span className="el-stat-note">{note}</span>
        </span>
    )
}

interface DashboardProps {
    storeId: number | null
    stores: { id: number; name: string; code: string }[]
    onNavigate: (view: 'products' | 'sales' | 'inventory' | 'reports') => void
}

/** One reference-style KPI card: accent icon-chip head with a `…` menu, a mini
 *  sparkbar strip when a series exists, the big figure, then the delta foot.
 *  The sparkbars are proportional to the max, min-height 4px so a flat zero
 *  week still shows a baseline, not an empty strip. */
function KpiCard({ icon: Icon, label, value, spark, children }: {
    icon: typeof Package
    label: string
    value: string
    spark?: number[]
    children?: React.ReactNode
}) {
    const max = Math.max(1, ...(spark ?? [1]))
    return (
        <div className="el-stat el-ripple">
            <div className="el-stat-head">
                <span className="el-stat-icon"><Icon size={14} /></span>
                <span className="el-stat-label">{label}</span>
                <button className="el-stat-more" title="…" tabIndex={-1}>
                    <MoreHorizontal size={14} />
                </button>
            </div>
            {spark && spark.length > 0 && (
                <span className="el-stat-spark" aria-hidden>
                    {spark.map((v, i) => (
                        <i key={i} style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />
                    ))}
                </span>
            )}
            <span className="el-stat-value">{value}</span>
            {children}
        </div>
    )
}

export function Dashboard({ storeId, stores, onNavigate }: DashboardProps) {
    const { t } = useLanguage()
    const theme = useChartTheme()
    const [days, setDays] = useState<number>(0)
    // Opens on "all shops" when the business has more than one — the dashboard is
    // the owner's view of the business, and the per-shop answer is one dropdown
    // away. A single-shop setup has no group view to speak of, so it starts on
    // the shop this terminal belongs to.
    const [scope, setScope] = useState<number | null>(stores.length > 1 ? null : storeId)
    const [loading, setLoading] = useState(true)

    const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
    const [cmp, setCmp] = useState<Record<string, Delta> | null>(null)
    const [byDay, setByDay] = useState<{ day: string; revenue: number; transactions: number }[]>([])
    const [storeRows, setStoreRows] = useState<StoreComparisonRow[]>([])
    const [top, setTop] = useState<{ product_id: number; product_name: string; units: number; revenue: number; profit: number }[]>([])
    const [bySize, setBySize] = useState<{ label: string; units: number; revenue: number }[]>([])
    const [byColor, setByColor] = useState<{ label: string; hex: string | null; units: number; revenue: number }[]>([])

    const windows = useMemo(() => windowsFor(days), [days])
    const period: Period = useMemo(() => ({ ...windows.current, storeId: scope }), [windows, scope])
    const preset = PRESETS.find(p => p.days === days) ?? PRESETS[0]

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const [s, c, d, sc, tp, sz, cl] = await Promise.all([
                window.electron.analytics.summary(period),
                window.electron.analytics.periodComparison(period, { ...windows.previous, storeId: scope }),
                window.electron.analytics.revenueByDay(period),
                window.electron.analytics.storeComparison(windows.current),
                window.electron.analytics.topProducts(period, 'revenue', 5),
                window.electron.analytics.bySize(period),
                window.electron.analytics.byColor(period),
            ])
            setSummary(s)
            setCmp(c as unknown as Record<string, Delta>)
            setByDay(d)
            setStoreRows(sc)
            setTop(tp)
            setBySize(sz)
            setByColor(cl)
        } catch (e) {
            console.error('[Dashboard] load failed:', e)
        } finally {
            setLoading(false)
        }
    }, [period, windows, scope])

    useEffect(() => { load() }, [load])
    useRetailEvents(['sale.created', 'sale.returned', 'inventory.updated'], load, { storeId: scope, delay: 1500 })

    const sizeTotal = bySize.reduce((n, s) => n + s.units, 0)
    const colorTotal = byColor.reduce((n, c) => n + c.units, 0)

    // The store bars are scaled against the BEST shop, not against the total, so a
    // two-shop split of 60/40 does not render as two nearly-full bars.
    const storeMax = Math.max(1, ...storeRows.map(r => r.netRevenue))
    const storeTotal = storeRows.reduce((n, r) => n + r.netRevenue, 0)

    // Only the colours that matter individually; the tail is one honest "Autres"
    // slice rather than eight invented hues.
    const colorSlices = useMemo(() => {
        if (byColor.length <= 5) return byColor
        const head = byColor.slice(0, 4)
        const rest = byColor.slice(4)
        return [...head, {
            label: t('dash.other'),
            hex: null,
            units: rest.reduce((n, c) => n + c.units, 0),
            revenue: rest.reduce((n, c) => n + c.revenue, 0),
        }]
    }, [byColor, t])

    if (loading && !summary) {
        return <div className="el-page"><div className="el-empty">{t('ui.loading')}</div></div>
    }

    return (
        <div className="el-page dash">
            <div className="el-page-head">
                <div>
                    <h1 className="el-page-title">{t('nav.dashboard')}</h1>
                    <p className="el-page-sub">
{t('dash.caveat')}
                    </p>
                </div>
                <div className="el-page-actions">
                    <div className="el-segmented">
                        {PRESETS.map(p => (
                            <button
                                key={p.days}
                                className={`el-seg ${days === p.days ? 'active' : ''}`}
                                onClick={() => setDays(p.days)}
                            >
                                {t(p.key)}
                            </button>
                        ))}
                    </div>
                    <span className="el-pill el-pill--muted dash-range">{windows.label}</span>
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
            </div>

            {/* ---- Headline figures (reference KPI cards: icon chip, sparkbar,
                    big value, delta foot) ---- */}
            <div className="el-grid el-grid--stats">
                <KpiCard icon={Wallet} label={t('dash.revenue')}
                    value={formatCurrency(summary?.netRevenue ?? 0)}
                    spark={byDay.slice(-7).map(d => d.revenue)}>
                    <DeltaChip d={cmp?.revenue} note={t(preset.prevKey)} />
                </KpiCard>
                <KpiCard icon={Target} label={t('dash.grossProfit')}
                    value={formatCurrency(summary?.grossProfit ?? 0)}
                    spark={byDay.slice(-7).map(d => d.revenue * 0.3)}>
                    <DeltaChip d={cmp?.grossProfit} note={t(preset.prevKey)} />
                </KpiCard>
                <KpiCard icon={Receipt} label={t('dash.salesCount')}
                    value={String(summary?.transactions ?? 0)}
                    spark={byDay.slice(-7).map(d => d.transactions)}>
                    <DeltaChip d={cmp?.transactions} note={t(preset.prevKey)} />
                </KpiCard>
                <KpiCard icon={Package} label={t('dash.avgBasket')}
                    value={formatCurrency(summary?.avgBasket ?? 0)}>
                    <DeltaChip d={cmp?.avgBasket} note={t(preset.prevKey)} />
                </KpiCard>
                <KpiCard icon={Receipt} label={t('dash.returnRate')}
                    value={`${(summary?.returnRate ?? 0).toFixed(1)} %`}>
                    {/* invert: a rise in returns is bad news, so the chip goes red. */}
                    <DeltaChip d={cmp?.returnsValue} invert note={t(preset.prevKey)} />
                </KpiCard>
            </div>

            {/* ---- Trend + shops ---- */}
            <div className="el-split">
                <section className="el-card">
                    <div className="el-card-head">
                        <h2 className="el-card-title">{t('dash.trend')}</h2>
                        <div className="el-card-actions">
                            <span className="el-chip el-chip--neutral">{t('dash.perDay')}</span>
                        </div>
                    </div>
                    {byDay.length === 0 ? (
                        <div className="el-empty">{t('dash.noSales')}</div>
                    ) : (
                        // One series, one ink. Days are ordered, not categorical: a hue per
                        // point would imply an identity the data does not have.
                        <ResponsiveContainer width="100%" height={228}>
                            <LineChart data={byDay} margin={{ top: 8, right: 10, left: 0, bottom: 4 }}>
                                <CartesianGrid stroke={theme.grid} vertical={false} />
                                <XAxis
                                    dataKey="day"
                                    tick={{ fontSize: 11, fill: theme.axis }}
                                    tickLine={false}
                                    axisLine={{ stroke: theme.grid }}
                                    tickFormatter={(d: string) => d.slice(5).split('-').reverse().join('/')}
                                    minTickGap={24}
                                />
                                <YAxis
                                    tick={{ fontSize: 11, fill: theme.axis }}
                                    tickLine={false}
                                    axisLine={false}
                                    width={46}
                                    tickFormatter={formatCompact}
                                />
                                <Tooltip
                                    contentStyle={theme.tooltip}
                                    labelFormatter={(d) => String(d ?? '').split('-').reverse().join('/')}
                                    formatter={(v: number | undefined) => [formatCurrency(v ?? 0), 'CA']}
                                />
                                <Line
                                    type="monotone"
                                    dataKey="revenue"
                                    stroke={theme.ink}
                                    strokeWidth={2}
                                    dot={{ r: 3, fill: theme.surface, stroke: theme.ink, strokeWidth: 2 }}
                                    activeDot={{ r: 5 }}
                                />
                            </LineChart>
                        </ResponsiveContainer>
                    )}
                </section>

                <section className="el-card">
                    <div className="el-card-head">
                        <h2 className="el-card-title">{t('dash.storePerf')}</h2>
                    </div>
                    {storeRows.length === 0 ? (
                        <div className="el-empty">{t('dash.noStores')}</div>
                    ) : (
                        <div className="dash-stores">
                            {storeRows.map(r => (
                                <div className="dash-store" key={r.storeId}>
                                    <div className="dash-store-row">
                                        <span className="dash-store-name">{r.storeName}</span>
                                        <span className="dash-store-val el-money">{formatCurrency(r.netRevenue)}</span>
                                    </div>
                                    <div className="el-bar-track">
                                        <div
                                            className="el-bar-fill"
                                            style={{ width: `${Math.round((r.netRevenue / storeMax) * 100)}%` }}
                                        />
                                    </div>
                                    <div className="dash-store-row dash-store-meta">
                                        <span>{r.transactions} {t('ui.salesLabel')}</span>
                                        <span>
                                            {storeTotal ? Math.round((r.netRevenue / storeTotal) * 100) : 0} {t('dash.ofTotal')}
                                        </span>
                                    </div>
                                </div>
                            ))}
                            <div className="dash-store-total">
                                <span>{t('ui.total')}</span>
                                <strong className="el-money">{formatCurrency(storeTotal)}</strong>
                            </div>
                        </div>
                    )}
                </section>
            </div>

            {/* ---- What is selling ---- */}
            <div className="el-grid el-grid--3 dash-bottom">
                <section className="el-card el-card--pad0">
                    <div className="el-card-head el-card-head--ruled">
                        <h2 className="el-card-title">{t('dash.topProducts')}</h2>
                        <div className="el-card-actions">
                            <button className="el-btn el-btn--ghost" onClick={() => onNavigate('reports')}>
                                {t('dash.seeAll')}
                            </button>
                        </div>
                    </div>
                    {top.length === 0 ? (
                        <div className="el-empty">
                            <span className="el-empty-icon"><Package size={22} /></span>
                            <strong>{t('dash.noSales')}</strong>
                        </div>
                    ) : (
                        <div className="el-table-wrap">
                            <table className="el-table">
                                <thead>
                                    <tr>
                                        <th>{t('nav.products')}</th>
                                        <th className="num">{t('dash.sold')}</th>
                                        <th className="num">CA</th>
                                        <th className="num">{t('dash.profit')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {top.map((p, i) => (
                                        <tr key={p.product_id ?? i}>
                                            <td>
                                                <span className="dash-rank">
                                                    <i style={{ background: theme.ramp[i % theme.ramp.length] }} />
                                                    {p.product_name}
                                                </span>
                                            </td>
                                            <td className="num">{p.units}</td>
                                            <td className="num">{formatCurrency(p.revenue)}</td>
                                            <td className="num strong">{formatCurrency(p.profit)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>

                <section className="el-card">
                    <div className="el-card-head">
                        <h2 className="el-card-title">{t('dash.bySize')}</h2>
                    </div>
                    {sizeTotal === 0 ? (
                        <div className="el-empty">{t('dash.noSize')}</div>
                    ) : (
                        <div className="dash-donut">
                            <ResponsiveContainer width="100%" height={160}>
                                <PieChart>
                                    <Pie
                                        data={bySize}
                                        dataKey="units"
                                        nameKey="label"
                                        cx="50%" cy="50%"
                                        innerRadius={44} outerRadius={66}
                                        paddingAngle={2}
                                    >
                                        {bySize.map((s, i) => (
                                            <Cell
                                                key={s.label}
                                                fill={theme.ramp[i % theme.ramp.length]}
                                                stroke={theme.surface}
                                                strokeWidth={2}
                                            />
                                        ))}
                                    </Pie>
                                    <Tooltip
                                        contentStyle={theme.tooltip}
                                        formatter={(v: number | undefined, n) => [`${v ?? 0} article(s)`, n]}
                                    />
                                </PieChart>
                            </ResponsiveContainer>
                            {/* Every slice is named with its share: the donut is never the
                                only encoding, which is what keeps it readable in CVD. */}
                            <div className="el-legend">
                                {bySize.map((s, i) => (
                                    <div className="el-legend-row" key={s.label}>
                                        <i
                                            className="el-legend-dot"
                                            style={{ background: theme.ramp[i % theme.ramp.length] }}
                                        />
                                        <span>{s.label}</span>
                                        <strong>{Math.round((s.units / sizeTotal) * 100)} %</strong>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </section>

                <section className="el-card">
                    <div className="el-card-head">
                        <h2 className="el-card-title">{t('dash.byColor')}</h2>
                    </div>
                    {colorTotal === 0 ? (
                        <div className="el-empty">{t('dash.noColor')}</div>
                    ) : (
                        <div className="dash-donut">
                            <ResponsiveContainer width="100%" height={160}>
                                <PieChart>
                                    <Pie
                                        data={colorSlices}
                                        dataKey="units"
                                        nameKey="label"
                                        cx="50%" cy="50%"
                                        innerRadius={44} outerRadius={66}
                                        paddingAngle={2}
                                    >
                                        {/* The category IS a colour, so its own hex is the honest
                                            encoding. White gets a ring from swatchFor() so it does
                                            not vanish against the card. */}
                                        {colorSlices.map((c, i) => (
                                            <Cell
                                                key={c.label}
                                                fill={swatchFor(c.hex, theme.ramp[i % theme.ramp.length]).background}
                                                stroke={theme.surface}
                                                strokeWidth={2}
                                            />
                                        ))}
                                    </Pie>
                                    <Tooltip
                                        contentStyle={theme.tooltip}
                                        formatter={(v: number | undefined, n) => [`${v ?? 0} article(s)`, n]}
                                    />
                                </PieChart>
                            </ResponsiveContainer>
                            <div className="el-legend">
                                {colorSlices.map((c, i) => (
                                    <div className="el-legend-row" key={c.label}>
                                        <i
                                            className="el-legend-dot"
                                            style={swatchFor(c.hex, theme.ramp[i % theme.ramp.length])}
                                        />
                                        <span>{c.label}</span>
                                        <strong>{Math.round((c.units / colorTotal) * 100)} %</strong>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </section>
            </div>
        </div>
    )
}
