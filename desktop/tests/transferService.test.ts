import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from './helpers/sqliteHarness'
import { runRetailMigrations } from '../electron/migrationsRetail'

let testDb: any
vi.mock('../electron/database', () => ({ getDatabase: () => testDb }))

const { TransferService, TransferError } = await import('../electron/transferService')
const { InventoryService } = await import('../electron/inventoryService')
const { PermissionDeniedError } = await import('../electron/permissionService')

const COSTUME = 1
const CASUAL = 2
const OWNER = 10
const MANAGER = 11
const CASHIER = 12

function seed(costumeStock = 10) {
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Ilyes', 'x', 'owner')").run(OWNER)
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Karim', 'x', 'manager')").run(MANAGER)
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Sara', 'x', 'cashier')").run(CASHIER)

    testDb.prepare("INSERT INTO products (id, name, cost_price, retail_price) VALUES (1, 'Chemise Oxford', 2200, 4500)").run()
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (1, 1, 'M', 'Blanche')").run()
    testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (?, 1, 1, ?)')
        .run(COSTUME, costumeStock)
}

const line = (quantity: number) => ([{
    productId: 1, variantId: 1, productName: 'Chemise Oxford', size: 'M', color: 'Blanche', quantity,
}])

const newTransfer = (quantity = 5, userId = MANAGER) => TransferService.create({
    fromStoreId: COSTUME, toStoreId: CASUAL, userId, lines: line(quantity),
})

const itemIds = (transferId: number) =>
    (testDb.prepare('SELECT id FROM stock_transfer_items WHERE transfer_id = ? ORDER BY id').all(transferId) as any[])
        .map(r => r.id)

beforeEach(() => {
    testDb = makeTestDb()
    runRetailMigrations(testDb)
    seed()
})

describe('transfer — the two phases', () => {
    it('moves stock out on ship and in on receive, never both at once', () => {
        const { id } = newTransfer(5)

        // Nothing moves while the paperwork is being made.
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(10)
        expect(InventoryService.getStock(CASUAL, 1, 1)).toBe(0)

        TransferService.ship(id, MANAGER)
        // Out of the source, and NOT yet in the destination — the goods are in the van.
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(5)
        expect(InventoryService.getStock(CASUAL, 1, 1)).toBe(0)

        TransferService.receive(id, MANAGER)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(5)
        expect(InventoryService.getStock(CASUAL, 1, 1)).toBe(5)
    })

    it('writes one movement per phase, against the right store', () => {
        const { id } = newTransfer(5)
        TransferService.ship(id, MANAGER)
        TransferService.receive(id, MANAGER)

        const moves = testDb.prepare(
            "SELECT store_id, quantity, movement_type FROM stock_movements WHERE reference_type = 'stock_transfer' ORDER BY id"
        ).all() as any[]
        expect(moves).toEqual([
            { store_id: COSTUME, quantity: -5, movement_type: 'transfer' },
            { store_id: CASUAL, quantity: 5, movement_type: 'transfer' },
        ])
    })

    it('numbers transfers gaplessly', () => {
        expect(newTransfer(1).transferNumber).toMatch(/^TRF-\d{4}-000001$/)
        expect(newTransfer(1).transferNumber).toMatch(/^TRF-\d{4}-000002$/)
    })
})

