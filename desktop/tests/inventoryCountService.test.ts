import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from './helpers/sqliteHarness'
import { runRetailMigrations } from '../electron/migrationsRetail'

let testDb: any
vi.mock('../electron/database', () => ({ getDatabase: () => testDb }))

const { InventoryCountService, CountError } = await import('../electron/inventoryCountService')
const { InventoryService } = await import('../electron/inventoryService')
const { PermissionDeniedError } = await import('../electron/permissionService')

const COSTUME = 1
const CASUAL = 2
const OWNER = 10
const STOCK = 11    // 'warehouse' — may count AND adjust
const CASHIER = 12  // may do neither

function seed() {
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Ilyes', 'x', 'owner')").run(OWNER)
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Nabil', 'x', 'warehouse')").run(STOCK)
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Sara', 'x', 'cashier')").run(CASHIER)

    testDb.prepare("INSERT INTO categories (id, name) VALUES (1, 'Costumes')").run()
    testDb.prepare("INSERT INTO categories (id, name) VALUES (2, 'Chemises')").run()
    testDb.prepare("INSERT INTO products (id, name, category_id, cost_price) VALUES (1, 'Costume Milano', 1, 18000)").run()
    testDb.prepare("INSERT INTO products (id, name, category_id, cost_price) VALUES (2, 'Chemise Oxford', 2, 2000)").run()
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (1, 1, '52', 'Bleu Marine')").run()
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (2, 1, '54', 'Bleu Marine')").run()
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (3, 2, 'M', 'Blanche')").run()

    testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (1, 1, 1, 10)').run()
    testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (1, 1, 2, 5)').run()
    testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (1, 2, 3, 20)').run()
}

const startFull = (userId = STOCK, storeId = COSTUME) =>
    InventoryCountService.start({ storeId, userId, scope: 'full' })

/** The count line for one variant. */
function lineFor(countId: number, variantId: number) {
    return testDb.prepare('SELECT id FROM inventory_count_items WHERE count_id = ? AND variant_id = ?')
        .get(countId, variantId) as { id: number }
}

beforeEach(() => {
    testDb = makeTestDb()
    runRetailMigrations(testDb)
    seed()
})

describe('starting a count', () => {
    it('materialises a line per active variant, including ones with no stock row', () => {
        // A count exists partly to find goods the system does not know about; starting
        // from stock_inventory alone would make those invisible.
        const { id, lineCount } = startFull()
        expect(lineCount).toBe(3)
        const detail = InventoryCountService.getById(id)!
        expect(detail.items).toHaveLength(3)
    })

    it('scopes to a category', () => {
        const { id, lineCount } = InventoryCountService.start({
            storeId: COSTUME, userId: STOCK, scope: 'category', categoryId: 2,
        })
        expect(lineCount).toBe(1)
        expect((InventoryCountService.getById(id)!.items[0] as any).product_name).toBe('Chemise Oxford')
    })

    it('scopes to an explicit selection', () => {
        const { lineCount } = InventoryCountService.start({
            storeId: COSTUME, userId: STOCK, scope: 'selection', variantIds: [1, 3],
        })
        expect(lineCount).toBe(2)
    })

    it('refuses a second open count on the same store', () => {
        // Two open counts would each snapshot the other's adjustments and
        // double-correct on apply.
        startFull()
        expect(() => startFull()).toThrow(/déjà en cours/)
    })

    it('allows a concurrent count in the OTHER store', () => {
        startFull(STOCK, COSTUME)
        expect(() => startFull(STOCK, CASUAL)).not.toThrow()
    })

    it('numbers counts gaplessly', () => {
        expect(startFull().countNumber).toMatch(/^CNT-\d{4}-000001$/)
    })

    it('refuses a cashier', () => {
        expect(() => startFull(CASHIER)).toThrow(PermissionDeniedError)
        expect((testDb.prepare('SELECT COUNT(*) AS n FROM inventory_counts').get() as any).n).toBe(0)
    })
})

