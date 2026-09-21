import type Database from 'better-sqlite3'
import { BrowserWindow, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getDatabase } from './database'
import { nextDocNumber } from './sequences'

function escapeHtml(s: any): string {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Multi-depot (Phase 4.6)
//
// Warehouse id 1 = main magasin, whose stock lives in stock_inventory (the POS
// authoritative source, left untouched). Any other warehouse stores stock in
// depot_stock. These helpers abstract that split so transfers and depot views
// can treat every location uniformly.
// ---------------------------------------------------------------------------

const MAIN_WAREHOUSE = 1

function readStock(db: Database.Database, warehouseId: number, productId: number): number {
    if (warehouseId === MAIN_WAREHOUSE) {
        const row = db.prepare('SELECT quantity FROM stock_inventory WHERE product_id = ? AND variant_id IS NULL').get(productId) as { quantity: number } | undefined
        return row?.quantity ?? 0
    }
    const row = db.prepare('SELECT quantity FROM depot_stock WHERE warehouse_id = ? AND product_id = ?').get(warehouseId, productId) as { quantity: number } | undefined
    return row?.quantity ?? 0
}

function adjustStock(db: Database.Database, warehouseId: number, productId: number, delta: number) {
    if (warehouseId === MAIN_WAREHOUSE) {
        const exists = db.prepare('SELECT 1 FROM stock_inventory WHERE product_id = ? AND variant_id IS NULL').get(productId)
        if (exists) {
            db.prepare("UPDATE stock_inventory SET quantity = quantity + ?, updated_at = datetime('now') WHERE product_id = ? AND variant_id IS NULL").run(delta, productId)
        } else {
            db.prepare('INSERT INTO stock_inventory (product_id, quantity) VALUES (?, ?)').run(productId, delta)
        }
        return
    }
    db.prepare(`
        INSERT INTO depot_stock (warehouse_id, product_id, quantity) VALUES (?, ?, ?)
        ON CONFLICT(warehouse_id, product_id) DO UPDATE SET quantity = quantity + excluded.quantity, updated_at = datetime('now')
    `).run(warehouseId, productId, delta)
}

export const WarehouseService = {
    list() {
        return getDatabase().prepare('SELECT * FROM warehouses WHERE is_active = 1 ORDER BY is_default DESC, name').all() as any[]
    },
    create(w: { name: string; type?: string; address?: string }) {
        const db = getDatabase()
        const res = db.prepare('INSERT INTO warehouses (name, type, address) VALUES (?, ?, ?)').run(w.name, w.type || 'depot', w.address || null)
        return { id: res.lastInsertRowid as number }
    },
    deactivate(id: number) {
        if (id === MAIN_WAREHOUSE) return { success: false, error: 'Cannot remove the main magasin.' }
        getDatabase().prepare('UPDATE warehouses SET is_active = 0 WHERE id = ?').run(id)
        return { success: true }
    },
    /** Stock of every product in a given warehouse (joined with product names). */
    stock(warehouseId: number) {
        const db = getDatabase()
        if (warehouseId === MAIN_WAREHOUSE) {
            return db.prepare(`
                SELECT p.id AS product_id, p.name AS product_name, COALESCE(si.quantity, 0) AS quantity
                FROM products p LEFT JOIN stock_inventory si ON p.id = si.product_id AND si.variant_id IS NULL
                WHERE p.is_active = 1 ORDER BY p.name
            `).all() as any[]
        }
        return db.prepare(`
            SELECT p.id AS product_id, p.name AS product_name, COALESCE(ds.quantity, 0) AS quantity
            FROM products p LEFT JOIN depot_stock ds ON p.id = ds.product_id AND ds.warehouse_id = ?
            WHERE p.is_active = 1 ORDER BY p.name
        `).all(warehouseId) as any[]
    },
    /** Move stock from one location to another and emit a Bon de transfert. */
    createTransfer(fromWarehouseId: number, toWarehouseId: number, items: { product_id: number; quantity: number }[], userId?: number, notes?: string) {
        const db = getDatabase()
        if (fromWarehouseId === toWarehouseId) return { success: false, error: 'Source and destination must differ.' }
        const clean = items.filter(i => i.product_id && i.quantity > 0)
        if (clean.length === 0) return { success: false, error: 'No items to transfer.' }

        const transferNumber = nextDocNumber('transfer', 'BT')
        const run = db.transaction(() => {
            const res = db.prepare('INSERT INTO transfer_orders (transfer_number, from_warehouse_id, to_warehouse_id, user_id, notes) VALUES (?, ?, ?, ?, ?)')
                .run(transferNumber, fromWarehouseId, toWarehouseId, userId || null, notes || null)
            const transferId = res.lastInsertRowid as number
            const insItem = db.prepare('INSERT INTO transfer_items (transfer_id, product_id, product_name, quantity) VALUES (?, ?, ?, ?)')
            const mv = db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, reason, reference_type, reference_id, user_id) VALUES (?, 'transfer', ?, ?, 'transfer', ?, ?)`)
            for (const it of clean) {
                const prod = db.prepare('SELECT name FROM products WHERE id = ?').get(it.product_id) as { name?: string } | undefined
                adjustStock(db, fromWarehouseId, it.product_id, -it.quantity)
                adjustStock(db, toWarehouseId, it.product_id, it.quantity)
                insItem.run(transferId, it.product_id, prod?.name || null, it.quantity)
                // Record BOTH legs so the movement ledger reconciles with on-hand totals.
                mv.run(it.product_id, -it.quantity, `Transfert ${transferNumber} — sortie dépôt ${fromWarehouseId}`, transferId, userId || null)
                mv.run(it.product_id, it.quantity, `Transfert ${transferNumber} — entrée dépôt ${toWarehouseId}`, transferId, userId || null)
            }
            return transferId
        })
        const id = run()
        return { success: true, id, transfer_number: transferNumber }
    },
    getTransfer(id: number) {
        const db = getDatabase()
        const order = db.prepare(`
            SELECT t.*, wf.name AS from_name, wt.name AS to_name
            FROM transfer_orders t
            LEFT JOIN warehouses wf ON wf.id = t.from_warehouse_id
            LEFT JOIN warehouses wt ON wt.id = t.to_warehouse_id
            WHERE t.id = ?
        `).get(id) as any
        if (!order) return null
        order.items = db.prepare('SELECT * FROM transfer_items WHERE transfer_id = ?').all(id)
        return order
    },
    listTransfers(limit = 50) {
        return getDatabase().prepare(`
            SELECT t.*, wf.name AS from_name, wt.name AS to_name
            FROM transfer_orders t
            LEFT JOIN warehouses wf ON wf.id = t.from_warehouse_id
            LEFT JOIN warehouses wt ON wt.id = t.to_warehouse_id
            ORDER BY t.id DESC LIMIT ?
        `).all(limit) as any[]
    },
    async printTransfer(id: number) {
        const t = this.getTransfer(id)
        if (!t) throw new Error('Transfer not found')

        const rows = (t.items || []).map((it: any, i: number) =>
            `<tr><td>${i + 1}</td><td>${escapeHtml(it.product_name || it.product_id)}</td><td style="text-align:right">${it.quantity}</td></tr>`).join('')
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bon de transfert ${escapeHtml(t.transfer_number)}</title>
        <style>
          body{font-family:Arial,sans-serif;padding:24px;color:#111}
          h1{font-size:20px;margin:0 0 4px}
          .meta{margin:12px 0;font-size:13px}
          table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
          th,td{border:1px solid #999;padding:6px 8px;text-align:left}
          th{background:#f0f0f0}
          .sign{margin-top:48px;display:flex;justify-content:space-between;font-size:13px}
        </style></head><body>
          <h1>BON DE TRANSFERT N° ${escapeHtml(t.transfer_number)}</h1>
          <div class="meta">
            <div>Date : ${escapeHtml(t.created_at)}</div>
            <div>De : <b>${escapeHtml(t.from_name)}</b> &nbsp;→&nbsp; Vers : <b>${escapeHtml(t.to_name)}</b></div>
            ${t.notes ? `<div>Note : ${escapeHtml(t.notes)}</div>` : ''}
          </div>
          <table><thead><tr><th style="width:40px">#</th><th>Désignation</th><th style="width:100px;text-align:right">Quantité</th></tr></thead>
          <tbody>${rows}</tbody></table>
          <div class="sign"><div>Expéditeur : __________________</div><div>Réceptionnaire : __________________</div></div>
        </body></html>`

        const tempPath = path.join(app.getPath('temp'), `transfer_${t.transfer_number}.html`)
        fs.writeFileSync(tempPath, html, 'utf-8')
        const printWin = new BrowserWindow({ show: false, width: 800, height: 1000, webPreferences: { nodeIntegration: false } })
        await printWin.loadFile(tempPath)
        await new Promise<void>(resolve => setTimeout(resolve, 800))
        const printerRow = getDatabase().prepare("SELECT value FROM config WHERE key = 'printer_config'").get() as { value: string } | undefined
        const printerName = printerRow ? (JSON.parse(printerRow.value).order || '') : ''
        const opts = { silent: true, printBackground: true, deviceName: printerName, pageSize: 'A4' as const, margins: { marginType: 'printableArea' as const } }
        return new Promise((resolve) => {
            printWin.webContents.print(opts, (success, errorType) => {
                if (success) { try { fs.unlinkSync(tempPath) } catch { /* */ } printWin.close(); resolve({ success: true }) }
                else {
                    printWin.webContents.print({ ...opts, deviceName: '' }, (ok, err) => {
                        try { fs.unlinkSync(tempPath) } catch { /* */ } printWin.close()
                        resolve(ok ? { success: true } : { success: false, error: err || errorType })
                    })
                }
            })
        })
    },
    _readStock: readStock,
}
