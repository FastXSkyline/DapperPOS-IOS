import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from './helpers/sqliteHarness'
import { runRetailMigrations } from '../electron/migrationsRetail'

// electron/database.ts pulls in `electron` and the native better-sqlite3 binding,
// neither of which loads under vitest. The factory form of vi.mock replaces the
// module without ever evaluating it, so the service under test runs its real SQL
// against node:sqlite.
let testDb: any
vi.mock('../electron/database', () => ({ getDatabase: () => testDb }))

const { InventoryService, InsufficientStockError } = await import('../electron/inventoryService')

const COSTUME = 1
const CASUAL = 2

/** One product, one variant, seeded with `qty` in the Costume store. */
function seedVariant(qty: number, storeId = COSTUME) {
    testDb.prepare("INSERT OR IGNORE INTO products (id, name, cost_price, retail_price) VALUES (1, 'Costume Milano', 18000, 35000)").run()
    testDb.prepare("INSERT OR IGNORE INTO product_variants (id, product_id, size, color) VALUES (1, 1, '52', 'Bleu Marine')").run()
    testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (?, 1, 1, ?)').run(storeId, qty)
}

beforeEach(() => {
    testDb = makeTestDb()
    runRetailMigrations(testDb)
})

describe('oversell guard', () => {
    // The brief's §62 scenario. better-sqlite3 and node:sqlite are both synchronous,
    // so two terminals cannot literally interleave mid-statement — but that is the
    // point: the store server serialises them, and each UPDATE either matches the
    // row or matches nothing. These tests assert the losing side is refused rather
    // than silently writing a negative quantity.
    it('lets the first sale take the last suit and refuses the second', () => {
        seedVariant(1)
        const ctx = { storeId: COSTUME, userId: 1 }

        expect(InventoryService.consume(1, 1, 1, ctx)).toBe(0)
        expect(() => InventoryService.consume(1, 1, 1, ctx)).toThrow(InsufficientStockError)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(0)
    })

    it('refuses a quantity larger than stock without partially consuming it', () => {
        seedVariant(3)
        const ctx = { storeId: COSTUME, userId: 1 }

        expect(() => InventoryService.consume(1, 1, 5, ctx)).toThrow(InsufficientStockError)
        // The failed attempt must leave stock untouched — a half-applied decrement is
        // worse than the oversell it was trying to prevent.
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(3)
    })

    it('reports the real available figure in the error', () => {
        seedVariant(2)
        try {
            InventoryService.consume(1, 1, 6, { storeId: COSTUME })
            expect.unreachable('should have thrown')
        } catch (e: any) {
            expect(e.code).toBe('INSUFFICIENT_STOCK')
            expect(e.available).toBe(2)
            expect(e.requested).toBe(6)
            expect(e.productName).toBe('Costume Milano')
        }
    })

    it('refuses a variant that was never stocked in this store', () => {
        seedVariant(5, COSTUME)
        // Casual has never carried this suit — no row at all, not a zero row.
        expect(() => InventoryService.consume(1, 1, 1, { storeId: CASUAL })).toThrow(InsufficientStockError)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(5)
    })

    it('keeps the two stores independent', () => {
        seedVariant(1, COSTUME)
        seedVariant(1, CASUAL)

        InventoryService.consume(1, 1, 1, { storeId: COSTUME })
        // Costume selling its last one must not touch Casual's.
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(0)
        expect(InventoryService.getStock(CASUAL, 1, 1)).toBe(1)
        expect(() => InventoryService.consume(1, 1, 1, { storeId: CASUAL })).not.toThrow()
    })

    it('rolls the whole cart back when one line is short', () => {
        testDb.prepare("INSERT INTO products (id, name) VALUES (1, 'Chemise Oxford')").run()
        testDb.prepare("INSERT INTO products (id, name) VALUES (2, 'Pantalon Chino')").run()
        testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (1, 1, 'M', 'Blanche')").run()
        testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (2, 2, '48', 'Beige')").run()
        testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (1, 1, 1, 10)').run()
        testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (1, 2, 2, 1)').run()

        expect(() => InventoryService.consumeMany([
            { productId: 1, variantId: 1, quantity: 2 },
            { productId: 2, variantId: 2, quantity: 3 },   // only 1 in stock
        ], { storeId: COSTUME })).toThrow(InsufficientStockError)

        // The shirt must NOT have left stock just because it happened to be first.
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(10)
        expect(InventoryService.getStock(COSTUME, 2, 2)).toBe(1)
        // ...and no movement may survive the rollback either.
        const moves = testDb.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as any
        expect(moves.n).toBe(0)
    })

    it('honours the owner override that permits negative stock', () => {
        seedVariant(1)
        testDb.prepare("INSERT INTO config (key, value) VALUES ('allow_negative_stock', '1')").run()

        expect(InventoryService.consume(1, 1, 3, { storeId: COSTUME })).toBe(-2)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(-2)
    })

    it('records a debt row rather than losing the movement when overriding with no stock row', () => {
        testDb.prepare("INSERT INTO products (id, name) VALUES (1, 'Veste Slim')").run()
        testDb.prepare("INSERT INTO config (key, value) VALUES ('allow_negative_stock', '1')").run()

        expect(InventoryService.consume(1, null, 2, { storeId: CASUAL })).toBe(-2)
        expect(InventoryService.getStock(CASUAL, 1, null)).toBe(-2)
        const m = testDb.prepare('SELECT quantity, store_id FROM stock_movements').get() as any
        expect(m.quantity).toBe(-2)
        expect(m.store_id).toBe(CASUAL)
    })
})

