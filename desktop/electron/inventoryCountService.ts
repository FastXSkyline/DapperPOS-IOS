import { getDatabase } from './database'
import { nextDocNumber } from './sequences'
import { InventoryService } from './inventoryService'
import { PermissionService } from './permissionService'
import { AuditService } from './auditService'

// ---------------------------------------------------------------------------
// Inventaire / stock counts (brief §21).
//
// THE TIMING PROBLEM THIS IS BUILT AROUND. A count takes hours and the shop keeps
// selling while it happens. So:
//
//   • `expected_qty` is snapshotted PER LINE, at the moment that line is counted —
//     not once at session start. Snapshotting the whole session up front would make
//     every garment sold during the count look like a shrinkage.
//
//   • Applying writes a DELTA, never an absolute. The finding is "13 fewer than the
//     system believed when I counted this rail", and that discrepancy is still true
//     an hour later even though four more have since been sold. Setting stock to the
//     counted figure would erase those four sales.
//
// Nothing touches live stock until APPLY, which needs `inventory.adjust` — a higher
// bar than `inventory.count`, because counting is clerical and applying moves money.
//
// Apply goes through InventoryService.setAbsolute rather than consume/receive: an
// adjustment is precisely the operation allowed to correct stock to any value,
// including revealing that it is negative. Routing it through the oversell guard
// would refuse the very findings a count exists to surface.
// ---------------------------------------------------------------------------

export type CountStatus = 'draft' | 'counting' | 'review' | 'applied' | 'cancelled'
export type CountScope = 'full' | 'category' | 'selection'

export interface StartCountInput {
    storeId: number
    userId: number
    scope: CountScope
    categoryId?: number | null
    /** For scope 'selection': the variants to count. */
    variantIds?: number[]
    notes?: string | null
}

export class CountError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
        super(message)
        this.name = 'CountError'
        this.code = code
    }
}

function loadCount(id: number) {
    const row = getDatabase().prepare('SELECT * FROM inventory_counts WHERE id = ?').get(id) as any
    if (!row) throw new CountError('COUNT_NOT_FOUND', 'Inventaire introuvable')
    return row
}

