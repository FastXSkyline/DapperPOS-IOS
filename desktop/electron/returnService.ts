import { getDatabase } from './database'
import { nextDocNumber } from './sequences'
import { InventoryService } from './inventoryService'
import { PermissionService } from './permissionService'
import { AuditService } from './auditService'
import { TransactionService } from './transactionService'

// ---------------------------------------------------------------------------
// Returns, refunds and exchanges (brief §16, §17).
//
// THE RULE EVERYTHING ELSE FOLLOWS FROM: a return is never a deletion or an edit
// of the original sale. It is a new document that points at it. That is the brief's
// anti-fraud requirement (§60), and independently it is Algerian law — a facture
// d'avoir is the only lawful way to reverse an issued invoice, and an issued
// invoice must never be silently altered (docs/ALGERIA_REQUIREMENTS.md).
//
// PRICE COMES FROM THE ORIGINAL LINE, ALWAYS. A shirt bought at 4 500 DA and
// returned after the price rose to 5 200 refunds 4 500. Reading today's price would
// hand the customer a profit for waiting, and would silently change historical
// margins. §92 lists this as an edge case; here it is simply the only price the
// code can see, because the refund amount is copied from transaction_items.
//
// AN EXCHANGE IS A RETURN PLUS A SALE. The replacement sale is created through the
// ordinary TransactionService path — same pricing rules, same per-line TVA, same
// stock guard, same gapless numbering — and then linked here. Re-implementing a
// sale inside this module would produce a second, subtly different sale path, and
// the two would drift.
//
// STORE: goods return to the store that PHYSICALLY receives them, which may not be
// the store that sold them (§92). Revenue stays attributed to the original sale's
// store; the stock movement lands where the garment actually is.
// ---------------------------------------------------------------------------

export interface ReturnLineInput {
    /** transaction_items.id of the line being returned. */
    originalItemId: number
    quantity: number
    /** Damaged goods come back into the shop but not into sellable stock. */
    condition?: 'resellable' | 'damaged'
    reason?: string | null
}

export interface CreateReturnInput {
    originalTransactionId: number
    /** Store physically receiving the goods. Defaults to the original sale's store. */
    storeId?: number
    terminalId?: number | null
    userId: number
    lines: ReturnLineInput[]
    refundMethod?: string | null
    reason?: string | null
    notes?: string | null
}

export interface CreateExchangeInput extends CreateReturnInput {
    /** A COMPLETED replacement sale, created through the normal sale path. */
    replacementTransactionId: number
}

/** One line of the replacement cart. Priced by the caller (the till already
 *  resolved promotions and negotiated prices through PricingService). */
export interface ReplacementLine {
    productId: number
    variantId: number | null
    productName: string
    quantity: number
    unitPrice: number
    sku?: string | null
}

export interface ExchangeWithNewSaleInput extends CreateReturnInput {
    replacement: ReplacementLine[]
    /** How the customer settles a shortfall when the new goods cost more. */
    topUpMethod?: string
}

export class ReturnError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
        super(message)
        this.name = 'ReturnError'
        this.code = code
    }
}

interface OriginalLine {
    id: number
    transaction_id: number
    product_id: number
    variant_id: number | null
    product_name: string
    quantity: number
    unit_price: number
    returned_quantity: number
    tax_rate: number | null
    size?: string | null
    color?: string | null
}

