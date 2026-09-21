import { useState, useEffect } from 'react'
import {
    AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
    PieChart, Pie, Cell
} from 'recharts'
import { TrendingUp, Banknote, ShoppingBag, Printer, Layers, Users, Package } from 'lucide-react'
import { formatCurrency, formatDate as formatDateStandard, formatDateTime, formatDateISO } from '../utils/formatters'
import './AnalyticsDashboard.css'

interface DashboardStats {
    todaySales: number
    todayTransactions: number
    todayCashReceived: number
    avgTransactionValue: number
    lowStockCount: number
    totalRevenue: number
    totalProfit: number
    totalDebt: number
    totalStockValue: number
    topDebtors: { name: string; amount: number }[]
}

interface ChartData {
    date: string
    salesVolume: number
    cashFlow: number
}

interface CategoryData {
    name: string
    value: number
}

// PaymentData interface removed

interface TopProduct {
    name: string
    total_qty: number
    total_revenue: number
}

// Categorical ramp for the Elegance palette (see src/styles/tokens.css).
//
// VALIDATED, not chosen by eye: adjacent slots alternate cool/warm so the pairs a
// reader actually compares are the ones furthest apart, which is what survives
// deuteranopia. Assign in order and never cycle — a filter that drops a series
// must not repaint the ones that remain.
//
// Kept in sync BY HAND with --chart-1..8 in tokens.css. Recharts needs a resolved
// colour string for its SVG fills and gradient stops, so a var() reference cannot
// be passed straight through. Change one, change the other.
const RAMP_LIGHT = ['#4F46E5', '#EA580C', '#0D9488', '#CA8A04', '#0EA5E9', '#65A30D', '#7C3AED', '#DB2777']
const RAMP_DARK = ['#6366F1', '#F97316', '#14B8A6', '#EAB308', '#0EA5E9', '#84CC16', '#8B5CF6', '#EC4899']

/** Ordinal ramp for the current theme. Dark mode is stepped separately, not flipped. */
function useRamp(): string[] {
    const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark')
    useEffect(() => {
        const el = document.documentElement
        const obs = new MutationObserver(() => setDark(el.dataset.theme === 'dark'))
        obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
        return () => obs.disconnect()
    }, [])
    return dark ? RAMP_DARK : RAMP_LIGHT
}

