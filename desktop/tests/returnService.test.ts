import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from './helpers/sqliteHarness'
import { runRetailMigrations } from '../electron/migrationsRetail'

let testDb: any
vi.mock('../electron/database', () => ({ getDatabase: () => testDb }))

const { ReturnService, ReturnError } = await import('../electron/returnService')
const { InventoryService } = await import('../electron/inventoryService')
const { PermissionDeniedError } = await import('../electron/permissionService')

const COSTUME = 1
const CASUAL = 2
const MANAGER = 10
const CASHIER = 11

/**
 * A completed sale of `qty` × one variant at `price`, with matching stock already
 * removed — i.e. the state the database is really in after a sale.
 */
function seedSale(opts: { qty?: number; price?: number; stockAfter?: number; storeId?: number } = {}) {
    const qty = opts.qty ?? 2
    const price = opts.price ?? 35000
    const storeId = opts.storeId ?? COSTUME

    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Karim', 'x', 'manager')").run(MANAGER)
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Sara', 'x', 'cashier')").run(CASHIER)
    testDb.prepare("INSERT INTO products (id, name, cost_price, retail_price) VALUES (1, 'Costume Milano', 18000, ?)").run(price)
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (1, 1, '52', 'Bleu Marine')").run()
    testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (?, 1, 1, ?)')
        .run(storeId, opts.stockAfter ?? 3)
    testDb.prepare(`
        INSERT INTO transactions (id, transaction_number, user_id, status, store_id,
                                  subtotal, total_amount, completed_at)
        VALUES (1, 'TX-2026-000001', ?, 'completed', ?, ?, ?, datetime('now'))
    `).run(MANAGER, storeId, qty * price, qty * price)
    testDb.prepare(`
        INSERT INTO transaction_items (id, transaction_id, product_id, variant_id, product_name,
                                       quantity, unit_price, tax_rate, line_total)
        VALUES (1, 1, 1, 1, 'Costume Milano', ?, ?, 19, ?)
    `).run(qty, price, qty * price)
}

/** A completed replacement sale, for exchange tests. */
function seedReplacement(total: number, id = 2) {
    testDb.prepare(`
        INSERT INTO transactions (id, transaction_number, user_id, status, store_id, subtotal, total_amount, completed_at)
        VALUES (?, ?, ?, 'completed', ?, ?, ?, datetime('now'))
    `).run(id, `TX-2026-00000${id}`, MANAGER, COSTUME, total, total)
    return id
}

beforeEach(() => {
    testDb = makeTestDb()
    runRetailMigrations(testDb)
})