export const InventoryCountService = {
    /**
     * Open a count and materialise its line list.
     *
     * Lines are created for every ACTIVE variant in scope, including those with no
     * stock row at all: a count exists partly to find goods the system does not know
     * about, and starting from `stock_inventory` alone would make those invisible.
     * `expected_qty` is left at 0 here and filled in when the line is actually
     * counted — see the header.
     */
    start(input: StartCountInput) {
        PermissionService.assertCan(input.userId, 'inventory.count')
        const db = getDatabase()

        const open = db.prepare(
            "SELECT count_number FROM inventory_counts WHERE store_id = ? AND status IN ('draft','counting','review')"
        ).get(input.storeId) as any
        if (open) {
            // Two open counts on one store would each snapshot the other's
            // adjustments and double-correct on apply.
            throw new CountError('COUNT_ALREADY_OPEN',
                `Un inventaire est déjà en cours pour ce magasin (${open.count_number})`)
        }

        return db.transaction(() => {
            const number = nextDocNumber('count', 'CNT')
            const res = db.prepare(`
                INSERT INTO inventory_counts (count_number, store_id, scope, category_id, status, started_by, notes)
                VALUES (?, ?, ?, ?, 'counting', ?, ?)
            `).run(number, input.storeId, input.scope, input.categoryId ?? null, input.userId, input.notes ?? null)
            const countId = Number(res.lastInsertRowid)

            const where: string[] = ['p.is_active = 1', 'pv.is_active = 1']
            const params: any[] = []
            if (input.scope === 'category') {
                if (!input.categoryId) throw new CountError('NO_CATEGORY', 'Aucune catégorie choisie')
                where.push('p.category_id = ?')
                params.push(input.categoryId)
            }
            if (input.scope === 'selection') {
                if (!input.variantIds?.length) throw new CountError('NO_SELECTION', 'Aucun article sélectionné')
                where.push(`pv.id IN (${input.variantIds.map(() => '?').join(',')})`)
                params.push(...input.variantIds)
            }

            const rows = db.prepare(`
                SELECT pv.id AS variant_id, pv.product_id, p.name AS product_name,
                       pv.size, pv.color, pv.sku,
                       COALESCE(pv.cost_price, p.cost_price, 0) AS unit_cost
                FROM product_variants pv
                JOIN products p ON p.id = pv.product_id
                WHERE ${where.join(' AND ')}
                ORDER BY p.name, pv.sort_order, pv.size, pv.color
            `).all(...params) as any[]

            if (!rows.length) throw new CountError('NOTHING_TO_COUNT', 'Aucun article à inventorier')

            const ins = db.prepare(`
                INSERT INTO inventory_count_items
                    (count_id, product_id, variant_id, product_name, size, color, sku, unit_cost)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `)
            for (const r of rows) {
                ins.run(countId, r.product_id, r.variant_id, r.product_name,
                    r.size, r.color, r.sku, r.unit_cost)
            }

            AuditService.log({
                userId: input.userId, action: 'inventory.count_start',
                entityType: 'inventory_count', entityId: countId, storeId: input.storeId,
                summary: `${number} — ${rows.length} référence(s), portée ${input.scope}`,
            })

            return { id: countId, countNumber: number, lineCount: rows.length }
        })()
    },

    /**
     * Record a physical count for one line.
     *
     * The expected figure is read HERE, not at session start, so the difference is
     * measured against what the system believed at the moment of counting.
     */
    countLine(itemId: number, countedQty: number, userId: number) {
        PermissionService.assertCan(userId, 'inventory.count')
        if (countedQty < 0) throw new CountError('INVALID_QUANTITY', 'Quantité comptée négative')

        const db = getDatabase()
        const item = db.prepare(`
            SELECT i.*, c.store_id, c.status
            FROM inventory_count_items i
            JOIN inventory_counts c ON c.id = i.count_id
            WHERE i.id = ?
        `).get(itemId) as any
        if (!item) throw new CountError('ITEM_NOT_FOUND', 'Ligne introuvable')
        if (item.status !== 'counting' && item.status !== 'review') {
            throw new CountError('COUNT_CLOSED', 'Cet inventaire n’est plus modifiable')
        }

        const expected = InventoryService.getStock(item.store_id, item.product_id, item.variant_id)
        db.prepare(`
            UPDATE inventory_count_items
               SET expected_qty = ?, counted_qty = ?, difference = ?,
                   counted_by = ?, counted_at = datetime('now')
             WHERE id = ?
        `).run(expected, countedQty, countedQty - expected, userId, itemId)

        return { expected, counted: countedQty, difference: countedQty - expected }
    },

    /** Clear a line back to uncounted — a mis-keyed figure should not have to be
     *  "corrected" to a number the counter never actually saw. */
    clearLine(itemId: number, userId: number) {
        PermissionService.assertCan(userId, 'inventory.count')
        getDatabase().prepare(`
            UPDATE inventory_count_items
               SET counted_qty = NULL, difference = NULL, counted_by = NULL, counted_at = NULL
             WHERE id = ?
        `).run(itemId)
        return { ok: true }
    },

    /** Move to review — the point where the differences are looked at before anything moves. */
    review(countId: number, userId: number) {
        PermissionService.assertCan(userId, 'inventory.count')
        const c = loadCount(countId)
        if (c.status !== 'counting') {
            throw new CountError('INVALID_TRANSITION', 'Seul un inventaire en cours peut passer en revue')
        }
        getDatabase().prepare("UPDATE inventory_counts SET status = 'review' WHERE id = ?").run(countId)
        return { ok: true }
    },

    /**
     * Apply the findings to live stock.
     *
     * UNCOUNTED LINES ARE IGNORED, never treated as zero. A count that was abandoned
     * half way through would otherwise wipe the stock of everything nobody reached —
     * the single most destructive thing this module could do.
     */
    apply(countId: number, userId: number) {
        // A higher bar than counting: this one moves stock and therefore money.
        PermissionService.assertCan(userId, 'inventory.adjust')
        const db = getDatabase()
        const c = loadCount(countId)
        if (c.status !== 'counting' && c.status !== 'review') {
            throw new CountError('INVALID_TRANSITION',
                `Inventaire ${c.count_number} : déjà ${c.status === 'applied' ? 'appliqué' : c.status}`)
        }

        const lines = db.prepare(
            'SELECT * FROM inventory_count_items WHERE count_id = ? AND counted_qty IS NOT NULL'
        ).all(countId) as any[]
        if (!lines.length) throw new CountError('NOTHING_COUNTED', 'Aucune ligne comptée')

        return db.transaction(() => {
            let adjusted = 0
            let netUnits = 0
            let netValue = 0

            for (const line of lines) {
                const delta = line.counted_qty - line.expected_qty
                if (delta === 0) continue

                // Delta, not absolute: sales made since this line was counted must
                // survive the adjustment.
                const current = InventoryService.getStock(c.store_id, line.product_id, line.variant_id)
                InventoryService.setAbsolute(
                    line.product_id, line.variant_id, current + delta,
                    {
                        storeId: c.store_id, userId,
                        reason: `Inventaire ${c.count_number}`,
                        referenceType: 'inventory_count', referenceId: countId,
                    },
                    'inventory_count',
                )
                adjusted++
                netUnits += delta
                netValue += delta * (line.unit_cost ?? 0)
            }

            db.prepare(`
                UPDATE inventory_counts SET status = 'applied', applied_by = ?, applied_at = datetime('now')
                 WHERE id = ?
            `).run(userId, countId)

            AuditService.log({
                userId, action: 'inventory.count_apply',
                entityType: 'inventory_count', entityId: countId, storeId: c.store_id,
                // Any real discrepancy is worth the loudest level: it means goods
                // left the shop without a sale.
                severity: netUnits !== 0 ? 'critical' : 'warning',
                summary: `${c.count_number} appliqué — ${adjusted} ajustement(s), ` +
                         `écart net ${netUnits} article(s) / ${netValue.toFixed(2)} DA`,
                newValue: { adjusted, netUnits, netValue, linesCounted: lines.length },
            })

            return { adjusted, netUnits, netValue, linesCounted: lines.length }
        })()
    },

    cancel(countId: number, userId: number, reason?: string) {
        PermissionService.assertCan(userId, 'inventory.count')
        const c = loadCount(countId)
        if (c.status === 'applied') {
            // Stock has already moved; "cancelling" would only hide the record of it.
            throw new CountError('ALREADY_APPLIED', 'Un inventaire appliqué ne peut pas être annulé')
        }
        getDatabase().prepare("UPDATE inventory_counts SET status = 'cancelled' WHERE id = ?").run(countId)
        AuditService.log({
            userId, action: 'inventory.count_cancel', entityType: 'inventory_count',
            entityId: countId, storeId: c.store_id, severity: 'warning',
            summary: `${c.count_number} annulé — ${reason ?? 'sans motif'}`,
        })
        return { ok: true }
    },

    // --- Reads --------------------------------------------------------------

    list(storeId?: number, limit = 50) {
        const where = storeId != null ? 'WHERE c.store_id = ?' : ''
        const params: any[] = storeId != null ? [storeId] : []
        return getDatabase().prepare(`
            SELECT c.*, s.name AS store_name,
                   su.name AS started_by_name, au.name AS applied_by_name,
                   cat.name AS category_name,
                   (SELECT COUNT(*) FROM inventory_count_items i WHERE i.count_id = c.id) AS line_count,
                   (SELECT COUNT(*) FROM inventory_count_items i WHERE i.count_id = c.id AND i.counted_qty IS NOT NULL) AS counted_lines,
                   (SELECT COALESCE(SUM(i.difference), 0) FROM inventory_count_items i WHERE i.count_id = c.id) AS net_difference,
                   (SELECT COALESCE(SUM(i.difference * i.unit_cost), 0) FROM inventory_count_items i WHERE i.count_id = c.id) AS net_value
            FROM inventory_counts c
            LEFT JOIN stores s ON s.id = c.store_id
            LEFT JOIN users su ON su.id = c.started_by
            LEFT JOIN users au ON au.id = c.applied_by
            LEFT JOIN categories cat ON cat.id = c.category_id
            ${where}
            ORDER BY c.started_at DESC, c.id DESC
            LIMIT ?
        `).all(...params, limit)
    },

    /** The open count for a store, if any — what the count screen resumes into. */
    getOpen(storeId: number) {
        const row = getDatabase().prepare(
            "SELECT id FROM inventory_counts WHERE store_id = ? AND status IN ('counting','review') LIMIT 1"
        ).get(storeId) as { id: number } | undefined
        return row ? this.getById(row.id) : null
    },

    getById(countId: number, filter: 'all' | 'uncounted' | 'differences' = 'all') {
        const db = getDatabase()
        const header = db.prepare(`
            SELECT c.*, s.name AS store_name, su.name AS started_by_name,
                   au.name AS applied_by_name, cat.name AS category_name
            FROM inventory_counts c
            LEFT JOIN stores s ON s.id = c.store_id
            LEFT JOIN users su ON su.id = c.started_by
            LEFT JOIN users au ON au.id = c.applied_by
            LEFT JOIN categories cat ON cat.id = c.category_id
            WHERE c.id = ?
        `).get(countId) as any
        if (!header) return null

        const clauses: Record<typeof filter, string> = {
            all: '',
            uncounted: 'AND i.counted_qty IS NULL',
            differences: 'AND i.counted_qty IS NOT NULL AND i.difference != 0',
        }

        const items = db.prepare(`
            SELECT i.*,
                   COALESCE(si.quantity, 0) AS current_stock
            FROM inventory_count_items i
            LEFT JOIN stock_inventory si
              ON si.store_id = ? AND si.product_id = i.product_id
             AND COALESCE(si.variant_id, 0) = COALESCE(i.variant_id, 0)
            WHERE i.count_id = ? ${clauses[filter]}
            ORDER BY i.product_name, i.size, i.color
        `).all(header.store_id, countId)

        const totals = db.prepare(`
            SELECT COUNT(*) AS lines,
                   COALESCE(SUM(CASE WHEN counted_qty IS NOT NULL THEN 1 ELSE 0 END), 0) AS counted,
                   COALESCE(SUM(CASE WHEN counted_qty IS NOT NULL AND difference != 0 THEN 1 ELSE 0 END), 0) AS with_difference,
                   COALESCE(SUM(expected_qty), 0) AS expected_total,
                   COALESCE(SUM(COALESCE(counted_qty, 0)), 0) AS counted_total,
                   COALESCE(SUM(COALESCE(difference, 0)), 0) AS net_difference,
                   COALESCE(SUM(COALESCE(difference, 0) * unit_cost), 0) AS net_value
            FROM inventory_count_items WHERE count_id = ?
        `).get(countId)

        return { ...(header as object), items, totals }
    },
}
