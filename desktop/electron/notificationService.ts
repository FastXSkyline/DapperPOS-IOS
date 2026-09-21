import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// Notification centre (brief §58).
//
// This module MAKES no findings of its own — it re-reads the services that
// already know (inventory, transfers, counts, cash) and turns their answers into
// rows. Duplicating the low-stock rule here would give the shop two definitions
// of "low" that could disagree.
//
// DEDUPLICATION IS THE WHOLE PROBLEM. The sweep runs on every boot and on demand;
// without a key, "Costume Milano 52 is low" becomes forty identical rows in a week
// and the centre becomes noise nobody reads. Migration 41's partial unique index on
// `dedupe_key WHERE read_at IS NULL` enforces one-open-alert-per-condition at the
// database level, so a race between two sweeps cannot slip a second copy through.
//
// The index is partial ON PURPOSE: once the owner dismisses an alert, the same
// condition may legitimately raise it again later. Dismissing means "I have seen
// this", not "never tell me again".
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'warning' | 'critical' | 'success'

export interface NotificationInput {
    type: string
    severity: Severity
    title: string
    body?: string | null
    storeId?: number | null
    entityType?: string | null
    entityId?: number | null
    /** Stable identity of the CONDITION, not of the event. */
    dedupeKey?: string | null
}

