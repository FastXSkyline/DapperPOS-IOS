import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from './helpers/sqliteHarness'
import { runRetailMigrations } from '../electron/migrationsRetail'

// electron/database.ts pulls in `electron` and the native better-sqlite3 binding,
// neither of which loads under vitest. The factory form of vi.mock replaces the
// module without ever evaluating it, so the service runs its real SQL against
// node:sqlite.
let testDb: any
vi.mock('../electron/database', () => ({ getDatabase: () => testDb }))

const { PayrollService } = await import('../electron/payrollService')
const { ExpenseService } = await import('../electron/expenseService')

const COSTUME = 1
const CASUAL = 2

function seedStores() {
    testDb.prepare("INSERT OR IGNORE INTO stores (id, name, code) VALUES (?, 'Costume', 'CST')").run(COSTUME)
    testDb.prepare("INSERT OR IGNORE INTO stores (id, name, code) VALUES (?, 'Casual', 'CAS')").run(CASUAL)
}

function hire(name: string, salary: number, storeId: number | null = COSTUME, allowances = 0) {
    const res = PayrollService.createEmployee({
        name, base_salary: salary, allowances, store_id: storeId,
    })
    return (res as any).id as number
}

const payrollExpenses = () =>
    testDb.prepare("SELECT * FROM expenses WHERE source_type = 'payroll' ORDER BY id").all() as any[]

beforeEach(() => {
    testDb = makeTestDb()
    runRetailMigrations(testDb)
    seedStores()
})

describe('payslip arithmetic', () => {
    it('takes CNAS and IRG off the gross, and adds the employer share on top', () => {
        const id = hire('Sara', 60000)
        const { payslip } = PayrollService.computePayslip(id, '2026-09') as any

        expect(payslip.gross).toBe(60000)
        expect(payslip.cnasEmployee).toBeCloseTo(5400, 2)     // 9 %
        expect(payslip.cnasEmployer).toBeCloseTo(15300, 2)    // 25.5 %
        expect(payslip.taxable).toBeCloseTo(54600, 2)

        // Net is what the employee receives: gross − employee CNAS − IRG.
        expect(payslip.net).toBeCloseTo(payslip.gross - payslip.cnasEmployee - payslip.irg, 2)

        // Employer cost is what the SHOP spends, and it is strictly more than net.
        // This is the distinction the whole feature turns on.
        expect(payslip.employerCost).toBeCloseTo(75300, 2)
        expect(payslip.employerCost).toBeGreaterThan(payslip.net)
    })

    it('counts a standing allowance as part of the gross, not on top of the net', () => {
        const id = hire('Karim', 40000, COSTUME, 6000)
        const { payslip } = PayrollService.computePayslip(id, '2026-09') as any

        expect(payslip.gross).toBe(46000)
        expect(payslip.allowances).toBe(6000)
        // The allowance is inside the CNAS base — not a tax-free top-up.
        expect(payslip.cnasEmployee).toBeCloseTo(4140, 2)
    })

    it('charges no IRG below the exemption threshold', () => {
        const id = hire('Nadia', 25000)
        const { payslip } = PayrollService.computePayslip(id, '2026-09') as any
        expect(payslip.irg).toBe(0)
    })

    it('recomputing a period replaces the slip instead of adding a second one', () => {
        const id = hire('Sara', 60000)
        PayrollService.computePayslip(id, '2026-09')
        PayrollService.computePayslip(id, '2026-09', 10000)

        const slips = PayrollService.listPayslips('2026-09')
        expect(slips).toHaveLength(1)
        expect(slips[0].gross).toBe(70000)
    })
})

