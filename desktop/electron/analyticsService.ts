import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// Retail analytics (brief §45–§56).
//
// DEFINITIONS, STATED ONCE. The brief (§79) is right to insist: "profit" means
// nothing until you say what is in it. Everything below uses these, and the UI
// shows the same words.
//
//   Gross revenue  = Σ total_amount of COMPLETED sales in the window (TTC).
//   Returns        = Σ returned_value of completed returns in the window.
//   Net revenue    = Gross revenue − Returns.
//   COGS           = Σ quantity × unit_cost over the SOLD lines.
//   Gross profit   = Net revenue − COGS.
//   Gross margin   = Gross profit ÷ Net revenue × 100.
//
// Expenses are NOT deducted anywhere here, so nothing in this module may be
// called "net profit". That figure needs expenses and payroll, and calling a
// gross number "profit" is exactly the misleading presentation §79 forbids.
//
// COST: `transaction_items.unit_cost` is frozen at the moment of sale (Migration
// 42). Rows written before that migration are NULL and fall back to the product's
// CURRENT cost, so their margin still drifts when a supplier price changes —
// `estimatedCostLines` counts them so a report can say how much of it is a guess
// rather than quietly presenting an estimate as a measurement.
//
// A RETURN IS ATTRIBUTED TO THE SELLING STORE, not the receiving one, so a
// garment bought in Costume and handed back in Casual does not make Casual's
// revenue look worse than it was.
// ---------------------------------------------------------------------------

export interface Period {
    from?: string
    to?: string
    storeId?: number | null
}

/** WHERE fragment + params for the completed sales in a period. */
function saleScope(p: Period, alias = 't') {
    const where: string[] = [`${alias}.status = 'completed'`]
    const params: any[] = []
    if (p.storeId != null) { where.push(`${alias}.store_id = ?`); params.push(p.storeId) }
    if (p.from) { where.push(`${alias}.created_at >= ?`); params.push(p.from) }
    if (p.to) { where.push(`${alias}.created_at <= ?`); params.push(p.to) }
    return { clause: where.join(' AND '), params }
}

/** The cost of one sold line: frozen if we have it, current cost otherwise. */
const LINE_COST = `COALESCE(ti.unit_cost, pv.cost_price, p.cost_price, 0)`