describe('transfer — idempotency', () => {
    // The §92 edge case. A boolean `received` column would have been one forgotten
    // check away from doubling the destination's stock.
    it('refuses a second receive and does not double the stock', () => {
        const { id } = newTransfer(5)
        TransferService.ship(id, MANAGER)
        TransferService.receive(id, MANAGER)

        expect(() => TransferService.receive(id, MANAGER)).toThrow(TransferError)
        expect(InventoryService.getStock(CASUAL, 1, 1)).toBe(5)
    })

    it('refuses a second ship and does not double-deduct the source', () => {
        const { id } = newTransfer(5)
        TransferService.ship(id, MANAGER)

        expect(() => TransferService.ship(id, MANAGER)).toThrow(/impossible de passer/)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(5)
    })

    it('refuses to receive goods that were never shipped', () => {
        const { id } = newTransfer(5)
        expect(() => TransferService.receive(id, MANAGER)).toThrow(/impossible de passer/)
        expect(InventoryService.getStock(CASUAL, 1, 1)).toBe(0)
    })

    it('refuses to cancel goods already in transit', () => {
        // Cancelling here would strand stock that has already left the source.
        const { id } = newTransfer(5)
        TransferService.ship(id, MANAGER)
        expect(() => TransferService.cancel(id, MANAGER, 'erreur')).toThrow(/impossible de passer/)
    })

    it('allows cancelling before the goods leave, touching no stock', () => {
        const { id } = newTransfer(5)
        TransferService.cancel(id, MANAGER, 'commande annulée')
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(10)
        const t = testDb.prepare('SELECT status FROM stock_transfers WHERE id = ?').get(id) as any
        expect(t.status).toBe('cancelled')
    })
})

describe('transfer — partial quantities', () => {
    it('ships short and records what actually left', () => {
        const { id } = newTransfer(5)
        const [item] = itemIds(id)

        TransferService.ship(id, MANAGER, { [item]: 3 })
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(7)

        const row = testDb.prepare('SELECT quantity_requested, quantity_shipped FROM stock_transfer_items WHERE id = ?')
            .get(item) as any
        expect(row).toMatchObject({ quantity_requested: 5, quantity_shipped: 3 })
    })

    it('receives short and leaves the discrepancy visible rather than reconciling it', () => {
        const { id } = newTransfer(5)
        const [item] = itemIds(id)
        TransferService.ship(id, MANAGER)

        const res = TransferService.receive(id, MANAGER, { [item]: 4 })
        expect(res.discrepancy).toBe(1)

        // 5 left, 4 arrived. The missing one must NOT be quietly credited anywhere.
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(5)
        expect(InventoryService.getStock(CASUAL, 1, 1)).toBe(4)
        const row = testDb.prepare('SELECT quantity_shipped, quantity_received FROM stock_transfer_items WHERE id = ?')
            .get(item) as any
        expect(row).toMatchObject({ quantity_shipped: 5, quantity_received: 4 })
    })

    it('flags a short receipt as critical in the audit log', () => {
        const { id } = newTransfer(5)
        const [item] = itemIds(id)
        TransferService.ship(id, MANAGER)
        TransferService.receive(id, MANAGER, { [item]: 2 })

        const a = testDb.prepare("SELECT severity, summary FROM audit_logs WHERE action = 'transfer.receive'").get() as any
        expect(a.severity).toBe('critical')
        expect(a.summary).toContain('écart de 3')
    })

    it('refuses to ship more than was requested', () => {
        const { id } = newTransfer(5)
        const [item] = itemIds(id)
        expect(() => TransferService.ship(id, MANAGER, { [item]: 9 })).toThrow(/demandé/)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(10)
    })

    it('refuses to receive more than was shipped', () => {
        const { id } = newTransfer(5)
        const [item] = itemIds(id)
        TransferService.ship(id, MANAGER, { [item]: 3 })
        expect(() => TransferService.receive(id, MANAGER, { [item]: 5 })).toThrow(/expédié/)
        expect(InventoryService.getStock(CASUAL, 1, 1)).toBe(0)
    })

    it('refuses a shipment where every line is zero', () => {
        const { id } = newTransfer(5)
        const [item] = itemIds(id)
        expect(() => TransferService.ship(id, MANAGER, { [item]: 0 })).toThrow(/Aucun article/)
    })
})

