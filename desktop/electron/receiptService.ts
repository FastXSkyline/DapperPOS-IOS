import path from 'node:path'
import fs from 'node:fs'
import { BrowserWindow, app } from 'electron'
import { getDatabase } from './database'
import { escapeHtml } from './util/escapeHtml'
import { brandLogoImg } from './util/brandLogo'

export interface ReceiptConfig {
  companyName: string
  companyAddress: string
  companyPhone: string
  companyEmail: string
  logoPath: string | null
  taxId: string | null
  // Algerian fiscal identity (décret 05-468) — drives all printed documents.
  nif: string
  nis: string
  rc: string
  articleImposition: string
  capital: string
  formeJuridique: string
  bankAccount: string
  showTaxBreakdown: boolean
  footerMessage: string
  paperWidth: 58 | 80 // mm
  headerAlignment: 'left' | 'center' | 'right'
  fontSize: number
  showLogo: boolean
  customNote: string
  // Localization (Phase 6.1)
  bilingualArabic?: boolean   // print Arabic alongside French (Loi 91-05)
  easternNumerals?: boolean   // ٠١٢٣ instead of 0123
}

export interface ReceiptData {
  transactionNumber: string
  date: string
  cashierName: string
  customerName: string | null
  items: {
    name: string
    quantity: number
    /** What the line actually sold for, per unit. */
    unitPrice: number
    /**
     * The shelf price BEFORE a promotion or quantity break, when one applied.
     * Present only when it is genuinely higher than unitPrice, so the templates
     * can print it struck through — "you paid less than the ticket said" is the
     * one thing a customer checks on the way out, and a receipt that hides it
     * makes a promotion invisible at exactly the moment it should land.
     */
    originalUnitPrice?: number
    total: number
    discount?: number
    taxRate?: number
    taxAmount?: number
    unit?: string
    unitFactor?: number
  }[]
  subtotal: number
  discount: number
  tax: number
  total: number
  payments: {
    method: string
    amount: number
  }[]
  change: number
  adminSignature?: string | null
  timbre?: number
  isCreditNote?: boolean
  // Optional buyer fiscal identifiers (B2B facture) — populated from the customer.
  fiscalId?: string
  rc?: string
  nis?: string
  ai?: string
  customerPhone?: string
}

// Default config
const DEFAULT_CONFIG: ReceiptConfig = {
  companyName: '',
  companyAddress: '',
  companyPhone: '',
  companyEmail: '',
  // Legacy field. The wordmark now comes from util/brandLogo.ts so every
  // document — receipt, facture, bon de commande, rapport — carries the same
  // mark from one source. `showLogo` still switches it off; this path is no
  // longer read. (The file it pointed at was the previous business's logo.)
  logoPath: null,
  taxId: null,
  nif: '',
  nis: '',
  rc: '',
  articleImposition: '',
  capital: '',
  formeJuridique: '',
  bankAccount: '',
  showTaxBreakdown: true,
  footerMessage: 'Merci pour votre confiance !',
  paperWidth: 80,
  headerAlignment: 'center',
  fontSize: 12,
  showLogo: true,
  customNote: '',
  bilingualArabic: false,
  easternNumerals: false
}

