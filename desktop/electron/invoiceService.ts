import { BrowserWindow } from 'electron'
import { getDatabase } from './database'
import { ReceiptService, type ReceiptData } from './receiptService'
import { escapeHtml } from './util/escapeHtml'
import { brandLogoImg } from './util/brandLogo'
import { montantEnLettresAR } from './arabicWords'

// Arabic translation of the common document titles (bilingual header, Loi 91-05).
const DOC_TITLE_AR: Record<string, string> = {
  'FACTURE': 'فاتورة',
  "FACTURE D'AVOIR": 'فاتورة إشعار دائن',
  'DEVIS': 'عرض أسعار',
  'FACTURE PROFORMA': 'فاتورة أولية',
  'BON DE COMMANDE': 'سند طلب',
  'BON DE LIVRAISON': 'سند تسليم',
  'FACTURE RÉCAPITULATIVE': 'فاتورة إجمالية',
}

// Helper function: Convert number to French words
function numberToFrenchWords(n: number): string {
  const units = ['', 'UN', 'DEUX', 'TROIS', 'QUATRE', 'CINQ', 'SIX', 'SEPT', 'HUIT', 'NEUF', 'DIX', 'ONZE', 'DOUZE', 'TREIZE', 'QUATORZE', 'QUINZE', 'SEIZE', 'DIX-SEPT', 'DIX-HUIT', 'DIX-NEUF'];
  const tens = ['', '', 'VINGT', 'TRENTE', 'QUARANTE', 'CINQUANTE', 'SOIXANTE', 'SOIXANTE', 'QUATRE-VINGT', 'QUATRE-VINGT'];

  n = Math.floor(n)
  if (n === 0) return 'ZÉRO';
  if (n < 20) return units[n];
  if (n < 100) {
    const t = Math.floor(n / 10);
    const u = n % 10;
    if (t === 7 || t === 9) return tens[t] + '-' + units[10 + u];
    if (u === 1 && t !== 8) return tens[t] + ' ET UN';
    return tens[t] + (u ? '-' + units[u] : (t === 8 ? 'S' : ''));
  }
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    const prefix = h === 1 ? 'CENT' : units[h] + ' CENT' + (r === 0 && h > 1 ? 'S' : '');
    return prefix + (r ? ' ' + numberToFrenchWords(r) : '');
  }
  if (n < 1000000) {
    const m = Math.floor(n / 1000);
    const r = n % 1000;
    const prefix = m === 1 ? 'MILLE' : numberToFrenchWords(m) + ' MILLE';
    return prefix + (r ? ' ' + numberToFrenchWords(r) : '');
  }
  if (n < 1000000000) {
    const m = Math.floor(n / 1000000);
    const r = n % 1000000;
    const prefix = m === 1 ? 'UN MILLION' : numberToFrenchWords(m) + ' MILLIONS';
    return prefix + (r ? ' ' + numberToFrenchWords(r) : '');
  }
  return n.toString();
}

// Amount in words including centimes — required mention on the Algerian facture.
function amountInWords(n: number): string {
  const abs = Math.abs(Math.round((n || 0) * 100) / 100)
  let dinars = Math.floor(abs)
  let centimes = Math.round((abs - dinars) * 100)
  if (centimes === 100) { dinars += 1; centimes = 0 } // carry float rounding
  let s = `${numberToFrenchWords(dinars)} DINARS`
  if (centimes > 0) s += ` ET ${numberToFrenchWords(centimes)} CENTIMES`
  if (n < 0) s = `MOINS ${s}`
  return s
}

