import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from './helpers/sqliteHarness'
import { runRetailMigrations } from '../electron/migrationsRetail'

let testDb: any
vi.mock('../electron/database', () => ({ getDatabase: () => testDb }))

const { AnalyticsService } = await import('../electron/analyticsService')
const { TransactionService } = await import('../electron/transactionService')
const { ReturnService } = await import('../electron/returnService')

const COSTUME = 1
const CASUAL = 2
const SELLER = 10

/** Catalogue: one suit (52/54 Navy) and one shirt (M/XL Blanche), tax-exempt so
 *  the arithmetic under test is the analytics, not the TVA. */
function seedCatalogue() {
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Karim', 'x', 'manager')").run(SELLER)

    testDb.prepare("INSERT INTO products (id, name, cost_price, retail_price, tax_category_id) VALUES (1, 'Costume Milano', 18000, 35000, 3)").run()
    testDb.prepare("INSERT INTO products (id, name, cost_price, retail_price, tax_category_id) VALUES (2, 'Chemise Oxford', 2000, 4500, 3)").run()
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (1, 1, '52', 'Bleu Marine')").run()
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (2, 1, '54', 'Bleu Marine')").run()
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (3, 2, 'M', 'Blanche')").run()
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (4, 2, 'XL', 'Noir')").run()

    for (const [store, variant, product, qty] of [
        [COSTUME, 1, 1, 50], [COSTUME, 2, 1, 50], [COSTUME, 3, 2, 50], [COSTUME, 4, 2, 50],
        [CASUAL, 1, 1, 50], [CASUAL, 3, 2, 50],
    ]) {
        testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (?, ?, ?, ?)')
            .run(store, product, variant, qty)
    }
}

/** A completed sale. `at` overrides created_at so hour/period tests can place it. */
function sell(
    lines: { productId: number; variantId: number; name: string; qty: number; price: number }[],
    opts: { storeId?: number; at?: string; customerId?: number } = {},
) {
    const t = TransactionService.create(SELLER, opts.customerId, opts.storeId ?? COSTUME)
    for (const l of lines) {
        TransactionService.addItem(t.id, l.productId, l.name, l.qty, l.price, null, l.variantId)
    }
    TransactionService.complete(t.id)
    if (opts.at) {
        testDb.prepare('UPDATE transactions SET created_at = ?, completed_at = ? WHERE id = ?')
            .run(opts.at, opts.at, t.id)
    }
    return t.id
}

const SUIT = { productId: 1, variantId: 1, name: 'Costume Milano', price: 35000 }
const SHIRT = { productId: 2, variantId: 3, name: 'Chemise Oxford', price: 4500 }

beforeEach(() => {
    testDb = makeTestDb()
    runRetailMigrations(testDb)
    seedCatalogue()
})

describe('summary — the definitions', () => {
    it('nets returns off gross revenue', () => {
        const saleId = sell([{ ...SUIT, qty: 1 }])
        sell([{ ...SHIRT, qty: 2 }])

        let s = AnalyticsService.summary({})
        expect(s.grossRevenue).toBe(35000 + 9000)
        expect(s.netRevenue).toBe(44000)

        const item = testDb.prepare('SELECT id FROM transaction_items WHERE transaction_id = ?').get(saleId) as any
        ReturnService.createRefund({
            originalTransactionId: saleId, userId: SELLER,
            lines: [{ originalItemId: item.id, quantity: 1 }],
        })

        s = AnalyticsService.summary({})
        expect(s.grossRevenue).toBe(44000)     // gross does not move
        expect(s.returnsValue).toBe(35000)
        expect(s.netRevenue).toBe(9000)        // net does
    })

    it('computes gross profit and margin from COGS', () => {
        sell([{ ...SUIT, qty: 1 }])            // sells 35 000, costs 18 000
        const s = AnalyticsService.summary({})
        expect(s.cogs).toBe(18000)
        expect(s.grossProfit).toBe(17000)
        expect(s.grossMargin).toBeCloseTo(48.571, 2)
    })

    it('freezes the margin against a later change in purchase price', () => {
        // The bug Migration 42 fixes. Before it, raising the supplier price rewrote
        // the profit on every sale already made.
        sell([{ ...SUIT, qty: 1 }])
        const before = AnalyticsService.summary({})

        testDb.prepare('UPDATE products SET cost_price = 30000 WHERE id = 1').run()
        testDb.prepare('UPDATE product_variants SET cost_price = 30000 WHERE id = 1').run()

        const after = AnalyticsService.summary({})
        expect(after.cogs).toBe(before.cogs)
        expect(after.grossProfit).toBe(17000)
        expect(after.estimatedCostLines).toBe(0)
    })

    it('counts lines whose cost is only an estimate', () => {
        sell([{ ...SUIT, qty: 1 }])
        // Simulate a line written before Migration 42.
        testDb.prepare('UPDATE transaction_items SET unit_cost = NULL').run()
        const s = AnalyticsService.summary({})
        expect(s.estimatedCostLines).toBe(1)
        // It still falls back to the current cost rather than counting the goods free.
        expect(s.cogs).toBe(18000)
    })

    it('reports zeroes, not NaN, for an empty window', () => {
        const s = AnalyticsService.summary({ from: '2000-01-01', to: '2000-01-02' })
        expect(s.grossRevenue).toBe(0)
        expect(s.grossMargin).toBe(0)
        expect(s.returnRate).toBe(0)
        expect(s.avgBasket).toBe(0)
    })
})

