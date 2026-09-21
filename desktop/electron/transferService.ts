import { getDatabase } from './database'
import { nextDocNumber } from './sequences'
import { InventoryService } from './inventoryService'
import { PermissionService } from './permissionService'
import { AuditService } from './auditService'

// ---------------------------------------------------------------------------
// Stock transfers between stores (brief §20, RETAIL_PLAN.md §7).
//
// TWO PHASES, NOT ONE. Goods physically travel, so there is a window in which
// stock has left Costume and has not yet arrived at Casual. Modelling a transfer
// as an instantaneous move would make that window invisible: either the stock
// exists in both shops at once, or in neither. So the source decrements on SHIP
// and the destination increments on RECEIVE, and the gap is reported as
// IN TRANSIT — which is also the only way the "shipped but never received" case
// in §92 can ever be noticed.
//
// THREE QUANTITIES PER LINE, NOT ONE: what was asked for, what actually left,
// and what actually arrived. They differ in real life — a box is short, an item
// is damaged in the van — and a single column would hide exactly the discrepancy
// the owner needs to see.
//
// IDEMPOTENCY IS BY STATE, NOT BY FLAG. Every transition asserts the current
// status first, so a double-clicked "Recevoir" or a retried sync cannot receive
// the same goods twice. That is the §92 edge case, and a boolean `received`
// column would have been one forgotten check away from failing it.
//
// The source decrement goes through InventoryService, so shipping is subject to
// the same oversell guard as a sale: a shop cannot send stock it does not have.
// ---------------------------------------------------------------------------

export type TransferStatus =
    | 'draft' | 'requested' | 'approved' | 'prepared' | 'shipped' | 'received' | 'cancelled'

/** Transitions the service will perform, keyed by the state they must start from.
 *  Declared as data so the rules are readable in one place rather than scattered
 *  across five methods. */
const ALLOWED_FROM: Record<Exclude<TransferStatus, 'draft'>, TransferStatus[]> = {
    requested: ['draft'],
    approved: ['draft', 'requested'],
    prepared: ['approved', 'requested', 'draft'],
    shipped: ['prepared', 'approved', 'requested', 'draft'],
    received: ['shipped'],
    // Only before the goods leave. Once they are in the van, the honest options are
    // to receive them (possibly short) or to send them back as a new transfer —
    // "cancelling" would silently strand stock that has already left the source.
    cancelled: ['draft', 'requested', 'approved', 'prepared'],
}

const STATUS_LABEL: Record<TransferStatus, string> = {
    draft: 'Brouillon', requested: 'Demandé', approved: 'Approuvé', prepared: 'Préparé',
    shipped: 'Expédié', received: 'Reçu', cancelled: 'Annulé',
}

export interface TransferLineInput {
    productId: number
    variantId: number | null
    productName: string
    size?: string | null
    color?: string | null
    sku?: string | null
    quantity: number
}

export interface CreateTransferInput {
    fromStoreId: number
    toStoreId: number
    userId: number
    lines: TransferLineInput[]
    notes?: string | null
}

/** Per line: how many actually left / arrived. Omitted lines default to the
 *  quantity from the previous phase. */
export type QuantityMap = Record<number, number>

export class TransferError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
        super(message)
        this.name = 'TransferError'
        this.code = code
    }
}

function loadTransfer(id: number) {
    const row = getDatabase().prepare('SELECT * FROM stock_transfers WHERE id = ?').get(id) as any
    if (!row) throw new TransferError('TRANSFER_NOT_FOUND', 'Transfert introuvable')
    return row
}

/** Assert the transfer is in a state this transition may start from. */
function assertTransition(transfer: any, to: Exclude<TransferStatus, 'draft'>) {
    const from = ALLOWED_FROM[to]
    if (!from.includes(transfer.status)) {
        throw new TransferError(
            'INVALID_TRANSITION',
            `Transfert ${transfer.transfer_number} : impossible de passer de ` +
            `« ${STATUS_LABEL[transfer.status as TransferStatus] ?? transfer.status} » à ` +
            `« ${STATUS_LABEL[to]} »`,
        )
    }
}

