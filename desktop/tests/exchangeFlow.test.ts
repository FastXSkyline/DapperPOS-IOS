import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from './helpers/sqliteHarness'
import { runRetailMigrations } from '../electron/migrationsRetail'

let testDb: any
vi.mock('../electron/database', () => ({ getDatabase: () => testDb }))

const { ReturnService } = await import('../electron/returnService')
const { InventoryService } = await import('../electron/inventoryService')
const { PermissionDeniedError } = await import('../electron/permissionService')

const COSTUME = 1
const MANAGER = 10
const CASHIER = 11
// 'warehouse' is what users.role permits; it IS the brief's STOCK_MANAGER.
const STOCK_MGR = 12

// Products: 1 = the suit that comes back, 2 = the replacement.
function seed(opts: { soldPrice?: number; newPrice?: number; newStock?: number } = {}) {
    const soldPrice = opts.soldPrice ?? 35000
    const newPrice = opts.newPrice ?? 40000

    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Karim', 'x', 'manager')").run(MANAGER)
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Sara', 'x', 'cashier')").run(CASHIER)
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Nabil', 'x', 'warehouse')").run(STOCK_MGR)

    // tax_category_id 3 = exonéré, so totals stay round and the maths under test is
    // the exchange balance, not the TVA (which fiscalMath.test.ts already covers).
    testDb.prepare("INSERT INTO products (id, name, cost_price, retail_price, tax_category_id) VALUES (1, 'Costume Milano', 18000, ?, 3)").run(soldPrice)
    testDb.prepare("INSERT INTO products (id, name, cost_price, retail_price, tax_category_id) VALUES (2, 'Costume Classic', 20000, ?, 3)").run(newPrice)
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (1, 1, '52', 'Bleu Marine')").run()
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (2, 2, '54', 'Noir')").run()

    // The suit already left stock when it was sold; the replacement is on the rail.
    testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (1, 1, 1, 0)').run()
    testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (1, 2, 2, ?)').run(opts.newStock ?? 3)

    testDb.prepare(`
        INSERT INTO transactions (id, transaction_number, user_id, status, store_id, subtotal, total_amount, amount_paid, completed_at)
        VALUES (1, 'BL-2026-000001', ?, 'completed', 1, ?, ?, ?, datetime('now'))
    `).run(MANAGER, soldPrice, soldPrice, soldPrice)
    testDb.prepare(`
        INSERT INTO transaction_items (id, transaction_id, product_id, variant_id, product_name, quantity, unit_price, tax_rate, line_total)
        VALUES (1, 1, 1, 1, 'Costume Milano', 1, ?, 0, ?)
    `).run(soldPrice, soldPrice)

    // Keep the gapless counter in step with the sale just inserted by hand, exactly
    // as a real database would be. Without this the replacement sale is allocated
    // BL-…-000001 again and collides on the unique number.
    testDb.prepare('INSERT OR REPLACE INTO doc_sequences (doc_type, year, last_number) VALUES (?, ?, 1)')
        .run('sale', new Date().getFullYear())
}

const replacement = (price: number, qty = 1) => ([{
    productId: 2, variantId: 2, productName: 'Costume Classic', quantity: qty, unitPrice: price,
}])

const baseInput = (userId = MANAGER) => ({
    originalTransactionId: 1,
    userId,
    lines: [{ originalItemId: 1, quantity: 1 }],
    reason: 'Taille incorrecte',
})

beforeEach(() => {
    testDb = makeTestDb()
    runRetailMigrations(testDb)
})