export function AnalyticsDashboard() {
    const [stats, setStats] = useState<DashboardStats | null>(null)
    const [salesData, setSalesData] = useState<ChartData[]>([])
    const [topProducts, setTopProducts] = useState<TopProduct[]>([])
    const [categoryData, setCategoryData] = useState<CategoryData[]>([])
    const [loading, setLoading] = useState(true)
    const ramp = useRamp()

    const [dateRange, setDateRange] = useState({ start: '', end: '' })

    useEffect(() => {
        const end = new Date()
        const start = new Date()
        start.setDate(start.getDate() - 7)
        setDateRange({ start: formatDateISO(start), end: formatDateISO(end) })
    }, [])

    useEffect(() => {
        if (!dateRange.start || !dateRange.end) return

        const fetchData = async () => {
            try {
                setLoading(true)
                const [statsData, chartData, productsData, catData] = await Promise.all([
                    window.electron.report.getStats(),
                    window.electron.report.getChartData({ startDate: dateRange.start, endDate: dateRange.end }),
                    window.electron.report.getTopProducts(8),
                    window.electron.report.getCategorySales({ startDate: dateRange.start, endDate: dateRange.end }),
                ])

                setStats(statsData)
                setSalesData(chartData)
                setTopProducts(productsData)
                setCategoryData(catData)
            } catch (error) {
                console.error('Failed to load dashboard:', error)
            } finally {
                setLoading(false)
            }
        }

        fetchData()
    }, [dateRange])

    const handlePreset = (days: number) => {
        const end = new Date()
        const start = new Date()
        start.setDate(start.getDate() - days)
        setDateRange({ start: formatDateISO(start), end: formatDateISO(end) })
    }

    const printReport = () => {
        window.print()
    }

    if (loading) return <div className="loading">Chargement du rapport…</div>

    return (
        <div className="dashboard printable">
            <div className="dashboard-header no-print">
                <div className="header-left">
                    <h1 className="dashboard-title">Analyses</h1>
                    <p className="el-page-sub">Performance de la boutique, en direct. « Bénéfice brut » exclut les charges et les salaires.</p>
                </div>
                <div className="header-actions">
                    <button className="btn-print" onClick={printReport}>
                        <Printer size={18} />
                        <span>Imprimer</span>
                    </button>
                    <div className="date-controls">
                        <div className="presets">
                            <button onClick={() => handlePreset(0)}>Today</button>
                            <button onClick={() => handlePreset(7)}>7D</button>
                            <button onClick={() => handlePreset(30)}>30D</button>
                            <button onClick={() => handlePreset(365)}>1Y</button>
                        </div>
                        <div className="custom-range">
                            <input
                                type="date"
                                value={dateRange.start}
                                onChange={(e) => setDateRange(prev => ({ ...prev, start: e.target.value }))}
                            />
                            <input
                                type="date"
                                value={dateRange.end}
                                onChange={(e) => setDateRange(prev => ({ ...prev, end: e.target.value }))}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Print Only Header */}
            <div className="print-header only-print">
                <h1>Rapport de performance</h1>
                <p>Période : {formatDateStandard(dateRange.start)} au {formatDateStandard(dateRange.end)}</p>
                <p>Édité le {formatDateTime(new Date())}</p>
            </div>

            {/* High-Density Stats Grid */}
            <div className="stats-grid">
                <div className="stat-card primary">
                    <div className="stat-icon"><ShoppingBag size={24} /></div>
                    <div className="stat-content">
                        <label>Ventes du jour</label>
                        <div className="value">{formatCurrency(stats?.todaySales || 0)}</div>
                        <div className="sub-label">Chiffre d&apos;affaires facturé</div>
                    </div>
                </div>
                <div className="stat-card success">
                    <div className="stat-icon"><Banknote size={24} /></div>
                    <div className="stat-content">
                        <label>Encaissé aujourd&apos;hui</label>
                        <div className="value">{formatCurrency(stats?.todayCashReceived || 0)}</div>
                        <div className="sub-label">Argent réellement rentré</div>
                    </div>
                </div>
                <div className="stat-card ghost">
                    <div className="stat-icon"><TrendingUp size={24} /></div>
                    <div className="stat-content">
                        <label>Panier moyen</label>
                        <div className="value">{formatCurrency(stats?.avgTransactionValue || 0)}</div>
                        <div className="sub-label">{stats?.todayTransactions} txns today</div>
                    </div>
                </div>
                <div className="stat-card purple">
                    <div className="stat-icon"><Layers size={24} /></div>
                    <div className="stat-content">
                        <label>Bénéfice brut</label>
                        <div className="value">{formatCurrency(stats?.totalProfit || 0)}</div>
                        <div className="margin">Marge {((stats?.totalProfit || 0) / (stats?.totalRevenue || 1) * 100).toFixed(1)} % · hors charges</div>
                    </div>
                </div>
                <div className="stat-card danger">
                    <div className="stat-icon"><Users size={24} /></div>
                    <div className="stat-content">
                        <label>Créances clients</label>
                        <div className="value">{formatCurrency(stats?.totalDebt || 0)}</div>
                        <div className="sub-label">Restant dû</div>
                    </div>
                </div>
                <div className="stat-card warning">
                    <div className="stat-icon"><Package size={24} /></div>
                    <div className="stat-content">
                        <label>Valeur du stock</label>
                        <div className="value">{formatCurrency(stats?.totalStockValue || 0)}</div>
                        <div className="sub-label">Au prix d&apos;achat</div>
                    </div>
                </div>
            </div>

            <div className="charts-main-grid">
                {/* Sales Trend - Large Area Chart */}
                <div className="chart-card span-2">
                    <div className="chart-header">
                        <h3>Évolution du chiffre d&apos;affaires</h3>
                        <p>Facturé et encaissé, jour par jour</p>
                    </div>
                    <div className="chart-container">
                        <ResponsiveContainer width="100%" height={340}>
                            <AreaChart data={salesData}>
                                <defs>
                                    <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor={ramp[0]} stopOpacity={0.26} />
                                        <stop offset="95%" stopColor={ramp[0]} stopOpacity={0} />
                                    </linearGradient>
                                    <linearGradient id="colorCash" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor={ramp[3]} stopOpacity={0.20} />
                                        <stop offset="95%" stopColor={ramp[3]} stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--separator)" />
                                <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'var(--text-tertiary)' }} dy={10} />
                                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'var(--text-tertiary)' }} />
                                <Tooltip
                                    contentStyle={{ borderRadius: '14px', border: '1px solid var(--border-light)', background: 'var(--surface)', boxShadow: 'var(--shadow-lg)' }}
                                />
                                <Legend verticalAlign="top" height={36} />
                                {/* Two series with no hue between them: the lightness gap is backed by a
                                    dashed stroke on the second, so identity never rests on colour alone. */}
                                <Area type="monotone" dataKey="salesVolume" stroke={ramp[0]} strokeWidth={3} fillOpacity={1} fill="url(#colorSales)" name="Facturé" />
                                <Area type="monotone" dataKey="cashFlow" stroke={ramp[3]} strokeWidth={3} strokeDasharray="6 4" fillOpacity={1} fill="url(#colorCash)" name="Encaissé" />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                {/* Category Distribution - Pie Chart */}
                <div className="chart-card">
                    <div className="chart-header">
                        <h3>Répartition par famille</h3>
                        <p>Revenue share by product category</p>
                    </div>
                    <div className="chart-container pie">
                        <ResponsiveContainer width="100%" height={300}>
                            <PieChart>
                                <Pie
                                    data={categoryData}
                                    cx="50%"
                                    cy="50%"
                                    innerRadius={60}
                                    outerRadius={80}
                                    paddingAngle={5}
                                    dataKey="value"
                                >
                                    {/* Ranked by share, so the ramp's ORDER carries the ranking and
                                        its hue only makes slices tellable apart — which is what keeps
                                        the chart readable in greyscale. Categories beyond the ramp
                                        clamp to its last step rather than cycling back to the first,
                                        which would falsely imply a small category is the largest. */}
                                    {categoryData.map((_entry, index) => (
                                        <Cell key={`cell-${index}`} fill={ramp[Math.min(index, ramp.length - 1)]} stroke="var(--surface)" strokeWidth={2} />
                                    ))}
                                </Pie>
                                <Tooltip contentStyle={{ borderRadius: '14px', border: '1px solid var(--border-light)', background: 'var(--surface)', boxShadow: 'var(--shadow-lg)' }} />
                                <Legend verticalAlign="bottom" align="center" iconType="circle" />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            </div>

            <div className="details-grid">
                {/* Top Selling Products - Detailed Table */}
                <div className="detail-card">
                    <div className="card-header">
                        <h3>Performance par produit</h3>
                        <button className="btn-text">Tout voir</button>
                    </div>
                    <table className="performance-table">
                        <thead>
                            <tr>
                                <th>Produit</th>
                                <th>Vendus</th>
                                <th>Chiffre d&apos;affaires</th>
                                <th>Part du total</th>
                            </tr>
                        </thead>
                        <tbody>
                            {topProducts.map((p, i) => (
                                <tr key={i}>
                                    <td>
                                        <div className="product-info">
                                            <span className="rank">{i + 1}</span>
                                            {p.name}
                                        </div>
                                    </td>
                                    <td className="center"><strong>{p.total_qty}</strong></td>
                                    <td className="right">{p.total_revenue.toFixed(2)} DZD</td>
                                    <td>
                                        <div className="progress-bar">
                                            {/* One series — the bar's LENGTH already encodes revenue.
                                                Colouring each row differently would spend the identity
                                                channel re-encoding what length shows, so every bar
                                                wears the same ink. */}
                                            <div
                                                className="fill"
                                                style={{ width: `${(p.total_revenue / (stats?.totalRevenue || 1) * 100)}%`, background: ramp[0] }}
                                            ></div>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {/* Payment Methods analytics removed */}

                <div className="detail-card">
                    <div className="card-header">
                        <h3>Principaux impayés</h3>
                        <p>Les plus gros restes dus</p>
                    </div>
                    <div className="debtors-mini-list">
                        {stats?.topDebtors.map((debtor, i) => (
                            <div key={i} className="debtor-row">
                                <span className="debtor-name">{debtor.name}</span>
                                <span className="debtor-amount">{formatCurrency(debtor.amount)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}
