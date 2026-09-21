import { getDatabase } from './database'
import { PermissionService } from './permissionService'
import { AuditService } from './auditService'

// ---------------------------------------------------------------------------
// Sales targets (brief §44).
//
// WHAT A TARGET IS MEASURED AGAINST, stated once so the number on the dashboard
// means something: **net revenue** — gross sales in the period minus returns
// against them. The same definition analyticsService.ts uses, deliberately, so a
// seller's target and the seller's line in the reports can never disagree.
//
// A RETURN IS CHARGED TO WHOEVER MADE THE ORIGINAL SALE, not to whoever handled
// the return. Otherwise a target could be hit by selling hard in week one and
// letting it all come back in week four, while the colleague who processed the
// refunds absorbed the damage.
//
// COMPANY AND STORE TARGETS ARE INDEPENDENT ROWS, not a parent and its children.
// The owner may deliberately set store targets that sum to less than the company
// one (a stretch goal) or more (padding). Forcing them to agree would be inventing
// a rule the business did not ask for — so they are reported side by side with the
// difference made visible, and left alone.
// ---------------------------------------------------------------------------

export type TargetScope = 'company' | 'store' | 'employee'
export type PeriodType = 'day' | 'week' | 'month' | 'year'

export interface TargetInput {
    scope: TargetScope
    storeId?: number | null
    userId?: number | null
    periodType: PeriodType
    periodStart: string
    periodEnd: string
    targetAmount: number
    notes?: string | null
}

export interface TargetProgress {
    id: number
    scope: TargetScope
    store_id: number | null
    user_id: number | null
    period_type: PeriodType
    period_start: string
    period_end: string
    target_amount: number
    notes: string | null
    store_name: string | null
    user_name: string | null
    /** Net revenue achieved in the window, on the definition in the header. */
    achieved: number
    /** 0–∞. Capped nowhere: beating a target is worth seeing. */
    percent: number
    remaining: number
    /** Where the period should be if progress were linear. Null once it has ended. */
    expectedPercent: number | null
    daysLeft: number
}

export class TargetError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
        super(message)
        this.name = 'TargetError'
        this.code = code
    }
}

/**
 * Net revenue for one target's scope and window.
 *
 * Company = every store. Store = one. Employee = the sales they rang up, minus
 * the returns against those sales whoever processed them.
 */
function achievedFor(row: {
    scope: TargetScope; store_id: number | null; user_id: number | null
    period_start: string; period_end: string
}): number {
    const db = getDatabase()
    const from = row.period_start
    const to = `${row.period_end} 23:59:59`

    const where: string[] = ["t.status = 'completed'", 't.created_at >= ?', 't.created_at <= ?']
    const params: any[] = [from, to]
    if (row.scope === 'store' && row.store_id != null) {
        where.push('t.store_id = ?'); params.push(row.store_id)
    }
    if (row.scope === 'employee' && row.user_id != null) {
        where.push('t.user_id = ?'); params.push(row.user_id)
    }

    const gross = (db.prepare(
        `SELECT COALESCE(SUM(t.total_amount), 0) AS v FROM transactions t WHERE ${where.join(' AND ')}`
    ).get(...params) as any).v

    // Returns are matched through the ORIGINAL sale, so they land on the store and
    // the seller that made it — never on whoever happened to be at the till when
    // the customer came back.
    const rWhere: string[] = ["r.status = 'completed'", 'r.created_at >= ?', 'r.created_at <= ?']
    const rParams: any[] = [from, to]
    if (row.scope === 'store' && row.store_id != null) {
        rWhere.push('o.store_id = ?'); rParams.push(row.store_id)
    }
    if (row.scope === 'employee' && row.user_id != null) {
        rWhere.push('o.user_id = ?'); rParams.push(row.user_id)
    }

    const returned = (db.prepare(`
        SELECT COALESCE(SUM(r.returned_value), 0) AS v
        FROM sale_returns r
        JOIN transactions o ON o.id = r.original_transaction_id
        WHERE ${rWhere.join(' AND ')}
    `).get(...rParams) as any).v

    return gross - returned
}

/** How far through the period we are, as a percentage. Null once it has ended. */
function expectedPercent(start: string, end: string): number | null {
    const from = Date.parse(start)
    const to = Date.parse(`${end}T23:59:59`)
    const now = Date.now()
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null
    if (now >= to) return null
    if (now <= from) return 0
    return ((now - from) / (to - from)) * 100
}

function daysLeft(end: string): number {
    const to = Date.parse(`${end}T23:59:59`)
    if (!Number.isFinite(to)) return 0
    return Math.max(0, Math.ceil((to - Date.now()) / 86_400_000))
}

