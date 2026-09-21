import { getDatabase } from './database'
import { StockService } from './stockService'
import { BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { ReceiptService } from './receiptService'
import { escapeHtml } from './util/escapeHtml'
import { brandLogoImg } from './util/brandLogo'
import { nextDocNumber } from './sequences'

export interface PurchaseOrder {
    id: number
    po_number: string
    supplier_id: number
    status: 'pending' | 'partial' | 'received' | 'cancelled'
    order_date: string
    expected_date?: string
    received_date?: string
    subtotal: number
    tax_amount: number
    total_amount: number
    notes?: string
    created_by: number
    supplier_name?: string
}

export interface PurchaseOrderItem {
    id: number
    purchase_order_id: number
    product_id: number
    variant_id?: number
    quantity_ordered: number
    quantity_received: number
    unit?: string
    unit_cost: number
    total_cost: number
    product_name?: string
    sku?: string
}

export const PurchaseOrderService = {
    generatePONumber() {
        const date = new Date()
        const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '')
        const random = Math.random().toString(36).substring(2, 6).toUpperCase()
        return `PO-${dateStr}-${random}`
    },

    // --- Import lot / landed-cost allocation (Phase 4.10) ---
    // Spread freight/customs/handling across a PO's lines (by value) and update each
    // product's cost_price to the resulting landed unit cost.
    applyLandedCost(poId: number, extraCost: number) {
        const db = getDatabase()
        const po = this.getById(poId)
        if (!po) return { success: false, error: 'Order not found.' }
        const items = po.items as any[]
        const totalValue = items.reduce((s, it) => s + (it.unit_cost || 0) * (it.quantity_ordered || 0), 0)
        if (totalValue <= 0) return { success: false, error: 'Order has no value to allocate against.' }
        const run = db.transaction(() => {
            for (const it of items) {
                const lineValue = (it.unit_cost || 0) * (it.quantity_ordered || 0)
                const share = extraCost * (lineValue / totalValue)
                const perUnit = it.quantity_ordered > 0 ? share / it.quantity_ordered : 0
                const landed = (it.unit_cost || 0) + perUnit
                db.prepare("UPDATE products SET cost_price = ?, updated_at = datetime('now') WHERE id = ?").run(landed, it.product_id)
            }
        })
        run()
        return { success: true, allocated: extraCost }
    },

    // --- Supplier returns / retour fournisseur (Phase 4.8) ---
    createReturn(supplierId: number | null, items: { product_id: number; quantity: number; unit_cost?: number }[], userId: number, reason?: string) {
        const db = getDatabase()
        const clean = (items || []).filter(i => i.product_id && i.quantity > 0)
        if (clean.length === 0) return { success: false, error: 'No items to return.' }
        const returnNumber = nextDocNumber('supplier_return', 'RETF')
        const total = clean.reduce((s, i) => s + (i.unit_cost || 0) * i.quantity, 0)
        const run = db.transaction(() => {
            const res = db.prepare('INSERT INTO supplier_returns (return_number, supplier_id, user_id, total_amount, reason) VALUES (?, ?, ?, ?, ?)')
                .run(returnNumber, supplierId || null, userId, total, reason || null)
            const id = res.lastInsertRowid as number
            const insItem = db.prepare('INSERT INTO supplier_return_items (return_id, product_id, product_name, quantity, unit_cost) VALUES (?, ?, ?, ?, ?)')
            for (const it of clean) {
                const prod = db.prepare('SELECT name FROM products WHERE id = ?').get(it.product_id) as { name?: string } | undefined
                // Let an insufficient-stock throw roll back the WHOLE return (no orphan record).
                StockService.adjustStock(it.product_id, it.quantity, 'out', userId, `Retour fournisseur ${returnNumber}`, `RETF ID: ${id}`)
                insItem.run(id, it.product_id, prod?.name || null, it.quantity, it.unit_cost || 0)
            }
            return id
        })
        try {
            const id = run()
            return { success: true, id, return_number: returnNumber }
        } catch (e: any) {
            return { success: false, error: e?.message || 'Retour impossible (stock insuffisant ?).' }
        }
    },
    listReturns(limit = 50) {
        return getDatabase().prepare(`
            SELECT r.*, s.company_name AS supplier_name FROM supplier_returns r
            LEFT JOIN suppliers s ON s.id = r.supplier_id ORDER BY r.id DESC LIMIT ?
        `).all(limit) as any[]
    },

    async create(userId: number, supplierId: number, items: any[], notes?: string) {
        const db = getDatabase()
        const poNumber = nextDocNumber('purchase_order', 'PO')

        const subtotal = items.reduce((sum, item) => sum + (item.unitCost * item.quantity), 0)
        const totalAmount = subtotal // Assuming no tax for now or 0

        const result = db.prepare(`
            INSERT INTO purchase_orders (po_number, supplier_id, created_by, subtotal, total_amount, notes, status)
            VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `).run(poNumber, supplierId, userId, subtotal, totalAmount, notes || null)

        const poId = result.lastInsertRowid as number

        for (const item of items) {
            db.prepare(`
                INSERT INTO purchase_order_items (purchase_order_id, product_id, variant_id, quantity_ordered, unit, unit_cost, total_cost)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(poId, item.productId, item.variantId || null, item.quantity, item.unit || 'piece', item.unitCost, item.unitCost * item.quantity)
        }

        return { id: poId, po_number: poNumber }
    },

    getAll() {
        const db = getDatabase()
        return db.prepare(`
            SELECT po.*, s.company_name as supplier_name
            FROM purchase_orders po
            JOIN suppliers s ON po.supplier_id = s.id
            ORDER BY po.created_at DESC
        `).all() as PurchaseOrder[]
    },

    getById(id: number) {
        const db = getDatabase()
        const po = db.prepare(`
            SELECT po.*, s.company_name as supplier_name, s.address as supplier_address, s.phone as supplier_phone, s.email as supplier_email
            FROM purchase_orders po
            JOIN suppliers s ON po.supplier_id = s.id
            WHERE po.id = ?
        `).get(id) as any

        if (po) {
            // pv.size/color let the UI and the printed BC say *which* size/colour was
            // ordered; variant_label is the ready-made "M / Noir" suffix.
            po.items = db.prepare(`
                SELECT poi.*, p.name as product_name, p.sku,
                       pv.size AS variant_size, pv.color AS variant_color,
                       TRIM(COALESCE(pv.size, '') || CASE WHEN COALESCE(pv.size,'') <> '' AND COALESCE(pv.color,'') <> '' THEN ' / ' ELSE '' END || COALESCE(pv.color, '')) AS variant_label
                FROM purchase_order_items poi
                JOIN products p ON poi.product_id = p.id
                LEFT JOIN product_variants pv ON pv.id = poi.variant_id
                WHERE poi.purchase_order_id = ?
            `).all(id)
        }

        return po
    },

    async receive(id: number, userId: number) {
        const db = getDatabase()
        const po = this.getById(id)

        if (!po) throw new Error('Order not found')
        if (po.status === 'received') return { success: false, error: 'Order already received' }

        // Receive only the outstanding reliquat (handles a prior partial receipt).
        for (const item of po.items) {
            const remaining = (item.quantity_ordered || 0) - (item.quantity_received || 0)
            if (remaining > 0) {
                try {
                    StockService.adjustStock(
                        item.product_id,
                        remaining,
                        'in',
                        userId,
                        `Purchase Order Received: ${po.po_number}`,
                        `PO ID: ${id}`,
                        item.variant_id
                    )
                } catch (stockError) {
                    console.error(`[PO Service] Failed to receive stock for product ${item.product_id}:`, stockError)
                }
            }
            db.prepare('UPDATE purchase_order_items SET quantity_received = quantity_ordered WHERE id = ?').run(item.id)
        }

        db.prepare('UPDATE purchase_orders SET status = ?, received_date = ? WHERE id = ?')
            .run('received', new Date().toISOString(), id)

        return { success: true }
    },

    /** Partial reception (Bon de réception with reliquat). lines: per-item received qty. */
    async receivePartial(id: number, userId: number, lines: { item_id: number; quantity: number }[]) {
        const db = getDatabase()
        const po = this.getById(id)
        if (!po) return { success: false, error: 'Order not found' }
        if (po.status === 'received') return { success: false, error: 'Order already fully received' }

        const byId = new Map(lines.map(l => [l.item_id, l.quantity]))
        for (const item of po.items) {
            const want = Number(byId.get(item.id) || 0)
            if (want <= 0) continue
            const remaining = (item.quantity_ordered || 0) - (item.quantity_received || 0)
            const toReceive = Math.min(want, remaining)
            if (toReceive <= 0) continue
            try {
                StockService.adjustStock(item.product_id, toReceive, 'in', userId, `PO partial reception: ${po.po_number}`, `PO ID: ${id}`, item.variant_id)
            } catch (e) {
                console.error(`[PO Service] partial receive failed for product ${item.product_id}:`, e)
            }
            db.prepare('UPDATE purchase_order_items SET quantity_received = quantity_received + ? WHERE id = ?').run(toReceive, item.id)
        }

        // Recompute status from the updated reliquat.
        const items = db.prepare('SELECT quantity_ordered, quantity_received FROM purchase_order_items WHERE purchase_order_id = ?').all(id) as any[]
        const allDone = items.every(it => (it.quantity_received || 0) >= (it.quantity_ordered || 0))
        db.prepare('UPDATE purchase_orders SET status = ?, received_date = ? WHERE id = ?')
            .run(allDone ? 'received' : 'partial', allDone ? new Date().toISOString() : null, id)
        return { success: true, status: allDone ? 'received' : 'partial' }
    },

    generatePOHTML(po: any): string {
        const config = ReceiptService.getConfig()

        // Ensure signature is loaded if not provided
        if (!po.adminSignature) {
            po.adminSignature = ReceiptService.getAdminSignature()
        }

        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Purchase Order ${escapeHtml(po.po_number)}</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 0; margin: 0; color: #000; line-height: 1.1; background: #fff; font-size: 13px; }
        .page-container { padding: 12mm 15mm; min-height: 250mm; }
        
        .header-branding { display: grid; grid-template-columns: 1fr 2fr 1fr; align-items: start; margin-bottom: 20px; border-bottom: 1px solid #000; padding-bottom: 10px; }
        .branding-left { text-align: left; font-size: 0.9em; font-weight: bold; line-height: 1.3; }
        .branding-center { text-align: center; }
        .branding-right { text-align: right; }
        .branding-right img { max-height: 80px; }

        .brand-corp { font-size: 1.1em; font-weight: bold; }
        .brand-boss { font-size: 1.3em; font-weight: 1000; margin: 2px 0; }
        .brand-loc { font-size: 1em; }

        .info-grid { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 15px; }
        .supplier-box { border: 2px solid #000; padding: 10px; border-radius: 12px; width: 250px; text-align: left; }
        .supplier-box b { text-decoration: underline; font-size: 1.1em; }

        .signature-area { margin-top: 30px; display: flex; justify-content: flex-end; }
        .signature-box { padding: 12px; width: 450px; height: 250px; text-align: center; }
        .signature-box b { text-decoration: underline; font-size: 1.1em; margin-bottom: 25px; display: block; }

        table.items-table { width: 100%; border-collapse: collapse; margin-top: 10px; border: 2.5px solid #000; }
        table.items-table th, table.items-table td { border: 2px solid #000; padding: 5px 8px; text-align: left; }
        table.items-table th { background: #eee; font-weight: 1000; font-size: 0.95em; text-align: center; }
        .text-right { text-align: right; }
        .text-center { text-align: center; }
        
        .meta-line { display: block; font-size: 1.2em; font-weight: bold; margin: 3px 0; }

        .info-boxes { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0; }
        .box { border: 2.5px solid #000; padding: 12px; border-radius: 12px; height: 110px; }
        .box b { text-decoration: underline; font-size: 1.2em; display: block; margin-bottom: 8px; }

        table { width: 100%; border-collapse: collapse; margin-top: 5px; }
        th, td { border: 1.5px solid #000; padding: 6px 10px; text-align: left; font-size: 1em; }
        th { background: #eee; font-weight: 900; }
        .text-right { text-align: right; }
        
        .footer-notes { margin-top: 15px; font-size: 0.9em; border-top: 1px solid #000; padding-top: 5px; }
        
        @media print {
            .receipt-half { border-bottom: 1px dashed #000; }
            @page { margin: 0; size: A4; }
        }
        
        .totals { margin-left: auto; width: 300px; }
        .total-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9; }
        .total-row.grand-total { border-top: 2px solid #2563eb; border-bottom: none; font-weight: bold; font-size: 18px; color: #2563eb; margin-top: 10px; }
        
        .footer { margin-top: 100px; border-top: 1px solid #e2e8f0; padding-top: 20px; font-size: 12px; color: #94a3b8; text-align: center; }
        @media print {
            body { padding: 0; }
            .no-print { display: none; }
        }
    </style>
</head>
<body>
    <div class="page-container">
        <div class="header-branding">
            <div class="branding-left">
                <div>${escapeHtml(config.companyPhone || '')}</div>
                ${config.nif ? `<div>NIF: ${escapeHtml(config.nif)}</div>` : ''}
            </div>
            <div class="branding-center">
                <div class="brand-corp">${escapeHtml(config.formeJuridique || '')}</div>
                <div class="brand-boss">${escapeHtml(config.companyName || '')}</div>
                <div class="brand-loc">${escapeHtml(config.companyAddress || '')}</div>
            </div>
            <div class="branding-right">
                ${brandLogoImg(34)}
            </div>
        </div>

        <div class="info-grid">
            <div class="supplier-box">
                <b>FOURNISSEUR:</b><br>
                <div style="font-size: 1.1em; font-weight: bold; margin-top: 5px;">${escapeHtml(po.supplier_name)}</div>
                <div style="margin-top: 3px;">${escapeHtml(po.supplier_phone || '')}</div>
            </div>
        </div>

        <div class="main-content">
            <div style="text-align: center; margin-bottom: 15px;">
                <h1 style="margin: 0; font-size: 2em; text-decoration: underline;">${po.status === 'received' ? 'BON DE RÈGLEMENT' : 'BON DE COMMANDE'}</h1>
            </div>
            
            <div class="doc-meta-right">
                <div style="display: flex; justify-content: space-between; align-items: flex-end;">
                    <div><b>CHAUFFEUR:</b> Lemssara sbeaa</div>
                    <div style="text-align: right;">
                        N°: ${escapeHtml(po.po_number.split('-').pop())}<br>
                        Date: ${new Date(po.created_at).toLocaleDateString('fr-FR')} | Heure: ${new Date(po.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </div>
                </div>
            </div>

            <table class="items-table">
            <thead>
                <tr>
                    <th width="40px" class="text-center">N°</th>
                    <th>Désignation</th>
                    <th width="1%" style="white-space: nowrap;" class="text-center">Quantité</th>
                </tr>
            </thead>
            <tbody>
                ${po.items.map((item: any, index: number) => `
                    <tr>
                        <td class="text-center">${index + 1}</td>
                        <td><b>${escapeHtml(item.product_name)}</b>${item.variant_label ? ` <span style="font-weight:normal;">(${escapeHtml(item.variant_label)})</span>` : ''}</td>
                        <td class="text-center"><b>${item.quantity_ordered} ${escapeHtml(item.unit || '')}</b></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>

        ${po.notes ? `
        <div class="footer-notes">
            <b>Notes:</b> ${escapeHtml(po.notes)}
        </div>` : ''}

        <div class="signature-area">
            <div class="signature-box">
                <b>Cachet et Signature</b>
                ${po.adminSignature ? (
                po.adminSignature.startsWith('data:image/')
                    ? `<img src="${encodeURI(po.adminSignature)}" style="max-height: 240px; max-width: 400px; margin-top: 5px;">`
                    : `<div style="margin-top: 10px; font-weight: bold; font-style: italic; font-size: 1.2em;">${escapeHtml(po.adminSignature)}</div>`
            ) : ''}
            </div>
        </div>
    </div>
</body>
</html>
        `.trim()
    },

    async printPO(poId: number) {
        const po = this.getById(poId)
        if (!po) throw new Error('Purchase Order not found')

        const html = this.generatePOHTML(po)
        const tempPath = path.join(app.getPath('temp'), `order_${po.po_number}.html`)
        fs.writeFileSync(tempPath, html, 'utf-8')

        const printWin = new BrowserWindow({
            show: false,
            width: 800,
            height: 1000,
            title: `Order ${po.po_number} - Preview`,
            webPreferences: {
                nodeIntegration: false
            }
        })

        await printWin.loadFile(tempPath)

        // Wait for rendering
        await new Promise<void>(resolve => setTimeout(resolve, 1000))

        const currentDb = getDatabase()
        const printerRow = currentDb.prepare("SELECT value FROM config WHERE key = 'printer_config'").get() as { value: string } | undefined
        const printerName = printerRow ? JSON.parse(printerRow.value).order : ''

        const printOptions = {
            silent: true,
            printBackground: true,
            deviceName: printerName,
            pageSize: 'A4' as const,
            margins: { marginType: 'printableArea' as const }
        }

        return new Promise((resolve) => {
            printWin.webContents.print(printOptions, (success, errorType) => {
                if (success) {
                    try { fs.unlinkSync(tempPath) } catch (e) { }
                    printWin.close()
                    resolve({ success: true })
                } else {
                    console.warn(`[PO Print] Failed with '${printOptions.deviceName}', trying default printer...`, errorType)

                    // Fallback to default printer (no deviceName)
                    const fallbackOptions = { ...printOptions, deviceName: '' }
                    printWin.webContents.print(fallbackOptions, (successFallback, errorFallback) => {
                        try { fs.unlinkSync(tempPath) } catch (e) { }
                        printWin.close()
                        if (successFallback) {
                            console.log('[PO Print] Success with default printer')
                            resolve({ success: true })
                        } else {
                            console.error('[PO Print] Final failure:', errorFallback)
                            resolve({ success: false, error: errorFallback })
                        }
                    })
                }
            })
        })
    },

    async printPOFromData(po: any) {
        console.log(`[PurchaseOrderService] Printing PO from raw data: ${po.po_number}`)
        if (!po.items || po.items.length === 0) {
            console.error('[PurchaseOrderService] Cannot print PO: No items provided')
            throw new Error('PO has no items')
        }

        const html = this.generatePOHTML(po)
        const tempPath = path.join(app.getPath('temp'), `order_raw_${Date.now()}.html`)
        fs.writeFileSync(tempPath, html, 'utf-8')
        console.log(`[PurchaseOrderService] Wrote temp raw print file: ${tempPath}`)

        const printWin = new BrowserWindow({
            show: false,
            width: 800,
            height: 1000,
            webPreferences: { nodeIntegration: false }
        })

        await printWin.loadFile(tempPath)
        await new Promise<void>(resolve => setTimeout(resolve, 1200))

        const currentDb = getDatabase()
        const printerRow = currentDb.prepare("SELECT value FROM config WHERE key = 'printer_config'").get() as { value: string } | undefined
        const printerName = printerRow ? JSON.parse(printerRow.value).order : ''

        const printOptions = {
            silent: true,
            printBackground: true,
            deviceName: printerName,
            pageSize: 'A4' as const,
            margins: { marginType: 'printableArea' as const }
        }

        return new Promise((resolve) => {
            printWin.webContents.print(printOptions, (success, errorType) => {
                try { fs.unlinkSync(tempPath) } catch (e) { }
                if (success) {
                    console.log('[PO Print Raw] Success!')
                    printWin.close()
                    resolve({ success: true })
                } else {
                    console.warn(`[PO Print Raw] Failed with primary printer, trying default...`, errorType)
                    const fallbackOptions = { ...printOptions, deviceName: '' }
                    printWin.webContents.print(fallbackOptions, (success2) => {
                        printWin.close()
                        resolve({ success: success2 })
                    })
                }
            })
        })
    }
}