describe('exchange — the money', () => {
    it('charges the difference when the replacement costs more', () => {
        seed({ soldPrice: 35000, newPrice: 40000 })
        const r = ReturnService.exchangeWithNewSale({
            ...baseInput(), replacement: replacement(40000), topUpMethod: 'cash',
        })

        expect(r.returnedValue).toBe(35000)
        expect(r.replacementValue).toBe(40000)
        expect(r.balance).toBe(-5000)   // negative = customer tops up
    })

    it('settles the replacement with credit plus a cash top-up', () => {
        seed({ soldPrice: 35000, newPrice: 40000 })
        const r = ReturnService.exchangeWithNewSale({
            ...baseInput(), replacement: replacement(40000), topUpMethod: 'cash',
        })

        const pays = testDb.prepare(
            'SELECT payment_method, amount FROM payments WHERE transaction_id = ? ORDER BY id'
        ).all(r.replacementTransactionId) as any[]
        expect(pays).toEqual([
            { payment_method: 'store_credit', amount: 35000 },
            { payment_method: 'cash', amount: 5000 },
        ])

        // The replacement must read as a normal, fully-paid sale.
        const txn = testDb.prepare('SELECT status, total_amount, amount_paid, change_due FROM transactions WHERE id = ?')
            .get(r.replacementTransactionId) as any
        expect(txn.status).toBe('completed')
        expect(txn.amount_paid).toBe(40000)
        expect(txn.change_due).toBe(0)
    })

    it('refunds the difference when the replacement costs less, without overpaying the sale', () => {
        seed({ soldPrice: 35000, newPrice: 30000 })
        const r = ReturnService.exchangeWithNewSale({
            ...baseInput(), replacement: replacement(30000),
        })

        expect(r.balance).toBe(5000)    // positive = shop pays out

        // Credit is capped at what the new goods cost: paying the full 35 000 in would
        // show as 5 000 change due on the replacement and double-count the refund.
        const pays = testDb.prepare('SELECT payment_method, amount FROM payments WHERE transaction_id = ?')
            .all(r.replacementTransactionId) as any[]
        expect(pays).toEqual([{ payment_method: 'store_credit', amount: 30000 }])
        const txn = testDb.prepare('SELECT amount_paid, change_due FROM transactions WHERE id = ?')
            .get(r.replacementTransactionId) as any
        expect(txn.amount_paid).toBe(30000)
        expect(txn.change_due).toBe(0)
    })

    it('settles an even swap at zero with no cash movement', () => {
        seed({ soldPrice: 35000, newPrice: 35000 })
        const r = ReturnService.exchangeWithNewSale({
            ...baseInput(), replacement: replacement(35000),
        })
        expect(r.balance).toBe(0)
        const cash = testDb.prepare(
            "SELECT COUNT(*) AS n FROM payments WHERE transaction_id = ? AND payment_method = 'cash'"
        ).get(r.replacementTransactionId) as any
        expect(cash.n).toBe(0)
    })

    it('stamps no droit de timbre when nothing is settled in cash', () => {
        // Store credit is not cash, so an even swap must not attract stamp duty.
        seed({ soldPrice: 35000, newPrice: 35000 })
        const r = ReturnService.exchangeWithNewSale({ ...baseInput(), replacement: replacement(35000) })
        const txn = testDb.prepare('SELECT timbre FROM transactions WHERE id = ?').get(r.replacementTransactionId) as any
        expect(txn.timbre).toBe(0)
    })
})

describe('exchange — the goods', () => {
    it('returns the old garment to stock and takes the new one out', () => {
        seed({ newStock: 3 })
        ReturnService.exchangeWithNewSale({ ...baseInput(), replacement: replacement(40000) })

        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(1)   // came back
        expect(InventoryService.getStock(COSTUME, 2, 2)).toBe(2)   // went out
    })

    it('marks the original sale returned and blocks a second return of the same line', () => {
        seed()
        ReturnService.exchangeWithNewSale({ ...baseInput(), replacement: replacement(40000) })

        const orig = testDb.prepare('SELECT return_status FROM transactions WHERE id = 1').get() as any
        expect(orig.return_status).toBe('full')

        expect(() => ReturnService.createRefund({
            originalTransactionId: 1, userId: MANAGER, lines: [{ originalItemId: 1, quantity: 1 }],
        })).toThrow(/retournable/)
    })

    it('links both documents to each other', () => {
        seed()
        const r = ReturnService.exchangeWithNewSale({ ...baseInput(), replacement: replacement(40000) })
        const row = testDb.prepare('SELECT kind, exchange_transaction_id FROM sale_returns WHERE id = ?')
            .get(r.returnId) as any
        expect(row.kind).toBe('exchange')
        expect(row.exchange_transaction_id).toBe(r.replacementTransactionId)
        expect(r.replacementNumber).toMatch(/^BL-\d{4}-\d{6}$/)
    })
})