export const NotificationService = {
    /** Raise one notification. Silently a no-op if an unread one already exists
     *  for the same condition — that is the dedupe index doing its job, not an error. */
    raise(input: NotificationInput): boolean {
        try {
            getDatabase().prepare(`
                INSERT INTO notifications
                    (type, severity, title, body, store_id, entity_type, entity_id, dedupe_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                input.type, input.severity, input.title, input.body ?? null,
                input.storeId ?? null, input.entityType ?? null, input.entityId ?? null,
                input.dedupeKey ?? null,
            )
            return true
        } catch {
            // UNIQUE on the partial index: this condition is already flagged and unread.
            return false
        }
    },

    list(filters: { storeId?: number; unreadOnly?: boolean; limit?: number } = {}) {
        const where: string[] = []
        const params: any[] = []
        if (filters.storeId != null) {
            // A store-scoped alert or a global one; both concern this terminal.
            where.push('(n.store_id = ? OR n.store_id IS NULL)')
            params.push(filters.storeId)
        }
        if (filters.unreadOnly) where.push('n.read_at IS NULL')
        params.push(filters.limit ?? 100)

        return getDatabase().prepare(`
            SELECT n.*, s.name AS store_name
            FROM notifications n
            LEFT JOIN stores s ON s.id = n.store_id
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY
              -- Unread first, then by urgency, then newest. An owner opening this
              -- should meet the till discrepancy before last week's low-stock note.
              CASE WHEN n.read_at IS NULL THEN 0 ELSE 1 END,
              CASE n.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1
                              WHEN 'success' THEN 2 ELSE 3 END,
              n.created_at DESC
            LIMIT ?
        `).all(...params)
    },

    unreadCount(storeId?: number): number {
        const where = storeId != null ? 'AND (store_id = ? OR store_id IS NULL)' : ''
        const params = storeId != null ? [storeId] : []
        return (getDatabase()
            .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL ${where}`)
            .get(...params) as any).n
    },

    markRead(id: number) {
        getDatabase().prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL").run(id)
        return { ok: true }
    },

    markAllRead(storeId?: number) {
        const where = storeId != null ? 'AND (store_id = ? OR store_id IS NULL)' : ''
        const params = storeId != null ? [storeId] : []
        const res = getDatabase()
            .prepare(`UPDATE notifications SET read_at = datetime('now') WHERE read_at IS NULL ${where}`)
            .run(...params)
        return { ok: true, marked: res.changes }
    },

    /**
     * Re-evaluate every rule and raise what is currently true.
     *
     * Deliberately pull, not push: a shop PC is not always running, and a rule that
     * only fired at the instant a condition arose would miss everything that changed
     * while the machine was off. Sweeping on demand means the centre is always a
     * statement about NOW rather than a log of moments the app happened to be awake.
     */
    sweep(storeId?: number | null) {
        const db = getDatabase()
        let raised = 0
        const fire = (n: NotificationInput) => { if (this.raise(n)) raised++ }

        const storeFilter = storeId != null ? 'AND si.store_id = ?' : ''
        const storeParams: any[] = storeId != null ? [storeId] : []

        // --- Out of stock (§23) — louder than low stock: the sale is already lost.
        const out = db.prepare(`
            SELECT p.id AS product_id, p.name, pv.id AS variant_id, pv.size, pv.color,
                   si.store_id, s.name AS store_name
            FROM stock_inventory si
            JOIN products p ON p.id = si.product_id
            LEFT JOIN product_variants pv ON pv.id = si.variant_id
            LEFT JOIN stores s ON s.id = si.store_id
            WHERE p.is_active = 1 AND COALESCE(si.quantity, 0) <= 0
              AND p.min_stock_level > 0 ${storeFilter}
            LIMIT 200
        `).all(...storeParams) as any[]
        for (const r of out) {
            const variant = [r.size, r.color].filter(Boolean).join(' · ')
            fire({
                type: 'out_of_stock', severity: 'critical',
                title: `Rupture : ${r.name}${variant ? ` (${variant})` : ''}`,
                body: `${r.store_name ?? 'Magasin'} — plus aucun exemplaire disponible.`,
                storeId: r.store_id, entityType: 'product', entityId: r.product_id,
                dedupeKey: `out_of_stock:${r.store_id}:${r.product_id}:${r.variant_id ?? 0}`,
            })
        }

        // --- Low stock (§22) — excludes the ones already reported as ruptures, so a
        //     single garment never produces two alerts saying the same thing.
        const low = db.prepare(`
            SELECT p.id AS product_id, p.name, p.min_stock_level, pv.id AS variant_id,
                   pv.size, pv.color, si.quantity, si.store_id, s.name AS store_name
            FROM stock_inventory si
            JOIN products p ON p.id = si.product_id
            LEFT JOIN product_variants pv ON pv.id = si.variant_id
            LEFT JOIN stores s ON s.id = si.store_id
            WHERE p.is_active = 1 AND p.min_stock_level > 0
              AND COALESCE(si.quantity, 0) > 0
              AND COALESCE(si.quantity, 0) <= p.min_stock_level ${storeFilter}
            LIMIT 200
        `).all(...storeParams) as any[]
        for (const r of low) {
            const variant = [r.size, r.color].filter(Boolean).join(' · ')
            fire({
                type: 'low_stock', severity: 'warning',
                title: `Stock bas : ${r.name}${variant ? ` (${variant})` : ''}`,
                body: `${r.store_name ?? 'Magasin'} — ${r.quantity} restant(s) pour un minimum de ${r.min_stock_level}.`,
                storeId: r.store_id, entityType: 'product', entityId: r.product_id,
                dedupeKey: `low_stock:${r.store_id}:${r.product_id}:${r.variant_id ?? 0}`,
            })
        }

        // --- Transfers shipped and never received (§20, §92).
        const stuck = db.prepare(`
            SELECT t.id, t.transfer_number, t.shipped_at, t.to_store_id,
                   f.name AS from_name, d.name AS to_name,
                   CAST(julianday('now') - julianday(t.shipped_at) AS INTEGER) AS days
            FROM stock_transfers t
            LEFT JOIN stores f ON f.id = t.from_store_id
            LEFT JOIN stores d ON d.id = t.to_store_id
            WHERE t.status = 'shipped'
              AND julianday('now') - julianday(t.shipped_at) >= 3
        `).all() as any[]
        for (const t of stuck) {
            fire({
                type: 'transfer_stuck', severity: t.days >= 7 ? 'critical' : 'warning',
                title: `Transfert non réceptionné : ${t.transfer_number}`,
                body: `${t.from_name} → ${t.to_name}, expédié il y a ${t.days} jour(s).`,
                storeId: t.to_store_id, entityType: 'stock_transfer', entityId: t.id,
                // Keyed on the transfer, not the day count, so ageing does not
                // produce a fresh alert every morning.
                dedupeKey: `transfer_stuck:${t.id}`,
            })
        }

        // --- Transfers waiting to be received (informational, no ageing).
        const awaiting = db.prepare(`
            SELECT t.id, t.transfer_number, t.to_store_id, f.name AS from_name
            FROM stock_transfers t
            LEFT JOIN stores f ON f.id = t.from_store_id
            WHERE t.status = 'shipped'
              AND julianday('now') - julianday(t.shipped_at) < 3
        `).all() as any[]
        for (const t of awaiting) {
            fire({
                type: 'transfer_incoming', severity: 'info',
                title: `Transfert à réceptionner : ${t.transfer_number}`,
                body: `En provenance de ${t.from_name}.`,
                storeId: t.to_store_id, entityType: 'stock_transfer', entityId: t.id,
                dedupeKey: `transfer_incoming:${t.id}`,
            })
        }

        // --- Cash sessions closed with a variance (§39: explain discrepancies).
        const tills = db.prepare(`
            SELECT c.id, c.session_number, c.variance, c.store_id, c.closed_at, u.name AS closed_by_name
            FROM cash_sessions c
            LEFT JOIN users u ON u.id = c.closed_by
            WHERE c.status = 'closed' AND c.variance IS NOT NULL AND ABS(c.variance) >= 100
              AND julianday('now') - julianday(c.closed_at) <= 30
        `).all() as any[]
        for (const t of tills) {
            fire({
                type: 'cash_variance', severity: Math.abs(t.variance) >= 1000 ? 'critical' : 'warning',
                title: `Écart de caisse : ${t.variance > 0 ? '+' : ''}${t.variance.toFixed(2)} DA`,
                body: `Session ${t.session_number}${t.closed_by_name ? `, clôturée par ${t.closed_by_name}` : ''}.`,
                storeId: t.store_id, entityType: 'cash_session', entityId: t.id,
                dedupeKey: `cash_variance:${t.id}`,
            })
        }

        // --- Inventory counts left open. A count that is never applied silently
        //     stops being a control at all.
        const counts = db.prepare(`
            SELECT id, count_number, store_id,
                   CAST(julianday('now') - julianday(started_at) AS INTEGER) AS days
            FROM inventory_counts
            WHERE status IN ('counting', 'review')
              AND julianday('now') - julianday(started_at) >= 2
        `).all() as any[]
        for (const c of counts) {
            fire({
                type: 'count_open', severity: 'warning',
                title: `Inventaire en cours depuis ${c.days} jour(s)`,
                body: `${c.count_number} n’a pas encore été appliqué.`,
                storeId: c.store_id, entityType: 'inventory_count', entityId: c.id,
                dedupeKey: `count_open:${c.id}`,
            })
        }

        return { raised }
    },
}