export const TransferService = {
    STATUS_LABEL,

    create(input: CreateTransferInput) {
        PermissionService.assertCan(input.userId, 'inventory.transfer')
        if (input.fromStoreId === input.toStoreId) {
            throw new TransferError('SAME_STORE', 'Les magasins d’origine et de destination doivent différer')
        }
        if (!input.lines.length) {
            throw new TransferError('EMPTY_TRANSFER', 'Le transfert ne contient aucun article')
        }
        for (const l of input.lines) {
            if (l.quantity <= 0) throw new TransferError('INVALID_QUANTITY', 'Quantité invalide')
        }

        const db = getDatabase()
        return db.transaction(() => {
            const number = nextDocNumber('transfer', 'TRF')
            const res = db.prepare(`
                INSERT INTO stock_transfers
                    (transfer_number, from_store_id, to_store_id, status, requested_by, requested_at, notes)
                VALUES (?, ?, ?, 'draft', ?, datetime('now'), ?)
            `).run(number, input.fromStoreId, input.toStoreId, input.userId, input.notes ?? null)
            const id = Number(res.lastInsertRowid)

            const ins = db.prepare(`
                INSERT INTO stock_transfer_items
                    (transfer_id, product_id, variant_id, product_name, size, color, sku,
                     quantity_requested, unit_cost)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            for (const l of input.lines) {
                // Cost is snapshotted at creation so the value in transit does not move
                // if the purchase price changes while the goods are on the road.
                const cost = (db.prepare(
                    'SELECT COALESCE(pv.cost_price, p.cost_price, 0) AS c FROM products p ' +
                    'LEFT JOIN product_variants pv ON pv.id = ? WHERE p.id = ?'
                ).get(l.variantId, l.productId) as any)?.c ?? 0
                ins.run(id, l.productId, l.variantId, l.productName,
                    l.size ?? null, l.color ?? null, l.sku ?? null, l.quantity, cost)
            }

            AuditService.log({
                userId: input.userId, action: 'transfer.create', entityType: 'stock_transfer',
                entityId: id, storeId: input.fromStoreId,
                summary: `${number} — ${input.lines.length} ligne(s) vers le magasin ${input.toStoreId}`,
                newValue: { lines: input.lines },
            })

            return { id, transferNumber: number }
        })()
    },

    approve(transferId: number, userId: number) {
        PermissionService.assertCan(userId, 'inventory.transfer_approve')
        const t = loadTransfer(transferId)
        assertTransition(t, 'approved')
        getDatabase().prepare(`
            UPDATE stock_transfers SET status = 'approved', approved_by = ?,
                   approved_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?
        `).run(userId, transferId)
        AuditService.log({
            userId, action: 'transfer.approve', entityType: 'stock_transfer', entityId: transferId,
            storeId: t.from_store_id, severity: 'warning', summary: t.transfer_number,
        })
        return { ok: true }
    },

    /**
     * Goods leave the source. This is where source stock actually moves, guarded
     * against sending what the shop does not have.
     *
     * `shipped` may be short of `requested` — a box is never as full as the paperwork
     * says — and a line shipped as 0 is simply not sent.
     */
    ship(transferId: number, userId: number, quantities: QuantityMap = {}) {
        PermissionService.assertCan(userId, 'inventory.transfer')
        const db = getDatabase()
        const t = loadTransfer(transferId)
        assertTransition(t, 'shipped')

        const items = db.prepare('SELECT * FROM stock_transfer_items WHERE transfer_id = ?')
            .all(transferId) as any[]

        return db.transaction(() => {
            let anyShipped = false
            for (const item of items) {
                const qty = quantities[item.id] ?? item.quantity_requested
                if (qty < 0) throw new TransferError('INVALID_QUANTITY', 'Quantité expédiée négative')
                if (qty > item.quantity_requested) {
                    throw new TransferError(
                        'EXCEEDS_REQUESTED',
                        `${item.product_name} : ${qty} expédié pour ${item.quantity_requested} demandé`,
                    )
                }
                db.prepare('UPDATE stock_transfer_items SET quantity_shipped = ? WHERE id = ?')
                    .run(qty, item.id)
                if (qty > 0) {
                    anyShipped = true
                    InventoryService.consume(item.product_id, item.variant_id, qty, {
                        storeId: t.from_store_id, userId,
                        reason: `Transfert ${t.transfer_number}`,
                        referenceType: 'stock_transfer', referenceId: transferId,
                    }, 'transfer_out')
                }
            }
            if (!anyShipped) {
                throw new TransferError('NOTHING_SHIPPED', 'Aucun article à expédier')
            }

            db.prepare(`
                UPDATE stock_transfers SET status = 'shipped', shipped_by = ?,
                       shipped_at = datetime('now'), updated_at = datetime('now')
                 WHERE id = ?
            `).run(userId, transferId)

            AuditService.log({
                userId, action: 'transfer.ship', entityType: 'stock_transfer', entityId: transferId,
                storeId: t.from_store_id, severity: 'warning',
                summary: `${t.transfer_number} expédié`,
                newValue: { quantities },
            })
            return { ok: true }
        })()
    },

    /**
     * Goods arrive at the destination. Only ever from `shipped`, which is what makes
     * a second click a no-op error rather than a second helping of stock.
     *
     * A short receipt is recorded, not corrected: the difference between shipped and
     * received is a real discrepancy the owner must be able to see and investigate,
     * so it is left visible on the line rather than quietly reconciled.
     */
    receive(transferId: number, userId: number, quantities: QuantityMap = {}) {
        PermissionService.assertCan(userId, 'inventory.transfer')
        const db = getDatabase()
        const t = loadTransfer(transferId)
        assertTransition(t, 'received')

        const items = db.prepare('SELECT * FROM stock_transfer_items WHERE transfer_id = ?')
            .all(transferId) as any[]

        return db.transaction(() => {
            let discrepancy = 0
            for (const item of items) {
                const qty = quantities[item.id] ?? item.quantity_shipped
                if (qty < 0) throw new TransferError('INVALID_QUANTITY', 'Quantité reçue négative')
                if (qty > item.quantity_shipped) {
                    throw new TransferError(
                        'EXCEEDS_SHIPPED',
                        `${item.product_name} : ${qty} reçu pour ${item.quantity_shipped} expédié`,
                    )
                }
                db.prepare('UPDATE stock_transfer_items SET quantity_received = ? WHERE id = ?')
                    .run(qty, item.id)
                discrepancy += item.quantity_shipped - qty

                if (qty > 0) {
                    InventoryService.receive(item.product_id, item.variant_id, qty, {
                        storeId: t.to_store_id, userId,
                        reason: `Transfert ${t.transfer_number}`,
                        referenceType: 'stock_transfer', referenceId: transferId,
                    }, 'transfer_in')
                }
            }

            db.prepare(`
                UPDATE stock_transfers SET status = 'received', received_by = ?,
                       received_at = datetime('now'), updated_at = datetime('now')
                 WHERE id = ?
            `).run(userId, transferId)

            AuditService.log({
                userId, action: 'transfer.receive', entityType: 'stock_transfer', entityId: transferId,
                storeId: t.to_store_id,
                // A short receipt is worth flagging louder than a clean one.
                severity: discrepancy > 0 ? 'critical' : 'warning',
                summary: discrepancy > 0
                    ? `${t.transfer_number} reçu avec un écart de ${discrepancy} article(s)`
                    : `${t.transfer_number} reçu`,
                newValue: { quantities, discrepancy },
            })
            return { ok: true, discrepancy }
        })()
    },

    cancel(transferId: number, userId: number, reason?: string) {
        PermissionService.assertCan(userId, 'inventory.transfer')
        const t = loadTransfer(transferId)
        assertTransition(t, 'cancelled')
        getDatabase().prepare(`
            UPDATE stock_transfers SET status = 'cancelled', cancelled_at = datetime('now'),
                   updated_at = datetime('now'), notes = COALESCE(notes || ' | ', '') || ?
             WHERE id = ?
        `).run(`Annulé: ${reason ?? 'sans motif'}`, transferId)
        AuditService.log({
            userId, action: 'transfer.cancel', entityType: 'stock_transfer', entityId: transferId,
            storeId: t.from_store_id, severity: 'warning',
            summary: `${t.transfer_number} annulé — ${reason ?? 'sans motif'}`,
        })
        return { ok: true }
    },

    // --- Reads --------------------------------------------------------------

    list(filters: { storeId?: number; status?: TransferStatus; limit?: number } = {}) {
        const where: string[] = []
        const params: any[] = []
        if (filters.storeId != null) {
            // A store cares about what it is sending AND what is coming to it.
            where.push('(t.from_store_id = ? OR t.to_store_id = ?)')
            params.push(filters.storeId, filters.storeId)
        }
        if (filters.status) { where.push('t.status = ?'); params.push(filters.status) }
        params.push(filters.limit ?? 100)

        return getDatabase().prepare(`
            SELECT t.*,
                   f.name AS from_store_name, d.name AS to_store_name,
                   ru.name AS requested_by_name, su.name AS shipped_by_name, cu.name AS received_by_name,
                   (SELECT COUNT(*) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS line_count,
                   (SELECT COALESCE(SUM(i.quantity_requested), 0) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS total_requested,
                   (SELECT COALESCE(SUM(i.quantity_shipped), 0) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS total_shipped,
                   (SELECT COALESCE(SUM(i.quantity_received), 0) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS total_received
            FROM stock_transfers t
            LEFT JOIN stores f ON f.id = t.from_store_id
            LEFT JOIN stores d ON d.id = t.to_store_id
            LEFT JOIN users ru ON ru.id = t.requested_by
            LEFT JOIN users su ON su.id = t.shipped_by
            LEFT JOIN users cu ON cu.id = t.received_by
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY t.created_at DESC, t.id DESC
            LIMIT ?
        `).all(...params)
    },

    getById(transferId: number) {
        const db = getDatabase()
        const header = db.prepare(`
            SELECT t.*, f.name AS from_store_name, d.name AS to_store_name,
                   ru.name AS requested_by_name, su.name AS shipped_by_name, cu.name AS received_by_name
            FROM stock_transfers t
            LEFT JOIN stores f ON f.id = t.from_store_id
            LEFT JOIN stores d ON d.id = t.to_store_id
            LEFT JOIN users ru ON ru.id = t.requested_by
            LEFT JOIN users su ON su.id = t.shipped_by
            LEFT JOIN users cu ON cu.id = t.received_by
            WHERE t.id = ?
        `).get(transferId)
        if (!header) return null

        // The source's CURRENT stock is joined in so the person packing the box can
        // see, line by line, whether the shop can actually supply what was asked for
        // — before the ship button refuses the whole transfer.
        const items = db.prepare(`
            SELECT i.*,
                   COALESCE(si.quantity, 0) AS source_stock
            FROM stock_transfer_items i
            LEFT JOIN stock_transfers t ON t.id = i.transfer_id
            LEFT JOIN stock_inventory si
              ON si.store_id = t.from_store_id AND si.product_id = i.product_id
             AND COALESCE(si.variant_id, 0) = COALESCE(i.variant_id, 0)
            WHERE i.transfer_id = ?
            ORDER BY i.id
        `).all(transferId)
        return { ...(header as object), items }
    },

    /**
     * Goods that have left but not arrived, oldest first (§92: "a transfer is
     * shipped but never received"). Without this the stock simply disappears from
     * both shops' figures and nobody is prompted to ask why.
     */
    listInTransit(storeId?: number) {
        const params: any[] = []
        let filter = ''
        if (storeId != null) {
            filter = 'AND (t.from_store_id = ? OR t.to_store_id = ?)'
            params.push(storeId, storeId)
        }
        return getDatabase().prepare(`
            SELECT t.id, t.transfer_number, t.shipped_at,
                   f.name AS from_store_name, d.name AS to_store_name,
                   CAST(julianday('now') - julianday(t.shipped_at) AS INTEGER) AS days_in_transit,
                   COALESCE(SUM(i.quantity_shipped - i.quantity_received), 0) AS quantity,
                   COALESCE(SUM((i.quantity_shipped - i.quantity_received) * i.unit_cost), 0) AS value
            FROM stock_transfers t
            JOIN stock_transfer_items i ON i.transfer_id = t.id
            LEFT JOIN stores f ON f.id = t.from_store_id
            LEFT JOIN stores d ON d.id = t.to_store_id
            WHERE t.status = 'shipped' ${filter}
            GROUP BY t.id
            ORDER BY t.shipped_at ASC
        `).all(...params)
    },
}
