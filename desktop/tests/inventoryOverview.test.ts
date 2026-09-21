import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from './helpers/sqliteHarness'
import { runRetailMigrations } from '../electron/migrationsRetail'

let testDb: any
vi.mock('../electron/database', () => ({ getDatabase: () => testDb }))

const { InventoryService } = await import('../electron/inventoryService')

const COSTUME = 1
const CASUAL = 2

/* ---------------------------------------------------------------------------
   getOverview is what the Inventaire screen draws its health bar from, so the
   property that matters most is EXCLUSIVITY: every stock line gets exactly one
   state, and the four counts add up to the total.

   That is not pedantry. The screen it replaced read getLowStock, getOutOfStock
   and getDeadStock and showed all three, and those overlap — a variant at zero
   that has not sold in 90 days appears in two of them. The shop was told it had
   more problems than it has, and no total on the screen was true.
   --------------------------------------------------------------------------- */

function seedProduct(id: number, name: string, minStock = 0) {
    testDb.prepare(
        'INSERT OR IGNORE INTO products (id, name, cost_price, retail_price, min_stock_level) VALUES (?, ?, 18000, 35000, ?)',
    ).run(id, name, minStock)
}

function seedVariant(variantId: number, productId: number, size: string, color: string) {
    testDb.prepare(
        'INSERT OR IGNORE INTO product_variants (id, product_id, size, color) VALUES (?, ?, ?, ?)',
    ).run(variantId, productId, size, color)
}

function setStock(productId: number, variantId: number | null, qty: number, storeId = COSTUME) {
    testDb.prepare(
        'INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (?, ?, ?, ?)',
    ).run(storeId, productId, variantId, qty)
}

/** A sale `daysAgo` days back, which is what keeps a line out of "dormant". */
function soldDaysAgo(productId: number, variantId: number | null, daysAgo: number, storeId = COSTUME) {
    testDb.prepare(`
        INSERT INTO stock_movements (product_id, variant_id, store_id, movement_type, quantity, created_at)
        VALUES (?, ?, ?, 'out', -1, datetime('now', '-' || ? || ' days'))
    `).run(productId, variantId, storeId, daysAgo)
}

const stateOf = (rows: any[], variantId: number) =>
    rows.find(r => r.variant_id === variantId)?.state

beforeEach(() => {
    testDb = makeTestDb()
    runRetailMigrations(testDb)
    testDb.prepare("INSERT OR IGNORE INTO stores (id, name, code) VALUES (?, 'Costume', 'CST')").run(COSTUME)
    testDb.prepare("INSERT OR IGNORE INTO stores (id, name, code) VALUES (?, 'Casual', 'CAS')").run(CASUAL)
})

describe('stock state classification', () => {
    it('calls a line with stock and a recent sale healthy', () => {
        seedProduct(1, 'Costume Milano', 2)
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 8)
        soldDaysAgo(1, 10, 3)

        expect(stateOf(InventoryService.getOverview(COSTUME), 10)).toBe('healthy')
    })

    it('calls a line at or below its threshold low', () => {
        seedProduct(1, 'Costume Milano', 5)
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 5)
        soldDaysAgo(1, 10, 1)

        expect(stateOf(InventoryService.getOverview(COSTUME), 10)).toBe('low')
    })

    it('calls an empty line a rupture', () => {
        seedProduct(1, 'Costume Milano', 5)
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 0)

        expect(stateOf(InventoryService.getOverview(COSTUME), 10)).toBe('out')
    })

    it('calls stock that has not moved in the window dormant', () => {
        seedProduct(1, 'Costume Milano', 2)
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 8)
        soldDaysAgo(1, 10, 200)

        expect(stateOf(InventoryService.getOverview(COSTUME, 90), 10)).toBe('dead')
    })

    it('treats stock that has NEVER sold as dormant, not as healthy', () => {
        // The worst dead stock there is; a naive join on sales would hide exactly
        // these lines because they have no sale row to join to.
        seedProduct(1, 'Costume Milano', 2)
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 8)

        expect(stateOf(InventoryService.getOverview(COSTUME, 90), 10)).toBe('dead')
    })

    it('moves a line out of dormant when the window is widened past its last sale', () => {
        seedProduct(1, 'Costume Milano', 2)
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 8)
        soldDaysAgo(1, 10, 100)

        expect(stateOf(InventoryService.getOverview(COSTUME, 90), 10)).toBe('dead')
        expect(stateOf(InventoryService.getOverview(COSTUME, 180), 10)).toBe('healthy')
    })

    it('ignores a threshold of zero rather than flagging everything as low', () => {
        seedProduct(1, 'Costume Milano', 0)
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 1)
        soldDaysAgo(1, 10, 1)

        expect(stateOf(InventoryService.getOverview(COSTUME), 10)).toBe('healthy')
    })
})

