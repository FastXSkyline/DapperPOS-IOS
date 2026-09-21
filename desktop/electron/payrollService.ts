import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// Employees and payroll.
//
// Algerian payroll: CNAS (social security, employee + employer share),
// CACOBATPH (BTP only — irrelevant to a clothing shop, kept because the column
// exists and removing it would rewrite a shipped table), and IRG salaires
// (progressive income tax on the post-CNAS taxable base).
//
// ⚠️ RATES CHANGE WITH EVERY LOI DE FINANCES. The barème below is the common
// simplified monthly grid; the accountant must confirm it, exactly like the
// timbre brackets. It is deliberately in one place so a confirmation is a
// one-line edit.
//
// WHAT'S NEW: payroll now reaches the books. Computing a payslip and leaving it
// in its own table meant the shop's expenses did not know salaries existed —
// so every figure that subtracted expenses was wrong by the single largest cost
// the business has. `postPeriodToExpenses` writes one expense row per employee
// per period, tagged with its source, and the unique index from Migration 44
// makes pressing the button twice a no-op instead of a doubled wage bill.
//
// WHAT GETS POSTED is the EMPLOYER COST — gross + employer CNAS + CACOBATPH —
// not net pay. Net is what the employee receives; the withheld CNAS and IRG
// still leave the shop's account, just addressed to the state. Posting net
// would understate the wage bill by roughly a third.
// ---------------------------------------------------------------------------

const CNAS_EMPLOYEE = 0.09
const CNAS_EMPLOYER = 0.255   // 9 % + 25.5 % = 34.5 % total
const CACOBATPH = 0.1221      // BTP only

/** Monthly IRG salaire barème (simplified marginal brackets, DA). */
const IRG_BRACKETS: { upTo: number; rate: number }[] = [
    { upTo: 30000, rate: 0 },
    { upTo: 35000, rate: 0.20 },
    { upTo: 40000, rate: 0.23 },
    { upTo: 80000, rate: 0.27 },
    { upTo: 160000, rate: 0.30 },
    { upTo: 320000, rate: 0.33 },
    { upTo: Infinity, rate: 0.35 },
]

function computeIRG(taxable: number): number {
    let irg = 0
    let lower = 0
    for (const b of IRG_BRACKETS) {
        if (taxable <= lower) break
        const slice = Math.min(taxable, b.upTo) - lower
        if (slice > 0) irg += slice * b.rate
        lower = b.upTo
    }
    return Math.round(irg)
}

export interface EmployeeInput {
    name: string
    position?: string | null
    base_salary?: number
    allowances?: number
    phone?: string | null
    email?: string | null
    address?: string | null
    national_id?: string | null
    ncc?: string | null
    hire_date?: string | null
    end_date?: string | null
    contract_type?: string | null
    store_id?: number | null
    user_id?: number | null
    notes?: string | null
    is_btp?: boolean
}

/** Columns a caller may write, in the order the INSERT/UPDATE below uses them. */
const FIELDS = [
    'name', 'position', 'base_salary', 'allowances', 'phone', 'email', 'address',
    'national_id', 'ncc', 'hire_date', 'end_date', 'contract_type', 'store_id',
    'user_id', 'notes', 'is_btp',
] as const

function values(e: EmployeeInput): any[] {
    return [
        e.name,
        e.position ?? null,
        Number(e.base_salary) || 0,
        Number(e.allowances) || 0,
        e.phone ?? null,
        e.email ?? null,
        e.address ?? null,
        e.national_id ?? null,
        e.ncc ?? null,
        e.hire_date ?? null,
        e.end_date ?? null,
        e.contract_type ?? 'cdi',
        e.store_id ?? null,
        e.user_id ?? null,
        e.notes ?? null,
        e.is_btp ? 1 : 0,
    ]
}

