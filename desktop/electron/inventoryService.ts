import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// Store-scoped inventory with a real oversell guard.
//
// THE PROBLEM THIS EXISTS TO SOLVE
//
// StockService.adjustStock() reads the current quantity, subtracts in JavaScript,
// then writes the result back. Between the read and the write, another terminal on
// the same store server can do exactly the same thing. Both read "1 in stock", both
// decide the sale is fine, both write 0, and the shop has sold a suit it does not
// own. That is the brief's §62 race, and it is why the live database already
// carries negative stock.
//
// The fix is not a bigger lock or a check higher up — it is to never read and write
// as separate steps:
//
//     UPDATE stock_inventory SET quantity = quantity - :qty
//      WHERE ... AND quantity >= :qty
//
// SQLite evaluates that as one statement under a write lock. The second terminal's
// UPDATE matches zero rows and reports insufficient stock instead of overselling.
// `changes === 0` IS the guard; there is no separate check to forget to call.
//
// This depends on Migration 34's UNIQUE index on (store_id, product_id,
// COALESCE(variant_id, 0)). Without it several rows could match and "quantity" would
// be ambiguous — the guard would silently protect only one of them.
//
// SCOPE OF THE GUARANTEE: one process owns the SQLite file, so this holds across
// every terminal in a store (they reach it through the Fastify server — see
// docs/RETAIL_PLAN.md §2). It does NOT hold across stores, which is fine: inventory
// is per store, so a cross-store race over one variant cannot exist.
// ---------------------------------------------------------------------------

export type MovementType =
    | 'purchase' | 'sale' | 'return' | 'transfer_out' | 'transfer_in'
    | 'adjustment' | 'damage' | 'loss' | 'inventory_count'

/**
 * One stock line's health. Mutually exclusive and ordered: a rupture is a
 * rupture before it is anything else, and only stock you actually HAVE can be
 * called dormant. That exclusivity is what makes the four counts add up to the
 * total — see getOverview.
 */
export type StockState = 'healthy' | 'low' | 'out' | 'dead'

export interface StockOverviewRow {
    product_id: number
    product_name: string
    min_stock_level: number
    category_id: number | null
    category_name: string | null
    variant_id: number | null
    size: string | null
    color: string | null
    sku: string | null
    barcode: string | null
    store_id: number | null
    store_name: string | null
    quantity: number
    unit_cost: number
    unit_price: number
    stock_value: number
    /** Last time a unit left this line's shelf; null if it never has. */
    last_sale_at: string | null
    state: StockState
}

/** Maps the rich retail movement vocabulary onto the four values the existing
 *  stock_movements CHECK constraint allows. The precise reason survives in the
 *  `reason` column, so no history is lost by the narrowing. */
const LEGACY_TYPE: Record<MovementType, 'in' | 'out' | 'adjustment' | 'transfer'> = {
    purchase: 'in',
    sale: 'out',
    return: 'in',
    transfer_out: 'transfer',
    transfer_in: 'transfer',
    adjustment: 'adjustment',
    damage: 'out',
    loss: 'out',
    inventory_count: 'adjustment',
}

export interface MovementContext {
    storeId: number
    userId?: number | null
    reason?: string | null
    referenceType?: string | null
    referenceId?: number | null
    notes?: string | null
}

export class InsufficientStockError extends Error {
    readonly code = 'INSUFFICIENT_STOCK'
    readonly productName: string
    readonly requested: number
    readonly available: number

    constructor(productName: string, requested: number, available: number) {
        super(`Stock insuffisant pour ${productName} — demandé ${requested}, disponible ${available}`)
        this.name = 'InsufficientStockError'
        this.productName = productName
        this.requested = requested
        this.available = available
    }
}

/** Owner-level escape hatch (brief §12). Off by default: a shop that can sell what
 *  it does not have cannot trust any stock figure it reports. */
function negativeStockAllowed(): boolean {
    const row = getDatabase()
        .prepare("SELECT value FROM config WHERE key = 'allow_negative_stock'")
        .get() as { value: string } | undefined
    return row?.value === '1' || row?.value === 'true'
}