describe('transfer — the oversell guard applies to shipping', () => {
    it('refuses to send stock the source does not have, and unwinds whole', () => {
        const { id } = newTransfer(50)   // only 10 on hand

        expect(() => TransferService.ship(id, MANAGER)).toThrow(/Stock insuffisant/)

        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(10)
        const t = testDb.prepare('SELECT status FROM stock_transfers WHERE id = ?').get(id) as any
        expect(t.status).toBe('draft')
        expect((testDb.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as any).n).toBe(0)
    })

    it('unwinds every line when a later one is short', () => {
        testDb.prepare("INSERT INTO products (id, name, cost_price) VALUES (2, 'Polo Premium', 1500)").run()
        testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (2, 2, 'L', 'Noir')").run()
        testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (1, 2, 2, 1)').run()

        const { id } = TransferService.create({
            fromStoreId: COSTUME, toStoreId: CASUAL, userId: MANAGER,
            lines: [
                { productId: 1, variantId: 1, productName: 'Chemise Oxford', quantity: 2 },
                { productId: 2, variantId: 2, productName: 'Polo Premium', quantity: 4 },  // only 1
            ],
        })

        expect(() => TransferService.ship(id, MANAGER)).toThrow(/Stock insuffisant/)
        // The shirt must not have left just because it happened to be first.
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(10)
        expect(InventoryService.getStock(COSTUME, 2, 2)).toBe(1)
    })
})

describe('transfer — validation and permissions', () => {
    it('refuses a transfer to the same store', () => {
        expect(() => TransferService.create({
            fromStoreId: COSTUME, toStoreId: COSTUME, userId: MANAGER, lines: line(1),
        })).toThrow(/doivent différer/)
    })

    it('refuses an empty transfer', () => {
        expect(() => TransferService.create({
            fromStoreId: COSTUME, toStoreId: CASUAL, userId: MANAGER, lines: [],
        })).toThrow(/aucun article/)
    })

    it('refuses a cashier, who has no transfer permission', () => {
        expect(() => newTransfer(1, CASHIER)).toThrow(PermissionDeniedError)
        expect((testDb.prepare('SELECT COUNT(*) AS n FROM stock_transfers').get() as any).n).toBe(0)
    })

    it('lets a manager approve but not a cashier', () => {
        const { id } = newTransfer(2)
        expect(() => TransferService.approve(id, CASHIER)).toThrow(PermissionDeniedError)
        expect(() => TransferService.approve(id, MANAGER)).not.toThrow()
    })

    it('snapshots unit cost at creation so goods in transit hold their value', () => {
        const { id } = newTransfer(5)
        testDb.prepare('UPDATE products SET cost_price = 9999 WHERE id = 1').run()
        const detail = TransferService.getById(id)!
        expect((detail.items[0] as any).unit_cost).toBe(2200)
    })
})

describe('transfer — reporting', () => {
    it('reports goods that left but never arrived', () => {
        const { id } = newTransfer(5)
        TransferService.ship(id, MANAGER)

        const inTransit = TransferService.listInTransit() as any[]
        expect(inTransit).toHaveLength(1)
        expect(inTransit[0].quantity).toBe(5)
        expect(inTransit[0].value).toBe(5 * 2200)

        TransferService.receive(id, MANAGER)
        expect(TransferService.listInTransit()).toHaveLength(0)
    })

    it('ages an outstanding transfer so it can be chased', () => {
        const { id } = newTransfer(5)
        TransferService.ship(id, MANAGER)
        testDb.prepare("UPDATE stock_transfers SET shipped_at = datetime('now', '-9 days') WHERE id = ?").run(id)

        const [row] = TransferService.listInTransit() as any[]
        expect(row.days_in_transit).toBe(9)
    })

    it('lists a transfer for both the sending and the receiving store', () => {
        newTransfer(3)
        expect(TransferService.list({ storeId: COSTUME })).toHaveLength(1)
        expect(TransferService.list({ storeId: CASUAL })).toHaveLength(1)
    })

    it('shows the source’s current stock beside each line', () => {
        const { id } = newTransfer(5)
        const detail = TransferService.getById(id)!
        expect((detail.items[0] as any).source_stock).toBe(10)
    })
})