describe('refunds', () => {
    it('refunds at the price actually paid, not today’s price', () => {
        seedSale({ qty: 2, price: 35000, stockAfter: 1 })
        // The shop raises the price after the sale. The refund must ignore this.
        testDb.prepare('UPDATE products SET retail_price = 42000 WHERE id = 1').run()
        testDb.prepare('UPDATE product_variants SET retail_price = 42000 WHERE id = 1').run()

        const r = ReturnService.createRefund({
            originalTransactionId: 1, userId: MANAGER,
            lines: [{ originalItemId: 1, quantity: 1 }],
            refundMethod: 'cash',
        })

        expect(r.returnedValue).toBe(35000)
        expect(r.balance).toBe(35000)
        expect(r.returnNumber).toMatch(/^RET-\d{4}-000001$/)
    })

    it('puts resellable goods back into stock and writes a movement', () => {
        seedSale({ qty: 2, stockAfter: 1 })
        ReturnService.createRefund({
            originalTransactionId: 1, userId: MANAGER,
            lines: [{ originalItemId: 1, quantity: 1 }],
        })

        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(2)
        const m = testDb.prepare("SELECT * FROM stock_movements WHERE reference_type = 'sale_return'").get() as any
        expect(m.quantity).toBe(1)
        expect(m.movement_type).toBe('in')
        expect(m.store_id).toBe(COSTUME)
    })

    it('books damaged goods to shrinkage instead of sellable stock', () => {
        seedSale({ qty: 2, stockAfter: 1 })
        ReturnService.createRefund({
            originalTransactionId: 1, userId: MANAGER,
            lines: [{ originalItemId: 1, quantity: 1, condition: 'damaged' }],
        })

        // Not resellable, so stock must not move...
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(1)
        // ...but the cost must not vanish either.
        const loss = testDb.prepare('SELECT * FROM stock_losses').get() as any
        expect(loss.quantity).toBe(1)
        expect(loss.total_cost).toBe(18000)
        expect(loss.reason).toBe('damage')
        expect(loss.store_id).toBe(COSTUME)
    })

    it('marks the sale partially then fully returned', () => {
        seedSale({ qty: 2, stockAfter: 1 })
        const status = () => (testDb.prepare('SELECT return_status AS s FROM transactions WHERE id = 1').get() as any).s

        expect(status()).toBe('none')
        ReturnService.createRefund({ originalTransactionId: 1, userId: MANAGER, lines: [{ originalItemId: 1, quantity: 1 }] })
        expect(status()).toBe('partial')
        ReturnService.createRefund({ originalTransactionId: 1, userId: MANAGER, lines: [{ originalItemId: 1, quantity: 1 }] })
        expect(status()).toBe('full')
    })

    it('refuses to return more than was sold, across several returns', () => {
        seedSale({ qty: 2, stockAfter: 1 })
        ReturnService.createRefund({ originalTransactionId: 1, userId: MANAGER, lines: [{ originalItemId: 1, quantity: 2 }] })

        expect(() => ReturnService.createRefund({
            originalTransactionId: 1, userId: MANAGER, lines: [{ originalItemId: 1, quantity: 1 }],
        })).toThrow(ReturnError)
    })

    it('refuses a quantity larger than the line in one go', () => {
        seedSale({ qty: 2, stockAfter: 1 })
        expect(() => ReturnService.createRefund({
            originalTransactionId: 1, userId: MANAGER, lines: [{ originalItemId: 1, quantity: 5 }],
        })).toThrow(/retournable/)
    })

    it('refuses a line belonging to a different sale', () => {
        seedSale({ qty: 2, stockAfter: 1 })
        seedReplacement(1000, 2)
        expect(() => ReturnService.createRefund({
            originalTransactionId: 2, userId: MANAGER, lines: [{ originalItemId: 1, quantity: 1 }],
        })).toThrow(/n’appartient pas/)
    })

    it('refuses to refund a sale that was never completed', () => {
        seedSale({ qty: 1, stockAfter: 1 })
        testDb.prepare("UPDATE transactions SET status = 'pending' WHERE id = 1").run()
        expect(() => ReturnService.createRefund({
            originalTransactionId: 1, userId: MANAGER, lines: [{ originalItemId: 1, quantity: 1 }],
        })).toThrow(/finalisée/)
    })

    it('refuses a cashier who lacks sales.refund, and leaves nothing behind', () => {
        seedSale({ qty: 2, stockAfter: 1 })
        expect(() => ReturnService.createRefund({
            originalTransactionId: 1, userId: CASHIER, lines: [{ originalItemId: 1, quantity: 1 }],
        })).toThrow(PermissionDeniedError)

        expect((testDb.prepare('SELECT COUNT(*) AS n FROM sale_returns').get() as any).n).toBe(0)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(1)
    })

    it('rolls the whole return back if one line is invalid', () => {
        seedSale({ qty: 2, stockAfter: 1 })
        // Second line names a nonexistent item; validation happens before any write,
        // so nothing at all may be recorded.
        expect(() => ReturnService.createRefund({
            originalTransactionId: 1, userId: MANAGER,
            lines: [{ originalItemId: 1, quantity: 1 }, { originalItemId: 999, quantity: 1 }],
        })).toThrow(ReturnError)

        expect((testDb.prepare('SELECT COUNT(*) AS n FROM sale_returns').get() as any).n).toBe(0)
        expect((testDb.prepare('SELECT returned_quantity AS q FROM transaction_items WHERE id = 1').get() as any).q).toBe(0)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(1)
    })

    it('accepts goods sold in one store and returned in the other', () => {
        // Brief §92. Revenue stays with the selling store; the garment lands where it
        // was physically handed over.
        seedSale({ qty: 1, stockAfter: 0, storeId: COSTUME })
        ReturnService.createRefund({
            originalTransactionId: 1, storeId: CASUAL, userId: MANAGER,
            lines: [{ originalItemId: 1, quantity: 1 }],
        })

        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(0)
        expect(InventoryService.getStock(CASUAL, 1, 1)).toBe(1)
        const r = testDb.prepare('SELECT store_id AS s FROM sale_returns').get() as any
        expect(r.s).toBe(CASUAL)
    })

    it('reverses TVA at the original line’s rate', () => {
        seedSale({ qty: 1, price: 11900, stockAfter: 0 })
        ReturnService.createRefund({
            originalTransactionId: 1, userId: MANAGER, lines: [{ originalItemId: 1, quantity: 1 }],
        })
        const item = testDb.prepare('SELECT tax_rate, tax_amount FROM sale_return_items').get() as any
        expect(item.tax_rate).toBe(19)
        expect(item.tax_amount).toBeCloseTo(1900, 2)
    })

    it('writes an audit entry naming both documents', () => {
        seedSale({ qty: 1, stockAfter: 0 })
        ReturnService.createRefund({
            originalTransactionId: 1, userId: MANAGER,
            lines: [{ originalItemId: 1, quantity: 1 }], reason: 'Taille incorrecte',
        })
        const a = testDb.prepare("SELECT * FROM audit_logs WHERE action = 'sale.refund'").get() as any
        expect(a).toBeDefined()
        expect(a.severity).toBe('warning')
        expect(a.summary).toContain('TX-2026-000001')
        expect(a.user_name).toBe('Karim')
        expect(JSON.parse(a.new_value).reason).toBe('Taille incorrecte')
    })

    it('numbers returns gaplessly', () => {
        seedSale({ qty: 3, stockAfter: 0 })
        const a = ReturnService.createRefund({ originalTransactionId: 1, userId: MANAGER, lines: [{ originalItemId: 1, quantity: 1 }] })
        const b = ReturnService.createRefund({ originalTransactionId: 1, userId: MANAGER, lines: [{ originalItemId: 1, quantity: 1 }] })
        expect(a.returnNumber.endsWith('000001')).toBe(true)
        expect(b.returnNumber.endsWith('000002')).toBe(true)
    })
})

