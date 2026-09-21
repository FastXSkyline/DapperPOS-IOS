import { getDatabase } from './database'
import { nextDocNumber } from './sequences'

// ---------------------------------------------------------------------------
// Cash sessions / Z-report (Dapper Phase 2)
//
// One session = one till day. It opens with a counted float and closes with a
// counted drawer; the Z-report explains the difference between the two.
//
// Cash is attributed to a session by PAYMENT time, not sale time — a credit sale
// settled in cash days later moves that day's drawer, not the day the goods left.
// Every window below is therefore [opened_at, closed_at ?? now) over payments.created_at.
// ---------------------------------------------------------------------------

export interface CashSession {
    id: number
    session_number: string | null
    opened_at: string
    closed_at: string | null
    opening_float: number
    counted_cash: number | null
    expected_cash: number | null
    variance: number | null
    opened_by: number | null
    closed_by: number | null
    notes: string | null
    status: 'open' | 'closed'
}

export interface ZReport {
    session: CashSession
    /** Payment totals for the window, split by instrument. */
    byMethod: { payment_method: string; total: number; count: number }[]
    cashIn: number
    nonCashTotal: number
    movementsIn: number
    movementsOut: number
    expenses: number
    /** opening float + cash taken + drawer top-ups − payouts − cash expenses. */
    expectedCash: number
    salesCount: number
    salesTotal: number
    taxTotal: number
    discountTotal: number
    timbreTotal: number
    /** Credit notes issued in the window. Informational: createAvoir writes no payment
     *  row, so a refund only moves the drawer if it was also recorded as a payout. */
    avoirCount: number
    avoirTotal: number
    movements: { id: number; direction: string; amount: number; reason: string | null; created_at: string }[]
}

/** Window end for an open session: "now" in the same format SQLite writes. */
const WINDOW_END = `COALESCE(s.closed_at, datetime('now'))`