/** Load and validate the lines being returned, resolving each to its original price. */
function resolveLines(originalTransactionId: number, lines: ReturnLineInput[]) {
    const db = getDatabase()
    if (!lines.length) throw new ReturnError('EMPTY_RETURN', 'Aucun article à retourner')

    const resolved: { input: ReturnLineInput; original: OriginalLine }[] = []
    for (const line of lines) {
        if (line.quantity <= 0) {
            throw new ReturnError('INVALID_QUANTITY', 'La quantité retournée doit être positive')
        }
        const original = db.prepare(`
            SELECT ti.*, pv.size, pv.color
            FROM transaction_items ti
            LEFT JOIN product_variants pv ON pv.id = ti.variant_id
            WHERE ti.id = ?
        `).get(line.originalItemId) as OriginalLine | undefined

        if (!original) {
            throw new ReturnError('ITEM_NOT_FOUND', `Ligne ${line.originalItemId} introuvable`)
        }
        if (original.transaction_id !== originalTransactionId) {
            // Guards against a crafted request refunding a line from someone else's sale.
            throw new ReturnError('ITEM_MISMATCH', 'Cette ligne n’appartient pas à la vente indiquée')
        }

        const alreadyReturned = original.returned_quantity ?? 0
        const remaining = original.quantity - alreadyReturned
        if (line.quantity > remaining + 1e-9) {
            throw new ReturnError(
                'EXCEEDS_SOLD_QUANTITY',
                `${original.product_name}: ${line.quantity} demandé, ${remaining} retournable ` +
                `(${original.quantity} vendu, ${alreadyReturned} déjà retourné)`,
            )
        }
        resolved.push({ input: line, original })
    }
    return resolved
}