describe('exchanges', () => {
    it('charges the customer when the replacement costs more', () => {
        // Brief §17: old 35 000, new 40 000 → customer pays 5 000.
        seedSale({ qty: 1, price: 35000, stockAfter: 0 })
        const replacementId = seedReplacement(40000)

        const r = ReturnService.createExchange({
            originalTransactionId: 1, userId: MANAGER,
            lines: [{ originalItemId: 1, quantity: 1 }],
            replacementTransactionId: replacementId,
        })

        expect(r.returnedValue).toBe(35000)
        expect(r.replacementValue).toBe(40000)
        expect(r.balance).toBe(-5000)   // negative = customer tops up
    })

    it('refunds the customer when the replacement costs less', () => {
        seedSale({ qty: 1, price: 35000, stockAfter: 0 })
        const replacementId = seedReplacement(30000)

        const r = ReturnService.createExchange({
            originalTransactionId: 1, userId: MANAGER,
            lines: [{ originalItemId: 1, quantity: 1 }],
            replacementTransactionId: replacementId,
        })
        expect(r.balance).toBe(5000)    // positive = shop pays out
    })

    it('settles at zero on an even swap', () => {
        seedSale({ qty: 1, price: 35000, stockAfter: 0 })
        const replacementId = seedReplacement(35000)
        const r = ReturnService.createExchange({
            originalTransactionId: 1, userId: MANAGER,
            lines: [{ originalItemId: 1, quantity: 1 }],
            replacementTransactionId: replacementId,
        })
        expect(r.balance).toBe(0)
    })

    it('lets a cashier exchange but not refund', () => {
        seedSale({ qty: 1, price: 35000, stockAfter: 0 })
        const replacementId = seedReplacement(35000)
        expect(() => ReturnService.createExchange({
            originalTransactionId: 1, userId: CASHIER,
            lines: [{ originalItemId: 1, quantity: 1 }],
            replacementTransactionId: replacementId,
        })).not.toThrow()
    })

    it('refuses an exchange against an unfinished replacement sale', () => {
        seedSale({ qty: 1, stockAfter: 0 })
        const replacementId = seedReplacement(30000)
        testDb.prepare("UPDATE transactions SET status = 'pending' WHERE id = ?").run(replacementId)
        expect(() => ReturnService.createExchange({
            originalTransactionId: 1, userId: MANAGER,
            lines: [{ originalItemId: 1, quantity: 1 }],
            replacementTransactionId: replacementId,
        })).toThrow(/remplacement/)
    })

    it('returns the old garment to stock as part of the exchange', () => {
        seedSale({ qty: 1, price: 35000, stockAfter: 0 })
        const replacementId = seedReplacement(40000)
        ReturnService.createExchange({
            originalTransactionId: 1, userId: MANAGER,
            lines: [{ originalItemId: 1, quantity: 1 }],
            replacementTransactionId: replacementId,
        })
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(1)
    })
})