describe('posting the wage bill to the books', () => {
    it('writes one expense per employee, valued at the employer cost', () => {
        hire('Sara', 60000)
        hire('Karim', 40000, CASUAL)
        PayrollService.runPayroll('2026-09')

        const res = PayrollService.postPeriodToExpenses('2026-09', 1) as any
        expect(res.success).toBe(true)
        expect(res.posted).toBe(2)

        const rows = payrollExpenses()
        expect(rows).toHaveLength(2)
        // 60000 × 1.255 + 40000 × 1.255
        expect(res.total).toBeCloseTo(125500, 2)
        expect(rows.every(r => r.category === 'salaires')).toBe(true)
    })

    it('attributes each salary to the shop that employs the person', () => {
        hire('Sara', 60000, COSTUME)
        hire('Karim', 40000, CASUAL)
        PayrollService.runPayroll('2026-09')
        PayrollService.postPeriodToExpenses('2026-09', 1)

        const byStore = Object.fromEntries(
            payrollExpenses().map(r => [r.store_id, r.amount]),
        )
        expect(byStore[COSTUME]).toBeCloseTo(75300, 2)
        expect(byStore[CASUAL]).toBeCloseTo(50200, 2)
    })

    it('dates the cost inside the period it was earned, not the day it was posted', () => {
        hire('Sara', 60000)
        PayrollService.runPayroll('2026-09')
        PayrollService.postPeriodToExpenses('2026-09', 1)

        // A September wage bill recorded in October is a September cost, or the
        // month's figures are wrong in both directions.
        expect(payrollExpenses()[0].spent_at.startsWith('2026-09')).toBe(true)
    })

    // THE POINT OF THE UNIQUE INDEX. The natural way to use the screen is "run
    // payroll, notice a bonus is missing, fix it, run again" — and without this
    // the second press silently doubles the largest cost the business has.
    it('does not double the wage bill when payroll is posted twice', () => {
        hire('Sara', 60000)
        PayrollService.runPayroll('2026-09')

        PayrollService.postPeriodToExpenses('2026-09', 1)
        PayrollService.postPeriodToExpenses('2026-09', 1)

        const rows = payrollExpenses()
        expect(rows).toHaveLength(1)
        expect(rows[0].amount).toBeCloseTo(75300, 2)
    })

    it('updates the existing expense when a corrected payroll is re-posted', () => {
        const id = hire('Sara', 60000)
        PayrollService.runPayroll('2026-09')
        PayrollService.postPeriodToExpenses('2026-09', 1)

        // The owner forgot a 10 000 DA bonus.
        PayrollService.computePayslip(id, '2026-09', 10000)
        PayrollService.postPeriodToExpenses('2026-09', 1)

        const rows = payrollExpenses()
        expect(rows).toHaveLength(1)
        expect(rows[0].amount).toBeCloseTo(70000 * 1.255, 2)
    })

    it('keeps each period separate', () => {
        hire('Sara', 60000)
        PayrollService.runPayroll('2026-09')
        PayrollService.postPeriodToExpenses('2026-09', 1)
        PayrollService.runPayroll('2026-10')
        PayrollService.postPeriodToExpenses('2026-10', 1)

        expect(payrollExpenses()).toHaveLength(2)
        expect(PayrollService.postingStatus('2026-09').count).toBe(1)
        expect(PayrollService.postingStatus('2026-10').count).toBe(1)
    })

    it('refuses to post a period nobody has calculated', () => {
        hire('Sara', 60000)
        const res = PayrollService.postPeriodToExpenses('2026-09', 1) as any
        expect(res.success).toBe(false)
        expect(payrollExpenses()).toHaveLength(0)
    })

    it('leaves hand-entered expenses alone', () => {
        ExpenseService.create('Loyer septembre', 90000, 1, { category: 'loyer', storeId: COSTUME })
        hire('Sara', 60000)
        PayrollService.runPayroll('2026-09')
        PayrollService.postPeriodToExpenses('2026-09', 1)
        PayrollService.postPeriodToExpenses('2026-09', 1)

        const all = testDb.prepare('SELECT * FROM expenses').all() as any[]
        expect(all).toHaveLength(2)
        expect(all.filter(r => r.source_type === null)).toHaveLength(1)
    })

    it('reports the wage bill from the ledger, so an uncalculated period counts as zero', () => {
        hire('Sara', 60000)
        PayrollService.runPayroll('2026-09')

        // Calculated but NOT posted: the books do not know about it yet, and a
        // report that counted it would disagree with the Dépenses screen.
        expect(PayrollService.wageBill().total).toBe(0)

        PayrollService.postPeriodToExpenses('2026-09', 1)
        expect(PayrollService.wageBill().total).toBeCloseTo(75300, 2)
    })
})

describe('the employee register', () => {
    it('deactivates rather than deletes, so posted expenses keep their backing', () => {
        const id = hire('Sara', 60000)
        PayrollService.runPayroll('2026-09')
        PayrollService.postPeriodToExpenses('2026-09', 1)

        PayrollService.deleteEmployee(id)

        expect(PayrollService.listEmployees()).toHaveLength(0)
        expect(PayrollService.listEmployees(true)).toHaveLength(1)
        // The slip that justifies the expense is still there.
        expect(PayrollService.listPayslips('2026-09')).toHaveLength(1)
    })

    it('only runs payroll for active staff', () => {
        hire('Sara', 60000)
        const leaver = hire('Karim', 40000)
        PayrollService.deleteEmployee(leaver)

        const { slips } = PayrollService.runPayroll('2026-09')
        expect(slips).toHaveLength(1)
        expect(slips[0].employee).toBe('Sara')
    })

    it('refuses to file someone with no name', () => {
        const res = PayrollService.createEmployee({ name: '   ', base_salary: 1000 }) as any
        expect(res.success).toBe(false)
    })
})

describe('expense ledger', () => {
    it('will not let a generated payroll row be deleted by hand', () => {
        hire('Sara', 60000)
        PayrollService.runPayroll('2026-09')
        PayrollService.postPeriodToExpenses('2026-09', 1)

        const row = payrollExpenses()[0]
        const res = ExpenseService.delete(row.id)

        // Deleting it here would leave the payslip standing with no matching cost.
        // The correction belongs at the source, followed by a re-post.
        expect(res.success).toBe(false)
        expect(payrollExpenses()).toHaveLength(1)
    })

    it('breaks a period down by category', () => {
        ExpenseService.create('Loyer', 90000, 1, { category: 'loyer', spentAt: '2026-09-01 10:00:00' })
        ExpenseService.create('Sonelgaz', 12000, 1, { category: 'electricite', spentAt: '2026-09-03 10:00:00' })
        hire('Sara', 60000)
        PayrollService.runPayroll('2026-09')
        PayrollService.postPeriodToExpenses('2026-09', 1)

        const rows = ExpenseService.byCategory({ from: '2026-09-01', to: '2026-09-30 23:59:59' })
        const map = Object.fromEntries(rows.map(r => [r.category, r.total]))
        expect(map.loyer).toBe(90000)
        expect(map.electricite).toBe(12000)
        expect(map.salaires).toBeCloseTo(75300, 2)
    })

    it('filters on the date the cost was incurred, not the day it was typed in', () => {
        // Entered today, but it is an August bill.
        ExpenseService.create('Sonelgaz août', 12000, 1, { spentAt: '2026-08-15 10:00:00' })
        ExpenseService.create('Sonelgaz sept.', 13000, 1, { spentAt: '2026-09-15 10:00:00' })

        expect(ExpenseService.total({ from: '2026-09-01', to: '2026-09-30 23:59:59' })).toBe(13000)
        expect(ExpenseService.total({ from: '2026-08-01', to: '2026-08-31 23:59:59' })).toBe(12000)
    })
})