describe('sales by size', () => {
    it('orders suit sizes numerically, not alphabetically', () => {
        // The reason the `sizes` reference table exists: sorted as text, '54' would
        // come before '9' and XL before XS, and the chart would lie about which end
        // of the range is selling.
        sell([{ ...SUIT, qty: 1 }])
        sell([{ productId: 1, variantId: 2, name: 'Costume Milano', qty: 3, price: 35000 }])

        const rows = AnalyticsService.salesBySize({})
        expect(rows.map(r => r.label)).toEqual(['52', '54'])
        expect(rows.find(r => r.label === '54')!.units).toBe(3)
        expect(rows[0].size_group).toBe('suit')
    })

    it('orders alpha sizes S → M → L → XL', () => {
        sell([{ productId: 2, variantId: 4, name: 'Chemise Oxford', qty: 1, price: 4500 }])  // XL
        sell([{ ...SHIRT, qty: 5 }])                                                          // M
        const rows = AnalyticsService.salesBySize({})
        expect(rows.map(r => r.label)).toEqual(['M', 'XL'])
    })

    it('ignores lines with no variant', () => {
        const t = TransactionService.create(SELLER, undefined, COSTUME)
        TransactionService.addItem(t.id, 1, 'Costume Milano', 1, 35000, null, null)
        testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (1, 1, NULL, 5)').run()
        TransactionService.complete(t.id)
        expect(AnalyticsService.salesBySize({})).toHaveLength(0)
    })
})

describe('sales by colour', () => {
    it('ranks colours by units and carries the swatch', () => {
        sell([{ ...SUIT, qty: 2 }])                                                            // Bleu Marine
        sell([{ productId: 2, variantId: 4, name: 'Chemise Oxford', qty: 5, price: 4500 }])    // Noir

        const rows = AnalyticsService.salesByColor({})
        expect(rows[0]).toMatchObject({ label: 'Noir', units: 5 })
        expect(rows[1]).toMatchObject({ label: 'Bleu Marine', units: 2 })
        // The hex comes from the seeded palette so a chart can show the real colour.
        expect(rows[0].hex).toBe('#111111')
    })
})

describe('sales by hour', () => {
    it('returns all 24 hours, including the dead ones', () => {
        // A bar chart that omits quiet hours closes the gap and makes a slow
        // afternoon look busy.
        sell([{ ...SHIRT, qty: 1 }], { at: '2026-09-01 10:30:00' })
        const rows = AnalyticsService.salesByHour({})
        expect(rows).toHaveLength(24)
        expect(rows[0].hour).toBe(0)
        expect(rows[23].hour).toBe(23)
        expect(rows.filter(r => r.transactions > 0)).toHaveLength(1)
    })

    it('buckets a sale into its local hour with items and revenue', () => {
        sell([{ ...SHIRT, qty: 3 }], { at: '2026-09-01 14:05:00' })
        const rows = AnalyticsService.salesByHour({})
        // created_at is stored in UTC and read back as localtime, so assert on the
        // single non-empty bucket rather than on a fixed hour.
        const busy = rows.filter(r => r.transactions > 0)
        expect(busy).toHaveLength(1)
        expect(busy[0].items).toBe(3)
        expect(busy[0].revenue).toBe(13500)
    })
})

describe('store comparison', () => {
    it('splits revenue by store without hardcoding a store name', () => {
        sell([{ ...SUIT, qty: 1 }], { storeId: COSTUME })
        sell([{ ...SHIRT, qty: 2 }], { storeId: CASUAL })

        const rows = AnalyticsService.storeComparison({})
        expect(rows.map(r => r.storeCode)).toEqual(['CST', 'CAS'])
        expect(rows.find(r => r.storeCode === 'CST')!.grossRevenue).toBe(35000)
        expect(rows.find(r => r.storeCode === 'CAS')!.grossRevenue).toBe(9000)
    })

    it('picks up a third store with no code change', () => {
        testDb.prepare("INSERT INTO stores (id, code, name, sort_order) VALUES (3, 'OUT', 'Outlet', 3)").run()
        const rows = AnalyticsService.storeComparison({})
        expect(rows).toHaveLength(3)
        expect(rows[2].storeName).toBe('Outlet')
    })

    it('charges a return to the store that SOLD the goods', () => {
        // Sold in Costume, handed back in Casual. Casual's revenue must not suffer
        // for a sale it never made.
        const saleId = sell([{ ...SUIT, qty: 1 }], { storeId: COSTUME })
        const item = testDb.prepare('SELECT id FROM transaction_items WHERE transaction_id = ?').get(saleId) as any
        ReturnService.createRefund({
            originalTransactionId: saleId, storeId: CASUAL, userId: SELLER,
            lines: [{ originalItemId: item.id, quantity: 1 }],
        })

        const rows = AnalyticsService.storeComparison({})
        expect(rows.find(r => r.storeCode === 'CST')!.returnsValue).toBe(35000)
        expect(rows.find(r => r.storeCode === 'CAS')!.returnsValue).toBe(0)
    })

    it('reports stock value per store', () => {
        const rows = AnalyticsService.storeComparison({})
        // Costume: 100 suits @18 000 + 100 shirts @2 000
        expect(rows.find(r => r.storeCode === 'CST')!.stockValue).toBe(100 * 18000 + 100 * 2000)
        expect(rows.find(r => r.storeCode === 'CAS')!.stockValue).toBe(50 * 18000 + 50 * 2000)
    })
})

