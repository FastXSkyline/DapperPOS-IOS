import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// Loyalty — points earned per DZD spent, redeemed as a discount (Dapper Phase 3).
//
// customers.loyalty_points is the running balance; loyalty_entries is the ledger
// that explains it. The balance is always recomputed FROM the ledger rather than
// incremented in place, so the two can never drift.
//
// Earning is idempotent: loyalty_entries carries UNIQUE(transaction_id, direction),
// so a retried sale completion cannot award the same points twice.
// ---------------------------------------------------------------------------

export interface LoyaltyConfig {
    /** Points granted per 1 DZD of sale. Default 0.01 = 1 point per 100 DZD. */
    earnPerDinar: number
    /** DZD of discount per redeemed point. Default 1. */
    dinarPerPoint: number
    /** Minimum balance before any redemption is allowed. */
    minRedeem: number
    enabled: boolean
}

const DEFAULTS: LoyaltyConfig = { earnPerDinar: 0.01, dinarPerPoint: 1, minRedeem: 100, enabled: true }

/** One ledger movement, joined with the sale it came from where there is one. */
export interface LoyaltyEntry {
    id: number
    customer_id: number
    transaction_id: number | null
    direction: 'earn' | 'redeem' | 'adjust'
    points: number
    note: string | null
    user_id: number | null
    created_at: string
    transaction_number: string | null
}

export interface LoyaltyCardHolder {
    id: number
    name: string
    phone: string | null
    loyalty_card_number: string | null
    loyalty_points: number
}

function cfgNumber(db: ReturnType<typeof getDatabase>, key: string, fallback: number): number {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined
    const n = row ? Number(row.value) : NaN
    return Number.isFinite(n) ? n : fallback
}