describe('return analytics', () => {
    it('rates returns against sales, not against other returns', () => {
        seedSale({ qty: 4, price: 10000, stockAfter: 4 })
        seedReplacement(10000, 2)   // a second completed sale, never returned
        ReturnService.createRefund({ originalTransactionId: 1, userId: MANAGER, lines: [{ originalItemId: 1, quantity: 1 }] })

        const a = ReturnService.analytics({})
        expect(a.salesCount).toBe(2)
        expect(a.returnsCount).toBe(1)
        expect(a.refundsCount).toBe(1)
        expect(a.returnRate).toBe(50)
        expect(a.returnedValue).toBe(10000)
    })

    it('reports 0 % rather than NaN for an empty period', () => {
        const a = ReturnService.analytics({ from: '2000-01-01', to: '2000-01-02' })
        expect(a.returnRate).toBe(0)
        expect(a.exchangeRate).toBe(0)
        expect(a.valueRate).toBe(0)
    })

    it('groups returns by reason', () => {
        seedSale({ qty: 3, price: 10000, stockAfter: 3 })
        ReturnService.createRefund({
            originalTransactionId: 1, userId: MANAGER,
            lines: [{ originalItemId: 1, quantity: 2, reason: 'Taille incorrecte' }],
        })
        const a = ReturnService.analytics({})
        expect(a.byReason[0]).toMatchObject({ reason: 'Taille incorrecte', n: 1 })
    })
})

describe('sale lookup for the till', () => {
    it('reports what is still returnable per line', () => {
        seedSale({ qty: 3, price: 10000, stockAfter: 3 })
        ReturnService.createRefund({ originalTransactionId: 1, userId: MANAGER, lines: [{ originalItemId: 1, quantity: 1 }] })

        const found = ReturnService.findSaleByNumber('TX-2026-000001')!
        expect(found.transaction.transaction_number).toBe('TX-2026-000001')
        expect((found.items[0] as any).returnable_quantity).toBe(2)
        expect(found.previousReturns).toHaveLength(1)
    })

    it('returns null for an unknown sale number', () => {
        expect(ReturnService.findSaleByNumber('TX-NOPE')).toBeNull()
    })
})