describe('period comparison', () => {
    it('reports the change and the percentage', () => {
        sell([{ ...SHIRT, qty: 2 }], { at: '2026-08-15 10:00:00' })   // previous
        sell([{ ...SHIRT, qty: 3 }], { at: '2026-09-15 10:00:00' })   // current

        const c = AnalyticsService.periodComparison(
            { from: '2026-09-01', to: '2026-09-30 23:59:59' },
            { from: '2026-08-01', to: '2026-08-31 23:59:59' },
        )
        expect(c.revenue.previous).toBe(9000)
        expect(c.revenue.current).toBe(13500)
        expect(c.revenue.change).toBe(4500)
        expect(c.revenue.percent).toBeCloseTo(50, 6)
    })

    it('reports null rather than Infinity when the previous period was empty', () => {
        sell([{ ...SHIRT, qty: 1 }], { at: '2026-09-15 10:00:00' })
        const c = AnalyticsService.periodComparison(
            { from: '2026-09-01', to: '2026-09-30 23:59:59' },
            { from: '2026-08-01', to: '2026-08-31 23:59:59' },
        )
        expect(c.revenue.percent).toBeNull()
        expect(c.revenue.current).toBe(4500)
    })
})

describe('customer mix', () => {
    it('counts a customer as new only on their first ever sale', () => {
        testDb.prepare("INSERT INTO customers (id, name) VALUES (5, 'Amine')").run()
        sell([{ ...SHIRT, qty: 1 }], { customerId: 5, at: '2026-08-01 10:00:00' })
        sell([{ ...SHIRT, qty: 1 }], { customerId: 5, at: '2026-09-01 10:00:00' })

        // Looking only at September, Amine is a RETURNING customer — treating them as
        // new because the window is short would inflate acquisition every month.
        const sept = AnalyticsService.customerMix({ from: '2026-09-01', to: '2026-09-30 23:59:59' })
        expect(sept.newCustomers).toBe(0)
        expect(sept.returningCustomers).toBe(1)

        const all = AnalyticsService.customerMix({})
        expect(all.newCustomers).toBe(1)
    })

    it('counts walk-in sales separately from named customers', () => {
        sell([{ ...SHIRT, qty: 1 }])                       // no customer
        sell([{ ...SHIRT, qty: 1 }], { customerId: 1 })    // "Walk-in Customer"
        const mix = AnalyticsService.customerMix({})
        expect(mix.walkInSales).toBe(2)
        expect(mix.totalCustomers).toBe(0)
    })
})

describe('top products and employees', () => {
    it('ranks products by revenue, units and profit independently', () => {
        sell([{ ...SUIT, qty: 1 }])      // 35 000 revenue, 17 000 profit, 1 unit
        sell([{ ...SHIRT, qty: 10 }])    // 45 000 revenue, 25 000 profit, 10 units

        expect(AnalyticsService.topProducts({}, 'units')[0].product_name).toBe('Chemise Oxford')
        expect(AnalyticsService.topProducts({}, 'revenue')[0].product_name).toBe('Chemise Oxford')
        expect(AnalyticsService.topProducts({}, 'profit')[0].profit).toBe(25000)
    })

    it('ranks variants, not just products', () => {
        sell([{ ...SUIT, qty: 1 }])
        sell([{ productId: 1, variantId: 2, name: 'Costume Milano', qty: 4, price: 35000 }])
        const rows = AnalyticsService.topVariants({})
        expect(rows[0]).toMatchObject({ size: '54', units: 4 })
    })

    it('reports per-seller revenue and items', () => {
        sell([{ ...SUIT, qty: 1 }])
        sell([{ ...SHIRT, qty: 2 }])
        const rows = AnalyticsService.employeePerformance({})
        expect(rows).toHaveLength(1)
        expect(rows[0].user_name).toBe('Karim')
        expect(rows[0].transactions).toBe(2)
        expect(rows[0].revenue).toBe(44000)
        expect(rows[0].items_sold).toBe(3)
    })
})
