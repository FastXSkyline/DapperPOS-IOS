import { BrowserWindow, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getDatabase } from './database'
import { ReceiptService } from './receiptService'

// ---------------------------------------------------------------------------
// Kredi ledger / accounts receivable + payable (Phase 4.9)
// ---------------------------------------------------------------------------

function esc(s: any): string {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export const LedgerService = {
    /** Net amount a customer owes across all completed sales/avoirs (single source of truth). */
    customerBalance(customerId: number): number {
        const db = getDatabase()
        const row = db.prepare(`
            SELECT COALESCE(SUM(total_amount - amount_paid), 0) AS bal
            FROM transactions
            WHERE customer_id = ? AND status IN ('completed', 'refunded')
        `).get(customerId) as { bal: number }
        return row.bal || 0
    },

    /** Recompute and persist customers.current_balance (called after balance-affecting events). */
    recomputeCustomerBalance(customerId: number | null | undefined) {
        if (!customerId) return
        const db = getDatabase()
        const bal = this.customerBalance(customerId)
        db.prepare("UPDATE customers SET current_balance = ?, updated_at = datetime('now') WHERE id = ?").run(bal, customerId)
    },

    creditStatus(customerId: number) {
        const db = getDatabase()
        const c = db.prepare('SELECT credit_limit, current_balance FROM customers WHERE id = ?').get(customerId) as { credit_limit: number; current_balance: number } | undefined
        const balance = this.customerBalance(customerId)
        const limit = c?.credit_limit || 0
        return { balance, limit, available: limit > 0 ? limit - balance : Infinity, over: limit > 0 && balance > limit }
    },

    /** Statement of account: every completed sale/avoir with running balance + payments. */
    customerStatement(customerId: number) {
        const db = getDatabase()
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as any
        const txns = db.prepare(`
            SELECT id, transaction_number, doc_type, total_amount, amount_paid, debt_status,
                   COALESCE(completed_at, created_at) AS date
            FROM transactions
            WHERE customer_id = ? AND status IN ('completed', 'refunded')
            ORDER BY COALESCE(completed_at, created_at) ASC, id ASC
        `).all(customerId) as any[]
        let running = 0
        const lines = txns.map(t => {
            running += (t.total_amount - t.amount_paid)
            return { ...t, balance: running }
        })
        return { customer, lines, balance: running }
    },

    /** Aging buckets of outstanding receivables, per customer. */
    aging() {
        const db = getDatabase()
        const rows = db.prepare(`
            SELECT c.id AS customer_id, c.name AS customer_name,
                   t.total_amount - t.amount_paid AS outstanding,
                   COALESCE(t.debt_due_date, t.completed_at, t.created_at) AS ref_date
            FROM transactions t JOIN customers c ON c.id = t.customer_id
            WHERE t.status = 'completed' AND t.debt_status IN ('unpaid', 'partial')
        `).all() as any[]
        const now = Date.now()
        const buckets: Record<string, { current: number; d30: number; d60: number; d90: number; over90: number; total: number }> = {}
        const names: Record<number, string> = {}
        for (const r of rows) {
            const ageDays = r.ref_date ? Math.floor((now - new Date(r.ref_date).getTime()) / 86400000) : 0
            const b = buckets[r.customer_id] || (buckets[r.customer_id] = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0 })
            names[r.customer_id] = r.customer_name
            const amt = r.outstanding || 0
            if (ageDays <= 0) b.current += amt
            else if (ageDays <= 30) b.d30 += amt
            else if (ageDays <= 60) b.d60 += amt
            else if (ageDays <= 90) b.d90 += amt
            else b.over90 += amt
            b.total += amt
        }
        return Object.entries(buckets).map(([id, b]) => ({ customer_id: Number(id), customer_name: names[Number(id)], ...b }))
    },

    /** Partial settlement of a single invoice (amount + method). */
    settlePartial(transactionId: number, amount: number, method: string, reference?: string) {
        const db = getDatabase()
        const txn = db.prepare('SELECT customer_id, total_amount, amount_paid FROM transactions WHERE id = ?').get(transactionId) as any
        if (!txn) return { success: false, error: 'Transaction not found.' }
        const remaining = (txn.total_amount || 0) - (txn.amount_paid || 0)
        const pay = Math.min(amount, remaining)
        if (pay <= 0) return { success: false, error: 'Nothing left to settle.' }
        // Reuse the canonical addPayment so timbre/debt_status stay consistent.
        const { TransactionService } = require('./transactionService') as typeof import('./transactionService')
        TransactionService.addPayment(transactionId, method as any, pay, reference)
        this.recomputeCustomerBalance(txn.customer_id)
        return { success: true, paid: pay, remaining: remaining - pay }
    },

    async printStatement(customerId: number) {
        const { customer, lines, balance } = this.customerStatement(customerId)
        if (!customer) return { success: false, error: 'Customer not found.' }
        const cfg: any = ReceiptService.getConfig()
        const rows = lines.map(l => `
            <tr>
              <td>${esc(l.date)}</td>
              <td>${esc(l.transaction_number)}</td>
              <td style="text-align:right">${(l.total_amount || 0).toLocaleString()}</td>
              <td style="text-align:right">${(l.amount_paid || 0).toLocaleString()}</td>
              <td style="text-align:right">${(l.balance || 0).toLocaleString()}</td>
            </tr>`).join('')
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Relevé ${esc(customer.name)}</title>
        <style>
          body{font-family:Arial,sans-serif;padding:24px;color:#111}
          h1{font-size:20px;margin:0}
          .co{font-size:13px;color:#333;margin-bottom:4px}
          .meta{margin:12px 0;font-size:13px}
          table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px}
          th,td{border:1px solid #999;padding:5px 7px}
          th{background:#f0f0f0;text-align:left}
          .tot{margin-top:14px;font-size:15px;font-weight:bold;text-align:right}
          .cachet{margin-top:50px;border:1px dashed #999;width:220px;height:90px;float:right;text-align:center;font-size:11px;color:#777;padding-top:8px}
        </style></head><body>
          <div class="co"><b>${esc(cfg.companyName || '')}</b> ${cfg.nif ? '— NIF: ' + esc(cfg.nif) : ''} ${cfg.rc ? '— RC: ' + esc(cfg.rc) : ''}</div>
          <h1>RELEVÉ DE COMPTE</h1>
          <div class="meta">
            <div>Client : <b>${esc(customer.name)}</b> ${customer.phone ? '— ' + esc(customer.phone) : ''}</div>
            ${customer.nif ? `<div>NIF client : ${esc(customer.nif)}</div>` : ''}
            <div>Édité le : ${esc(new Date().toLocaleDateString())}</div>
          </div>
          <table>
            <thead><tr><th>Date</th><th>Document</th><th style="text-align:right">Montant</th><th style="text-align:right">Réglé</th><th style="text-align:right">Solde</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5">Aucun mouvement</td></tr>'}</tbody>
          </table>
          <div class="tot">Solde dû : ${balance.toLocaleString()} DA</div>
          <div class="cachet">Cachet & signature</div>
        </body></html>`

        const tempPath = path.join(app.getPath('temp'), `releve_${customerId}.html`)
        fs.writeFileSync(tempPath, html, 'utf-8')
        const win = new BrowserWindow({ show: false, width: 800, height: 1000, webPreferences: { nodeIntegration: false } })
        await win.loadFile(tempPath)
        await new Promise<void>(resolve => setTimeout(resolve, 800))
        const printerRow = getDatabase().prepare("SELECT value FROM config WHERE key = 'printer_config'").get() as { value: string } | undefined
        const printerName = printerRow ? (JSON.parse(printerRow.value).order || '') : ''
        const opts = { silent: true, printBackground: true, deviceName: printerName, pageSize: 'A4' as const, margins: { marginType: 'printableArea' as const } }
        return new Promise((resolve) => {
            win.webContents.print(opts, (success, errorType) => {
                if (success) { try { fs.unlinkSync(tempPath) } catch { /* */ } win.close(); resolve({ success: true }) }
                else win.webContents.print({ ...opts, deviceName: '' }, (ok, err) => { try { fs.unlinkSync(tempPath) } catch { /* */ } win.close(); resolve(ok ? { success: true } : { success: false, error: err || errorType }) })
            })
        })
    },

    // ---- Supplier accounts payable ----
    supplierBalance(supplierId: number): number {
        const db = getDatabase()
        const owed = (db.prepare("SELECT COALESCE(SUM(total_amount), 0) AS s FROM purchase_orders WHERE supplier_id = ? AND status IN ('received', 'partial')").get(supplierId) as { s: number }).s
        const paid = (db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM supplier_payments WHERE supplier_id = ?').get(supplierId) as { s: number }).s
        const returned = (db.prepare('SELECT COALESCE(SUM(total_amount), 0) AS s FROM supplier_returns WHERE supplier_id = ?').get(supplierId) as { s: number }).s
        return owed - paid - returned
    },
    addSupplierPayment(supplierId: number, amount: number, method = 'cash', reference?: string, notes?: string) {
        const db = getDatabase()
        db.prepare('INSERT INTO supplier_payments (supplier_id, amount, payment_method, reference_number, notes) VALUES (?, ?, ?, ?, ?)')
            .run(supplierId, amount, method, reference || null, notes || null)
        return { success: true, balance: this.supplierBalance(supplierId) }
    },
    supplierStatement(supplierId: number) {
        const db = getDatabase()
        const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId) as any
        const orders = db.prepare("SELECT po_number AS ref, total_amount, COALESCE(received_date, order_date) AS date FROM purchase_orders WHERE supplier_id = ? AND status IN ('received','partial') ORDER BY date").all(supplierId)
        const payments = db.prepare('SELECT amount, payment_method, created_at FROM supplier_payments WHERE supplier_id = ? ORDER BY created_at').all(supplierId)
        return { supplier, orders, payments, balance: this.supplierBalance(supplierId) }
    },

    // ---- Post-dated cheque register ----
    addCheque(c: { direction: 'incoming' | 'outgoing'; party_type?: string; party_id?: number; cheque_number?: string; bank?: string; amount: number; due_date?: string; notes?: string }) {
        const db = getDatabase()
        const res = db.prepare(`INSERT INTO post_dated_cheques (direction, party_type, party_id, cheque_number, bank, amount, due_date, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(c.direction, c.party_type || null, c.party_id || null, c.cheque_number || null, c.bank || null, c.amount, c.due_date || null, c.notes || null)
        return { id: res.lastInsertRowid as number }
    },
    listCheques(filter?: { direction?: string; status?: string }) {
        const db = getDatabase()
        let sql = 'SELECT * FROM post_dated_cheques WHERE 1=1'
        const params: any[] = []
        if (filter?.direction) { sql += ' AND direction = ?'; params.push(filter.direction) }
        if (filter?.status) { sql += ' AND status = ?'; params.push(filter.status) }
        sql += ' ORDER BY due_date ASC'
        return db.prepare(sql).all(...params) as any[]
    },
    updateChequeStatus(id: number, status: string) {
        getDatabase().prepare('UPDATE post_dated_cheques SET status = ? WHERE id = ?').run(status, id)
        return { success: true }
    },
}
