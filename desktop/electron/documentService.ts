import { getDatabase } from './database'
import { nextDocNumber } from './sequences'
import { TransactionService } from './transactionService'
import { ProductService } from './productService'
import { InvoiceService } from './invoiceService'

// ---------------------------------------------------------------------------
// Commercial document flow (Phase 4.7)
//
// Reuses the transactions table with a doc_type discriminator. Drafts
// (devis / proforma / bon_commande) stay 'pending' and never touch stock —
// stock only moves when a document is converted into a bon_livraison and that
// sale is completed through the normal TransactionService.complete() path.
// ---------------------------------------------------------------------------

export type DocType = 'devis' | 'proforma' | 'bon_commande' | 'bon_livraison' | 'facture' | 'facture_recap'

const DOC_META: Record<DocType, { prefix: string; title: string }> = {
    devis: { prefix: 'DEV', title: 'DEVIS' },
    proforma: { prefix: 'PRO', title: 'FACTURE PROFORMA' },
    bon_commande: { prefix: 'BC', title: 'BON DE COMMANDE' },
    bon_livraison: { prefix: 'BL', title: 'BON DE LIVRAISON' },
    facture: { prefix: 'FACT', title: 'FACTURE' },
    facture_recap: { prefix: 'FACT', title: 'FACTURE RÉCAPITULATIVE' },
}

