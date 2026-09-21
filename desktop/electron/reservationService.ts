import { getDatabase } from './database'
import { TransactionService } from './transactionService'
import { StockService } from './stockService'
import { ProductService } from './productService'

// ---------------------------------------------------------------------------
// Client reservations / acompte + consignation (Phase 4.10)
// ---------------------------------------------------------------------------

export const ReservationService = {
    /** Reserve stock for a customer with an optional deposit (acompte). Increments
     *  stock_inventory.reserved_quantity so the POS stock-available math sees it held. */
    reserve(customerId: number | null, productId: number, quantity: number, deposit: number, userId: number, notes?: string) {
        const db = getDatabase()
        const prod = ProductService.getById(productId) as any
        if (!prod) return { success: false, error: 'Product not found.' }
        const run = db.transaction(() => {
            const res = db.prepare(`INSERT INTO reservations (customer_id, product_id, product_name, quantity, deposit, user_id, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(customerId || null, productId, prod.name, quantity, deposit || 0, userId, notes || null)
            db.prepare("UPDATE stock_inventory SET reserved_quantity = COALESCE(reserved_quantity, 0) + ? WHERE product_id = ? AND variant_id IS NULL").run(quantity, productId)
            return res.lastInsertRowid as number
        })
        return { success: true, id: run() }
    },

    list(status: string = 'active') {
        const db = getDatabase()
        return db.prepare(`
            SELECT r.*, c.name AS customer_name FROM reservations r
            LEFT JOIN customers c ON c.id = r.customer_id
            WHERE (? = 'all' OR r.status = ?) ORDER BY r.id DESC
        `).all(status, status) as any[]
    },

    release(id: number) {
        const db = getDatabase()
        const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id) as any
        if (!r || r.status !== 'active') return { success: false, error: 'Reservation not active.' }
        db.transaction(() => {
            db.prepare("UPDATE stock_inventory SET reserved_quantity = MAX(0, COALESCE(reserved_quantity, 0) - ?) WHERE product_id = ? AND variant_id IS NULL").run(r.quantity, r.product_id)
            db.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = ?").run(id)
        })()
        return { success: true }
    },

    /** Turn an active reservation into a real sale: release the hold, build a pending
     *  sale with the reserved line, and post the deposit as a first payment. */
    fulfill(id: number, userId: number) {
        const db = getDatabase()
        const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id) as any
        if (!r || r.status !== 'active') return { success: false, error: 'Reservation not active.' }
        const prod = ProductService.getById(r.product_id) as any
        const sale = TransactionService.create(userId, r.customer_id || undefined)
        TransactionService.addItem(sale.id, r.product_id, r.product_name || prod?.name || 'Article', r.quantity, prod?.retail_price || 0)
        if (r.deposit > 0) TransactionService.addPayment(sale.id, 'cash', r.deposit, `Acompte réservation #${id}`)
        db.transaction(() => {
            db.prepare("UPDATE stock_inventory SET reserved_quantity = MAX(0, COALESCE(reserved_quantity, 0) - ?) WHERE product_id = ? AND variant_id IS NULL").run(r.quantity, r.product_id)
            db.prepare("UPDATE reservations SET status = 'fulfilled', sale_id = ? WHERE id = ?").run(sale.id, id)
        })()
        return { success: true, sale_id: sale.id, transaction_number: sale.transaction_number }
    },

    // ---- Consignation (supplier-owned stock held for sale) ----
    consignmentReceive(supplierId: number | null, productId: number, quantity: number, unitCost: number, userId: number) {
        const db = getDatabase()
        const prod = ProductService.getById(productId) as any
        if (!prod) return { success: false, error: 'Product not found.' }
        const run = db.transaction(() => {
            const res = db.prepare(`INSERT INTO consignments (supplier_id, product_id, product_name, quantity, unit_cost) VALUES (?, ?, ?, ?, ?)`)
                .run(supplierId || null, productId, prod.name, quantity, unitCost || 0)
            // Goods are physically present and sellable, so add to stock.
            StockService.adjustStock(productId, quantity, 'in', userId, 'Consignation reçue', `Consignment ID: ${res.lastInsertRowid}`)
            return res.lastInsertRowid as number
        })
        return { success: true, id: run() }
    },
    consignmentList(status: string = 'open') {
        const db = getDatabase()
        return db.prepare(`
            SELECT cs.*, s.company_name AS supplier_name FROM consignments cs
            LEFT JOIN suppliers s ON s.id = cs.supplier_id
            WHERE (? = 'all' OR cs.status = ?) ORDER BY cs.id DESC
        `).all(status, status) as any[]
    },
    /** Settle sold consignment units (creates a supplier payable for the settled qty). */
    consignmentSettle(id: number, quantity: number) {
        const db = getDatabase()
        const c = db.prepare('SELECT * FROM consignments WHERE id = ?').get(id) as any
        if (!c) return { success: false, error: 'Consignment not found.' }
        const remaining = (c.quantity || 0) - (c.quantity_settled || 0)
        const settleQty = Math.min(quantity, remaining)
        if (settleQty <= 0) return { success: false, error: 'Nothing left to settle.' }
        const amount = settleQty * (c.unit_cost || 0)
        db.transaction(() => {
            db.prepare('UPDATE consignments SET quantity_settled = quantity_settled + ? WHERE id = ?').run(settleQty, id)
            const newC = db.prepare('SELECT quantity, quantity_settled FROM consignments WHERE id = ?').get(id) as any
            if ((newC.quantity_settled || 0) >= (newC.quantity || 0)) db.prepare("UPDATE consignments SET status = 'settled' WHERE id = ?").run(id)
        })()
        // `amount` is the sum now owed to the supplier for the settled units — pay it
        // via the supplier AP (ledger.supplierPay) when the cash actually goes out.
        return { success: true, settled: settleQty, amount }
    },
}