function performReturn(input: CreateReturnInput & { kind: 'refund' | 'exchange'; replacementTransactionId: number | null }) {
    const db = getDatabase()

    const original = db.prepare('SELECT * FROM transactions WHERE id = ?')
        .get(input.originalTransactionId) as any
    if (!original) throw new ReturnError('SALE_NOT_FOUND', 'Vente d’origine introuvable')
    if (original.status !== 'completed') {
        throw new ReturnError('SALE_NOT_COMPLETED', 'Seule une vente finalisée peut être retournée')
    }

    const resolved = resolveLines(input.originalTransactionId, input.lines)
    // Goods land where they are handed over, which is not always where they were sold.
    const storeId = input.storeId ?? original.store_id ?? 1

    // One transaction around the whole thing: the refund document, the stock that
    // comes back, the returned-quantity counters and the sale's return status
    // either all happen or none do. A partially applied return would either refund
    // goods that never re-entered stock, or let the same garment be returned twice.
    const result = db.transaction(() => {
        const returnNumber = nextDocNumber('return', 'RET')

        let returnedValue = 0
        for (const { input: line, original: o } of resolved) {
            returnedValue += line.quantity * o.unit_price
        }
        const replacementValue = input.replacementTransactionId
            ? (db.prepare('SELECT total_amount FROM transactions WHERE id = ?')
                .get(input.replacementTransactionId) as any).total_amount ?? 0
            : 0
        const balance = returnedValue - replacementValue

        const res = db.prepare(`
            INSERT INTO sale_returns
                (return_number, kind, original_transaction_id, exchange_transaction_id,
                 store_id, terminal_id, user_id, customer_id,
                 returned_value, replacement_value, balance,
                 refund_method, reason, notes, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')
        `).run(
            returnNumber, input.kind, input.originalTransactionId,
            input.replacementTransactionId, storeId, input.terminalId ?? null,
            input.userId, original.customer_id ?? null,
            returnedValue, replacementValue, balance,
            input.refundMethod ?? null, input.reason ?? null, input.notes ?? null,
        )
        const returnId = Number(res.lastInsertRowid)

        const insItem = db.prepare(`
            INSERT INTO sale_return_items
                (return_id, original_item_id, product_id, variant_id, product_name,
                 size, color, quantity, unit_price, line_total, tax_rate, tax_amount,
                 restock, item_condition, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        for (const { input: line, original: o } of resolved) {
            const condition = line.condition ?? 'resellable'
            const restock = condition === 'resellable'
            const lineTotal = line.quantity * o.unit_price
            // TVA is reversed at the ORIGINAL line's rate, so an avoir declares the
            // same tax the facture collected even if the rate has since changed.
            const taxRate = o.tax_rate ?? 0
            const taxAmount = taxRate > 0 ? lineTotal - lineTotal / (1 + taxRate / 100) : 0

            insItem.run(
                returnId, o.id, o.product_id, o.variant_id, o.product_name,
                o.size ?? null, o.color ?? null, line.quantity, o.unit_price, lineTotal,
                taxRate, taxAmount, restock ? 1 : 0, condition, line.reason ?? null,
            )

            db.prepare(`
                UPDATE transaction_items
                   SET returned_quantity = COALESCE(returned_quantity, 0) + ?
                 WHERE id = ?
            `).run(line.quantity, o.id)

            if (restock) {
                InventoryService.receive(o.product_id, o.variant_id, line.quantity, {
                    storeId, userId: input.userId,
                    reason: `Retour ${returnNumber}`,
                    referenceType: 'sale_return', referenceId: returnId,
                }, 'return')
            } else {
                // Damaged goods are back in the building but not sellable. Booking
                // them to shrinkage keeps stock honest AND makes the cost visible —
                // simply not restocking would make the loss disappear entirely.
                const unitCost = (db.prepare(
                    'SELECT COALESCE(pv.cost_price, p.cost_price, 0) AS c FROM products p ' +
                    'LEFT JOIN product_variants pv ON pv.id = ? WHERE p.id = ?'
                ).get(o.variant_id, o.product_id) as any)?.c ?? 0
                db.prepare(`
                    INSERT INTO stock_losses
                        (product_id, variant_id, quantity, total_cost, reason, store_id)
                    VALUES (?, ?, ?, ?, 'damage', ?)
                `).run(o.product_id, o.variant_id, line.quantity, unitCost * line.quantity, storeId)
            }
        }

        // Full or partial, computed from the lines rather than tracked incrementally,
        // so it cannot drift out of step with what was actually returned.
        const totals = db.prepare(`
            SELECT SUM(quantity) AS sold, SUM(COALESCE(returned_quantity, 0)) AS returned
            FROM transaction_items WHERE transaction_id = ?
        `).get(input.originalTransactionId) as any
        const returnStatus = (totals.returned ?? 0) <= 0 ? 'none'
            : (totals.returned + 1e-9 >= totals.sold ? 'full' : 'partial')
        db.prepare('UPDATE transactions SET return_status = ? WHERE id = ?')
            .run(returnStatus, input.originalTransactionId)

        return { returnId, returnNumber, returnedValue, replacementValue, balance, returnStatus }
    })()

    AuditService.log({
        userId: input.userId,
        action: input.kind === 'exchange' ? 'sale.exchange' : 'sale.refund',
        entityType: 'sale_return',
        entityId: result.returnId,
        storeId,
        terminalId: input.terminalId ?? null,
        severity: 'warning',
        summary: `${result.returnNumber} sur ${original.transaction_number} — ` +
                 `retour ${result.returnedValue.toFixed(2)} DA, solde ${result.balance.toFixed(2)} DA`,
        newValue: {
            originalTransaction: original.transaction_number,
            lines: resolved.map(r => ({
                product: r.original.product_name,
                size: r.original.size, color: r.original.color,
                quantity: r.input.quantity,
                unitPrice: r.original.unit_price,
                condition: r.input.condition ?? 'resellable',
            })),
            reason: input.reason,
        },
    })

    return result
}

export const ReturnService = {
    /** The original sale plus, per line, how much of it can still come back. */
    getReturnableSale(transactionId: number) {
        const db = getDatabase()
        const txn = db.prepare(`
            SELECT t.*, c.name AS customer_name, s.name AS store_name, u.name AS user_name
            FROM transactions t
            LEFT JOIN customers c ON c.id = t.customer_id
            LEFT JOIN stores s ON s.id = t.store_id
            LEFT JOIN users u ON u.id = t.user_id
            WHERE t.id = ?
        `).get(transactionId) as any
        if (!txn) return null

        const items = db.prepare(`
            SELECT ti.*, pv.size, pv.color, pv.sku AS variant_sku,
                   (ti.quantity - COALESCE(ti.returned_quantity, 0)) AS returnable_quantity
            FROM transaction_items ti
            LEFT JOIN product_variants pv ON pv.id = ti.variant_id
            WHERE ti.transaction_id = ?
            ORDER BY ti.id
        `).all(transactionId)

        const previous = db.prepare(`
            SELECT id, return_number, kind, created_at, balance, returned_value
            FROM sale_returns WHERE original_transaction_id = ? AND status = 'completed'
            ORDER BY created_at DESC
        `).all(transactionId)

        return { transaction: txn, items, previousReturns: previous }
    },

    /** Find a sale by its number — how the till looks one up when a customer walks in. */
    findSaleByNumber(transactionNumber: string) {
        const row = getDatabase()
            .prepare('SELECT id FROM transactions WHERE transaction_number = ?')
            .get(transactionNumber.trim()) as { id: number } | undefined
        return row ? this.getReturnableSale(row.id) : null
    },

    /**
     * Straight refund: goods come back, money goes out, no replacement.
     */
    createRefund(input: CreateReturnInput) {
        PermissionService.assertCan(input.userId, 'sales.refund')
        return performReturn({ ...input, kind: 'refund', replacementTransactionId: null })
    },

    /**
     * Exchange: goods come back and a replacement sale (already completed through
     * the normal path) is linked to them. `balance` is signed — positive means the
     * shop owes the customer, negative means the customer tops up (§17).
     */
    createExchange(input: CreateExchangeInput) {
        PermissionService.assertCan(input.userId, 'sales.exchange')
        const replacement = getDatabase()
            .prepare('SELECT id, status, total_amount FROM transactions WHERE id = ?')
            .get(input.replacementTransactionId) as any
        if (!replacement) throw new ReturnError('REPLACEMENT_NOT_FOUND', 'Vente de remplacement introuvable')
        if (replacement.status !== 'completed') {
            throw new ReturnError('REPLACEMENT_NOT_COMPLETED',
                'La vente de remplacement doit être finalisée avant l’échange')
        }
        return performReturn({ ...input, kind: 'exchange', replacementTransactionId: input.replacementTransactionId })
    },


    /**
     * The real counter workflow: goods come back and different goods go out, in one
     * gesture.
     *
     * WHY THIS ORCHESTRATES INSTEAD OF THE UI DOING IT: the replacement sale must be
     * created, paid and completed, and the return recorded against it, as ONE atomic
     * step. If the UI drove those four calls itself, a failure between them (the
     * commonest being the replacement being out of stock) would leave a completed
     * sale that no return points at — the customer would have walked out with goods
     * while the returned garment was never booked back in and the original sale was
     * never marked returned. Wrapping them here means the exchange either happens
     * whole or not at all.
     *
     * The replacement still goes through TransactionService, so it gets the same
     * pricing, the same per-line TVA, the same gapless numbering and — critically —
     * the same oversell guard as any other sale.
     *
     * HOW THE MONEY WORKS. The replacement is a full-price sale settled first with
     * the credit from the returned goods, then with cash/card for any shortfall:
     *
     *     new 40 000 = store_credit 35 000 + cash 5 000     → balance −5 000
     *     new 30 000 = store_credit 30 000                  → balance +5 000, paid out
     *
     * That keeps the replacement a normal, fully-paid sale (so reports, Z-report and
     * the customer's balance all stay right) while `sale_returns.balance` carries the
     * single signed number the cashier actually acts on. Droit de timbre falls out
     * correctly for free: it is computed on the CASH portion, and store credit is not
     * cash, so only a genuine top-up is stamped.
     */
    exchangeWithNewSale(input: ExchangeWithNewSaleInput) {
        // Checked BEFORE anything is created. A permission failure discovered after
        // the replacement sale was completed would be the orphan this method exists
        // to prevent, and rolling back is not a substitute for not starting.
        PermissionService.assertCan(input.userId, 'sales.exchange')
        if (!input.replacement.length) {
            throw new ReturnError('EMPTY_REPLACEMENT', 'Le panier de remplacement est vide')
        }
        for (const line of input.replacement) {
            if (line.quantity <= 0) {
                throw new ReturnError('INVALID_QUANTITY', 'Quantité de remplacement invalide')
            }
        }

        const db = getDatabase()
        const original = db.prepare('SELECT * FROM transactions WHERE id = ?')
            .get(input.originalTransactionId) as any
        if (!original) throw new ReturnError('SALE_NOT_FOUND', 'Vente d’origine introuvable')

        // Validate the returned lines up front too, for the same reason.
        const resolved = resolveLines(input.originalTransactionId, input.lines)
        const returnedValue = resolved.reduce(
            (sum, r) => sum + r.input.quantity * r.original.unit_price, 0)

        const storeId = input.storeId ?? original.store_id ?? 1

        return db.transaction(() => {
            const replacement = TransactionService.create(
                input.userId, original.customer_id ?? undefined, storeId, input.terminalId ?? null)

            for (const line of input.replacement) {
                TransactionService.addItem(
                    replacement.id, line.productId, line.productName,
                    line.quantity, line.unitPrice, line.sku ?? null, line.variantId)
            }

            const totals = db.prepare('SELECT total_amount FROM transactions WHERE id = ?')
                .get(replacement.id) as { total_amount: number }
            const replacementTotal = totals.total_amount ?? 0

            // Credit can never exceed what the new goods cost — the excess is refunded
            // through the return's balance instead, not left sitting as an overpayment
            // that would show up as change due on the replacement sale.
            const credit = Math.min(returnedValue, replacementTotal)
            if (credit > 0) {
                TransactionService.addPayment(replacement.id, 'store_credit', credit)
            }
            const topUp = replacementTotal - credit
            if (topUp > 0) {
                TransactionService.addPayment(
                    replacement.id, (input.topUpMethod ?? 'cash') as any, topUp)
            }

            // Runs the oversell guard on the NEW goods. If the shop cannot actually
            // supply the replacement, the whole exchange unwinds here.
            TransactionService.complete(replacement.id)

            const result = performReturn({
                ...input,
                kind: 'exchange',
                replacementTransactionId: replacement.id,
            })

            return { ...result, replacementTransactionId: replacement.id, replacementNumber: replacement.transaction_number }
        })()
    },

    /** Returns list, newest first, for the back office. */
    list(filters: { storeId?: number; from?: string; to?: string; kind?: 'refund' | 'exchange'; limit?: number } = {}) {
        const where: string[] = ["r.status = 'completed'"]
        const params: any[] = []
        if (filters.storeId != null) { where.push('r.store_id = ?'); params.push(filters.storeId) }
        if (filters.kind) { where.push('r.kind = ?'); params.push(filters.kind) }
        if (filters.from) { where.push('r.created_at >= ?'); params.push(filters.from) }
        if (filters.to) { where.push('r.created_at <= ?'); params.push(filters.to) }
        params.push(filters.limit ?? 200)

        return getDatabase().prepare(`
            SELECT r.*, t.transaction_number AS original_number,
                   x.transaction_number AS exchange_number,
                   c.name AS customer_name, u.name AS user_name, s.name AS store_name,
                   (SELECT SUM(quantity) FROM sale_return_items WHERE return_id = r.id) AS item_count
            FROM sale_returns r
            LEFT JOIN transactions t ON t.id = r.original_transaction_id
            LEFT JOIN transactions x ON x.id = r.exchange_transaction_id
            LEFT JOIN customers c ON c.id = r.customer_id
            LEFT JOIN users u ON u.id = r.user_id
            LEFT JOIN stores s ON s.id = r.store_id
            WHERE ${where.join(' AND ')}
            ORDER BY r.created_at DESC, r.id DESC
            LIMIT ?
        `).all(...params)
    },

    getById(returnId: number) {
        const db = getDatabase()
        const header = db.prepare(`
            SELECT r.*, t.transaction_number AS original_number,
                   x.transaction_number AS exchange_number,
                   c.name AS customer_name, u.name AS user_name, s.name AS store_name
            FROM sale_returns r
            LEFT JOIN transactions t ON t.id = r.original_transaction_id
            LEFT JOIN transactions x ON x.id = r.exchange_transaction_id
            LEFT JOIN customers c ON c.id = r.customer_id
            LEFT JOIN users u ON u.id = r.user_id
            LEFT JOIN stores s ON s.id = r.store_id
            WHERE r.id = ?
        `).get(returnId)
        if (!header) return null
        const items = db.prepare('SELECT * FROM sale_return_items WHERE return_id = ? ORDER BY id').all(returnId)
        return { ...(header as object), items }
    },

    /**
     * Return and exchange rates (brief §54).
     *
     * Denominator is gross sales in the window, so the figure answers "what share of
     * what we sold came back" rather than the meaningless "returns per return".
     */
    analytics(filters: { storeId?: number; from?: string; to?: string } = {}) {
        const db = getDatabase()
        const rw: string[] = ["r.status = 'completed'"]
        const rp: any[] = []
        const tw: string[] = ["t.status = 'completed'"]
        const tp: any[] = []
        if (filters.storeId != null) {
            rw.push('r.store_id = ?'); rp.push(filters.storeId)
            tw.push('t.store_id = ?'); tp.push(filters.storeId)
        }
        if (filters.from) { rw.push('r.created_at >= ?'); rp.push(filters.from); tw.push('t.created_at >= ?'); tp.push(filters.from) }
        if (filters.to) { rw.push('r.created_at <= ?'); rp.push(filters.to); tw.push('t.created_at <= ?'); tp.push(filters.to) }

        const sales = db.prepare(
            `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount), 0) AS revenue FROM transactions t WHERE ${tw.join(' AND ')}`
        ).get(...tp) as any

        const returns = db.prepare(`
            SELECT COUNT(*) AS n,
                   COALESCE(SUM(CASE WHEN kind = 'refund' THEN 1 ELSE 0 END), 0) AS refunds,
                   COALESCE(SUM(CASE WHEN kind = 'exchange' THEN 1 ELSE 0 END), 0) AS exchanges,
                   COALESCE(SUM(returned_value), 0) AS returned_value,
                   COALESCE(SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END), 0) AS refunded_cash
            FROM sale_returns r WHERE ${rw.join(' AND ')}
        `).get(...rp) as any

        const byReason = db.prepare(`
            SELECT COALESCE(NULLIF(ri.reason, ''), r.reason, 'Non précisé') AS reason,
                   COUNT(*) AS n, COALESCE(SUM(ri.line_total), 0) AS value
            FROM sale_return_items ri
            JOIN sale_returns r ON r.id = ri.return_id
            WHERE ${rw.join(' AND ')}
            -- GROUP BY 1, not "reason": the alias collides with both ri.reason and
            -- r.reason, and SQLite resolves that to the raw columns, not the COALESCE.
            GROUP BY 1 ORDER BY n DESC
        `).all(...rp)

        const topProducts = db.prepare(`
            SELECT ri.product_name, ri.size, ri.color,
                   SUM(ri.quantity) AS quantity, SUM(ri.line_total) AS value
            FROM sale_return_items ri
            JOIN sale_returns r ON r.id = ri.return_id
            WHERE ${rw.join(' AND ')}
            GROUP BY ri.product_id, ri.variant_id
            ORDER BY quantity DESC LIMIT 20
        `).all(...rp)

        const byEmployee = db.prepare(`
            SELECT u.name AS user_name, COUNT(*) AS n, COALESCE(SUM(r.returned_value), 0) AS value
            FROM sale_returns r LEFT JOIN users u ON u.id = r.user_id
            WHERE ${rw.join(' AND ')}
            GROUP BY r.user_id ORDER BY n DESC
        `).all(...rp)

        return {
            salesCount: sales.n,
            salesRevenue: sales.revenue,
            returnsCount: returns.n,
            refundsCount: returns.refunds,
            exchangesCount: returns.exchanges,
            returnedValue: returns.returned_value,
            refundedCash: returns.refunded_cash,
            // Guarded against a zero denominator: an empty period is 0 %, not NaN.
            returnRate: sales.n > 0 ? (returns.refunds / sales.n) * 100 : 0,
            exchangeRate: sales.n > 0 ? (returns.exchanges / sales.n) * 100 : 0,
            valueRate: sales.revenue > 0 ? (returns.returned_value / sales.revenue) * 100 : 0,
            byReason, topProducts, byEmployee,
        }
    },
}