export const CashSessionService = {
    /** The currently open session, or undefined when the till is closed. */
    getCurrent(): CashSession | undefined {
        const db = getDatabase()
        return db.prepare("SELECT * FROM cash_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1").get() as CashSession | undefined
    },

    getById(id: number): CashSession | undefined {
        const db = getDatabase()
        return db.prepare('SELECT * FROM cash_sessions WHERE id = ?').get(id) as CashSession | undefined
    },

    list(limit = 50) {
        const db = getDatabase()
        return db.prepare(`
            SELECT cs.*, u.name AS opened_by_name
            FROM cash_sessions cs
            LEFT JOIN users u ON u.id = cs.opened_by
            ORDER BY cs.id DESC LIMIT ?
        `).all(limit) as (CashSession & { opened_by_name?: string })[]
    },

    /** Open the till. Refuses if one is already open — two open drawers cannot reconcile. */
    open(userId: number, openingFloat: number, notes?: string) {
        const db = getDatabase()
        const existing = this.getCurrent()
        if (existing) return { success: false, error: 'Une caisse est déjà ouverte.', session: existing }

        const res = db.prepare(`
            INSERT INTO cash_sessions (opening_float, opened_by, notes, status)
            VALUES (?, ?, ?, 'open')
        `).run(Number(openingFloat) || 0, userId, notes || null)
        return { success: true, id: res.lastInsertRowid as number }
    },

    /** Record a manual drawer movement (petty cash out, safe drop, top-up). */
    addMovement(direction: 'in' | 'out', amount: number, reason: string, userId: number) {
        const db = getDatabase()
        const session = this.getCurrent()
        if (!session) return { success: false, error: 'Aucune caisse ouverte.' }
        if (!(Number(amount) > 0)) return { success: false, error: 'Montant invalide.' }

        db.prepare('INSERT INTO cash_movements (session_id, direction, amount, reason, user_id) VALUES (?, ?, ?, ?, ?)')
            .run(session.id, direction, Number(amount), reason || null, userId)
        return { success: true }
    },

    /**
     * Build the Z-report for a session (defaults to the open one).
     * Read-only — safe to call repeatedly to preview the close.
     */
    report(sessionId?: number): ZReport | { error: string } {
        const db = getDatabase()
        const session = sessionId ? this.getById(sessionId) : this.getCurrent()
        if (!session) return { error: 'Aucune caisse trouvée.' }

        const win = [session.id]

        const byMethod = db.prepare(`
            SELECT p.payment_method, ROUND(SUM(p.amount), 2) AS total, COUNT(*) AS count
            FROM payments p, cash_sessions s
            WHERE s.id = ?
              AND p.created_at >= s.opened_at AND p.created_at < ${WINDOW_END}
            GROUP BY p.payment_method
            ORDER BY total DESC
        `).all(...win) as { payment_method: string; total: number; count: number }[]

        const cashIn = byMethod.find(m => m.payment_method === 'cash')?.total || 0
        const nonCashTotal = byMethod.filter(m => m.payment_method !== 'cash').reduce((s, m) => s + m.total, 0)

        const mv = db.prepare(`
            SELECT direction, ROUND(COALESCE(SUM(amount), 0), 2) AS total
            FROM cash_movements WHERE session_id = ? GROUP BY direction
        `).all(session.id) as { direction: string; total: number }[]
        const movementsIn = mv.find(m => m.direction === 'in')?.total || 0
        const movementsOut = mv.find(m => m.direction === 'out')?.total || 0

        // Expenses have no payment_method column, and in a shop they come out of the
        // till — counted as drawer cash-out so the physical count reconciles.
        const expenses = (db.prepare(`
            SELECT ROUND(COALESCE(SUM(e.amount), 0), 2) AS total
            FROM expenses e, cash_sessions s
            WHERE s.id = ?
              AND e.created_at >= s.opened_at AND e.created_at < ${WINDOW_END}
        `).get(...win) as { total: number }).total

        const sales = db.prepare(`
            SELECT COUNT(*) AS n,
                   ROUND(COALESCE(SUM(t.total_amount), 0), 2) AS total,
                   ROUND(COALESCE(SUM(t.tax_amount), 0), 2) AS tax,
                   ROUND(COALESCE(SUM(t.discount_amount), 0), 2) AS discount,
                   ROUND(COALESCE(SUM(t.timbre), 0), 2) AS timbre
            FROM transactions t, cash_sessions s
            WHERE s.id = ? AND t.status = 'completed'
              AND t.completed_at >= s.opened_at AND t.completed_at < ${WINDOW_END}
        `).get(...win) as { n: number; total: number; tax: number; discount: number; timbre: number }

        const avoirs = db.prepare(`
            SELECT COUNT(*) AS n, ROUND(COALESCE(SUM(ABS(t.total_amount)), 0), 2) AS total
            FROM transactions t, cash_sessions s
            WHERE s.id = ? AND t.status = 'refunded'
              AND t.completed_at >= s.opened_at AND t.completed_at < ${WINDOW_END}
        `).get(...win) as { n: number; total: number }

        const movements = db.prepare(`
            SELECT id, direction, amount, reason, created_at FROM cash_movements
            WHERE session_id = ? ORDER BY id
        `).all(session.id) as ZReport['movements']

        const expectedCash = round2(session.opening_float + cashIn + movementsIn - movementsOut - expenses)

        return {
            session,
            byMethod,
            cashIn,
            nonCashTotal: round2(nonCashTotal),
            movementsIn,
            movementsOut,
            expenses,
            expectedCash,
            salesCount: sales.n,
            salesTotal: sales.total,
            taxTotal: sales.tax,
            discountTotal: sales.discount,
            timbreTotal: sales.timbre,
            avoirCount: avoirs.n,
            avoirTotal: avoirs.total,
            movements
        }
    },

    /**
     * Close the till against a physically counted drawer. Stamps a gapless Z-number
     * and freezes expected/variance so the report stays reproducible afterwards.
     */
    close(userId: number, countedCash: number, notes?: string) {
        const db = getDatabase()
        const session = this.getCurrent()
        if (!session) return { success: false, error: 'Aucune caisse ouverte.' }

        const rep = this.report(session.id)
        if ('error' in rep) return { success: false, error: rep.error }

        const counted = Number(countedCash) || 0
        const variance = round2(counted - rep.expectedCash)
        const zNumber = nextDocNumber('z_report', 'Z')

        db.prepare(`
            UPDATE cash_sessions
            SET status = 'closed', closed_at = datetime('now'), closed_by = ?,
                counted_cash = ?, expected_cash = ?, variance = ?,
                session_number = ?, notes = COALESCE(?, notes)
            WHERE id = ?
        `).run(userId, counted, rep.expectedCash, variance, zNumber, notes || null, session.id)

        return { success: true, id: session.id, session_number: zNumber, expected: rep.expectedCash, counted, variance }
    }
}

function round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100
}
