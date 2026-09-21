import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from './helpers/sqliteHarness'
import { runRetailMigrations } from '../electron/migrationsRetail'

let testDb: any
vi.mock('../electron/database', () => ({ getDatabase: () => testDb }))

const { TargetService } = await import('../electron/targetService')
const { PermissionDeniedError } = await import('../electron/permissionService')

const COSTUME = 1
const CASUAL = 2
const OWNER = 10
const SELLER_A = 11
const SELLER_B = 12

/** A window that definitely contains "now", so progress is measurable. */
const YEAR = new Date().getFullYear()
const PERIOD = { periodStart: `${YEAR}-01-01`, periodEnd: `${YEAR}-12-31`, periodType: 'year' as const }

function seed() {
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Ilyes', 'x', 'owner')").run(OWNER)
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Karim', 'x', 'manager')").run(SELLER_A)
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (?, 'Sara', 'x', 'cashier')").run(SELLER_B)
}

let txnSeq = 0
/** A completed sale, attributed to a seller and a store. */
function sale(total: number, opts: { userId?: number; storeId?: number } = {}) {
    txnSeq++
    testDb.prepare(`
        INSERT INTO transactions (id, transaction_number, user_id, status, store_id, subtotal, total_amount, completed_at)
        VALUES (?, ?, ?, 'completed', ?, ?, ?, datetime('now'))
    `).run(txnSeq, `BL-${txnSeq}`, opts.userId ?? SELLER_A, opts.storeId ?? COSTUME, total, total)
    return txnSeq
}

/** A completed return against a sale. */
function refund(originalId: number, value: number, receivedInStore = COSTUME) {
    testDb.prepare(`
        INSERT INTO sale_returns (return_number, kind, original_transaction_id, store_id, user_id, returned_value, balance, status)
        VALUES (?, 'refund', ?, ?, ?, ?, ?, 'completed')
    `).run(`RET-${originalId}`, originalId, receivedInStore, SELLER_B, value, value)
}

const setTarget = (input: Partial<Parameters<typeof TargetService.set>[0]> = {}) =>
    TargetService.set({
        scope: 'company', targetAmount: 1_000_000, ...PERIOD, ...input,
    } as Parameters<typeof TargetService.set>[0], OWNER)

beforeEach(() => {
    testDb = makeTestDb()
    runRetailMigrations(testDb)
    seed()
    txnSeq = 0
})

describe('setting a target', () => {
    it('stores a company target and reports progress against net revenue', () => {
        setTarget({ targetAmount: 100_000 })
        sale(30_000)

        const [t] = TargetService.list()
        expect(t.target_amount).toBe(100_000)
        expect(t.achieved).toBe(30_000)
        expect(t.percent).toBe(30)
        expect(t.remaining).toBe(70_000)
    })

    it('corrects an existing target rather than leaving two that disagree', () => {
        setTarget({ targetAmount: 100_000 })
        setTarget({ targetAmount: 150_000 })
        const rows = TargetService.list()
        expect(rows).toHaveLength(1)
        expect(rows[0].target_amount).toBe(150_000)
    })

    it('keeps company, store and employee targets for the same period apart', () => {
        // The natural key includes the sentinel ids, so three scopes coexist.
        setTarget({ scope: 'company', targetAmount: 100_000 })
        setTarget({ scope: 'store', storeId: COSTUME, targetAmount: 60_000 })
        setTarget({ scope: 'employee', userId: SELLER_A, targetAmount: 40_000 })
        expect(TargetService.list()).toHaveLength(3)
    })

    it('keeps two stores’ targets apart', () => {
        setTarget({ scope: 'store', storeId: COSTUME, targetAmount: 60_000 })
        setTarget({ scope: 'store', storeId: CASUAL, targetAmount: 40_000 })
        expect(TargetService.list({ scope: 'store' })).toHaveLength(2)
    })

    it('refuses a target of zero or less', () => {
        expect(() => setTarget({ targetAmount: 0 })).toThrow(/supérieur à zéro/)
        expect(() => setTarget({ targetAmount: -5 })).toThrow(/supérieur à zéro/)
    })

    it('refuses a period that ends before it starts', () => {
        expect(() => setTarget({ periodStart: `${YEAR}-06-01`, periodEnd: `${YEAR}-01-01` }))
            .toThrow(/précède/)
    })

    it('refuses a store target with no store, and an employee target with no employee', () => {
        expect(() => setTarget({ scope: 'store' })).toThrow(/désigner un magasin/)
        expect(() => setTarget({ scope: 'employee' })).toThrow(/désigner un employé/)
    })

    it('refuses a cashier and records nothing', () => {
        expect(() => TargetService.set(
            { scope: 'company', targetAmount: 1000, ...PERIOD }, SELLER_B,
        )).toThrow(PermissionDeniedError)
        expect(TargetService.list()).toHaveLength(0)
    })

    it('audits the change', () => {
        setTarget({ targetAmount: 250_000 })
        const a = testDb.prepare("SELECT * FROM audit_logs WHERE action = 'target.set'").get() as any
        expect(a.severity).toBe('warning')
        expect(a.summary).toContain('250000.00')
    })
})