export const TargetService = {
    /**
     * Create or replace a target. Upserted on the natural key, so setting the same
     * period twice corrects the figure rather than leaving two rows that disagree
     * about what the goal was.
     */
    set(input: TargetInput, userId: number) {
        PermissionService.assertCan(userId, 'settings.manage')

        if (!(input.targetAmount > 0)) {
            throw new TargetError('INVALID_AMOUNT', 'L’objectif doit être supérieur à zéro')
        }
        if (input.periodEnd < input.periodStart) {
            throw new TargetError('INVALID_PERIOD', 'La date de fin précède la date de début')
        }
        if (input.scope === 'store' && !input.storeId) {
            throw new TargetError('NO_STORE', 'Un objectif magasin doit désigner un magasin')
        }
        if (input.scope === 'employee' && !input.userId) {
            throw new TargetError('NO_EMPLOYEE', 'Un objectif vendeur doit désigner un employé')
        }

        const db = getDatabase()
        // The UNIQUE index treats NULLs as distinct, so a company target (both ids
        // NULL) would never collide with itself. Normalising to 0 gives every scope
        // one row per period.
        const storeId = input.scope === 'store' ? input.storeId! : 0
        const targetUserId = input.scope === 'employee' ? input.userId! : 0

        const res = db.prepare(`
            INSERT INTO sales_targets
                (scope, store_id, user_id, period_type, period_start, period_end, target_amount, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, store_id, user_id, period_type, period_start)
            DO UPDATE SET target_amount = excluded.target_amount,
                          period_end = excluded.period_end,
                          notes = excluded.notes
        `).run(input.scope, storeId, targetUserId, input.periodType,
            input.periodStart, input.periodEnd, input.targetAmount, input.notes ?? null)

        AuditService.log({
            userId, action: 'target.set', entityType: 'sales_target',
            entityId: Number(res.lastInsertRowid) || null,
            storeId: input.scope === 'store' ? input.storeId! : null,
            severity: 'warning',
            summary: `Objectif ${input.scope} ${input.periodStart} → ${input.periodEnd} : ${input.targetAmount.toFixed(2)} DA`,
            newValue: input as unknown as Record<string, unknown>,
        })

        return { ok: true }
    },

    remove(id: number, userId: number) {
        PermissionService.assertCan(userId, 'settings.manage')
        const before = getDatabase().prepare('SELECT * FROM sales_targets WHERE id = ?').get(id)
        getDatabase().prepare('DELETE FROM sales_targets WHERE id = ?').run(id)
        AuditService.log({
            userId, action: 'target.remove', entityType: 'sales_target', entityId: id,
            oldValue: before as Record<string, unknown>, severity: 'warning',
        })
        return { ok: true }
    },

    /** Targets with their progress, newest period first. */
    list(filters: { scope?: TargetScope; storeId?: number; activeOnly?: boolean } = {}): TargetProgress[] {
        const where: string[] = []
        const params: any[] = []
        if (filters.scope) { where.push('t.scope = ?'); params.push(filters.scope) }
        if (filters.storeId != null) {
            // A store's view wants its own targets AND the company one it sits inside.
            where.push("(t.store_id = ? OR t.scope = 'company')")
            params.push(filters.storeId)
        }
        if (filters.activeOnly) {
            where.push("date('now') BETWEEN t.period_start AND t.period_end")
        }

        const rows = getDatabase().prepare(`
            SELECT t.*, s.name AS store_name, u.name AS user_name
            FROM sales_targets t
            LEFT JOIN stores s ON s.id = t.store_id
            LEFT JOIN users u ON u.id = t.user_id
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY t.period_start DESC, t.scope, t.id
        `).all(...params) as any[]

        return rows.map(row => {
            // 0 is the "not applicable" sentinel written by set(); it is not a real id.
            const storeId = row.store_id || null
            const rowUserId = row.user_id || null
            const achieved = achievedFor({ ...row, store_id: storeId, user_id: rowUserId })
            return {
                ...row,
                store_id: storeId,
                user_id: rowUserId,
                achieved,
                percent: row.target_amount > 0 ? (achieved / row.target_amount) * 100 : 0,
                remaining: Math.max(0, row.target_amount - achieved),
                expectedPercent: expectedPercent(row.period_start, row.period_end),
                daysLeft: daysLeft(row.period_end),
            }
        })
    },

    /**
     * The targets in force today, for the dashboard.
     *
     * `storeGap` is the difference between the company target and the sum of the
     * store targets covering the same period. Reported rather than prevented: the
     * owner may set stores deliberately short or long, and the useful thing is to
     * see it, not to be stopped.
     */
    current(storeId?: number) {
        const active = this.list({ storeId, activeOnly: true })
        const company = active.find(t => t.scope === 'company') ?? null
        const stores = active.filter(t => t.scope === 'store')
        const employees = active.filter(t => t.scope === 'employee')

        const storeSum = stores.reduce((n, t) => n + t.target_amount, 0)
        return {
            company,
            stores,
            employees,
            storeGap: company ? storeSum - company.target_amount : null,
        }
    },
}