describe('counting a line', () => {
    it('snapshots the expected figure at the moment of counting, not at session start', () => {
        // The core timing rule. Two shirts sell after the session opens; the count
        // must measure against 18, not against the 20 that was true at start.
        const { id } = startFull()
        InventoryService.consume(2, 3, 2, { storeId: COSTUME }, 'sale')

        const res = InventoryCountService.countLine(lineFor(id, 3).id, 18, STOCK)
        expect(res.expected).toBe(18)
        expect(res.difference).toBe(0)
    })

    it('records a shortfall as a negative difference', () => {
        const { id } = startFull()
        const res = InventoryCountService.countLine(lineFor(id, 1).id, 7, STOCK)
        expect(res).toEqual({ expected: 10, counted: 7, difference: -3 })
    })

    it('accepts zero as a real count', () => {
        const { id } = startFull()
        const res = InventoryCountService.countLine(lineFor(id, 1).id, 0, STOCK)
        expect(res.difference).toBe(-10)
    })

    it('refuses a negative count', () => {
        const { id } = startFull()
        expect(() => InventoryCountService.countLine(lineFor(id, 1).id, -1, STOCK)).toThrow(/négative/)
    })

    it('clears a mis-keyed line back to uncounted', () => {
        const { id } = startFull()
        const line = lineFor(id, 1).id
        InventoryCountService.countLine(line, 999, STOCK)
        InventoryCountService.clearLine(line, STOCK)

        const row = testDb.prepare('SELECT counted_qty, difference FROM inventory_count_items WHERE id = ?')
            .get(line) as any
        expect(row.counted_qty).toBeNull()
        expect(row.difference).toBeNull()
    })

    it('refuses to count into an applied session', () => {
        const { id } = startFull()
        InventoryCountService.countLine(lineFor(id, 1).id, 10, STOCK)
        InventoryCountService.apply(id, STOCK)
        expect(() => InventoryCountService.countLine(lineFor(id, 2).id, 5, STOCK)).toThrow(/plus modifiable/)
    })
})

describe('applying a count', () => {
    it('applies the discrepancy and leaves matching lines alone', () => {
        const { id } = startFull()
        InventoryCountService.countLine(lineFor(id, 1).id, 7, STOCK)    // −3
        InventoryCountService.countLine(lineFor(id, 2).id, 5, STOCK)    // 0
        InventoryCountService.countLine(lineFor(id, 3).id, 23, STOCK)   // +3

        const res = InventoryCountService.apply(id, STOCK)
        expect(res.adjusted).toBe(2)
        expect(res.netUnits).toBe(0)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(7)
        expect(InventoryService.getStock(COSTUME, 1, 2)).toBe(5)
        expect(InventoryService.getStock(COSTUME, 2, 3)).toBe(23)
    })

    it('applies a DELTA, so sales made after counting survive', () => {
        // The whole reason apply does not write an absolute. Counted 7 (found 3
        // missing), then one more sold. Correct answer is 6, not 7.
        const { id } = startFull()
        InventoryCountService.countLine(lineFor(id, 1).id, 7, STOCK)
        InventoryService.consume(1, 1, 1, { storeId: COSTUME }, 'sale')
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(9)

        InventoryCountService.apply(id, STOCK)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(6)
    })

    it('ignores uncounted lines rather than treating them as zero', () => {
        // The most destructive thing this module could do: a count abandoned half
        // way through must not wipe the stock of everything nobody reached.
        const { id } = startFull()
        InventoryCountService.countLine(lineFor(id, 1).id, 8, STOCK)

        InventoryCountService.apply(id, STOCK)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(8)
        expect(InventoryService.getStock(COSTUME, 1, 2)).toBe(5)    // untouched
        expect(InventoryService.getStock(COSTUME, 2, 3)).toBe(20)   // untouched
    })

    it('writes one movement per adjusted line, carrying the delta', () => {
        const { id } = startFull()
        InventoryCountService.countLine(lineFor(id, 1).id, 4, STOCK)
        InventoryCountService.apply(id, STOCK)

        const m = testDb.prepare(
            "SELECT quantity, movement_type, store_id FROM stock_movements WHERE reference_type = 'inventory_count'"
        ).all() as any[]
        expect(m).toEqual([{ quantity: -6, movement_type: 'adjustment', store_id: COSTUME }])
    })

    it('can take stock negative, because that is a real finding', () => {
        // Routing an adjustment through the oversell guard would refuse exactly the
        // discrepancies a count exists to surface.
        const { id } = startFull()
        InventoryCountService.countLine(lineFor(id, 1).id, 2, STOCK)   // −8 from 10
        InventoryService.consume(1, 1, 9, { storeId: COSTUME }, 'sale')  // now 1
        InventoryCountService.apply(id, STOCK)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(-7)
    })

    it('refuses to apply twice', () => {
        const { id } = startFull()
        InventoryCountService.countLine(lineFor(id, 1).id, 7, STOCK)
        InventoryCountService.apply(id, STOCK)
        expect(() => InventoryCountService.apply(id, STOCK)).toThrow(CountError)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(7)
    })

    it('refuses to apply a count with nothing counted', () => {
        const { id } = startFull()
        expect(() => InventoryCountService.apply(id, STOCK)).toThrow(/Aucune ligne comptée/)
    })

    it('needs inventory.adjust, a higher bar than counting', () => {
        // The owner grants counting widely and adjusting narrowly; applying moves
        // stock and therefore money.
        testDb.prepare("DELETE FROM role_permissions WHERE role='warehouse' AND permission_code='inventory.adjust'").run()
        const { id } = startFull()
        InventoryCountService.countLine(lineFor(id, 1).id, 7, STOCK)

        expect(() => InventoryCountService.apply(id, STOCK)).toThrow(PermissionDeniedError)
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(10)
    })

    it('logs a discrepancy as critical, with the net figures', () => {
        const { id } = startFull()
        InventoryCountService.countLine(lineFor(id, 1).id, 7, STOCK)
        InventoryCountService.apply(id, STOCK)

        const a = testDb.prepare("SELECT * FROM audit_logs WHERE action = 'inventory.count_apply'").get() as any
        expect(a.severity).toBe('critical')
        expect(a.summary).toContain('écart net -3')
        expect(JSON.parse(a.new_value).netValue).toBe(-3 * 18000)
    })
})