describe('what counts towards a target', () => {
    it('nets returns off, charged to the seller who made the sale', () => {
        // Not to whoever processed the refund — otherwise a target could be hit by
        // selling hard early and letting it come back later, while a colleague
        // absorbed the damage.
        setTarget({ scope: 'employee', userId: SELLER_A, targetAmount: 100_000 })
        const s = sale(50_000, { userId: SELLER_A })
        refund(s, 20_000)   // processed by SELLER_B

        const [t] = TargetService.list({ scope: 'employee' })
        expect(t.achieved).toBe(30_000)
    })

    it('does not charge the return to the person who handled it', () => {
        setTarget({ scope: 'employee', userId: SELLER_B, targetAmount: 100_000 })
        const s = sale(50_000, { userId: SELLER_A })
        refund(s, 20_000)   // SELLER_B processed it, but did not sell it

        const [t] = TargetService.list({ scope: 'employee' })
        expect(t.achieved).toBe(0)
    })

    it('charges a cross-store return to the store that SOLD the goods', () => {
        setTarget({ scope: 'store', storeId: COSTUME, targetAmount: 100_000 })
        const s = sale(50_000, { storeId: COSTUME })
        refund(s, 20_000, CASUAL)   // handed back at the other shop

        const [t] = TargetService.list({ scope: 'store' })
        expect(t.achieved).toBe(30_000)
    })

    it('counts every store towards a company target', () => {
        setTarget({ scope: 'company', targetAmount: 100_000 })
        sale(30_000, { storeId: COSTUME })
        sale(20_000, { storeId: CASUAL })
        expect(TargetService.list()[0].achieved).toBe(50_000)
    })

    it('counts only its own store towards a store target', () => {
        setTarget({ scope: 'store', storeId: CASUAL, targetAmount: 100_000 })
        sale(30_000, { storeId: COSTUME })
        sale(20_000, { storeId: CASUAL })
        expect(TargetService.list({ scope: 'store' })[0].achieved).toBe(20_000)
    })

    it('ignores sales outside the window', () => {
        setTarget({ targetAmount: 100_000, periodStart: `${YEAR}-01-01`, periodEnd: `${YEAR}-12-31` })
        const id = sale(40_000)
        testDb.prepare("UPDATE transactions SET created_at = '2001-05-05 10:00:00' WHERE id = ?").run(id)
        expect(TargetService.list()[0].achieved).toBe(0)
    })

    it('ignores sales that were never completed', () => {
        setTarget({ targetAmount: 100_000 })
        const id = sale(40_000)
        testDb.prepare("UPDATE transactions SET status = 'pending' WHERE id = ?").run(id)
        expect(TargetService.list()[0].achieved).toBe(0)
    })

    it('includes the last day of the period', () => {
        // period_end is a date; a sale at 18:00 on that date must still count.
        const today = new Date().toISOString().slice(0, 10)
        setTarget({ targetAmount: 100_000, periodStart: today, periodEnd: today })
        sale(40_000)
        expect(TargetService.list()[0].achieved).toBe(40_000)
    })

    it('reports beating a target rather than capping at 100 %', () => {
        setTarget({ targetAmount: 10_000 })
        sale(25_000)
        expect(TargetService.list()[0].percent).toBe(250)
        expect(TargetService.list()[0].remaining).toBe(0)
    })
})

describe('pace and the dashboard', () => {
    it('reports where the period should be, so progress can be judged against it', () => {
        const today = new Date().toISOString().slice(0, 10)
        setTarget({ targetAmount: 100_000, periodStart: today, periodEnd: `${YEAR + 1}-12-31` })
        const [t] = TargetService.list()
        expect(t.expectedPercent).not.toBeNull()
        expect(t.expectedPercent!).toBeGreaterThanOrEqual(0)
        expect(t.expectedPercent!).toBeLessThan(100)
        expect(t.daysLeft).toBeGreaterThan(0)
    })

    it('reports no expected pace for a period that has ended', () => {
        setTarget({ targetAmount: 100_000, periodStart: '2001-01-01', periodEnd: '2001-12-31' })
        const [t] = TargetService.list()
        expect(t.expectedPercent).toBeNull()
        expect(t.daysLeft).toBe(0)
    })

    it('returns only the targets in force today', () => {
        const today = new Date().toISOString().slice(0, 10)
        setTarget({ targetAmount: 100_000, periodStart: today, periodEnd: today })
        setTarget({ scope: 'store', storeId: COSTUME, targetAmount: 50_000, periodStart: '2001-01-01', periodEnd: '2001-12-31' })

        const now = TargetService.current()
        expect(now.company).not.toBeNull()
        expect(now.stores).toHaveLength(0)
    })

    it('shows the gap when store targets do not sum to the company target', () => {
        // Reported, never prevented: the owner may set stores deliberately short.
        const today = new Date().toISOString().slice(0, 10)
        const window = { periodStart: today, periodEnd: today }
        setTarget({ scope: 'company', targetAmount: 100_000, ...window })
        setTarget({ scope: 'store', storeId: COSTUME, targetAmount: 40_000, ...window })
        setTarget({ scope: 'store', storeId: CASUAL, targetAmount: 30_000, ...window })

        expect(TargetService.current().storeGap).toBe(-30_000)
    })

    it('shows a store its own target and the company one it sits inside', () => {
        const today = new Date().toISOString().slice(0, 10)
        const window = { periodStart: today, periodEnd: today }
        setTarget({ scope: 'company', targetAmount: 100_000, ...window })
        setTarget({ scope: 'store', storeId: COSTUME, targetAmount: 40_000, ...window })
        setTarget({ scope: 'store', storeId: CASUAL, targetAmount: 30_000, ...window })

        const view = TargetService.current(COSTUME)
        expect(view.company).not.toBeNull()
        expect(view.stores.map(s => s.store_id)).toEqual([COSTUME])
    })

    it('removes a target', () => {
        setTarget({ targetAmount: 100_000 })
        const [t] = TargetService.list()
        TargetService.remove(t.id, OWNER)
        expect(TargetService.list()).toHaveLength(0)
    })
})