export const DocumentService = {
    create(docType: DocType, customerId: number | null, userId: number, items: { productId: number; quantity: number; unitPrice?: number }[], notes?: string) {
        const db = getDatabase()
        const meta = DOC_META[docType] || DOC_META.devis
        const number = nextDocNumber(docType, meta.prefix)
        const res = db.prepare(`
            INSERT INTO transactions (transaction_number, customer_id, user_id, status, doc_type, notes)
            VALUES (?, ?, ?, 'pending', ?, ?)
        `).run(number, customerId || null, userId, docType, notes || null)
        const docId = res.lastInsertRowid as number
        for (const it of items) {
            const prod = ProductService.getById(it.productId) as any
            if (!prod) continue
            const price = it.unitPrice != null ? it.unitPrice : (prod.retail_price || 0)
            TransactionService.addItem(docId, it.productId, prod.name, it.quantity, price, prod.sku, null)
        }
        return { id: docId, transaction_number: number, doc_type: docType }
    },

    getById(id: number) {
        const db = getDatabase()
        const doc = db.prepare(`
            SELECT t.*, c.name AS customer_name
            FROM transactions t LEFT JOIN customers c ON c.id = t.customer_id
            WHERE t.id = ?
        `).get(id) as any
        if (!doc) return null
        doc.items = db.prepare('SELECT * FROM transaction_items WHERE transaction_id = ?').all(id)
        return doc
    },

    list(docType?: DocType, limit = 100) {
        const db = getDatabase()
        if (docType) {
            return db.prepare(`
                SELECT t.*, c.name AS customer_name FROM transactions t
                LEFT JOIN customers c ON c.id = t.customer_id
                WHERE t.doc_type = ? ORDER BY t.id DESC LIMIT ?
            `).all(docType, limit) as any[]
        }
        return db.prepare(`
            SELECT t.*, c.name AS customer_name FROM transactions t
            LEFT JOIN customers c ON c.id = t.customer_id
            WHERE t.doc_type IS NOT NULL AND t.doc_type NOT IN ('bon_livraison') ORDER BY t.id DESC LIMIT ?
        `).all(limit) as any[]
    },

    /** Convert a draft (devis/proforma/BC) into a new bon_livraison sale, copying
     *  its lines. The returned pending sale is finished via the normal flow. */
    convertToSale(docId: number, userId: number) {
        const src = this.getById(docId)
        if (!src) return { success: false, error: 'Document not found.' }
        const sale = TransactionService.create(userId, src.customer_id || undefined)
        const db = getDatabase()
        db.prepare('UPDATE transactions SET source_doc_id = ? WHERE id = ?').run(docId, sale.id)
        for (const it of src.items as any[]) {
            const base = it.base_unit_price ?? it.unit_price
            TransactionService.addItem(sale.id, it.product_id, it.product_name, it.quantity, base, it.sku, it.variant_id, it.unit, it.unit_factor)
        }
        return { success: true, id: sale.id, transaction_number: sale.transaction_number }
    },

    /** Monthly facture récapitulative consolidating a customer's completed BLs. */
    createRecapitulative(customerId: number, year: number, month: number, userId: number) {
        const db = getDatabase()
        const mm = String(month).padStart(2, '0')
        const bls = db.prepare(`
            SELECT id, transaction_number FROM transactions
            WHERE customer_id = ? AND status = 'completed'
              AND (doc_type = 'bon_livraison' OR doc_type IS NULL)
              AND strftime('%Y', COALESCE(completed_at, created_at)) = ?
              AND strftime('%m', COALESCE(completed_at, created_at)) = ?
            ORDER BY id
        `).all(customerId, String(year), mm) as any[]
        if (bls.length === 0) return { success: false, error: 'Aucun bon de livraison pour cette période.' }

        const meta = DOC_META.facture_recap
        const number = nextDocNumber('facture', meta.prefix)
        const notes = `Récapitulatif ${mm}/${year} — BL: ${bls.map(b => b.transaction_number).join(', ')}`
        const res = db.prepare(`
            INSERT INTO transactions (transaction_number, customer_id, user_id, status, doc_type, notes)
            VALUES (?, ?, ?, 'completed', 'facture_recap', ?)
        `).run(number, customerId, userId, notes)
        const recapId = res.lastInsertRowid as number

        // Copy every line of every BL (stock already moved when the BLs completed).
        const copy = db.prepare(`
            INSERT INTO transaction_items (transaction_id, product_id, variant_id, product_name, sku, quantity, unit_price, base_unit_price, tax_rate, tax_amount, line_total, unit, unit_factor)
            SELECT ?, product_id, variant_id, product_name, sku, quantity, unit_price, base_unit_price, tax_rate, tax_amount, line_total, unit, unit_factor
            FROM transaction_items WHERE transaction_id = ?
        `)
        const run = db.transaction(() => {
            for (const bl of bls) copy.run(recapId, bl.id)
            // Sum the copied lines directly so the récapitulative reproduces the HISTORICAL
            // per-line TVA of the consolidated BLs (do NOT re-derive via recalculateTotals,
            // which would zero TVA if the shop has since switched to IFU).
            const agg = db.prepare('SELECT COALESCE(SUM(line_total),0) AS ht, COALESCE(SUM(tax_amount),0) AS tax FROM transaction_items WHERE transaction_id = ?').get(recapId) as { ht: number; tax: number }
            db.prepare('UPDATE transactions SET subtotal = ?, tax_amount = ?, total_amount = ? WHERE id = ?').run(agg.ht, agg.tax, agg.ht + agg.tax, recapId)
        })
        run()
        return { success: true, id: recapId, transaction_number: number, bl_count: bls.length }
    },

    /** Build ReceiptData from a stored document and print it on A4 with the right title. */
    async print(docId: number) {
        const doc = this.getById(docId)
        if (!doc) return { success: false, error: 'Document not found.' }
        const db = getDatabase()
        const customer = doc.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(doc.customer_id) as any : null
        const meta = DOC_META[(doc.doc_type as DocType)] || DOC_META.facture

        const data: any = {
            transactionNumber: doc.transaction_number,
            date: doc.completed_at || doc.created_at,
            cashierName: 'System',
            customerName: doc.customer_name || null,
            docTitle: meta.title,
            items: (doc.items as any[]).map(i => ({
                name: i.product_name,
                quantity: i.quantity,
                unitPrice: i.unit_price,
                total: i.line_total,
                discount: i.discount_amount || 0,
                taxRate: i.tax_rate || 0,
                taxAmount: i.tax_amount || 0,
                unit: i.unit || '',
                unitFactor: i.unit_factor || 1,
            })),
            subtotal: doc.subtotal,
            discount: doc.discount_amount || 0,
            tax: doc.tax_amount || 0,
            total: doc.total_amount,
            timbre: doc.timbre || 0,
            payments: [],
            change: 0,
            fiscalId: customer?.nif || customer?.tax_id || '',
            rc: customer?.rc || '',
            nis: customer?.nis || '',
            ai: customer?.ai || '',
            customerPhone: customer?.phone || '',
        }
        return InvoiceService.print(data)
    },
}