/** Recompute the cached balance from the ledger. Caller owns any surrounding transaction. */
function recomputeBalance(db: ReturnType<typeof getDatabase>, customerId: number) {
    const row = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN direction = 'redeem' THEN -points ELSE points END), 0) AS bal
        FROM loyalty_entries WHERE customer_id = ?
    `).get(customerId) as { bal: number }
    db.prepare("UPDATE customers SET loyalty_points = ?, updated_at = datetime('now') WHERE id = ?")
        .run(round2(row.bal || 0), customerId)
}

export const LoyaltyService = {
    getConfig(): LoyaltyConfig {
        const db = getDatabase()
        const enabledRow = db.prepare("SELECT value FROM config WHERE key = 'loyalty_enabled'").get() as { value: string } | undefined
        return {
            earnPerDinar: cfgNumber(db, 'loyalty_earn_per_dinar', DEFAULTS.earnPerDinar),
            dinarPerPoint: cfgNumber(db, 'loyalty_dinar_per_point', DEFAULTS.dinarPerPoint),
            minRedeem: cfgNumber(db, 'loyalty_min_redeem', DEFAULTS.minRedeem),
            enabled: enabledRow ? enabledRow.value === '1' : DEFAULTS.enabled
        }
    },

    setConfig(cfg: Partial<LoyaltyConfig>) {
        const db = getDatabase()
        const put = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
        db.transaction(() => {
            if (cfg.earnPerDinar != null) put.run('loyalty_earn_per_dinar', String(cfg.earnPerDinar))
            if (cfg.dinarPerPoint != null) put.run('loyalty_dinar_per_point', String(cfg.dinarPerPoint))
            if (cfg.minRedeem != null) put.run('loyalty_min_redeem', String(cfg.minRedeem))
            if (cfg.enabled != null) put.run('loyalty_enabled', cfg.enabled ? '1' : '0')
        })()
        return { success: true }
    },

    balance(customerId: number): number {
        const db = getDatabase()
        const row = db.prepare('SELECT COALESCE(loyalty_points, 0) AS p FROM customers WHERE id = ?').get(customerId) as { p: number } | undefined
        return row?.p || 0
    },

    history(customerId: number, limit = 50) {
        const db = getDatabase()
        return db.prepare(`
            SELECT le.*, t.transaction_number
            FROM loyalty_entries le
            LEFT JOIN transactions t ON t.id = le.transaction_id
            WHERE le.customer_id = ? ORDER BY le.id DESC LIMIT ?
        `).all(customerId, limit) as LoyaltyEntry[]
    },

    /** DZD a given number of points is worth. */
    pointsToDinars(points: number): number {
        return round2(points * this.getConfig().dinarPerPoint)
    },

    /**
     * Award points for a completed sale. Safe to call more than once — the UNIQUE
     * constraint makes the second attempt a no-op rather than a double award.
     * Called from TransactionService.complete() inside its own transaction.
     */
    earnForSale(transactionId: number): { awarded: number } {
        const db = getDatabase()
        const cfg = this.getConfig()
        if (!cfg.enabled || cfg.earnPerDinar <= 0) return { awarded: 0 }

        const txn = db.prepare('SELECT customer_id, total_amount FROM transactions WHERE id = ?')
            .get(transactionId) as { customer_id: number | null; total_amount: number } | undefined
        // Walk-in sales have no customer to credit.
        if (!txn?.customer_id || !(txn.total_amount > 0)) return { awarded: 0 }

        const points = round2(txn.total_amount * cfg.earnPerDinar)
        if (points <= 0) return { awarded: 0 }

        try {
            db.prepare(`INSERT INTO loyalty_entries (customer_id, transaction_id, direction, points, note)
                        VALUES (?, ?, 'earn', ?, 'Achat')`).run(txn.customer_id, transactionId, points)
        } catch {
            // UNIQUE(transaction_id, 'earn') violated: already awarded for this sale.
            return { awarded: 0 }
        }
        recomputeBalance(db, txn.customer_id)
        return { awarded: points }
    },

    /**
     * Redeem points against a sale. Returns the DZD discount to apply.
     * Refuses to overspend the balance or to go below the configured threshold.
     */
    redeem(customerId: number, points: number, transactionId?: number) {
        const db = getDatabase()
        const cfg = this.getConfig()
        if (!cfg.enabled) return { success: false, error: 'Programme de fidélité désactivé.' }

        const want = round2(Number(points) || 0)
        if (want <= 0) return { success: false, error: 'Nombre de points invalide.' }

        const bal = this.balance(customerId)
        if (want > bal) return { success: false, error: `Solde insuffisant (${bal} points).` }
        if (bal < cfg.minRedeem) return { success: false, error: `Minimum ${cfg.minRedeem} points pour utiliser la fidélité.` }

        const discount = round2(want * cfg.dinarPerPoint)
        try {
            db.transaction(() => {
                db.prepare(`INSERT INTO loyalty_entries (customer_id, transaction_id, direction, points, note)
                            VALUES (?, ?, 'redeem', ?, 'Remise fidélité')`).run(customerId, transactionId || null, want)
                recomputeBalance(db, customerId)
            })()
        } catch {
            return { success: false, error: 'Points déjà utilisés sur cette vente.' }
        }
        return { success: true, points: want, discount }
    },

    /** Manual correction (card migration, goodwill, mistake). */
    adjust(customerId: number, points: number, note: string, userId?: number) {
        const db = getDatabase()
        const delta = Number(points) || 0
        if (delta === 0) return { success: false, error: 'Aucun ajustement.' }
        db.transaction(() => {
            db.prepare(`INSERT INTO loyalty_entries (customer_id, transaction_id, direction, points, note, user_id)
                        VALUES (?, NULL, 'adjust', ?, ?, ?)`).run(customerId, delta, note || 'Ajustement', userId || null)
            recomputeBalance(db, customerId)
        })()
        return { success: true }
    },

    /** Customers holding points, best first — the shop's repeat buyers. */
    topCustomers(limit = 20) {
        const db = getDatabase()
        return db.prepare(`
            SELECT id, name, phone, loyalty_card_number, COALESCE(loyalty_points, 0) AS loyalty_points
            FROM customers WHERE is_active = 1 AND COALESCE(loyalty_points, 0) > 0
            ORDER BY loyalty_points DESC LIMIT ?
        `).all(limit) as LoyaltyCardHolder[]
    },

    setCardNumber(customerId: number, cardNumber: string) {
        getDatabase().prepare("UPDATE customers SET loyalty_card_number = ?, updated_at = datetime('now') WHERE id = ?")
            .run(cardNumber || null, customerId)
        return { success: true }
    },

    findByCard(cardNumber: string) {
        return getDatabase().prepare('SELECT * FROM customers WHERE loyalty_card_number = ? AND is_active = 1').get(cardNumber) as Record<string, unknown> | undefined
    }
}

function round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100
}