describe('exchange — atomicity', () => {
    // The whole reason the orchestration lives in the service. Each of these would,
    // if the UI drove the four calls itself, leave a completed sale that no return
    // points at — goods out of the door, nothing booked back in.

    it('unwinds completely when the replacement is out of stock', () => {
        seed({ newStock: 0 })

        expect(() => ReturnService.exchangeWithNewSale({
            ...baseInput(), replacement: replacement(40000),
        })).toThrow(/Stock insuffisant/)

        expect((testDb.prepare('SELECT COUNT(*) AS n FROM sale_returns').get() as any).n).toBe(0)
        // No orphan sale, no orphan payments, no movements.
        expect((testDb.prepare("SELECT COUNT(*) AS n FROM transactions WHERE id != 1").get() as any).n).toBe(0)
        expect((testDb.prepare('SELECT COUNT(*) AS n FROM payments').get() as any).n).toBe(0)
        expect((testDb.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as any).n).toBe(0)
        // The returned garment must NOT have been booked back in.
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(0)
        const orig = testDb.prepare('SELECT return_status FROM transactions WHERE id = 1').get() as any
        expect(orig.return_status).toBe('none')
    })

    it('unwinds when only part of the replacement cart can be supplied', () => {
        seed({ newStock: 1 })
        expect(() => ReturnService.exchangeWithNewSale({
            ...baseInput(), replacement: replacement(40000, 2),
        })).toThrow(/Stock insuffisant/)
        expect(InventoryService.getStock(COSTUME, 2, 2)).toBe(1)
        expect((testDb.prepare('SELECT COUNT(*) AS n FROM sale_returns').get() as any).n).toBe(0)
    })

    it('creates nothing at all when the user may not exchange', () => {
        seed()
        expect(() => ReturnService.exchangeWithNewSale({
            ...baseInput(STOCK_MGR), replacement: replacement(40000),
        })).toThrow(PermissionDeniedError)

        expect((testDb.prepare("SELECT COUNT(*) AS n FROM transactions WHERE id != 1").get() as any).n).toBe(0)
        expect((testDb.prepare('SELECT COUNT(*) AS n FROM sale_returns').get() as any).n).toBe(0)
    })

    it('creates nothing when the returned quantity exceeds what was sold', () => {
        seed()
        expect(() => ReturnService.exchangeWithNewSale({
            ...baseInput(), lines: [{ originalItemId: 1, quantity: 4 }], replacement: replacement(40000),
        })).toThrow(/retournable/)
        expect((testDb.prepare("SELECT COUNT(*) AS n FROM transactions WHERE id != 1").get() as any).n).toBe(0)
    })

    it('rejects an empty replacement cart before touching anything', () => {
        seed()
        expect(() => ReturnService.exchangeWithNewSale({
            ...baseInput(), replacement: [],
        })).toThrow(/vide/)
        expect((testDb.prepare('SELECT COUNT(*) AS n FROM sale_returns').get() as any).n).toBe(0)
    })
})

describe('exchange — permissions', () => {
    it('lets a cashier exchange even though they may not refund', () => {
        seed()
        expect(() => ReturnService.exchangeWithNewSale({
            ...baseInput(CASHIER), replacement: replacement(40000),
        })).not.toThrow()

        expect(() => ReturnService.createRefund({
            originalTransactionId: 1, userId: CASHIER, lines: [{ originalItemId: 1, quantity: 1 }],
        })).toThrow(PermissionDeniedError)
    })

    it('writes an audit entry for the exchange', () => {
        seed()
        ReturnService.exchangeWithNewSale({ ...baseInput(), replacement: replacement(40000) })
        const a = testDb.prepare("SELECT * FROM audit_logs WHERE action = 'sale.exchange'").get() as any
        expect(a).toBeDefined()
        expect(a.summary).toContain('BL-2026-000001')
        expect(a.severity).toBe('warning')
    })
})