export const ReceiptService = {
  getConfig(): ReceiptConfig {
    const db = getDatabase()
    const row = db.prepare("SELECT value FROM config WHERE key = 'receipt_config'").get() as { value: string } | undefined
    console.log('[ReceiptService] Fetched config row:', row ? 'FOUND' : 'NOT FOUND', row?.value)
    if (row) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(row.value) }
    }
    return DEFAULT_CONFIG
  },

  saveConfig(config: Partial<ReceiptConfig>) {
    const db = getDatabase()
    const current = this.getConfig()
    const updated = { ...current, ...config }
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('receipt_config', ?)").run(JSON.stringify(updated))
    return updated
  },

  getAdminSignature(): string | null {
    const db = getDatabase()
    const row = db.prepare("SELECT value FROM config WHERE key = 'admin_signature'").get() as { value: string } | undefined
    return row?.value || null
  },

  generateReceiptText(data: ReceiptData): string {
    const config = this.getConfig()
    const width = config.paperWidth === 58 ? 32 : 48
    const line = '='.repeat(width)
    const dottedLine = '-'.repeat(width)

    const centerText = (text: string) => {
      const padding = Math.max(0, Math.floor((width - text.length) / 2))
      return ' '.repeat(padding) + text
    }

    const formatLine = (left: string, right: string) => {
      const spaces = Math.max(1, width - left.length - right.length)
      return left + ' '.repeat(spaces) + right
    }

    const lines: string[] = [
      line,
      // The plain-text path drives ESC/POS printers that cannot take an image,
      // so the wordmark is set as spaced capitals rather than dropped.
      centerText('D A P P E R'),
      line,
      centerText(config.companyName),
      centerText(config.companyAddress),
      centerText(config.companyPhone),
      line,
      '',
      `Date: ${data.date}`,
      `Receipt: ${data.transactionNumber}`,
      `Cashier: ${data.cashierName}`,
    ]

    if (data.customerName) {
      lines.push(`Customer: ${data.customerName}`)
    }

    lines.push('', dottedLine, '')

    // Items
    data.items.forEach(item => {
      lines.push(item.name.substring(0, width))
      const u = item.unit ? ` ${item.unit}` : ''
      const f = item.unitFactor && item.unitFactor > 1 ? item.unitFactor : 1
      const dq = item.quantity / f          // quantity in the selling unit
      const up = item.unitPrice * f         // price per selling unit (so dq × up = line total)
      const qty = `  ${dq}${u} x ${up.toFixed(2)} DZD`
      const total = `${item.total.toFixed(2)} DZD`
      lines.push(formatLine(qty, total))
      // Monospace paper cannot strike text through, so the saving is stated in
      // words instead — the customer still sees what the ticket said and what
      // they actually paid.
      if (item.originalUnitPrice != null) {
        const was = item.originalUnitPrice * f
        lines.push(formatLine(`    Prix normal ${was.toFixed(2)}`, `PROMO -${((was - up) * dq).toFixed(2)} DZD`))
      }
      if (item.discount && item.discount > 0) {
        lines.push(formatLine('    Remise:', `-${item.discount.toFixed(2)} DZD`))
      }
    })

    lines.push('', dottedLine, '')

    // Totals
    lines.push(formatLine('Sous-total:', `${data.subtotal.toFixed(2)} DZD`))
    if (data.discount > 0) {
      lines.push(formatLine('Remise:', `-${data.discount.toFixed(2)} DZD`))
    }
    if (config.showTaxBreakdown && data.tax > 0) {
      lines.push(formatLine('TVA:', `${data.tax.toFixed(2)} DZD`))
    }
    lines.push(line)
    lines.push(formatLine('TOTAL:', `${data.total.toFixed(2)} DZD`))
    lines.push(line, '')

    // Payments
    data.payments.forEach(p => {
      lines.push(formatLine(`${p.method}:`, `${p.amount.toFixed(2)} DZD`))
    })
    if (data.change > 0) {
      lines.push(formatLine('Change:', `${data.change.toFixed(2)} DZD`))
    }

    lines.push('', dottedLine, '')
    lines.push(centerText(config.footerMessage))
    lines.push('')
    lines.push('', line)

    return lines.join('\n')
  },

  generateReceiptHTML(data: ReceiptData): string {
    const config = this.getConfig()

    // Ensure signature is loaded if not provided
    if (!data.adminSignature) {
      data.adminSignature = this.getAdminSignature()
    }

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: monospace, 'Courier New'; 
      font-size: ${config.fontSize}px; 
      width: ${config.paperWidth === 80 ? '72mm' : '48mm'}; /* Use printable width instead of paper width */
      padding: 5mm 2mm 2mm 2mm;
      margin: 0 auto;
      color: #000;
    }
    .center { text-align: center; }
    .right { text-align: right; }
    .bold { font-weight: bold; }
    .line { border-top: 1px solid #000; margin: 4px 0; height: 1px; }
    .dashed-line { border-top: 1px dashed #000; margin: 4px 0; height: 1px; }
    .big { font-size: ${config.fontSize + 1}px; font-weight: bold; }
    .huge { font-size: ${config.fontSize + 3}px; font-weight: 1000; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 1px 0; font-size: 0.95em; }
    th { text-align: center; font-size: 0.9em; border-bottom: 1px solid #000; }
    .bordered-box { border: 1.5px solid #000; padding: 4px; margin: 5px 0; }
    
    .signature-row { margin-top: 15px; text-align: right; font-size: 0.85em; font-weight: bold; text-decoration: underline; }
    
    .brand-grid { text-align: center; margin-bottom: 5px; border-bottom: 1px solid #000; padding-bottom: 4px; }
    .brand-info { line-height: 1.1; }
    .brand-info .corp { font-size: 0.95em; font-weight: bold; }
    .brand-info .boss { font-size: 1.25em; font-weight: bold; }
    .brand-info .loc { font-size: 1.1em; }
 
    .contact-block { text-align: left; font-size: 0.85em; font-weight: bold; margin-bottom: 5px; line-height: 1.2; }

    /* The wordmark. Printed on every document, from the same source as the
       on-screen mark (util/brandLogo.ts). Transparent background by
       construction, so it sits on the paper rather than in a white box. */
    .brand-logo { margin: 0 auto 4px; }

    /* A discounted line prints the ticket price struck through beside what the
       customer actually paid. Thermal paper has no colour, so the saving has to
       read from the strike and the word "Promo", never from a tint. */
    .was { text-decoration: line-through; opacity: 0.75; margin-right: 4px; }
    .promo-tag { font-weight: bold; }
    .saved-row td { padding-top: 0; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="brand-grid">
    ${config.showLogo ? brandLogoImg(config.paperWidth === 80 ? 34 : 26, 'margin-bottom:4px;') : ''}
    <div class="brand-info">
      <div class="corp">${escapeHtml(config.formeJuridique || '')}</div>
      <div class="boss">${escapeHtml(config.companyName || '')}</div>
      <div class="loc">${escapeHtml(config.companyAddress || '')}</div>
      ${config.nif || config.rc ? `<div class="loc" style="font-size:0.8em;">${config.nif ? `NIF: ${escapeHtml(config.nif)}` : ''}${config.nif && config.rc ? ' · ' : ''}${config.rc ? `RC: ${escapeHtml(config.rc)}` : ''}</div>` : ''}
    </div>
  </div>
 
  <div class="line"></div>
  
  <div class="center big" style="text-decoration: underline;">BON DE LIVRAISON</div>
  <div style="display:flex; justify-content: space-between; font-size: 0.9em; margin-bottom: 5px;">
    <span><b>N°:</b> ${escapeHtml(data.transactionNumber)}</span>
  </div>
  <div style="display:flex; justify-content: space-between; font-size: 0.9em; margin-bottom: 5px;">
    <span><b>Le:</b> ${escapeHtml(data.date)}</span>
  </div>
  ${data.customerName ? `<div class="bordered-box"><b>Nom du client:</b> ${escapeHtml(data.customerName)}</div>` : ''}
  
  <div class="line"></div>
  
  <table style="margin-top: 5px;">
    <thead>
      <tr>
        <th width="20px">N°</th>
        <th>Désignation</th>
        <th width="30px" class="right">Qté</th>
        <th width="60px" class="right">Total</th>
      </tr>
    </thead>
    ${data.items.map((item, index) => {
      const factor = item.unitFactor && item.unitFactor > 1 ? item.unitFactor : 1
      const shownQty = item.quantity / factor
      const paid = item.unitPrice * factor
      const was = item.originalUnitPrice != null ? item.originalUnitPrice * factor : null
      const saved = was != null ? (was - paid) * shownQty : 0
      return `
      <tr>
        <td>${index + 1}</td>
        <td><b>${escapeHtml(item.name)}</b></td>
        <td class="right">${shownQty}${item.unit ? ' ' + escapeHtml(item.unit) : ''}</td>
        <td class="right">${item.total.toFixed(2)}</td>
      </tr>
      ${was != null ? `
      <tr class="saved-row">
        <td></td>
        <td colspan="3">
          <span class="was">${was.toFixed(2)}</span>
          <span class="promo-tag">${paid.toFixed(2)} DZD</span>
          &nbsp;· PROMO −${saved.toFixed(2)}
        </td>
      </tr>` : ''}`
    }).join('')}
  </table>
  
  <div class="line"></div>
  
  <table>
    <tr><td>Subtotal</td><td class="right">${data.subtotal.toFixed(2)} DZD</td></tr>
    ${data.discount > 0 ? `<tr><td>Remise</td><td class="right">-${data.discount.toFixed(2)} DZD</td></tr>` : ''}
    ${data.tax > 0 ? `<tr><td>Tax</td><td class="right">${data.tax.toFixed(2)} DZD</td></tr>` : ''}
  </table>
  
  <div class="line"></div>
  <table><tr><td class="bold big">TOTAL</td><td class="right bold big">${data.total.toFixed(2)} DZD</td></tr></table>
  <div class="line"></div>
  
  ${data.payments.map(p => `<div>${escapeHtml(p.method)}: ${p.amount.toFixed(2)} DZD</div>`).join('')}
  ${data.change > 0 ? `<div>Change: ${data.change.toFixed(2)} DZD</div>` : ''}

  <div class="line"></div>

  <div class="center">${escapeHtml(config.footerMessage)}</div>

  ${data.adminSignature ? `
  <div class="signature-row" style="margin-top: 15px;">
    Cachet et Signature<br>
    ${data.adminSignature.startsWith('data:image/')
          ? `<img src="${encodeURI(data.adminSignature)}" style="max-height: 180px; max-width: 250px; margin-top: 5px;">`
          : `<span style="font-style: italic; font-size: 1.1em;">${escapeHtml(data.adminSignature)}</span>`
        }
  </div>` : ''}
</body>
</html>
    `.trim()
  },

  async generateReceiptDataFromTransaction(transactionId: number): Promise<ReceiptData> {
    const db = getDatabase()
    const txn = db.prepare(`
      SELECT t.*, c.name as customer_name, u.name as cashier_name
      FROM transactions t
      LEFT JOIN customers c ON t.customer_id = c.id
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.id = ?
    `).get(transactionId) as any

    const items = db.prepare(`
      SELECT * FROM transaction_items WHERE transaction_id = ?
    `).all(transactionId) as any[]

    const payments = db.prepare(`
      SELECT * FROM payments WHERE transaction_id = ?
    `).all(transactionId) as any[]

    return {
      transactionNumber: txn.transaction_number,
      date: txn.completed_at || txn.created_at,
      cashierName: txn.cashier_name || 'System',
      customerName: txn.customer_name || null,
      items: items.map(i => ({
        name: i.product_name,
        quantity: i.quantity,
        unitPrice: i.unit_price,
        // base_unit_price is the pre-promotion, pre-quantity-break price
        // (transactionService.addItem). It is only a DISCOUNT when it is
        // actually higher — for most lines the two are equal, and printing a
        // struck-through identical price would be noise on every receipt.
        originalUnitPrice: (i.base_unit_price != null && i.base_unit_price > i.unit_price)
          ? i.base_unit_price
          : undefined,
        total: i.line_total,
        discount: i.discount_amount || 0,
        taxRate: i.tax_rate || 0,
        taxAmount: i.tax_amount || 0,
        unit: i.unit || '',
        unitFactor: i.unit_factor || 1
      })),
      subtotal: txn.subtotal,
      discount: txn.discount_amount,
      tax: txn.tax_amount,
      total: txn.total_amount,
      payments: payments.map(p => ({
        method: p.payment_method,
        amount: p.amount
      })),
      change: txn.change_due || 0,
      timbre: txn.timbre || 0,
      isCreditNote: txn.status === 'refunded' || String(txn.transaction_number || '').startsWith('AV-'),
      adminSignature: this.getAdminSignature()
    }
  },



  async print(data: ReceiptData): Promise<{ success: boolean; error?: string }> {
    const html = this.generateReceiptHTML(data)
    console.log('[ReceiptService] Generating receipt, HTML length:', html.length)

    // Write HTML to temp file
    const tempPath = path.join(app.getPath('temp'), `receipt_${Date.now()}.html`)
    fs.writeFileSync(tempPath, html, 'utf-8')
    console.log('[ReceiptService] Wrote temp file:', tempPath)

    try {
      const printWin = new BrowserWindow({
        show: false, // Set to false for silent printing
        width: 400,
        height: 600,
        title: 'Receipt - Printing...',
        webPreferences: {
          nodeIntegration: false,
          backgroundThrottling: false
        }
      })

      // Load from file (more reliable than data URI)
      await printWin.loadFile(tempPath)
      console.log('[ReceiptService] File loaded')

      // Wait for rendering
      await new Promise<void>(resolve => setTimeout(resolve, 1500))

      const db = getDatabase()
      const printerRow = db.prepare("SELECT value FROM config WHERE key = 'printer_config'").get() as { value: string } | undefined
      const printerName = printerRow ? JSON.parse(printerRow.value).receipt : ''

      const printOptions = {
        silent: true,
        printBackground: true,
        deviceName: printerName,
        margins: { marginType: 'none' as const },
        pageSize: { width: 80000, height: 297000 }
      }

      return new Promise((resolve) => {
        printWin.webContents.print(printOptions, (success, errorType) => {
          if (success) {
            try { fs.unlinkSync(tempPath) } catch (e) { }
            setTimeout(() => printWin.close(), 500)
            console.log('[ReceiptService] Print sent successfully!')
            resolve({ success: true })
          } else {
            console.warn(`[ReceiptService] Print failed with '${printOptions.deviceName}', trying default printer...`, errorType)

            // Fallback to default printer
            const fallbackOptions = { ...printOptions, deviceName: '' }
            printWin.webContents.print(fallbackOptions, (successFallback, errorFallback) => {
              try { fs.unlinkSync(tempPath) } catch (e) { }
              setTimeout(() => printWin.close(), 500)

              if (successFallback) {
                console.log('[ReceiptService] Success with default printer')
                resolve({ success: true })
              } else {
                console.error('[ReceiptService] Final failure:', errorFallback)
                resolve({ success: false, error: errorFallback })
              }
            })
          }
        })
      })
    } catch (error: any) {
      console.error('[ReceiptService] Detailed print error:', error)
      try { fs.unlinkSync(tempPath) } catch (e) { }
      return { success: false, error: error.message }
    }
  }
}