export const AnalyticsService = {
    /**
     * Headline figures for a window (brief §45, §56).
     */
    summary(period: Period) {
        const db = getDatabase()
        const { clause, params } = saleScope(period)

        const sales = db.prepare(`
            SELECT COUNT(*) AS transactions,
                   COALESCE(SUM(t.total_amount), 0) AS gross_revenue,
                   COALESCE(SUM(t.discount_amount), 0) AS discounts,
                   COALESCE(AVG(t.total_amount), 0) AS avg_basket
            FROM transactions t WHERE ${clause}
        `).get(...params) as any

        const goods = db.prepare(`
            SELECT COALESCE(SUM(ti.quantity), 0) AS items_sold,
                   COALESCE(SUM(ti.quantity * ${LINE_COST}), 0) AS cogs,
                   COALESCE(SUM(CASE WHEN ti.unit_cost IS NULL THEN 1 ELSE 0 END), 0) AS estimated_cost_lines
            FROM transaction_items ti
            JOIN transactions t ON t.id = ti.transaction_id
            LEFT JOIN products p ON p.id = ti.product_id
            LEFT JOIN product_variants pv ON pv.id = ti.variant_id
            WHERE ${clause}
        `).get(...params) as any

        // Returns are scoped by the ORIGINAL sale's store, not the return's own.
        const rw: string[] = ["r.status = 'completed'"]
        const rp: any[] = []
        if (period.storeId != null) { rw.push('o.store_id = ?'); rp.push(period.storeId) }
        if (period.from) { rw.push('r.created_at >= ?'); rp.push(period.from) }
        if (period.to) { rw.push('r.created_at <= ?'); rp.push(period.to) }
        const returns = db.prepare(`
            SELECT COUNT(*) AS count,
                   COALESCE(SUM(CASE WHEN r.kind = 'refund' THEN 1 ELSE 0 END), 0) AS refunds,
                   COALESCE(SUM(CASE WHEN r.kind = 'exchange' THEN 1 ELSE 0 END), 0) AS exchanges,
                   COALESCE(SUM(r.returned_value), 0) AS value
            FROM sale_returns r
            JOIN transactions o ON o.id = r.original_transaction_id
            WHERE ${rw.join(' AND ')}
        `).get(...rp) as any

        const grossRevenue = sales.gross_revenue
        const netRevenue = grossRevenue - returns.value
        const cogs = goods.cogs
        const grossProfit = netRevenue - cogs

        return {
            transactions: sales.transactions,
            itemsSold: goods.items_sold,
            grossRevenue,
            returnsValue: returns.value,
            netRevenue,
            cogs,
            grossProfit,
            grossMargin: netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0,
            discounts: sales.discounts,
            avgBasket: sales.avg_basket,
            returnsCount: returns.count,
            refundsCount: returns.refunds,
            exchangesCount: returns.exchanges,
            returnRate: sales.transactions > 0 ? (returns.count / sales.transactions) * 100 : 0,
            /** How many sold lines have no frozen cost, so their margin is an estimate. */
            estimatedCostLines: goods.estimated_cost_lines,
        }
    },

    /**
     * Sales by size (brief §49).
     *
     * Ordered by the `sizes` reference table's `sort_order`, NOT alphabetically —
     * that is the whole reason the table exists. Sorting text puts 10 before 8 and
     * XL before XS, which makes the chart actively misleading about which end of
     * the range is selling.
     */
    salesBySize(period: Period) {
        const { clause, params } = saleScope(period)
        // Scalar subqueries, NOT a join to `sizes`.
        //
        // A size NAME is not unique across scales: '54' is both a suit size and a
        // trouser waist, so `LEFT JOIN sizes ON name = size` matches twice and SUM()
        // silently doubles the units. That is the worst kind of reporting bug —
        // plausible numbers, quietly wrong — so the lookup is kept scalar.
        //
        // When a name does span scales the group shown is the lowest-sorted match.
        // That is arbitrary but deterministic; the ordering is what actually matters.
        return getDatabase().prepare(`
            SELECT pv.size AS label,
                   COALESCE((SELECT s.size_group FROM sizes s
                              WHERE s.name = pv.size
                              ORDER BY s.sort_order, s.id LIMIT 1), 'other') AS size_group,
                   COALESCE(SUM(ti.quantity), 0) AS units,
                   COALESCE(SUM(ti.line_total), 0) AS revenue
            FROM transaction_items ti
            JOIN transactions t ON t.id = ti.transaction_id
            JOIN product_variants pv ON pv.id = ti.variant_id
            WHERE ${clause} AND pv.size IS NOT NULL AND pv.size != ''
            GROUP BY pv.size
            ORDER BY COALESCE((SELECT MIN(s.sort_order) FROM sizes s WHERE s.name = pv.size), 9999),
                     pv.size
        `).all(...params) as { label: string; size_group: string; units: number; revenue: number }[]
    },

    /** Sales by colour (brief §50). Swatch comes along so the chart can show it. */
    salesByColor(period: Period) {
        const { clause, params } = saleScope(period)
        return getDatabase().prepare(`
            SELECT pv.color AS label, c.hex,
                   COALESCE(SUM(ti.quantity), 0) AS units,
                   COALESCE(SUM(ti.line_total), 0) AS revenue
            FROM transaction_items ti
            JOIN transactions t ON t.id = ti.transaction_id
            JOIN product_variants pv ON pv.id = ti.variant_id
            LEFT JOIN colors c ON c.name = pv.color
            WHERE ${clause} AND pv.color IS NOT NULL AND pv.color != ''
            GROUP BY pv.color
            ORDER BY units DESC
        `).all(...params) as { label: string; hex: string | null; units: number; revenue: number }[]
    },

    /**
     * Sales by hour of day (brief §51) — which hours are worth staffing.
     *
     * Every hour from 00 to 23 is returned, including the empty ones. A bar chart
     * that silently omits the dead hours makes a quiet afternoon look like a busy
     * one, because the gap closes up.
     */
    salesByHour(period: Period) {
        const { clause, params } = saleScope(period)
        const rows = getDatabase().prepare(`
            SELECT CAST(strftime('%H', t.created_at, 'localtime') AS INTEGER) AS hour,
                   COUNT(DISTINCT t.id) AS transactions,
                   COALESCE(SUM(t.total_amount), 0) AS revenue
            FROM transactions t WHERE ${clause}
            GROUP BY hour
        `).all(...params) as { hour: number; transactions: number; revenue: number }[]

        const items = getDatabase().prepare(`
            SELECT CAST(strftime('%H', t.created_at, 'localtime') AS INTEGER) AS hour,
                   COALESCE(SUM(ti.quantity), 0) AS items
            FROM transaction_items ti
            JOIN transactions t ON t.id = ti.transaction_id
            WHERE ${clause}
            GROUP BY hour
        `).all(...params) as { hour: number; items: number }[]

        const byHour = new Map(rows.map(r => [r.hour, r]))
        const itemsByHour = new Map(items.map(r => [r.hour, r.items]))
        return Array.from({ length: 24 }, (_, hour) => ({
            hour,
            transactions: byHour.get(hour)?.transactions ?? 0,
            revenue: byHour.get(hour)?.revenue ?? 0,
            items: itemsByHour.get(hour) ?? 0,
        }))
    },

    /** Top products (brief §48), rankable by units, revenue or profit. */
    topProducts(period: Period, by: 'units' | 'revenue' | 'profit' = 'revenue', limit = 15) {
        const { clause, params } = saleScope(period)
        const order = by === 'units' ? 'units' : by === 'profit' ? 'profit' : 'revenue'
        return getDatabase().prepare(`
            SELECT ti.product_id, ti.product_name,
                   COALESCE(SUM(ti.quantity), 0) AS units,
                   COALESCE(SUM(ti.line_total), 0) AS revenue,
                   COALESCE(SUM(ti.line_total - ti.quantity * ${LINE_COST}), 0) AS profit
            FROM transaction_items ti
            JOIN transactions t ON t.id = ti.transaction_id
            LEFT JOIN products p ON p.id = ti.product_id
            LEFT JOIN product_variants pv ON pv.id = ti.variant_id
            WHERE ${clause}
            GROUP BY ti.product_id
            ORDER BY ${order} DESC
            LIMIT ?
        `).all(...params, limit) as
            { product_id: number; product_name: string; units: number; revenue: number; profit: number }[]
    },

    /** Top variants — which size/colour of which garment actually moves. */
    topVariants(period: Period, limit = 15) {
        const { clause, params } = saleScope(period)
        return getDatabase().prepare(`
            SELECT ti.product_name, pv.size, pv.color,
                   COALESCE(SUM(ti.quantity), 0) AS units,
                   COALESCE(SUM(ti.line_total), 0) AS revenue
            FROM transaction_items ti
            JOIN transactions t ON t.id = ti.transaction_id
            JOIN product_variants pv ON pv.id = ti.variant_id
            WHERE ${clause}
            GROUP BY ti.variant_id
            ORDER BY units DESC
            LIMIT ?
        `).all(...params, limit) as
            { product_name: string; size: string; color: string; units: number; revenue: number }[]
    },

    /**
     * Store comparison (brief §52). Store names are never hardcoded — the list is
     * whatever `stores` holds, so opening a third shop needs no code change.
     */
    storeComparison(period: Omit<Period, 'storeId'>) {
        const db = getDatabase()
        const stores = db.prepare('SELECT id, name, code FROM stores WHERE is_active = 1 ORDER BY sort_order, id')
            .all() as { id: number; name: string; code: string }[]

        return stores.map(s => {
            const sum = this.summary({ ...period, storeId: s.id })
            const stock = db.prepare(`
                SELECT COALESCE(SUM(si.quantity * COALESCE(pv.cost_price, p.cost_price, 0)), 0) AS value
                FROM stock_inventory si
                JOIN products p ON p.id = si.product_id
                LEFT JOIN product_variants pv ON pv.id = si.variant_id
                WHERE si.store_id = ? AND si.quantity > 0
            `).get(s.id) as any

            const customers = db.prepare(`
                SELECT
                  COUNT(DISTINCT CASE WHEN prior.n = 0 THEN t.customer_id END) AS new_customers,
                  COUNT(DISTINCT CASE WHEN prior.n > 0 THEN t.customer_id END) AS returning_customers
                FROM transactions t
                JOIN (
                    SELECT t2.id,
                           (SELECT COUNT(*) FROM transactions t3
                             WHERE t3.customer_id = t2.customer_id
                               AND t3.status = 'completed'
                               AND t3.created_at < t2.created_at) AS n
                    FROM transactions t2
                ) prior ON prior.id = t.id
                WHERE t.status = 'completed' AND t.store_id = ?
                  AND t.customer_id IS NOT NULL AND t.customer_id != 1
                  ${period.from ? 'AND t.created_at >= ?' : ''}
                  ${period.to ? 'AND t.created_at <= ?' : ''}
            `).get(...[s.id, period.from, period.to].filter(v => v != null)) as any

            return {
                storeId: s.id, storeName: s.name, storeCode: s.code,
                ...sum,
                stockValue: stock.value,
                newCustomers: customers?.new_customers ?? 0,
                returningCustomers: customers?.returning_customers ?? 0,
            }
        })
    },

    /**
     * Period comparison (brief §47).
     *
     * The caller supplies both windows rather than this guessing "the previous
     * one": "last month" is not a fixed number of days, and quietly comparing
     * 31 days against 28 would report a fall that is only the calendar.
     */
    periodComparison(current: Period, previous: Period) {
        const now = this.summary(current)
        const before = this.summary(previous)

        const delta = (a: number, b: number) => ({
            current: a,
            previous: b,
            change: a - b,
            // A rise from zero has no meaningful percentage; null says so instead of
            // rendering Infinity or a fake 100 %.
            percent: b !== 0 ? ((a - b) / Math.abs(b)) * 100 : null,
        })

        return {
            revenue: delta(now.netRevenue, before.netRevenue),
            grossProfit: delta(now.grossProfit, before.grossProfit),
            transactions: delta(now.transactions, before.transactions),
            itemsSold: delta(now.itemsSold, before.itemsSold),
            avgBasket: delta(now.avgBasket, before.avgBasket),
            returnsValue: delta(now.returnsValue, before.returnsValue),
        }
    },

    /** Revenue per day, for the trend line. */
    revenueByDay(period: Period) {
        const { clause, params } = saleScope(period)
        return getDatabase().prepare(`
            SELECT date(t.created_at, 'localtime') AS day,
                   COUNT(*) AS transactions,
                   COALESCE(SUM(t.total_amount), 0) AS revenue
            FROM transactions t WHERE ${clause}
            GROUP BY day ORDER BY day
        `).all(...params) as { day: string; transactions: number; revenue: number }[]
    },

    /**
     * Employee performance (brief §42).
     * Discount rate is expressed against gross, since that is what the discount
     * was actually applied to.
     */
    employeePerformance(period: Period) {
        const outer = saleScope(period, 't')
        // The subquery gets its own aliased scope rather than a regex rewrite of the
        // outer one: string-substituting an alias into SQL breaks the moment a column
        // name happens to contain the alias.
        const inner = saleScope(period, 't2')
        return getDatabase().prepare(`
            SELECT u.id AS user_id, u.name AS user_name,
                   COUNT(DISTINCT t.id) AS transactions,
                   COALESCE(SUM(t.total_amount), 0) AS revenue,
                   COALESCE(SUM(t.discount_amount), 0) AS discounts,
                   COALESCE(AVG(t.total_amount), 0) AS avg_basket,
                   (SELECT COALESCE(SUM(ti.quantity), 0)
                      FROM transaction_items ti
                      JOIN transactions t2 ON t2.id = ti.transaction_id
                     WHERE t2.user_id = u.id AND ${inner.clause}) AS items_sold,
                   (SELECT COUNT(*) FROM sale_returns r
                     WHERE r.user_id = u.id AND r.status = 'completed') AS returns_handled
            FROM transactions t
            JOIN users u ON u.id = t.user_id
            WHERE ${outer.clause}
            GROUP BY u.id
            ORDER BY revenue DESC
        `).all(...inner.params, ...outer.params) as any[]
    },

    /** New vs returning customers over the window (brief §34, §53). */
    customerMix(period: Period) {
        const db = getDatabase()
        const { clause, params } = saleScope(period)
        // "New" means this was the customer's first ever completed sale, not their
        // first in the window — otherwise every long-standing customer looks new
        // whenever the window is short.
        const row = db.prepare(`
            SELECT
              COUNT(DISTINCT CASE WHEN prior.n = 0 THEN t.customer_id END) AS new_customers,
              COUNT(DISTINCT CASE WHEN prior.n > 0 THEN t.customer_id END) AS returning_customers,
              COUNT(DISTINCT t.customer_id) AS total_customers
            FROM transactions t
            JOIN (
                SELECT t2.id,
                       (SELECT COUNT(*) FROM transactions t3
                         WHERE t3.customer_id = t2.customer_id
                           AND t3.status = 'completed'
                           AND t3.created_at < t2.created_at) AS n
                FROM transactions t2
            ) prior ON prior.id = t.id
            WHERE ${clause} AND t.customer_id IS NOT NULL AND t.customer_id != 1
        `).get(...params) as any

        const walkIns = db.prepare(`
            SELECT COUNT(*) AS n FROM transactions t
            WHERE ${clause} AND (t.customer_id IS NULL OR t.customer_id = 1)
        `).get(...params) as any

        return {
            newCustomers: row?.new_customers ?? 0,
            returningCustomers: row?.returning_customers ?? 0,
            totalCustomers: row?.total_customers ?? 0,
            walkInSales: walkIns?.n ?? 0,
        }
    },
}