function writeMovement(type: MovementType, productId: number, variantId: number | null,
                       delta: number, ctx: MovementContext): void {
    getDatabase().prepare(`
        INSERT INTO stock_movements
            (product_id, variant_id, store_id, movement_type, quantity, reason,
             reference_type, reference_id, user_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        productId, variantId, ctx.storeId, LEGACY_TYPE[type], delta,
        ctx.reason ?? type, ctx.referenceType ?? null, ctx.referenceId ?? null,
        ctx.userId ?? null, ctx.notes ?? null,
    )
}

export const InventoryService = {
    /** Stock of one variant in one store. `variantId` null reads the product's own
     *  base row (a product with no size/colour axis). */
    getStock(storeId: number, productId: number, variantId: number | null = null): number {
        const row = getDatabase().prepare(`
            SELECT quantity FROM stock_inventory
            WHERE store_id = ? AND product_id = ? AND COALESCE(variant_id, 0) = ?
        `).get(storeId, productId, variantId ?? 0) as { quantity: number } | undefined
        return row?.quantity ?? 0
    },

    /** Stock of one variant across every store — what the "is it in the other shop?"
     *  question at the till needs. */
    getStockAcrossStores(productId: number, variantId: number | null = null) {
        return getDatabase().prepare(`
            SELECT s.id AS store_id, s.name AS store_name, s.code AS store_code,
                   COALESCE(si.quantity, 0) AS quantity
            FROM stores s
            LEFT JOIN stock_inventory si
              ON si.store_id = s.id AND si.product_id = ?
             AND COALESCE(si.variant_id, 0) = ?
            WHERE s.is_active = 1
            ORDER BY s.sort_order, s.id
        `).all(productId, variantId ?? 0) as
            { store_id: number; store_name: string; store_code: string; quantity: number }[]
    },

    /**
     * Remove stock, refusing to go negative. THE atomic operation — see the header.
     *
     * Returns the resulting quantity. Throws InsufficientStockError rather than
     * returning a flag, because every caller that ignored the flag would be a
     * silent oversell, and there is no safe default for "the sale half-happened".
     */
    consume(productId: number, variantId: number | null, quantity: number,
            ctx: MovementContext, type: MovementType = 'sale'): number {
        if (quantity <= 0) throw new Error('La quantité doit être positive')
        const db = getDatabase()
        const vkey = variantId ?? 0

        const guarded = !negativeStockAllowed()
        const res = db.prepare(`
            UPDATE stock_inventory
               SET quantity = quantity - ?, updated_at = datetime('now')
             WHERE store_id = ? AND product_id = ? AND COALESCE(variant_id, 0) = ?
             ${guarded ? 'AND quantity >= ?' : ''}
        `).run(...(guarded
            ? [quantity, ctx.storeId, productId, vkey, quantity]
            : [quantity, ctx.storeId, productId, vkey]))

        if (res.changes === 0) {
            // Either the row is missing (never stocked here) or the guard rejected it.
            // Both are "not enough stock" to the caller, but the message has to name
            // the real figure or the cashier cannot act on it.
            const available = this.getStock(ctx.storeId, productId, variantId)
            if (!guarded) {
                // Negative stock is permitted and there is simply no row yet: create
                // it at the negative figure so the debt is visible rather than lost.
                db.prepare(`
                    INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity, updated_at)
                    VALUES (?, ?, ?, ?, datetime('now'))
                `).run(ctx.storeId, productId, variantId, -quantity)
                writeMovement(type, productId, variantId, -quantity, ctx)
                return -quantity
            }
            const name = (db.prepare('SELECT name FROM products WHERE id = ?').get(productId) as any)?.name
                ?? `#${productId}`
            throw new InsufficientStockError(name, quantity, available)
        }

        writeMovement(type, productId, variantId, -quantity, ctx)
        return this.getStock(ctx.storeId, productId, variantId)
    },

    /**
     * Add stock. Upserts, because store 2 legitimately has no row for a variant it
     * has never carried, and a goods receipt is exactly how the first one appears.
     */
    receive(productId: number, variantId: number | null, quantity: number,
            ctx: MovementContext, type: MovementType = 'purchase'): number {
        if (quantity <= 0) throw new Error('La quantité doit être positive')
        const db = getDatabase()
        const vkey = variantId ?? 0

        const res = db.prepare(`
            UPDATE stock_inventory
               SET quantity = quantity + ?, updated_at = datetime('now')
             WHERE store_id = ? AND product_id = ? AND COALESCE(variant_id, 0) = ?
        `).run(quantity, ctx.storeId, productId, vkey)

        if (res.changes === 0) {
            db.prepare(`
                INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity, updated_at)
                VALUES (?, ?, ?, ?, datetime('now'))
            `).run(ctx.storeId, productId, variantId, quantity)
        }

        writeMovement(type, productId, variantId, quantity, ctx)
        return this.getStock(ctx.storeId, productId, variantId)
    },

    /**
     * Set stock to an absolute figure — inventory counts and manual corrections.
     * The movement records the DELTA, not the target, so the ledger still sums to
     * the current quantity (brief §19).
     */
    setAbsolute(productId: number, variantId: number | null, newQuantity: number,
                ctx: MovementContext, type: MovementType = 'adjustment'): number {
        const db = getDatabase()
        const current = this.getStock(ctx.storeId, productId, variantId)
        const delta = newQuantity - current
        if (delta === 0) return current

        const res = db.prepare(`
            UPDATE stock_inventory SET quantity = ?, updated_at = datetime('now')
             WHERE store_id = ? AND product_id = ? AND COALESCE(variant_id, 0) = ?
        `).run(newQuantity, ctx.storeId, productId, variantId ?? 0)

        if (res.changes === 0) {
            db.prepare(`
                INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity, updated_at)
                VALUES (?, ?, ?, ?, datetime('now'))
            `).run(ctx.storeId, productId, variantId, newQuantity)
        }

        writeMovement(type, productId, variantId, delta, ctx)
        return newQuantity
    },

    /**
     * Reserve every line of a cart in one go. All-or-nothing: a sale that took three
     * of four garments would leave the customer holding a partial order and the shop
     * holding wrong stock, so the transaction rolls back the moment one line fails.
     */
    consumeMany(lines: { productId: number; variantId: number | null; quantity: number }[],
                ctx: MovementContext, type: MovementType = 'sale'): void {
        const db = getDatabase()
        db.transaction(() => {
            for (const l of lines) this.consume(l.productId, l.variantId, l.quantity, ctx, type)
        })()
    },

    /** Ledger for one variant in one store, newest first. */
    getMovements(storeId: number | null, productId?: number, variantId?: number | null, limit = 200) {
        const where: string[] = []
        const params: any[] = []
        if (storeId != null) { where.push('sm.store_id = ?'); params.push(storeId) }
        if (productId != null) { where.push('sm.product_id = ?'); params.push(productId) }
        if (variantId !== undefined) {
            where.push('COALESCE(sm.variant_id, 0) = ?'); params.push(variantId ?? 0)
        }
        params.push(limit)
        return getDatabase().prepare(`
            SELECT sm.*, p.name AS product_name, u.name AS user_name,
                   st.name AS store_name, pv.size, pv.color
            FROM stock_movements sm
            LEFT JOIN products p ON p.id = sm.product_id
            LEFT JOIN product_variants pv ON pv.id = sm.variant_id
            LEFT JOIN users u ON u.id = sm.user_id
            LEFT JOIN stores st ON st.id = sm.store_id
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY sm.created_at DESC, sm.id DESC
            LIMIT ?
        `).all(...params)
    },

    /** Variants at or below their product's minimum (brief §22). */
    getLowStock(storeId: number | null) {
        const params: any[] = []
        let storeFilter = ''
        if (storeId != null) { storeFilter = 'AND si.store_id = ?'; params.push(storeId) }
        return getDatabase().prepare(`
            SELECT p.id AS product_id, p.name AS product_name, p.min_stock_level,
                   pv.id AS variant_id, pv.size, pv.color, pv.sku,
                   si.store_id, s.name AS store_name,
                   COALESCE(si.quantity, 0) AS quantity
            FROM stock_inventory si
            JOIN products p ON p.id = si.product_id
            LEFT JOIN product_variants pv ON pv.id = si.variant_id
            LEFT JOIN stores s ON s.id = si.store_id
            WHERE p.is_active = 1 AND p.min_stock_level > 0
              AND COALESCE(si.quantity, 0) <= p.min_stock_level
              ${storeFilter}
            ORDER BY (COALESCE(si.quantity, 0) - p.min_stock_level) ASC
        `).all(...params)
    },

    /** Variants with nothing left (brief §23). */
    getOutOfStock(storeId: number | null) {
        const params: any[] = []
        let storeFilter = ''
        if (storeId != null) { storeFilter = 'AND si.store_id = ?'; params.push(storeId) }
        return getDatabase().prepare(`
            SELECT p.id AS product_id, p.name AS product_name,
                   pv.id AS variant_id, pv.size, pv.color, pv.sku,
                   si.store_id, s.name AS store_name
            FROM stock_inventory si
            JOIN products p ON p.id = si.product_id
            LEFT JOIN product_variants pv ON pv.id = si.variant_id
            LEFT JOIN stores s ON s.id = si.store_id
            WHERE p.is_active = 1 AND COALESCE(si.quantity, 0) <= 0
              ${storeFilter}
            ORDER BY p.name, pv.size, pv.color
        `).all(...params)
    },

    /**
     * Stock sitting unsold for `days` (brief §24).
     *
     * "No sale in the window" is decided by the absence of a sale movement, not by a
     * last_sold column — a column would have to be maintained on every path and would
     * be wrong the first time one forgot. Variants that have NEVER sold are included:
     * they are the worst dead stock, and a naive JOIN on sales would hide exactly
     * those.
     */
    getDeadStock(storeId: number | null, days = 90) {
        // Bound in statement order: the store filter's placeholder appears before the
        // window's, so it must be bound first.
        const params: any[] = []
        let storeFilter = ''
        if (storeId != null) { storeFilter = 'AND si.store_id = ?'; params.push(storeId) }
        params.push(days)
        return getDatabase().prepare(`
            SELECT p.id AS product_id, p.name AS product_name,
                   pv.id AS variant_id, pv.size, pv.color, pv.sku,
                   si.store_id, s.name AS store_name,
                   si.quantity,
                   COALESCE(pv.cost_price, p.cost_price, 0) AS unit_cost,
                   si.quantity * COALESCE(pv.cost_price, p.cost_price, 0) AS stock_value,
                   (SELECT MAX(sm.created_at) FROM stock_movements sm
                     WHERE sm.product_id = si.product_id
                       AND COALESCE(sm.variant_id, 0) = COALESCE(si.variant_id, 0)
                       AND sm.store_id = si.store_id
                       AND sm.movement_type = 'out') AS last_sale_at
            FROM stock_inventory si
            JOIN products p ON p.id = si.product_id
            LEFT JOIN product_variants pv ON pv.id = si.variant_id
            LEFT JOIN stores s ON s.id = si.store_id
            WHERE p.is_active = 1 AND si.quantity > 0 ${storeFilter}
              AND NOT EXISTS (
                    SELECT 1 FROM stock_movements sm
                     WHERE sm.product_id = si.product_id
                       AND COALESCE(sm.variant_id, 0) = COALESCE(si.variant_id, 0)
                       AND sm.store_id = si.store_id
                       AND sm.movement_type = 'out'
                       AND sm.created_at >= datetime('now', '-' || ? || ' days')
              )
            ORDER BY stock_value DESC
        `).all(...params) as any[]
    },

    /**
     * Every stock line, with its health state decided once, in SQL.
     *
     * getLowStock / getOutOfStock / getDeadStock each answer one question and
     * they overlap: a variant at zero is BOTH out of stock and (having not sold
     * in 90 days) dead. Reading all three into one screen therefore double-counts
     * — the shop is told it has 24 ruptures and 37 dormants when 19 of them are
     * the same garment.
     *
     * This returns one row per stock line with exactly ONE state, in priority
     * order: a rupture is a rupture first, and only stock you actually HAVE can
     * be described as dormant. The counts then add up to the total, which is
     * what lets the screen draw a single honest health bar.
     *
     * The three single-purpose queries stay: they are what the notification
     * sweep and the reports ask, and they are right for those.
     */
    getOverview(storeId: number | null, deadDays = 90) {
        const params: any[] = [deadDays]
        let storeFilter = ''
        if (storeId != null) { storeFilter = 'AND si.store_id = ?'; params.push(storeId) }

        return getDatabase().prepare(`
            SELECT p.id AS product_id, p.name AS product_name, p.min_stock_level,
                   p.category_id, c.name AS category_name,
                   pv.id AS variant_id, pv.size, pv.color,
                   COALESCE(pv.sku, p.sku) AS sku,
                   COALESCE(pv.barcode, p.barcode) AS barcode,
                   si.store_id, s.name AS store_name,
                   COALESCE(si.quantity, 0) AS quantity,
                   COALESCE(pv.cost_price, p.cost_price, 0) AS unit_cost,
                   COALESCE(pv.retail_price, p.retail_price, 0) AS unit_price,
                   COALESCE(si.quantity, 0) * COALESCE(pv.cost_price, p.cost_price, 0) AS stock_value,
                   last.at AS last_sale_at,
                   CASE
                     WHEN COALESCE(si.quantity, 0) <= 0 THEN 'out'
                     WHEN p.min_stock_level > 0
                          AND COALESCE(si.quantity, 0) <= p.min_stock_level THEN 'low'
                     WHEN last.at IS NULL
                          OR last.at < datetime('now', '-' || ? || ' days') THEN 'dead'
                     ELSE 'healthy'
                   END AS state
            FROM stock_inventory si
            JOIN products p ON p.id = si.product_id
            LEFT JOIN product_variants pv ON pv.id = si.variant_id
            LEFT JOIN stores s ON s.id = si.store_id
            LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN (
                SELECT sm.product_id, COALESCE(sm.variant_id, 0) AS vid, sm.store_id,
                       MAX(sm.created_at) AS at
                FROM stock_movements sm
                WHERE sm.movement_type = 'out'
                GROUP BY sm.product_id, COALESCE(sm.variant_id, 0), sm.store_id
            ) last
              ON last.product_id = si.product_id
             AND last.vid = COALESCE(si.variant_id, 0)
             AND last.store_id = si.store_id
            WHERE p.is_active = 1 ${storeFilter}
            ORDER BY p.name, pv.sort_order, pv.size, pv.color
        `).all(...params) as StockOverviewRow[]
    },

    /** Total quantity and cost value on hand (brief §55). */
    getStockValue(storeId: number | null) {
        const params: any[] = []
        let storeFilter = ''
        if (storeId != null) { storeFilter = 'AND si.store_id = ?'; params.push(storeId) }
        return getDatabase().prepare(`
            SELECT COALESCE(SUM(si.quantity), 0) AS total_quantity,
                   COALESCE(SUM(si.quantity * COALESCE(pv.cost_price, p.cost_price, 0)), 0) AS total_cost_value,
                   COALESCE(SUM(si.quantity * COALESCE(pv.retail_price, p.retail_price, 0)), 0) AS total_retail_value
            FROM stock_inventory si
            JOIN products p ON p.id = si.product_id
            LEFT JOIN product_variants pv ON pv.id = si.variant_id
            WHERE si.quantity > 0 ${storeFilter}
        `).get(...params) as { total_quantity: number; total_cost_value: number; total_retail_value: number }
    },
}