describe('cancelling and reading', () => {
    it('cancels an open count without touching stock', () => {
        const { id } = startFull()
        InventoryCountService.countLine(lineFor(id, 1).id, 1, STOCK)
        InventoryCountService.cancel(id, STOCK, 'reprise demain')
        expect(InventoryService.getStock(COSTUME, 1, 1)).toBe(10)
    })

    it('refuses to cancel an applied count', () => {
        // Stock has already moved; cancelling would only hide the record of it.
        const { id } = startFull()
        InventoryCountService.countLine(lineFor(id, 1).id, 7, STOCK)
        InventoryCountService.apply(id, STOCK)
        expect(() => InventoryCountService.cancel(id, STOCK)).toThrow(/ne peut pas être annulé/)
    })

    it('frees the store for a new count once cancelled', () => {
        const { id } = startFull()
        InventoryCountService.cancel(id, STOCK)
        expect(() => startFull()).not.toThrow()
    })

    it('reports progress and net variance', () => {
        const { id } = startFull()
        InventoryCountService.countLine(lineFor(id, 1).id, 7, STOCK)
        const d = InventoryCountService.getById(id)! as any
        expect(d.totals).toMatchObject({ lines: 3, counted: 1, with_difference: 1, net_difference: -3 })
        expect(d.totals.net_value).toBe(-3 * 18000)
    })

    it('filters to differences and to uncounted lines', () => {
        const { id } = startFull()
        InventoryCountService.countLine(lineFor(id, 1).id, 7, STOCK)
        InventoryCountService.countLine(lineFor(id, 2).id, 5, STOCK)

        expect(InventoryCountService.getById(id, 'differences')!.items).toHaveLength(1)
        expect(InventoryCountService.getById(id, 'uncounted')!.items).toHaveLength(1)
    })

    it('resumes the open count for a store', () => {
        const { id } = startFull()
        expect((InventoryCountService.getOpen(COSTUME) as any).id).toBe(id)
        expect(InventoryCountService.getOpen(CASUAL)).toBeNull()
    })
})