export const PayrollService = {
    /** The payroll MODULE (payslips, CNAS, IRG) is optional. The employee
     *  register itself is not — a shop always needs to know who works there —
     *  so the Employés screen reads this only to decide whether to show the
     *  payslip tab. */
    isEnabled(): boolean {
        const row = getDatabase()
            .prepare("SELECT value FROM config WHERE key = 'payroll_enabled'")
            .get() as { value: string } | undefined
        return row?.value === '1'
    },

    setEnabled(on: boolean) {
        getDatabase()
            .prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('payroll_enabled', ?)")
            .run(on ? '1' : '0')
        return { success: true }
    },

    /** Active staff, with the shop they belong to and the till login they use. */
    listEmployees(includeInactive = false) {
        return getDatabase().prepare(`
            SELECT e.*,
                   s.name AS store_name,
                   u.name AS user_name,
                   u.role AS user_role
            FROM employees e
            LEFT JOIN stores s ON s.id = e.store_id
            LEFT JOIN users u ON u.id = e.user_id
            ${includeInactive ? '' : 'WHERE e.is_active = 1'}
            ORDER BY e.is_active DESC, e.name
        `).all() as any[]
    },

    getEmployee(id: number) {
        return getDatabase().prepare('SELECT * FROM employees WHERE id = ?').get(id) as any
    },

    createEmployee(e: EmployeeInput) {
        if (!e?.name?.trim()) return { success: false, error: 'Le nom est obligatoire.' }
        const cols = FIELDS.join(', ')
        const marks = FIELDS.map(() => '?').join(', ')
        const res = getDatabase()
            .prepare(`INSERT INTO employees (${cols}) VALUES (${marks})`)
            .run(...values(e))
        return { success: true, id: res.lastInsertRowid as number }
    },

    updateEmployee(id: number, e: EmployeeInput) {
        if (!e?.name?.trim()) return { success: false, error: 'Le nom est obligatoire.' }
        const sets = FIELDS.map(f => `${f} = ?`).join(', ')
        getDatabase()
            .prepare(`UPDATE employees SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
            .run(...values(e), id)
        return { success: true }
    },

    /** Soft delete. A hard delete would orphan the payslips that back the
     *  expenses already posted to the books. */
    deleteEmployee(id: number) {
        getDatabase().prepare('UPDATE employees SET is_active = 0 WHERE id = ?').run(id)
        return { success: true }
    },

    /**
     * Compute (and persist) one payslip.
     *
     * `bonus` and `deductions` are per-period one-offs; `allowances` is the
     * employee's standing indemnity and is read from their record, so "why is
     * this month different from last" always has an answer on the slip.
     */
    computePayslip(employeeId: number, period: string, bonus = 0, deductions = 0) {
        const db = getDatabase()
        const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as any
        if (!emp) return { success: false as const, error: 'Employé introuvable.' }

        const allowances = Number(emp.allowances) || 0
        const gross = (Number(emp.base_salary) || 0) + allowances + (Number(bonus) || 0)
        const cnasEmployee = gross * CNAS_EMPLOYEE
        const cnasEmployer = gross * CNAS_EMPLOYER
        const cacobatph = emp.is_btp ? gross * CACOBATPH : 0
        const taxable = gross - cnasEmployee
        const irg = computeIRG(taxable)
        const net = gross - cnasEmployee - irg - (Number(deductions) || 0)
        const employerCost = gross + cnasEmployer + cacobatph

        db.prepare(`
            INSERT OR REPLACE INTO payslips
                (employee_id, period, gross, cnas_employee, cnas_employer, cacobatph,
                 taxable, irg, net, bonus, allowances, deductions, employer_cost)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            employeeId, period, gross, cnasEmployee, cnasEmployer, cacobatph,
            taxable, irg, net, Number(bonus) || 0, allowances, Number(deductions) || 0,
            employerCost,
        )

        return {
            success: true as const,
            payslip: {
                employeeId, employee: emp.name, storeId: emp.store_id ?? null, period,
                gross, cnasEmployee, cnasEmployer, cacobatph, taxable, irg, net,
                bonus: Number(bonus) || 0, allowances, deductions: Number(deductions) || 0,
                employerCost,
            },
        }
    },

    /** Run payroll for everyone active, for a period (YYYY-MM). */
    runPayroll(period: string) {
        const db = getDatabase()
        const emps = this.listEmployees()
        const run = db.transaction(() => {
            const slips = emps
                .map(e => this.computePayslip(e.id, period).payslip)
                .filter(Boolean) as any[]
            return slips
        })
        const slips = run()

        const totals = slips.reduce((t, s) => ({
            gross: t.gross + s.gross,
            cnasEmployee: t.cnasEmployee + s.cnasEmployee,
            cnasEmployer: t.cnasEmployer + s.cnasEmployer,
            cacobatph: t.cacobatph + s.cacobatph,
            irg: t.irg + s.irg,
            net: t.net + s.net,
            employerCost: t.employerCost + s.employerCost,
        }), { gross: 0, cnasEmployee: 0, cnasEmployer: 0, cacobatph: 0, irg: 0, net: 0, employerCost: 0 })

        return { slips, totals }
    },

    listPayslips(period: string) {
        return getDatabase().prepare(`
            SELECT ps.*, e.name AS employee_name, e.position, e.store_id, s.name AS store_name
            FROM payslips ps
            JOIN employees e ON e.id = ps.employee_id
            LEFT JOIN stores s ON s.id = e.store_id
            WHERE ps.period = ?
            ORDER BY e.name
        `).all(period) as any[]
    },

    /**
     * Post a period's payroll into the expense ledger.
     *
     * One row per employee rather than a single lump, so Dépenses can be read
     * per shop and a single correction does not require re-posting everyone.
     *
     * SAFE TO PRESS TWICE: `source_ref` is '<period>:<employeeId>' and Migration
     * 44 puts a unique index on (source_type, source_ref), so a re-run UPDATEs
     * the amount instead of appending a second wage bill. That matters because
     * the natural way to use this screen is "run payroll, notice a bonus is
     * missing, fix it, run again".
     */
    postPeriodToExpenses(period: string, userId?: number) {
        const db = getDatabase()
        const slips = this.listPayslips(period)
        if (!slips.length) return { success: false as const, error: 'Aucune fiche de paie pour cette période.' }

        // Post-dated to the last day of the period, not to today: a September
        // wage bill recorded in October lands in the wrong month's figures.
        const spentAt = `${period}-28 12:00:00`

        const upsert = db.prepare(`
            INSERT INTO expenses (name, amount, created_by, category, store_id, spent_at, source_type, source_ref)
            VALUES (?, ?, ?, 'salaires', ?, ?, 'payroll', ?)
            ON CONFLICT(source_type, source_ref) WHERE source_type IS NOT NULL
            DO UPDATE SET name = excluded.name,
                          amount = excluded.amount,
                          store_id = excluded.store_id,
                          spent_at = excluded.spent_at
        `)

        const run = db.transaction(() => {
            let posted = 0
            for (const s of slips) {
                // employer_cost is written by computePayslip; older rows predate the
                // column, so fall back to recomputing it from what is stored rather
                // than posting a zero.
                const cost = Number(s.employer_cost)
                    || (Number(s.gross) || 0) + (Number(s.cnas_employer) || 0) + (Number(s.cacobatph) || 0)
                upsert.run(
                    `Salaire ${period} — ${s.employee_name}`,
                    cost,
                    userId ?? null,
                    s.store_id ?? null,
                    spentAt,
                    `${period}:${s.employee_id}`,
                )
                posted++
            }
            return posted
        })

        const posted = run()
        const total = slips.reduce(
            (n, s) => n + (Number(s.employer_cost)
                || (Number(s.gross) || 0) + (Number(s.cnas_employer) || 0) + (Number(s.cacobatph) || 0)),
            0,
        )
        return { success: true as const, posted, total, period }
    },

    /** Whether a period's payroll is already in the ledger, and for how much. */
    postingStatus(period: string) {
        const row = getDatabase().prepare(`
            SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
            FROM expenses
            WHERE source_type = 'payroll' AND source_ref LIKE ?
        `).get(`${period}:%`) as { n: number; total: number }
        return { posted: row.n > 0, count: row.n, total: row.total }
    },

    /**
     * The wage bill for a window, for anything that reports cost.
     *
     * Reads the EXPENSES, not the payslips: a payslip that was never posted is
     * not yet a cost the books know about, and a report that counted it would
     * disagree with Dépenses on the same screen.
     */
    wageBill(from?: string, to?: string, storeId?: number | null) {
        const where: string[] = ["source_type = 'payroll'"]
        const params: any[] = []
        if (from) { where.push('spent_at >= ?'); params.push(from) }
        if (to) { where.push('spent_at <= ?'); params.push(to) }
        if (storeId != null) { where.push('store_id = ?'); params.push(storeId) }
        const row = getDatabase().prepare(`
            SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS lines
            FROM expenses WHERE ${where.join(' AND ')}
        `).get(...params) as { total: number; lines: number }
        return row
    },
}
