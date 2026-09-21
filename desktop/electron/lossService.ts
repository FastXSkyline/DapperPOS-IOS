import { getDatabase } from './database'
import { StockService } from './stockService'

// ---------------------------------------------------------------------------
// Pertes / shrinkage (Dapper Phase 3).
//
// Theft, damage and staining are a real cost line in apparel retail, and they are
// NOT the same thing as a routine stock adjustment: a correction fixes a counting
// mistake, a loss destroys value. Recording them separately is what lets the owner
// see what shrinkage actually costs over a season.
//
// Each loss snapshots the unit cost at the time it happened, so later price changes
// don't silently rewrite the historical valuation.
// ---------------------------------------------------------------------------

export type LossReason = 'theft' | 'damage' | 'stain' | 'expired' | 'lost' | 'other'

export interface StockLoss {
    id: number
    product_id: number
    variant_id: number | null
    product_name: string | null
    quantity: number
    unit_cost: number
    total_cost: number
    reason: LossReason
    notes: string | null
    user_id: number | null
    created_at: string
}

export const LossService = {
    /**
     * Record a loss and take the goods out of stock atomically.
     * Stock movement and loss row commit together, so stock can never drop without
     * a matching record of why.
     */
    record(input: {
        productId: number
        variantId?: number | null
        quantity: number
        reason: LossReason
        notes?: string
        userId?: number
    }) {
        const db = getDatabase()
        const qty = Number(input.quantity) || 0
        if (!input.productId) return { success: false, error: 'Article manquant.' }
        if (qty <= 0) return { success: false, error: 'Quantité invalide.' }

        const product = db.prepare('SELECT name, cost_price FROM products WHERE id = ?')
            .get(input.productId) as { name: string; cost_price: number } | undefined
        if (!product) return { success: false, error: 'Article introuvable.' }

        // A variant may carry its own cost; fall back to the product's.
        let unitCost = product.cost_price || 0
        if (input.variantId) {
            const v = db.prepare('SELECT cost_price FROM product_variants WHERE id = ?')
                .get(input.variantId) as { cost_price: number | null } | undefined
            if (v?.cost_price != null) unitCost = v.cost_price
        }

        const variantLabel = input.variantId
            ? (db.prepare(`SELECT TRIM(COALESCE(size,'') || CASE WHEN COALESCE(size,'') <> '' AND COALESCE(color,'') <> '' THEN ' / ' ELSE '' END || COALESCE(color,'')) AS label
                           FROM product_variants WHERE id = ?`).get(input.variantId) as { label: string } | undefined)?.label
            : ''
        const name = variantLabel ? `${product.name} (${variantLabel})` : product.name

        try {
            const id = db.transaction(() => {
                // Throws on insufficient stock, which rolls the whole thing back —
                // no loss record without the matching stock movement.
                StockService.adjustStock(
                    input.productId, qty, 'out', input.userId || 0,
                    `Perte: ${input.reason}`, input.notes || undefined,
                    input.variantId || undefined
                )
                const res = db.prepare(`
                    INSERT INTO stock_losses (product_id, variant_id, product_name, quantity, unit_cost, total_cost, reason, notes, user_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    input.productId, input.variantId || null, name, qty,
                    unitCost, round2(unitCost * qty), input.reason, input.notes || null, input.userId || null
                )
                return res.lastInsertRowid as number
            })()
            return { success: true, id }
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : ''
            const msg = /Insufficient stock/i.test(message)
                ? 'Stock insuffisant pour enregistrer cette perte.'
                : (message || 'Enregistrement impossible.')
            return { success: false, error: msg }
        }
    },

    list(limit = 100) {
        const db = getDatabase()
        return db.prepare(`
            SELECT sl.*, u.name AS user_name
            FROM stock_losses sl
            LEFT JOIN users u ON u.id = sl.user_id
            ORDER BY sl.id DESC LIMIT ?
        `).all(limit) as (StockLoss & { user_name?: string })[]
    },

    /** Cost of shrinkage over a period, split by reason — the number that matters. */
    summary(startDate?: string, endDate?: string) {
        const db = getDatabase()
        const start = startDate || '0000-01-01'
        const end = endDate || '9999-12-31'
        const byReason = db.prepare(`
            SELECT reason, COUNT(*) AS entries, ROUND(SUM(quantity), 2) AS quantity, ROUND(SUM(total_cost), 2) AS cost
            FROM stock_losses WHERE date(created_at) BETWEEN date(?) AND date(?)
            GROUP BY reason ORDER BY cost DESC
        `).all(start, end) as { reason: string; entries: number; quantity: number; cost: number }[]

        const total = byReason.reduce((s, r) => s + (r.cost || 0), 0)
        return { byReason, totalCost: round2(total), totalEntries: byReason.reduce((s, r) => s + r.entries, 0) }
    },

    /** Undo a mis-keyed loss: returns the goods to stock and drops the record. */
    revert(id: number, userId?: number) {
        const db = getDatabase()
        const loss = db.prepare('SELECT * FROM stock_losses WHERE id = ?').get(id) as StockLoss | undefined
        if (!loss) return { success: false, error: 'Perte introuvable.' }
        try {
            db.transaction(() => {
                StockService.adjustStock(
                    loss.product_id, loss.quantity, 'in', userId || 0,
                    'Annulation perte', `Perte #${id}`, loss.variant_id || undefined
                )
                db.prepare('DELETE FROM stock_losses WHERE id = ?').run(id)
            })()
            return { success: true }
        } catch (e: unknown) {
            return { success: false, error: e instanceof Error ? e.message : 'Annulation impossible.' }
        }
    }
}

function round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100
}