describe('movement ledger', () => {
    it('writes exactly one movement per stock change, signed', () => {
        seedVariant(10)
        const ctx = { storeId: COSTUME, userId: 1, referenceType: 'sale', referenceId: 42 }

        InventoryService.consume(1, 1, 3, ctx, 'sale')
        InventoryService.receive(1, 1, 5, ctx, 'purchase')
        InventoryService.consume(1, 1, 1, ctx, 'damage')

        const moves = testDb.prepare('SELECT movement_type, quantity, reason FROM stock_movements ORDER BY id').all() as any[]
        expect(moves).toHaveLength(3)
        expect(moves[0]).toMatchObject({ movement_type: 'out', quantity: -3 })
        expect(moves[1]).toMatchObject({ movement_type: 'in', quantity: 5 })
        expect(moves[2]).toMatchObject({ movement_type: 'out', quantity: -1 })
        // The narrow legacy CHECK loses 'damage'; the reason column must keep it.
        expect(moves[2].reason).toBe('damage')
    })

    it('sums to the current quantity — the ledger explains the stock', () => {
        seedVariant(0)
        const ctx = { storeId: COSTUME }
        InventoryService.receive(1, 1, 20, ctx, 'purchase')
        InventoryService.consume(1, 1, 1, ctx, 'sale')
        InventoryService.receive(1, 1, 1, ctx, 'return')
        InventoryService.consume(1, 1, 3, ctx, 'transfer_out')
        InventoryService.setAbsolute(1, 1, 22, ctx, 'inventory_count')

        const { total } = testDb.prepare('SELECT COALESCE(SUM(quantity),0) AS total FROM stock_movements').get() as any
        expect(total).toBe(22)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(22)
    })

    it('records the delta, not the target, when setting an absolute count', () => {
        seedVariant(50)
        InventoryService.setAbsolute(1, 1, 37, { storeId: COSTUME }, 'inventory_count')
        const m = testDb.prepare('SELECT quantity FROM stock_movements').get() as any
        expect(m.quantity).toBe(-13)
    })

    it('creates the row when receiving into a store that never carried the variant', () => {
        seedVariant(4, COSTUME)
        expect(InventoryService.receive(1, 1, 6, { storeId: CASUAL }, 'transfer_in')).toBe(6)
        expect(InventoryService.getStock(CASUAL, 1, 1)).toBe(6)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(4)
    })
})

describe('inventory reporting', () => {
    it('reports one variant across every store', () => {
        seedVariant(3, COSTUME)
        seedVariant(0, CASUAL)
        const rows = InventoryService.getStockAcrossStores(1, 1)
        expect(rows).toHaveLength(2)
        expect(rows.find(r => r.store_code === 'CST')!.quantity).toBe(3)
        expect(rows.find(r => r.store_code === 'CAS')!.quantity).toBe(0)
    })

    it('counts a never-sold variant as dead stock', () => {
        seedVariant(4)
        const dead = InventoryService.getDeadStock(COSTUME, 90)
        expect(dead).toHaveLength(1)
        expect(dead[0].last_sale_at).toBeNull()
        expect(dead[0].stock_value).toBe(4 * 18000)
    })

    it('does not call a recently sold variant dead', () => {
        seedVariant(4)
        InventoryService.consume(1, 1, 1, { storeId: COSTUME }, 'sale')
        expect(InventoryService.getDeadStock(COSTUME, 90)).toHaveLength(0)
    })

    it('calls a variant dead again once the window passes it by', () => {
        seedVariant(4)
        InventoryService.consume(1, 1, 1, { storeId: COSTUME }, 'sale')
        // Age the only sale movement past the window.
        testDb.prepare("UPDATE stock_movements SET created_at = datetime('now','-200 days')").run()
        expect(InventoryService.getDeadStock(COSTUME, 90)).toHaveLength(1)
        expect(InventoryService.getDeadStock(COSTUME, 365)).toHaveLength(0)
    })

    it('values stock at cost and at retail', () => {
        seedVariant(3)
        const v = InventoryService.getStockValue(COSTUME)
        expect(v.total_quantity).toBe(3)
        expect(v.total_cost_value).toBe(54000)
        expect(v.total_retail_value).toBe(105000)
    })

    it('flags low stock per store against the product minimum', () => {
        seedVariant(1, COSTUME)
        seedVariant(9, CASUAL)
        testDb.prepare('UPDATE products SET min_stock_level = 3 WHERE id = 1').run()

        expect(InventoryService.getLowStock(COSTUME)).toHaveLength(1)
        expect(InventoryService.getLowStock(CASUAL)).toHaveLength(0)
        expect(InventoryService.getLowStock(null)).toHaveLength(1)
    })
})
