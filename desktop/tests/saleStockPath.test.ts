import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from './helpers/sqliteHarness'
import { runRetailMigrations } from '../electron/migrationsRetail'

let testDb: any
vi.mock('../electron/database', () => ({ getDatabase: () => testDb }))

const { TransactionService } = await import('../electron/transactionService')
const { InventoryService } = await import('../electron/inventoryService')

const COSTUME = 1
const CASUAL = 2
const CASHIER = 11

// These tests exist for one reason: the oversell guard was previously implemented and
// tested in InventoryService but the till did not use it. A guard that is not on the
// sale path protects nothing, so this file asserts specifically that completing a real
// sale goes through it.

function seedCatalogue() {
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Sara', 'x', 'cashier')").run(CASHIER)
    testDb.prepare("INSERT INTO products (id, name, cost_price, retail_price, tax_category_id) VALUES (1, 'Costume Milano', 18000, 35000, 3)").run()
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (1, 1, '52', 'Bleu Marine')").run()
}

function stock(qty: number, storeId = COSTUME) {
    testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (?, 1, 1, ?)').run(storeId, qty)
}

/** Build a pending sale of `qty` and return its id. */
function makeSale(qty: number, storeId?: number) {
    const t = TransactionService.create(CASHIER, 1, storeId)
    TransactionService.addItem(t.id, 1, 'Costume Milano', qty, 35000, null, 1)
    return t.id
}

beforeEach(() => {
    testDb = makeTestDb()
    runRetailMigrations(testDb)
    seedCatalogue()
})

describe('the sale path uses the oversell guard', () => {
    it('lets one till take the last suit and refuses the next', () => {
        stock(1)
        const first = makeSale(1)
        const second = makeSale(1)

        TransactionService.complete(first)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(0)

        expect(() => TransactionService.complete(second)).toThrow(/Stock insuffisant/)
    })

    it('leaves the losing sale PENDING, not completed', () => {
        // The critical property. If the refused sale were still marked completed, the
        // shop would have a paid-for sale with no goods and no way to notice.
        stock(1)
        const first = makeSale(1)
        const second = makeSale(1)
        TransactionService.complete(first)

        try { TransactionService.complete(second) } catch { /* expected */ }

        const row = testDb.prepare('SELECT status FROM transactions WHERE id = ?').get(second) as any
        expect(row.status).toBe('pending')
    })

    it('rolls back the entire completion — no movement, no stock change', () => {
        stock(2)
        const sale = makeSale(5)

        expect(() => TransactionService.complete(sale)).toThrow()

        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(2)
        const moves = testDb.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as any
        expect(moves.n).toBe(0)
    })

    it('does not half-apply a multi-line cart', () => {
        testDb.prepare("INSERT INTO products (id, name, retail_price, tax_category_id) VALUES (2, 'Chemise Oxford', 4500, 3)").run()
        testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (2, 2, 'M', 'Blanche')").run()
        stock(10)
        testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (1, 2, 2, 1)').run()

        const t = TransactionService.create(CASHIER, 1)
        TransactionService.addItem(t.id, 1, 'Costume Milano', 2, 35000, null, 1)
        TransactionService.addItem(t.id, 2, 'Chemise Oxford', 3, 4500, null, 2)   // only 1 left

        expect(() => TransactionService.complete(t.id)).toThrow(/Stock insuffisant/)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(10)
        expect(InventoryService.getStock(COSTUME, 2, 2)).toBe(1)
    })

    it('refuses a sale of a variant this store never stocked', () => {
        // The old raw UPDATE matched zero rows here: the decrement silently vanished
        // while the movement row was still written, and stock and ledger disagreed
        // from that point on. It must now be refused outright.
        stock(5, COSTUME)
        const sale = makeSale(1, CASUAL)
        expect(() => TransactionService.complete(sale)).toThrow(/Stock insuffisant/)

        const moves = testDb.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as any
        expect(moves.n).toBe(0)
    })

    it('is still idempotent — a duplicate completion does not decrement twice', () => {
        stock(5)
        const sale = makeSale(2)
        TransactionService.complete(sale)
        TransactionService.complete(sale)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(3)
    })

    it('honours the owner override that permits negative stock', () => {
        stock(1)
        testDb.prepare("INSERT INTO config (key, value) VALUES ('allow_negative_stock', '1')").run()
        const sale = makeSale(3)
        expect(() => TransactionService.complete(sale)).not.toThrow()
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(-2)
    })
})

describe('sales carry their store', () => {
    it('stamps the device store on a new sale', () => {
        const t = TransactionService.create(CASHIER, 1)
        const row = testDb.prepare('SELECT store_id FROM transactions WHERE id = ?').get(t.id) as any
        expect(row.store_id).toBe(COSTUME)   // seeded default store
    })

    it('draws stock from the sale’s own store, not the device default', () => {
        stock(4, COSTUME)
        stock(4, CASUAL)
        const sale = makeSale(1, CASUAL)
        TransactionService.complete(sale)

        expect(InventoryService.getStock(CASUAL, 1, 1)).toBe(3)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(4)
    })

    it('writes the movement against the selling store', () => {
        stock(4, CASUAL)
        TransactionService.complete(makeSale(1, CASUAL))
        const m = testDb.prepare('SELECT store_id, reference_type, reference_id FROM stock_movements').get() as any
        expect(m.store_id).toBe(CASUAL)
        expect(m.reference_type).toBe('transaction')
    })
})

describe('void restores stock', () => {
    it('returns the goods to the store that sold them', () => {
        stock(3)
        const sale = makeSale(2)
        TransactionService.complete(sale)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(1)

        TransactionService.void(sale)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(3)

        const row = testDb.prepare('SELECT status FROM transactions WHERE id = ?').get(sale) as any
        expect(row.status).toBe('voided')
    })

    it('does not restock a sale that never completed', () => {
        stock(3)
        const sale = makeSale(2)
        TransactionService.void(sale)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(3)
    })
})

describe('advisory pre-check', () => {
    it('reports the short lines for the sale’s own store', () => {
        stock(1, COSTUME)
        const sale = makeSale(3, COSTUME)
        const short = TransactionService.checkStock(sale)
        expect(short).toHaveLength(1)
        expect(short[0]).toMatchObject({ requested: 3, available: 1 })
    })

    it('reports nothing when stock is sufficient', () => {
        stock(10)
        expect(TransactionService.checkStock(makeSale(3))).toHaveLength(0)
    })
})
