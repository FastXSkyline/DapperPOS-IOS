import type Database from 'better-sqlite3'
import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// Pricing engine
//
// Dapper is a RETAIL shop (Dapper Phase 4): there is exactly one shelf price.
// Precedence, highest to lowest:
//   1. Per-customer negotiated price (customer_prices)  -> fixed, ignores qty
//   2. products.retail_price                            -> the shelf price
//   3. Promotions / quantity breaks (pricing_rules)     -> applied on top of (2)
//
// The wholesale tier columns (products.wholesale_price / semi_wholesale_price,
// customers.price_tier) are left in the schema but are NO LONGER CONSULTED —
// see docs/DAPPER_PLAN.md §3.1. They are dormant, not deleted, so the change is
// reversible; nothing should start reading them again without revisiting that.
//
// The engine is authoritative on the backend so the POS, the sync server and
// the AI orchestrator all resolve identical prices. The renderer never has to
// re-implement this logic — it passes the *base* unit price and the backend
// applies any promotion or quantity break.
// ---------------------------------------------------------------------------

export interface PricingRule {
    id: number
    name: string
    rule_type: 'bulk' | 'promotional' | 'wholesale_tier'
    product_id: number | null
    category_id: number | null
    min_quantity: number
    discount_type: 'percentage' | 'fixed' | 'price_override'
    discount_value: number
    start_date: string | null
    end_date: string | null
    is_active: number
}

/**
 * The shelf price for a product, before promotions and quantity breaks.
 *
 * Retail-only: every customer pays the same shelf price, so this no longer takes a
 * customer. A specific customer can still have a negotiated price (see
 * negotiatedPrice) — that is a per-customer agreement, not a wholesale tier.
 */
export function shelfPrice(product: { retail_price?: number }): number {
    return product?.retail_price || 0
}

/** Negotiated per-customer price, or null if none. */
export function negotiatedPrice(db: Database.Database, customerId: number | null | undefined, productId: number): number | null {
    if (!customerId) return null
    const row = db.prepare('SELECT price FROM customer_prices WHERE customer_id = ? AND product_id = ?').get(customerId, productId) as { price: number } | undefined
    return row ? row.price : null
}

/** All active bulk/promotional rules applicable to a product (direct or via its category),
 *  within their date window, ordered by the threshold they require (descending). */
export function applicableRules(db: Database.Database, productId: number, categoryId: number | null): PricingRule[] {
    return db.prepare(`
        SELECT * FROM pricing_rules
        WHERE is_active = 1
          AND rule_type IN ('bulk', 'promotional', 'wholesale_tier')
          AND (product_id = ? OR (product_id IS NULL AND category_id IS NOT NULL AND category_id = ?))
          AND (start_date IS NULL OR start_date = '' OR date(start_date) <= date('now'))
          AND (end_date   IS NULL OR end_date   = '' OR date(end_date)   >= date('now'))
        ORDER BY min_quantity DESC
    `).all(productId, categoryId) as PricingRule[]
}

function priceFromRule(base: number, rule: PricingRule): number {
    switch (rule.discount_type) {
        case 'percentage': return base * (1 - rule.discount_value / 100)
        case 'fixed': return base - rule.discount_value
        case 'price_override': return rule.discount_value
        default: return base
    }
}

/** Apply the best (lowest) applicable quantity break to a base unit price. */
export function applyBulkPrice(db: Database.Database, productId: number, basePrice: number, quantity: number): number {
    const prod = db.prepare('SELECT category_id FROM products WHERE id = ?').get(productId) as { category_id: number | null } | undefined
    const rules = applicableRules(db, productId, prod?.category_id ?? null)
    let best = basePrice
    for (const rule of rules) {
        if (quantity >= (rule.min_quantity || 1)) {
            const candidate = priceFromRule(basePrice, rule)
            if (candidate >= 0 && candidate < best) best = candidate
        }
    }
    return best
}

/** Full resolution used by the AI / sync paths that only have ids. */
export function resolveUnitPrice(db: Database.Database, productId: number, customerId: number | null | undefined, quantity: number): number {
    const product = db.prepare('SELECT retail_price FROM products WHERE id = ?').get(productId) as { retail_price: number } | undefined
    if (!product) return 0
    const negotiated = negotiatedPrice(db, customerId, productId)
    if (negotiated != null) return negotiated // fixed agreed price, ignores promotions
    // Retail-only: no customer lookup needed, everyone starts from the shelf price.
    return applyBulkPrice(db, productId, shelfPrice(product), quantity)
}

export const PricingService = {
    listRules(): PricingRule[] {
        return getDatabase().prepare('SELECT * FROM pricing_rules ORDER BY is_active DESC, name').all() as PricingRule[]
    },
    createRule(r: Partial<PricingRule>): { id: number } {
        const db = getDatabase()
        const res = db.prepare(`
            INSERT INTO pricing_rules (name, rule_type, product_id, category_id, min_quantity, discount_type, discount_value, start_date, end_date, is_active)
            VALUES (@name, @rule_type, @product_id, @category_id, @min_quantity, @discount_type, @discount_value, @start_date, @end_date, 1)
        `).run({
            name: r.name || 'Remise quantité',
            rule_type: r.rule_type || 'bulk',
            product_id: r.product_id ?? null,
            category_id: r.category_id ?? null,
            min_quantity: r.min_quantity ?? 1,
            discount_type: r.discount_type || 'percentage',
            discount_value: r.discount_value ?? 0,
            start_date: r.start_date ?? null,
            end_date: r.end_date ?? null,
        })
        return { id: res.lastInsertRowid as number }
    },
    deleteRule(id: number): { success: boolean } {
        getDatabase().prepare('DELETE FROM pricing_rules WHERE id = ?').run(id)
        return { success: true }
    },
    setActive(id: number, active: boolean): { success: boolean } {
        getDatabase().prepare('UPDATE pricing_rules SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id)
        return { success: true }
    },
}