export const InvoiceService = {
  async generateInvoicePDF(data: ReceiptData): Promise<Buffer> {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true }
    })

    const html = this.generateInvoiceHTML(data)
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

    const pdfData = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    })

    win.close()
    return pdfData
  },

  async print(data: ReceiptData) {
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 1000,
      title: `Invoice ${data.transactionNumber} - Preview`,
      webPreferences: {
        nodeIntegration: false
      }
    })

    const html = this.generateInvoiceHTML(data)
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

    // Wait for rendering
    await new Promise<void>(resolve => setTimeout(resolve, 1000))

    const db = getDatabase()
    const printerRow = db.prepare("SELECT value FROM config WHERE key = 'printer_config'").get() as { value: string } | undefined
    const printerName = printerRow ? JSON.parse(printerRow.value).order : ''

    const printOptions = {
      silent: true, // Silent printing for A4 documents
      printBackground: true,
      deviceName: printerName,
      pageSize: 'A4' as const,
      margins: { marginType: 'printableArea' as const }
    }

    return new Promise((resolve) => {
      win.webContents.print(printOptions, (success, errorType) => {
        if (!success) console.error('[Invoice Print] Failed:', errorType)
        resolve({ success, error: errorType })
      })
    })
  },

  generateInvoiceHTML(data: ReceiptData): string {
    const config = ReceiptService.getConfig()

    // Ensure signature is loaded if not provided
    if (!data.adminSignature) {
      data.adminSignature = (ReceiptService as any).getAdminSignature?.() || null
    }

    console.log('[InvoiceService] Generating Invoice using Config:', config.companyName)
    const docNumber = data.transactionNumber || '000001'

    // Per-rate TVA breakdown (base HT + TVA per rate) — Algerian facture requirement.
    // An order-level discount reduces the taxable base proportionally; scale each rate
    // bucket by the same ratio so HT − Remise + Σ(TVA) + Timbre reconciles to Net.
    const discountAmt = data.discount || 0
    const ratio = (data.subtotal || 0) > 0 ? Math.max(0, ((data.subtotal || 0) - discountAmt) / (data.subtotal || 1)) : 1
    const byRate = new Map<number, { base: number; tax: number }>()
    for (const it of data.items) {
      const r = it.taxRate || 0
      if (r <= 0 && !it.taxAmount) continue
      const cur = byRate.get(r) || { base: 0, tax: 0 }
      cur.base += it.total || 0
      cur.tax += it.taxAmount || 0
      byRate.set(r, cur)
    }
    const tvaRows = Array.from(byRate.entries())
      .filter(([r]) => r > 0)
      .map(([r, v]) => `<tr><td class="label">TVA ${r}% (base ${(v.base * ratio).toLocaleString()})</td><td class="text-right">${(v.tax * ratio).toLocaleString()}</td></tr>`)
      .join('') || `<tr><td class="label">TVA</td><td class="text-right">${(data.tax || 0).toLocaleString()}</td></tr>`
    const remiseRow = discountAmt > 0 ? `<tr><td class="label">Remise</td><td class="text-right">-${discountAmt.toLocaleString()}</td></tr>` : ''
    const net = (data.total || 0) + (data.timbre || 0)

    // A4 Landscape layout matching the reference images
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: Arial, sans-serif; 
      font-size: 11px; 
      color: #000;
      background: #fff;
    }
    .page { 
      width: 297mm; 
      min-height: 210mm; 
      padding: 8mm 10mm;
    }
    
    /* Header Section */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 15px;
      border-bottom: 2px solid #000;
      padding-bottom: 10px;
    }
    
    .header-left {
      flex: 1;
    }
    
    .header-center {
      flex: 2;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    
    .header-right {
      flex: 1.5;
      text-align: right;
      border: 2px solid #c41e3a;
      border-radius: 10px;
      padding: 8px 12px;
    }
    
    .logo-box {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-bottom: 5px;
    }
    
    .logo-box img {
      max-height: 50px;
    }
    
    .company-name {
      font-size: 22px;
      font-weight: bold;
      color: #006666;
    }
    
    .company-subtitle {
      font-size: 11px;
      color: #c41e3a;
      margin-bottom: 5px;
    }
    
    .company-address {
      font-size: 10px;
      line-height: 1.4;
    }
    
    .company-info-line {
      font-size: 10px;
    }
    
    /* Document Title */
    .doc-title-section {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }
    
    .doc-title {
      font-size: 24px;
      font-weight: bold;
      padding: 8px 20px;
      border: 2px solid #000;
      border-radius: 8px;
      background: #f5f5f5;
    }
    
    .doc-number {
      font-size: 11px;
    }
    
    /* Customer Info Section */
    .customer-section {
      display: flex;
      gap: 20px;
      margin-bottom: 15px;
    }
    
    .customer-box {
      border: 1.5px solid #000;
      padding: 8px;
      flex: 1;
    }
    
    .customer-row {
      display: flex;
      margin-bottom: 3px;
    }
    
    .customer-label {
      width: 50px;
      font-weight: bold;
      font-size: 10px;
    }
    
    .customer-value {
      flex: 1;
      border-bottom: 1px solid #ccc;
      padding-left: 5px;
      font-size: 10px;
    }
    
    /* Meta Info */
    .meta-section {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 10px;
    }
    
    .meta-left span, .meta-right span {
      margin-right: 20px;
    }
    
    /* Items Table */
    .items-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 10px;
      font-size: 10px;
    }
    
    .items-table th {
      background: #e0e0e0;
      border: 1.5px solid #000;
      padding: 5px 4px;
      font-weight: bold;
      text-align: center;
      font-size: 9px;
    }
    
    .items-table td {
      border: 1px solid #000;
      padding: 4px;
      text-align: center;
    }
    
    .items-table .text-left {
      text-align: left;
    }
    
    .items-table .text-right {
      text-align: right;
    }
    
    /* Totals Section */
    .totals-section {
      display: flex;
      justify-content: flex-end;
      margin-top: 10px;
    }
    
    .totals-table {
      border-collapse: collapse;
      font-size: 11px;
    }
    
    .totals-table td {
      border: 1.5px solid #000;
      padding: 5px 15px;
    }
    
    .totals-table .label {
      font-weight: bold;
      background: #f0f0f0;
    }
    
    .totals-table .grand-total {
      font-size: 14px;
      font-weight: bold;
      background: #ffff99;
    }
    
    /* Footer */
    .footer-section {
      margin-top: 20px;
      font-size: 9px;
      text-align: center;
      font-style: italic;
      border-top: 1px solid #ccc;
      padding-top: 10px;
    }

    @media print {
      @page { 
        size: A4 landscape; 
        margin: 5mm;
      }
      body { 
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <!-- Header -->
    <div class="header">
      <div class="header-left">
        <!-- Empty or can add logo later -->
      </div>
      
      <div class="header-center">
        <div class="doc-title">${escapeHtml((data as any).docTitle || (data.isCreditNote ? "FACTURE D'AVOIR" : 'FACTURE'))} N° ${escapeHtml(docNumber)}</div>
        ${(config as any).bilingualArabic ? `<div class="doc-title" dir="rtl" style="font-size:0.85em;">${escapeHtml(DOC_TITLE_AR[((data as any).docTitle || (data.isCreditNote ? "FACTURE D'AVOIR" : 'FACTURE'))] || '')} رقم ${escapeHtml(docNumber)}</div>` : ''}
      </div>
      
      <div class="header-right">
        <div class="logo-box">
          ${brandLogoImg(34)}
          <span class="company-name">${escapeHtml(config.companyName || '')}</span>
        </div>
        <div class="company-subtitle">${escapeHtml(config.formeJuridique || '')}</div>
        <div class="company-address">
          ${escapeHtml(config.companyAddress || '')}<br>
          Tél.: ${escapeHtml(config.companyPhone || '')}${config.rc ? ` — RC: ${escapeHtml(config.rc)}` : ''}<br>
          Compte: ${escapeHtml(config.bankAccount || config.taxId || '')}
        </div>
      </div>
    </div>
    
    <!-- Customer Info -->
    <div class="customer-section">
      <div class="customer-box">
        <div class="customer-row">
          <span class="customer-label">POLE:</span>
          <span class="customer-value">${escapeHtml((data as any).pole || '')}</span>
        </div>
        <div class="customer-row">
          <span class="customer-label">Nom:</span>
          <span class="customer-value">${escapeHtml(data.customerName || 'Client Comptant')}</span>
        </div>
        <div class="customer-row">
          <span class="customer-label">Adr.:</span>
          <span class="customer-value">${escapeHtml((data as any).address || '')}</span>
        </div>
        <div class="customer-row">
          <span class="customer-label">Adr_LIV:</span>
          <span class="customer-value">${escapeHtml((data as any).deliveryAddress || '')}</span>
        </div>
        <div class="customer-row">
          <span class="customer-label">RC:</span>
          <span class="customer-value">${escapeHtml((data as any).rc || '')}</span>
        </div>
        <div class="customer-row">
          <span class="customer-label">Id Fiscal:</span>
          <span class="customer-value">${escapeHtml((data as any).fiscalId || '')}</span>
        </div>
        <div class="customer-row">
          <span class="customer-label">Compte:</span>
          <span class="customer-value">${escapeHtml((data as any).account || '')}</span>
        </div>
      </div>

      <div class="customer-box" style="max-width: 200px;">
        <div class="customer-row">
          <span class="customer-label">Tél.:</span>
          <span class="customer-value">${escapeHtml((data as any).customerPhone || '')}</span>
        </div>
        <div class="customer-row">
          <span class="customer-label">AI:</span>
          <span class="customer-value">${escapeHtml((data as any).ai || '')}</span>
        </div>
        <div class="customer-row">
          <span class="customer-label">NIS:</span>
          <span class="customer-value">${escapeHtml((data as any).nis || '')}</span>
        </div>
      </div>
    </div>
    
    <!-- Meta Info -->
    <div class="meta-section">
      <div class="meta-left">
        <span><b>Le:</b> ${escapeHtml(data.date.split(' ')[0] || new Date().toLocaleDateString('fr-FR'))}</span>
        <span><b>Paiement:</b> ${escapeHtml((data as any).paymentMethod || 'Espèce...')}</span>
        <span><b>Page:</b> 1 / 1</span>
        <span><b>Agent:</b> ${escapeHtml(data.cashierName || 'Admin')}</span>
      </div>
      <div class="meta-right">
        <span><b>N° Art.:</b> ${escapeHtml(config.articleImposition || '')}</span>
        <span><b>MF:</b> ${escapeHtml(config.nif || '')}</span>
        <span><b>NIS:</b> ${escapeHtml(config.nis || '')}</span>
      </div>
    </div>
    
    <!-- Items Table -->
    <table class="items-table">
      <thead>
        <tr>
          <th style="width: 30px;">#</th>
          <th style="width: 70px;">Code</th>
          <th style="width: 80px;">Ref</th>
          <th style="width: 80px;">Marque</th>
          <th style="width: auto;">Désignation</th>
          <th style="width: 50px;">Qté</th>
          <th style="width: 60px;">Colisage</th>
          <th style="width: 80px;">Disponibilité</th>
          <th style="width: 70px;">PU HT</th>
          <th style="width: 80px;">Sous Total</th>
        </tr>
      </thead>
      <tbody>
        ${data.items.map((item, index) => `
          <tr>
            <td>${index + 1}</td>
            <td>${escapeHtml((item as any).code || (item as any).sku || '')}</td>
            <td>${escapeHtml((item as any).reference || '')}</td>
            <td>${escapeHtml((item as any).marque || '')}</td>
            <td class="text-left">${escapeHtml(item.name)}</td>
            <td>${(((item as any).unitFactor && (item as any).unitFactor > 1) ? (item.quantity / (item as any).unitFactor) : item.quantity).toLocaleString(undefined, { maximumFractionDigits: 2 })}${(item as any).unit ? ' ' + escapeHtml((item as any).unit) : ''}</td>
            <td>${(item as any).unitFactor && (item as any).unitFactor > 1 ? `×${(item as any).unitFactor}` : escapeHtml((item as any).colisage || '')}</td>
            <td>${escapeHtml((item as any).disponibilite || '')}</td>
            <td class="text-right">${(() => { const f = (item as any).unitFactor && (item as any).unitFactor > 1 ? (item as any).unitFactor : 1; const dq = item.quantity / f; return (dq ? (item.total || 0) / dq : (item.unitPrice || 0) * f).toLocaleString(undefined, { maximumFractionDigits: 2 }) })()}</td>
            <td class="text-right">${(item.total || 0).toLocaleString()}</td>
          </tr>
        `).join('')}
        ${data.items.length < 10 ? Array(10 - data.items.length).fill('').map(() => `
          <tr>
            <td>&nbsp;</td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
          </tr>
        `).join('') : ''}
      </tbody>
    </table>
    
    <!-- Totals Section -->
    <div class="totals-section">
      <table class="totals-table">
        <tr>
          <td class="label">Total HT</td>
          <td class="text-right">${data.subtotal?.toLocaleString() || '0.00'}</td>
        </tr>
        ${remiseRow}
        ${tvaRows}
        <tr>
          <td class="label">Total TTC</td>
          <td class="text-right">${data.total?.toLocaleString() || '0.00'}</td>
        </tr>
        <tr>
          <td class="label">Timbre</td>
          <td class="text-right">${(data.timbre || 0).toLocaleString()}</td>
        </tr>
        <tr class="grand-total">
          <td class="label">Net à Payer</td>
          <td class="text-right">${net.toLocaleString()}</td>
        </tr>
      </table>
    </div>
    
    <!-- Footer with text representation of amount (bilingual FR + AR per Loi 91-05) -->
    <div class="footer-section">
      Arrêtée la présente facture à la somme de <b>${amountInWords(net)}</b>
      ${(config as any).bilingualArabic ? `<div dir="rtl" style="margin-top:6px; font-family: 'Segoe UI', Tahoma, sans-serif;">أوقفت هذه الفاتورة على مبلغ: <b>${montantEnLettresAR(net)}</b></div>` : ''}
    </div>

    <!-- Cachet & signature -->
    <div style="display:flex; justify-content:flex-end; margin-top:24px;">
      <div style="text-align:center; min-width:260px;">
        <div style="font-weight:bold; text-decoration:underline; margin-bottom:6px;">Cachet et Signature</div>
        ${data.adminSignature
        ? (data.adminSignature.startsWith('data:image/')
          ? `<img src="${encodeURI(data.adminSignature)}" style="max-height:120px; max-width:240px;">`
          : `<div style="font-style:italic; margin-top:8px;">${escapeHtml(data.adminSignature)}</div>`)
        : '<div style="height:90px;"></div>'}
      </div>
    </div>
  </div>
</body>
</html>
    `.trim()
  }
}
