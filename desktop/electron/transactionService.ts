import { getDatabase } from './database'
import { nextDocNumber } from './sequences'
import { applyBulkPrice } from './pricingService'
import { computeTimbre, computeLineTax } from './fiscalMath'
import { LoyaltyService } from './loyaltyService'
import { InventoryService } from './inventoryService'
import { StoreService } from './storeService'

// Re-exported so existing importers (syncServer, etc.) keep their import path.
export { computeTimbre, computeLineTax }

import type { Customer, Transaction, TransactionItem, Payment, HeldTransaction } from '../shared/types'

export type { Customer, Transaction, TransactionItem, Payment, HeldTransaction }


// Customer Service
export const CustomerService = {
    getAll() {
        const db = getDatabase()
        return db.prepare('SELECT * FROM customers WHERE is_active = 1 ORDER BY name').all() as Customer[]
    },

    getById(id: number) {
        const db = getDatabase()
        return db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer | undefined
    },

    search(query: string) {
        const db = getDatabase()
        const searchTerm = `%${query}%`
        return db.prepare('SELECT * FROM customers WHERE is_active = 1 AND (name LIKE ? OR phone LIKE ? OR company_name LIKE ?) ORDER BY name LIMIT 20').all(searchTerm, searchTerm, searchTerm) as Customer[]
    },

    create(customer: Partial<Customer>) {
        const db = getDatabase()
        return db.prepare(`
      INSERT INTO customers (name, phone, email, company_name, tax_id, nif, rc, nis, ai, customer_type, price_tier, billing_address, shipping_address, credit_limit, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
            customer.name, customer.phone || null, customer.email || null, customer.company_name || null,
            customer.tax_id || null,
            (customer as any).nif || null, (customer as any).rc || null, (customer as any).nis || null, (customer as any).ai || null,
            customer.customer_type || 'retail', (customer as any).price_tier || 'detail', customer.billing_address || null,
            customer.shipping_address || null, customer.credit_limit || 0
        )
    },

    update(id: number, customer: Partial<Customer>) {
        const db = getDatabase()
        const fields = Object.keys(customer).filter(k => k !== 'id')
        const sql = `UPDATE customers SET ${fields.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
        const values = fields.map(f => (customer as any)[f])
        return db.prepare(sql).run(...values, id)
    }
}

// --- TVA helpers (Algerian VAT) — exported so the sync ingest can recompute identically ---
// Whether stored prices already include tax (TTC) or are tax-exclusive (HT). Default HT.
export function pricesIncludeTax(db: ReturnType<typeof getDatabase>): boolean {
    const row = db.prepare("SELECT value FROM config WHERE key = 'prices_include_tax'").get() as { value: string } | undefined
    return row?.value === '1' || row?.value === 'true'
}

// IFU (Impôt Forfaitaire Unique) businesses do not charge TVA. réel = standard VAT.
export function isIfuRegime(db: ReturnType<typeof getDatabase>): boolean {
    const row = db.prepare("SELECT value FROM config WHERE key = 'regime'").get() as { value: string } | undefined
    return row?.value === 'ifu'
}

// The TVA rate (%) for a product, from its tax_category. 0 if none / exempt / IFU regime.
export function getProductTaxRate(db: ReturnType<typeof getDatabase>, productId: number): number {
    try {
        if (isIfuRegime(db)) return 0
        const row = db.prepare('SELECT COALESCE(tc.rate, 0) AS rate FROM products p LEFT JOIN tax_categories tc ON p.tax_category_id = tc.id WHERE p.id = ?').get(productId) as { rate: number } | undefined
        return row?.rate ?? 0
    } catch {
        return 0
    }
}

// Droit de timbre (stamp duty) on a CASH-settled amount. Graduated per 100-DA tranche:
// 1% (≤30 000), 1.5% (≤100 000), 2% (>100 000); min 5 DA; cap 10 000 DA; exempt ≤300 DA.
// ⚠️ Rates per Algerian Code du timbre — confirm with an accountant (plan 3.12).
// Recompute and persist a customer's running balance (kredi ledger, Phase 4.9).
// Kept inline (not via ledgerService) to avoid a module import cycle.
function recomputeCustomerBalance(db: ReturnType<typeof getDatabase>, customerId: number | null | undefined) {
    if (!customerId) return
    const row = db.prepare(`
        SELECT COALESCE(SUM(total_amount - amount_paid), 0) AS bal
        FROM transactions WHERE customer_id = ? AND status IN ('completed', 'refunded')
    `).get(customerId) as { bal: number }
    db.prepare("UPDATE customers SET current_balance = ?, updated_at = datetime('now') WHERE id = ?").run(row.bal || 0, customerId)
}

// Transaction Service
export const TransactionService = {
    generateTransactionNumber() {
        const date = new Date()
        const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '')
        const random = Math.random().toString(36).substring(2, 8).toUpperCase()
        return `TXN-${dateStr}-${random}`
    },

    // A sale belongs to the store and the till that made it. Stamped at CREATE, not
    // at completion, so the attribution survives a cart that is held overnight or
    // finished on a different terminal — and so stock is drawn from the right shop.
    create(userId: number, customerId?: number, storeId?: number, terminalId?: number | null) {
        const db = getDatabase()
        const txnNumber = nextDocNumber('sale', 'BL')
        const store = storeId ?? StoreService.getCurrentStoreId()
        const terminal = terminalId !== undefined ? terminalId : StoreService.getCurrentTerminalId()
        const result = db.prepare(`
      INSERT INTO transactions (transaction_number, customer_id, user_id, status, store_id, terminal_id)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(txnNumber, customerId || null, userId, store, terminal)
        return { id: result.lastInsertRowid as number, transaction_number: txnNumber, store_id: store }
    },

    getById(id: number) {
        const db = getDatabase()
        return db.prepare(`
      SELECT t.*, c.name as customer_name
      FROM transactions t
      LEFT JOIN customers c ON t.customer_id = c.id
      WHERE t.id = ?
    `).get(id) as Transaction | undefined
    },

    addItem(transactionId: number, productId: number, productName: string, quantity: number, unitPrice: number, sku?: string | null, variantId?: number | null, unit?: string | null, unitFactor?: number | null) {
        const db = getDatabase()
        const rate = getProductTaxRate(db, productId)
        // The caller passes the negotiated/tier base price; apply quantity breaks here.
        // quantity is always in BASE units; unit/unit_factor are for display/print only.
        const base = unitPrice
        const effective = applyBulkPrice(db, productId, base, quantity)
        const { ht, tax } = computeLineTax(effective * quantity, rate, pricesIncludeTax(db))
        const lineUnit = unit || (db.prepare('SELECT unite FROM products WHERE id = ?').get(productId) as { unite?: string } | undefined)?.unite || null
        const factor = unitFactor && unitFactor > 0 ? unitFactor : 1

        // Freeze what the garment COST us, alongside what it sold for (Migration 42).
        // Without this, a later change to the supplier price silently rewrites the
        // margin on every sale already made.
        const unitCost = (db.prepare(
            'SELECT COALESCE(pv.cost_price, p.cost_price, 0) AS c FROM products p ' +
            'LEFT JOIN product_variants pv ON pv.id = ? WHERE p.id = ?'
        ).get(variantId ?? null, productId) as { c: number } | undefined)?.c ?? 0

        // line_total is stored HT (tax-exclusive); tax_rate/tax_amount carry the TVA.
        // base_unit_price keeps the pre-break price so quantity edits can recompute.
        db.prepare(`
      INSERT INTO transaction_items (transaction_id, product_id, variant_id, product_name, sku, quantity, unit_price, base_unit_price, tax_rate, tax_amount, line_total, unit, unit_factor, unit_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(transactionId, productId, variantId || null, productName, sku || null, quantity, effective, base, rate, tax, ht, lineUnit, factor, unitCost)

        this.recalculateTotals(transactionId)
    },

    updateItemQuantity(itemId: number, quantity: number) {
        const db = getDatabase()
        const item = db.prepare('SELECT * FROM transaction_items WHERE id = ?').get(itemId) as TransactionItem & { base_unit_price?: number }
        if (!item) return

        // Recompute the quantity break against the stored base price (fallback to unit_price for legacy rows).
        const base = item.base_unit_price ?? item.unit_price
        const effective = applyBulkPrice(db, item.product_id, base, quantity)
        const { ht, tax } = computeLineTax(effective * quantity, item.tax_rate || 0, pricesIncludeTax(db))

        db.prepare('UPDATE transaction_items SET quantity = ?, unit_price = ?, tax_amount = ?, line_total = ? WHERE id = ?').run(quantity, effective, tax, ht, itemId)
        this.recalculateTotals(item.transaction_id)
    },

    removeItem(itemId: number) {
        const db = getDatabase()
        const item = db.prepare('SELECT transaction_id FROM transaction_items WHERE id = ?').get(itemId) as { transaction_id: number } | undefined
        if (!item) return

        db.prepare('DELETE FROM transaction_items WHERE id = ?').run(itemId)
        this.recalculateTotals(item.transaction_id)
    },

    /** Relabel a line's selling unit (Phase 4.4). quantity stays in base units, so
     *  totals are unchanged — only the printed/displayed unit + factor move. */
    setItemUnit(itemId: number, unit: string, unitFactor: number) {
        const db = getDatabase()
        const factor = unitFactor && unitFactor > 0 ? unitFactor : 1
        db.prepare('UPDATE transaction_items SET unit = ?, unit_factor = ? WHERE id = ?').run(unit, factor, itemId)
        return { success: true }
    },

    getItems(transactionId: number) {
        const db = getDatabase()
        return db.prepare('SELECT * FROM transaction_items WHERE transaction_id = ?').all(transactionId) as TransactionItem[]
    },

    /** Returns cart lines whose quantity exceeds available stock (drives an oversell warning).
     *  Non-blocking — the sale is still allowed; this just surfaces the risk. */
    /**
     * Advisory pre-check so the till can warn while the cart is being built.
     *
     * This is NOT the oversell guard — it reads and returns, so another terminal can
     * sell the last item between this call and completion. The real guard is the
     * atomic UPDATE inside InventoryService.consume(), which runs at completion.
     * Treat this purely as UI feedback (brief §62: never solve the race in the front end).
     */
    checkStock(transactionId: number) {
        const db = getDatabase()
        const txn = this.getById(transactionId)
        const storeId = (txn as any)?.store_id ?? StoreService.getCurrentStoreId()
        const rows = db.prepare(`
            SELECT ti.product_id, ti.variant_id, ti.product_name, ti.quantity AS requested,
                   COALESCE(si.quantity, 0) AS available
            FROM transaction_items ti
            LEFT JOIN stock_inventory si
              ON si.product_id = ti.product_id
             AND COALESCE(si.variant_id, 0) = COALESCE(ti.variant_id, 0)
             AND si.store_id = ?
            WHERE ti.transaction_id = ?
        `).all(storeId, transactionId) as
            { product_id: number; variant_id: number | null; product_name: string; requested: number; available: number }[]
        return rows.filter(r => r.requested > r.available)
    },

    applyDiscount(transactionId: number, discountType: 'percentage' | 'fixed', discountValue: number) {
        const db = getDatabase()
        const txn = this.getById(transactionId)
        if (!txn) return

        let discountAmount = 0
        if (discountType === 'percentage') {
            discountAmount = Math.min(txn.subtotal, Math.max(0, txn.subtotal * (discountValue / 100)))
        } else {
            discountAmount = Math.min(discountValue, txn.subtotal)
        }

        db.prepare(`UPDATE transactions SET discount_type = ?, discount_value = ?, discount_amount = ? WHERE id = ?`).run(discountType, discountValue, discountAmount, transactionId)
        this.recalculateTotals(transactionId)
    },

    recalculateTotals(transactionId: number) {
        const db = getDatabase()
        const items = this.getItems(transactionId)
        // subtotal = sum of HT line totals; rawTax = sum of per-line TVA.
        const subtotal = items.reduce((sum, item) => sum + (item.line_total || 0), 0)
        // Under the IFU regime no TVA is charged regardless of when lines were added.
        const rawTax = isIfuRegime(db) ? 0 : items.reduce((sum, item) => sum + (item.tax_amount || 0), 0)

        const txn = db.prepare('SELECT discount_type, discount_value FROM transactions WHERE id = ?').get(transactionId) as { discount_type: string; discount_value: number } | undefined
        let discountAmount = 0
        if (txn?.discount_type === 'percentage') {
            discountAmount = Math.min(subtotal, Math.max(0, subtotal * (txn.discount_value / 100)))
        } else if (txn?.discount_type === 'fixed') {
            discountAmount = Math.min(txn.discount_value, subtotal)
        }

        // An order-level discount reduces the taxable (HT) base, so TVA scales with it.
        const taxableRatio = subtotal > 0 ? Math.max(0, subtotal - discountAmount) / subtotal : 1
        const taxAmount = rawTax * taxableRatio
        const totalAmount = (subtotal - discountAmount) + taxAmount

        db.prepare(`UPDATE transactions SET subtotal = ?, tax_amount = ?, discount_amount = ?, total_amount = ? WHERE id = ?`).run(subtotal, taxAmount, discountAmount, totalAmount, transactionId)
    },

    addPayment(transactionId: number, method: Payment['payment_method'], amount: number, referenceNumber?: string) {
        const db = getDatabase()
        db.prepare(`INSERT INTO payments (transaction_id, payment_method, amount, reference_number) VALUES (?, ?, ?, ?)`).run(transactionId, method, amount, referenceNumber || null)

        // Update amount paid
        const payments = db.prepare('SELECT SUM(amount) as total FROM payments WHERE transaction_id = ?').get(transactionId) as { total: number }
        const txn = this.getById(transactionId)
        if (!txn) return

        const amountPaid = payments.total
        const changeDue = Math.max(0, amountPaid - txn.total_amount)

        let debtStatus = txn.debt_status
        if (amountPaid >= txn.total_amount) {
            debtStatus = 'paid'
        } else if (amountPaid > 0 && amountPaid < txn.total_amount) {
            debtStatus = 'partial'
        }

        // Recompute droit de timbre on the cash-settled portion (capped at the TTC total)
        // so a credit sale later settled in cash (settleDebt → addPayment) gets the stamp.
        const cashPaid = (db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE transaction_id = ? AND payment_method = 'cash'").get(transactionId) as { s: number }).s
        const timbre = computeTimbre(Math.min(cashPaid, txn.total_amount))

        db.prepare(`UPDATE transactions SET amount_paid = ?, change_due = ?, debt_status = ?, timbre = ? WHERE id = ?`).run(amountPaid, changeDue, debtStatus, timbre, transactionId)
        recomputeCustomerBalance(db, txn.customer_id)
    },

    settleDebt(transactionId: number) {
        const txn = this.getById(transactionId)
        if (!txn) return

        const remaining = txn.total_amount - txn.amount_paid
        if (remaining > 0) {
            this.addPayment(transactionId, 'cash', remaining, 'Debt Settlement')
        }
    },

    getPayments(transactionId: number) {
        const db = getDatabase()
        return db.prepare('SELECT * FROM payments WHERE transaction_id = ?').all(transactionId) as Payment[]
    },

    complete(transactionId: number, debtDueDate?: string, customerNameOverride?: string) {
        const db = getDatabase()
        const txn = this.getById(transactionId)
        if (!txn) return

        // Idempotency guard: completing a sale decrements stock and writes 'out' movements.
        // It must run EXACTLY ONCE. If the transaction is already completed (e.g. a duplicate
        // call from the UI), return without touching stock again.
        if (txn.status === 'completed') return

        let debtStatus = 'none'
        if (txn.amount_paid < txn.total_amount) {
            debtStatus = (txn.amount_paid || 0) <= 0 ? 'unpaid' : 'partial'
        } else if (txn.amount_paid >= txn.total_amount) {
            debtStatus = 'paid'
        }

        // Droit de timbre: applies to the CASH-settled portion of the invoice (exempt for
        // cheque/virement/CCP/card). Computed at completion once payments are recorded.
        const cashPaid = (db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE transaction_id = ? AND payment_method = 'cash'").get(transactionId) as { s: number }).s
        const timbre = cashPaid > 0 ? computeTimbre(Math.min(cashPaid, txn.total_amount)) : 0

        // Legacy sales predate store_id (Migration 34 backfilled them to store 1);
        // anything still NULL falls back to this device's store.
        const storeId = (txn as any).store_id ?? StoreService.getCurrentStoreId()

        // All-or-nothing: status update + stock decrement + movement rows + customer note
        // commit together, so a crash mid-loop cannot desync money and stock.
        const finalize = db.transaction(() => {
            db.prepare(`UPDATE transactions SET status = 'completed', completed_at = datetime('now'), debt_status = ?, debt_due_date = ?, timbre = ? WHERE id = ?`).run(debtStatus, debtDueDate || null, timbre, transactionId)

            // Stock leaves through InventoryService, never by raw UPDATE.
            //
            // The old code here did `SET quantity = quantity - ?` with no guard, which
            // had two failure modes: two tills could each sell the last suit, and a
            // product with no stock row matched zero rows so the decrement silently
            // vanished while the movement row was still written — the ledger and the
            // stock disagreed from that moment on.
            //
            // consume() is a single atomic `UPDATE ... WHERE quantity >= ?`, so the
            // losing till gets INSUFFICIENT_STOCK and this whole transaction rolls
            // back: no sale, no movement, no half-decrement.
            const items = this.getItems(transactionId)
            InventoryService.consumeMany(
                items.map(item => ({
                    productId: item.product_id,
                    variantId: item.variant_id ?? null,
                    quantity: item.quantity,
                })),
                {
                    storeId,
                    userId: txn.user_id,
                    reason: 'Sale',
                    referenceType: 'transaction',
                    referenceId: transactionId,
                },
                'sale',
            )

            if (customerNameOverride) {
                db.prepare('UPDATE transactions SET customer_notes = ? WHERE id = ?').run(`Name: ${customerNameOverride}`, transactionId)
            }

            // Loyalty points for the sale. Idempotent via UNIQUE(transaction_id, direction),
            // so the retry path below cannot award twice. Never let a loyalty problem
            // block a sale from completing.
            try {
                LoyaltyService.earnForSale(transactionId)
            } catch (e) {
                console.error('[Loyalty] earn failed for transaction', transactionId, e)
            }
        })

        try {
            finalize()
        } catch (error: any) {
            // The retry below exists only for very old databases missing debt/customer
            // columns. A business failure — above all INSUFFICIENT_STOCK — must NOT be
            // retried: running the same completion again would either fail identically
            // after pointless ALTER TABLEs, or, worse, look like a transient glitch.
            // Let it out unchanged so the till can tell the cashier what is short.
            if (error?.code === 'INSUFFICIENT_STOCK' || !/no such column|has no column/i.test(error?.message ?? '')) {
                throw error
            }
            // Emergency repair for very old DBs missing debt/customer columns, then retry once.
            console.warn('[TransactionService] Completion failed, attempting schema repair...', error.message)
            const info = db.prepare("PRAGMA table_info(transactions)").all() as any[]
            const cols = info.map(c => c.name)
            if (!cols.includes('debt_status')) db.exec("ALTER TABLE transactions ADD COLUMN debt_status TEXT DEFAULT 'none'")
            if (!cols.includes('debt_due_date')) db.exec("ALTER TABLE transactions ADD COLUMN debt_due_date TEXT")
            if (!cols.includes('customer_notes')) db.exec("ALTER TABLE transactions ADD COLUMN customer_notes TEXT")
            if (!cols.includes('timbre')) db.exec("ALTER TABLE transactions ADD COLUMN timbre REAL DEFAULT 0")
            finalize()
        }
        recomputeCustomerBalance(db, txn.customer_id)
    },

    void(transactionId: number) {
        const db = getDatabase()
        const txn = this.getById(transactionId)
        if (!txn) return
        db.transaction(() => {
            // Restore stock if the sale had already been completed (stock was decremented).
            if (txn.status === 'completed') {
                const storeId = (txn as any).store_id ?? StoreService.getCurrentStoreId()
                const items = this.getItems(transactionId)
                for (const it of items) {
                    // receive() upserts, so a void still restores stock even for a variant
                    // whose row was removed while the sale stood.
                    InventoryService.receive(it.product_id, it.variant_id ?? null, it.quantity, {
                        storeId, userId: txn.user_id, reason: 'Void',
                        referenceType: 'transaction', referenceId: transactionId,
                    }, 'return')
                }
            }
            db.prepare(`UPDATE transactions SET status = 'voided' WHERE id = ?`).run(transactionId)
        })()
        recomputeCustomerBalance(db, txn.customer_id)
    },

    // Facture d'avoir (credit note): the ONLY legal way to cancel/correct an issued facture.
    // Own gapless AV- series, references the original, reverses TVA, and restocks the goods.
    // restock=true (default) returns goods to inventory; false = scrap (damaged/defective,
    // credited to the customer but NOT added back to stock).
    createAvoir(originalTransactionId: number, userId: number, restock: boolean = true) {
        const db = getDatabase()
        const orig = this.getById(originalTransactionId)
        if (!orig) throw new Error('Original transaction not found')
        if (orig.status === 'refunded') throw new Error('Cannot credit a credit note')
        // Idempotency: a facture may be credited only once (else stock + TVA reverse twice).
        const existingAvoir = db.prepare("SELECT id FROM transactions WHERE notes = ?").get(`Avoir sur facture ${orig.transaction_number}`)
        if (existingAvoir) throw new Error(`Un avoir existe déjà pour la facture ${orig.transaction_number}`)
        const items = this.getItems(originalTransactionId)
        const avoirNumber = nextDocNumber('avoir', 'AV')
        // Goods credited back land in the store that sold them; legacy sales fall back
        // to this device's store.
        const storeId = (orig as any).store_id ?? StoreService.getCurrentStoreId()

        return db.transaction(() => {
            const info = db.prepare(`
                INSERT INTO transactions (transaction_number, customer_id, user_id, status, store_id, subtotal, discount_amount, tax_amount, total_amount, amount_paid, change_due, timbre, notes, completed_at, created_at)
                VALUES (?, ?, ?, 'refunded', ?, ?, ?, ?, ?, ?, 0, ?, ?, datetime('now'), datetime('now'))
            `).run(
                avoirNumber, orig.customer_id || null, userId, storeId,
                -(orig.subtotal || 0), -(orig.discount_amount || 0), -(orig.tax_amount || 0), -(orig.total_amount || 0), -(orig.amount_paid || 0), -((orig as any).timbre || 0),
                `Avoir sur facture ${orig.transaction_number}`
            )
            const avoirId = info.lastInsertRowid as number

            for (const it of items) {
                db.prepare(`INSERT INTO transaction_items (transaction_id, product_id, variant_id, product_name, sku, quantity, unit_price, base_unit_price, tax_rate, tax_amount, line_total, unit, unit_factor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(avoirId, it.product_id, it.variant_id || null, it.product_name, it.sku || null, -it.quantity, it.unit_price, (it as any).base_unit_price ?? it.unit_price, it.tax_rate || 0, -(it.tax_amount || 0), -(it.line_total || 0), (it as any).unit || null, (it as any).unit_factor || 1)

                if (restock) {
                    InventoryService.receive(it.product_id, it.variant_id ?? null, it.quantity, {
                        storeId, userId, reason: 'Avoir',
                        referenceType: 'avoir', referenceId: avoirId,
                    }, 'return')
                } else {
                    // Scrapped: record the credited return without returning goods to sellable
                    // stock. Written directly because this is a zero-quantity marker, not a
                    // stock change — InventoryService rejects a zero movement by design.
                    db.prepare(`INSERT INTO stock_movements (product_id, variant_id, store_id, movement_type, quantity, reason, reference_type, reference_id) VALUES (?, ?, ?, 'adjustment', 0, 'Avoir (rebut)', 'avoir', ?)`).run(it.product_id, it.variant_id || null, storeId, avoirId)
                }
            }

            recomputeCustomerBalance(db, orig.customer_id)
            return { id: avoirId, transaction_number: avoirNumber }
        })()
    },

    // Held transactions
    holdTransaction(userId: number, items: TransactionItem[], subtotal: number, customerId?: number, holdName?: string) {
        const db = getDatabase()
        return db.prepare(`
      INSERT INTO held_transactions (user_id, customer_id, hold_name, items_json, subtotal)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, customerId || null, holdName || null, JSON.stringify(items), subtotal)
    },

    getHeldTransactions(userId?: number) {
        const db = getDatabase()
        if (userId) {
            return db.prepare('SELECT * FROM held_transactions WHERE user_id = ? ORDER BY created_at DESC').all(userId) as HeldTransaction[]
        }
        return db.prepare('SELECT * FROM held_transactions ORDER BY created_at DESC').all() as HeldTransaction[]
    },

    retrieveHeldTransaction(heldId: number) {
        const db = getDatabase()
        const held = db.prepare('SELECT * FROM held_transactions WHERE id = ?').get(heldId) as HeldTransaction | undefined
        if (held) {
            db.prepare('DELETE FROM held_transactions WHERE id = ?').run(heldId)
        }
        return held
    },

    getRecentTransactions(limit: number = 50) {
        const db = getDatabase()
        return db.prepare(`
      SELECT t.*, c.name as customer_name, c.phone as customer_phone
      FROM transactions t
      LEFT JOIN customers c ON t.customer_id = c.id
      WHERE t.status = 'completed'
      ORDER BY t.completed_at DESC
      LIMIT ?
    `).all(limit) as Transaction[]
    },

    getDebtors() {
        const db = getDatabase()
        return db.prepare(`
            SELECT t.*, c.name as customer_name, c.phone as customer_phone
            FROM transactions t
            JOIN customers c ON t.customer_id = c.id
            WHERE t.status = 'completed' AND t.debt_status IN ('unpaid', 'partial')
            ORDER BY t.debt_due_date ASC
        `).all() as Transaction[]
    },

    getDeliveries(limit: number = 50) {
        const db = getDatabase()
        return db.prepare(`
            SELECT t.*, 
                   COALESCE(REPLACE(t.customer_notes, 'Name: ', ''), c.name, 'Client Comptant') as display_name
            FROM transactions t
            LEFT JOIN customers c ON t.customer_id = c.id
            WHERE t.status = 'completed' 
            AND (t.customer_notes LIKE 'Name: %' OR t.customer_id IS NOT NULL)
            ORDER BY t.completed_at DESC
            LIMIT ?
        `).all(limit) as any[]
    }
}