describe('state exclusivity', () => {
    it('gives a stale empty line ONE state — rupture, not rupture and dormant', () => {
        seedProduct(1, 'Costume Milano', 5)
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 0)
        soldDaysAgo(1, 10, 300)

        const rows = InventoryService.getOverview(COSTUME, 90)
        expect(rows.filter(r => r.variant_id === 10)).toHaveLength(1)
        expect(stateOf(rows, 10)).toBe('out')

        // The old screen read three overlapping queries and would have counted this
        // same garment in both the rupture list and the dormant list.
        const legacyOut = InventoryService.getOutOfStock(COSTUME) as any[]
        expect(legacyOut.some(r => r.variant_id === 10)).toBe(true)
    })

    it('prefers rupture over low for an empty line under its threshold', () => {
        seedProduct(1, 'Costume Milano', 5)
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 0)
        soldDaysAgo(1, 10, 1)

        expect(stateOf(InventoryService.getOverview(COSTUME), 10)).toBe('out')
    })

    it('prefers low over dormant for a nearly-empty line that has not sold', () => {
        seedProduct(1, 'Costume Milano', 5)
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 2)

        expect(stateOf(InventoryService.getOverview(COSTUME, 90), 10)).toBe('low')
    })

    it('makes the four counts add up to the number of lines', () => {
        seedProduct(1, 'Costume Milano', 3)
        seedVariant(10, 1, '52', 'Bleu Marine'); setStock(1, 10, 9); soldDaysAgo(1, 10, 2)   // healthy
        seedVariant(11, 1, '54', 'Bleu Marine'); setStock(1, 11, 3); soldDaysAgo(1, 11, 2)   // low
        seedVariant(12, 1, '56', 'Bleu Marine'); setStock(1, 12, 0)                          // out
        seedVariant(13, 1, '58', 'Noir'); setStock(1, 13, 6)                                 // dead

        const rows = InventoryService.getOverview(COSTUME, 90)
        const counts = { healthy: 0, low: 0, out: 0, dead: 0 } as Record<string, number>
        for (const r of rows) counts[r.state]++

        expect(rows).toHaveLength(4)
        expect(counts).toEqual({ healthy: 1, low: 1, out: 1, dead: 1 })
        expect(counts.healthy + counts.low + counts.out + counts.dead).toBe(rows.length)
    })
})

describe('scope and valuation', () => {
    it('judges each shop on its own stock', () => {
        seedProduct(1, 'Costume Milano', 5)
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 20, COSTUME)
        setStock(1, 10, 1, CASUAL)
        soldDaysAgo(1, 10, 2, COSTUME)
        soldDaysAgo(1, 10, 2, CASUAL)

        // The same garment is comfortable in one shop and nearly out in the other —
        // a combined figure would hide that, which is the whole reason stock is
        // per store.
        expect(InventoryService.getOverview(COSTUME).find(r => r.store_id === COSTUME)!.state).toBe('healthy')
        expect(InventoryService.getOverview(CASUAL).find(r => r.store_id === CASUAL)!.state).toBe('low')
    })

    it('returns both shops when no store is given', () => {
        seedProduct(1, 'Costume Milano')
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 4, COSTUME)
        setStock(1, 10, 6, CASUAL)

        const rows = InventoryService.getOverview(null)
        expect(rows).toHaveLength(2)
        expect(new Set(rows.map(r => r.store_id))).toEqual(new Set([COSTUME, CASUAL]))
    })

    it('values a line at cost, falling back to the product when the variant has none', () => {
        seedProduct(1, 'Costume Milano')
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 3)

        const row = InventoryService.getOverview(COSTUME).find(r => r.variant_id === 10)!
        expect(row.unit_cost).toBe(18000)
        expect(row.stock_value).toBe(54000)
        expect(row.unit_price).toBe(35000)
    })

    it("prefers the variant's own cost when it has one", () => {
        seedProduct(1, 'Costume Milano')
        seedVariant(10, 1, '52', 'Bleu Marine')
        testDb.prepare('UPDATE product_variants SET cost_price = 21000 WHERE id = 10').run()
        setStock(1, 10, 2)

        expect(InventoryService.getOverview(COSTUME).find(r => r.variant_id === 10)!.stock_value).toBe(42000)
    })

    it('leaves deactivated products out entirely', () => {
        seedProduct(1, 'Costume Milano')
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 5)
        testDb.prepare('UPDATE products SET is_active = 0 WHERE id = 1').run()

        expect(InventoryService.getOverview(COSTUME)).toHaveLength(0)
    })

    it('handles a product with no variants at all', () => {
        seedProduct(2, 'Ceinture cuir', 2)
        setStock(2, null, 1)

        const rows = InventoryService.getOverview(COSTUME)
        expect(rows).toHaveLength(1)
        expect(rows[0].variant_id).toBeNull()
        expect(rows[0].state).toBe('low')
    })

    it('reports when a line last sold, and null when it never has', () => {
        seedProduct(1, 'Costume Milano')
        seedVariant(10, 1, '52', 'Bleu Marine'); setStock(1, 10, 4); soldDaysAgo(1, 10, 5)
        seedVariant(11, 1, '54', 'Bleu Marine'); setStock(1, 11, 4)

        const rows = InventoryService.getOverview(COSTUME)
        expect(rows.find(r => r.variant_id === 10)!.last_sale_at).toBeTruthy()
        expect(rows.find(r => r.variant_id === 11)!.last_sale_at).toBeNull()
    })

    it('does not let one shop\'s sale rescue another shop\'s dormant stock', () => {
        seedProduct(1, 'Costume Milano')
        seedVariant(10, 1, '52', 'Bleu Marine')
        setStock(1, 10, 5, COSTUME)
        setStock(1, 10, 5, CASUAL)
        soldDaysAgo(1, 10, 2, COSTUME)

        const rows = InventoryService.getOverview(null, 90)
        expect(rows.find(r => r.store_id === COSTUME)!.state).toBe('healthy')
        expect(rows.find(r => r.store_id === CASUAL)!.state).toBe('dead')
    })
})
