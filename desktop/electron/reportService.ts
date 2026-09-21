import { brandLogoImg } from './util/brandLogo'
import { getDatabase } from './database'
import { ReceiptService } from './receiptService'
import { app, BrowserWindow } from 'electron'
import path from 'path'
import fs from 'fs'

export interface DashboardStats {
  todaySales: number
  todayTransactions: number
  todayCashReceived: number
  avgTransactionValue: number
  lowStockCount: number
  totalRevenue: number
  totalProfit: number
  totalDebt: number
  totalStockValue: number
  /** Calendar-year turnover — the IFU / réel threshold is assessed on it
   *  (8 000 000 DA, docs/ALGERIA_REQUIREMENTS.md). */
  annualTurnover: number
  topDebtors: { name: string; amount: number }[]
}

export interface ChartData {
  date: string
  total: number
}

export interface TopProduct {
  name: string
  total_qty: number
  total_revenue: number
}

export const ReportService = {
  getDashboardStats(): DashboardStats {
    const db = getDatabase()

    // SQLite date('now') returns UTC date string "YYYY-MM-DD"
    // We assume the app is running in a context where date('now') matches the desired "today".
    // Ideally, for a robust app, we should pass the client's localized date string.
    // For now, we'll rely on SQLite's storage.

    // Today's Payments (Cash Flow - includes debt payments made today)
    const cashReceived = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total_received
      FROM payments
      WHERE date(created_at, 'localtime') = date('now', 'localtime')
    `).get() as { total_received: number }

    // Today's Sales (Using 'localtime' modifier for accuracy)
    const dayStats = db.prepare(`
      SELECT 
        COALESCE(SUM(total_amount), 0) as total_sales,
        COUNT(*) as transaction_count,
        COALESCE(AVG(total_amount), 0) as avg_value
      FROM transactions 
      WHERE date(created_at, 'localtime') = date('now', 'localtime') AND status = 'completed'
    `).get() as { total_sales: number; transaction_count: number; avg_value: number }

    // ... existing lowStock query ...
    const lowStock = db.prepare(`
      SELECT COUNT(*) as count 
      FROM stock_inventory si
      JOIN products p ON si.product_id = p.id
      WHERE si.quantity <= p.min_stock_level
    `).get() as { count: number }

    // ... existing totalStats query ...
    const totalStats = db.prepare(`
      SELECT 
        COALESCE(SUM(total_amount), 0) as total_revenue,
        COALESCE(SUM((total_amount - COALESCE(tax_amount, 0)) - (
            SELECT SUM(quantity * p.cost_price)
            FROM transaction_items ti
            JOIN products p ON ti.product_id = p.id
            WHERE ti.transaction_id = transactions.id
        )), 0) as total_profit
      FROM transactions 
      WHERE status = 'completed'
    `).get() as { total_revenue: number; total_profit: number }

    // ... existing debtStats query ...
    const debtStats = db.prepare(`
        SELECT COALESCE(SUM(total_amount - amount_paid), 0) as total_debt
        FROM transactions
        WHERE status = 'completed' AND debt_status IN ('unpaid', 'partial')
    `).get() as { total_debt: number }

    const topDebtors = db.prepare(`
        SELECT c.name, SUM(t.total_amount - t.amount_paid) as amount
        FROM transactions t
        JOIN customers c ON t.customer_id = c.id
        WHERE t.status = 'completed' AND t.debt_status IN ('unpaid', 'partial')
        GROUP BY c.id
        ORDER BY amount DESC
        LIMIT 5
    `).all() as { name: string; amount: number }[]

    const stockValue = db.prepare(`
        SELECT SUM(si.quantity * p.cost_price) as total_value
        FROM stock_inventory si
        JOIN products p ON si.product_id = p.id
        WHERE p.is_active = 1
    `).get() as { total_value: number }

    // Current-year turnover (TTC) — used for the IFU 8,000,000 DA ceiling warning.
    const yearStats = db.prepare(`
        SELECT COALESCE(SUM(total_amount), 0) as annual_turnover
        FROM transactions
        WHERE status = 'completed' AND created_at >= ?
    `).get(`${new Date().getFullYear()}-01-01`) as { annual_turnover: number }

    return {
      todaySales: dayStats.total_sales,
      todayTransactions: dayStats.transaction_count,
      todayCashReceived: cashReceived.total_received,
      avgTransactionValue: dayStats.avg_value,
      lowStockCount: lowStock.count,
      totalRevenue: totalStats.total_revenue,
      totalProfit: totalStats.total_profit,
      totalDebt: debtStats.total_debt,
      totalStockValue: stockValue.total_value || 0,
      annualTurnover: yearStats.annual_turnover || 0,
      topDebtors
    }
  },

  getSalesChartData(startDate?: string, endDate?: string): any[] {
    const db = getDatabase()

    // Query for Sales Volume (Accrual)
    let salesQuery = `
      SELECT date(created_at, 'localtime') as date, COALESCE(SUM(total_amount), 0) as salesVolume
      FROM transactions
      WHERE status = 'completed'
    `
    // Query for Cash Flow (Payments received)
    let cashQuery = `
      SELECT date(created_at, 'localtime') as date, COALESCE(SUM(amount), 0) as cashFlow
      FROM payments
      WHERE 1=1
    `

    const params: any[] = []
    let dateFilter = ""

    if (startDate) {
      dateFilter += ` AND date(created_at, 'localtime') >= ?`
      params.push(startDate)
    } else {
      dateFilter += ` AND date(created_at, 'localtime') >= date('now', 'localtime', '-7 days')`
    }

    if (endDate) {
      dateFilter += ` AND date(created_at, 'localtime') <= ?`
      params.push(endDate)
    }

    const salesData = db.prepare(salesQuery + dateFilter + ` GROUP BY date(created_at, 'localtime')`).all(...params) as any[]
    const cashData = db.prepare(cashQuery + dateFilter + ` GROUP BY date(created_at, 'localtime')`).all(...params) as any[]

    // Merge data by date
    const dateMap = new Map()
    salesData.forEach(d => dateMap.set(d.date, { ...dateMap.get(d.date), date: d.date, salesVolume: d.salesVolume }))
    cashData.forEach(d => dateMap.set(d.date, { ...dateMap.get(d.date), date: d.date, cashFlow: d.cashFlow }))

    return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date))
  },

  getTopSellingProducts(limit = 5): TopProduct[] {
    const db = getDatabase()
    return db.prepare(`
        SELECT 
            p.name,
            SUM(ti.quantity) as total_qty,
            SUM(ti.line_total + COALESCE(ti.tax_amount, 0)) as total_revenue
        FROM transaction_items ti
        JOIN products p ON p.id = ti.product_id
        JOIN transactions t ON t.id = ti.transaction_id
        WHERE t.status = 'completed'
        GROUP BY p.id
        ORDER BY total_qty DESC
        LIMIT ?
      `).all(limit) as TopProduct[]
  },

  getLowStockProducts() {
    const db = getDatabase()
    return db.prepare(`
          SELECT p.id, p.name, p.sku, si.quantity, p.min_stock_level
          FROM products p
          JOIN stock_inventory si ON p.id = si.product_id
          WHERE si.quantity <= p.min_stock_level
          ORDER BY si.quantity ASC
      `).all()
  },

  getCategorySales(startDate?: string, endDate?: string) {
    const db = getDatabase()
    let query = `
      SELECT c.name, SUM(ti.line_total + COALESCE(ti.tax_amount, 0)) as value
      FROM transaction_items ti
      JOIN products p ON ti.product_id = p.id
      JOIN categories c ON p.category_id = c.id
      JOIN transactions t ON ti.transaction_id = t.id
      WHERE t.status = 'completed'
    `
    const params: any[] = []
    if (startDate) { query += " AND date(t.created_at, 'localtime') >= ?"; params.push(startDate) }
    if (endDate) { query += " AND date(t.created_at, 'localtime') <= ?"; params.push(endDate) }
    query += ' GROUP BY c.id ORDER BY value DESC'
    return db.prepare(query).all(...params)
  },

  getPaymentMethodStats(startDate?: string, endDate?: string) {
    const db = getDatabase()
    let query = `
      SELECT payment_method as method, SUM(amount) as total, COUNT(*) as count
      FROM payments
      WHERE 1=1
    `
    const params: any[] = []
    if (startDate) { query += " AND date(created_at, 'localtime') >= ?"; params.push(startDate) }
    if (endDate) { query += " AND date(created_at, 'localtime') <= ?"; params.push(endDate) }
    query += ' GROUP BY payment_method'
    return db.prepare(query).all(...params)
  },

  async printYearlyDeliveries(deliveries: any[], year: number) {
    const total = deliveries.reduce((sum, d) => sum + d.amount, 0)

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
          <style>
              body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px; color: #333; }
              .header { text-align: center; border-bottom: 2px solid #2563eb; padding-bottom: 20px; margin-bottom: 30px; }
              .header h1 { margin: 0; color: #1e40af; font-size: 24px; text-transform: uppercase; }
              .header p { margin: 5px 0 0; color: #64748b; }
              table { width: 100%; border-collapse: collapse; margin-top: 20px; }
              th { background: #f8fafc; color: #1e40af; text-align: left; padding: 12px; border: 1px solid #e2e8f0; font-size: 13px; text-transform: uppercase; }
              td { padding: 12px; border: 1px solid #e2e8f0; font-size: 13px; }
              .footer { margin-top: 40px; border-top: 2px solid #e2e8f0; padding-top: 20px; text-align: right; }
              .total-box { display: inline-block; background: #f1f5f9; padding: 15px 30px; border-radius: 8px; border: 1px solid #e2e8f0; }
              .total-label { font-size: 14px; color: #64748b; margin-bottom: 5px; }
              .total-amount { font-size: 24px; font-weight: 800; color: #2563eb; }
              .date { font-size: 11px; color: #94a3b8; text-align: center; margin-top: 50px; }
              @media print { .no-print { display: none; } }
          </style>
      </head>
      <body>
          <div class="header">
              <h1>Rapport Annuel des Livraisons - ${year}</h1>
              <p>Résumé consolidé des bons de livraison (Ventes à crédit)</p>
          </div>

          <table>
              <thead>
                  <tr>
                      <th>Date</th>
                      <th>Référence (N°)</th>
                      <th>Client</th>
                      <th style="text-align: right;">Montant (DZD)</th>
                  </tr>
              </thead>
              <tbody>
                  ${deliveries.map(d => `
                      <tr>
                          <td>${new Date(d.date).toLocaleDateString('fr-FR')}</td>
                          <td>${d.ref}</td>
                          <td>${d.customer || 'Client anonyme'}</td>
                          <td style="text-align: right; font-weight: 600;">${d.amount.toFixed(2)}</td>
                      </tr>
                  `).join('')}
              </tbody>
          </table>

          <div class="footer">
              <div class="total-box">
                  <div class="total-label">TOTAL GÉNÉRAL (${deliveries.length} Livraisons)</div>
                  <div class="total-amount">${total.toFixed(2)} DZD</div>
              </div>
          </div>

          <div class="date">Généré le ${new Date().toLocaleString('fr-FR')}</div>
      </body>
      </html>
    `.trim()

    const tempPath = path.join(app.getPath('temp'), `yearly_deliveries_${year}.html`)
    fs.writeFileSync(tempPath, html, 'utf-8')

    const printWin = new BrowserWindow({
      show: false,
      width: 800,
      height: 1000,
      webPreferences: { nodeIntegration: false }
    })

    await printWin.loadFile(tempPath)
    await new Promise<void>(resolve => setTimeout(resolve, 1500))

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
        printWin.close()
        resolve({ success, errorType })
      })
    })
  },

  async printYearlySettlement(supplierName?: string, year: number = new Date().getFullYear()) {
    const db = getDatabase()
    const config = ReceiptService.getConfig()

    let query = `
      SELECT po.id, po.po_number as ref, po.total_amount as amount, po.created_at as date, s.company_name as supplier_name
      FROM purchase_orders po
      JOIN suppliers s ON po.supplier_id = s.id
      WHERE strftime('%Y', po.created_at) = ?
    `
    const params: any[] = [year.toString()]

    if (supplierName) {
      query += ` AND s.company_name = ?`
      params.push(supplierName)
    }

    query += ` ORDER BY po.created_at ASC`

    const orders = db.prepare(query).all(...params) as any[]
    const total = orders.reduce((sum, o) => sum + o.amount, 0)

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 0; margin: 0; color: #000; line-height: 1.1; background: #fff; font-size: 13px; }
    .page-container { padding: 12mm 15mm; min-height: 250mm; }
    
    .header-branding { display: grid; grid-template-columns: 1fr 2fr 1fr; align-items: start; margin-bottom: 20px; border-bottom: 1px solid #000; padding-bottom: 15px; }
    .branding-left { text-align: left; }
    .branding-center { text-align: center; }
    .branding-right { text-align: right; }
    .branding-right img { max-height: 85px; }

    .brand-corp { font-size: 1.15em; font-weight: bold; margin-bottom: 2px; }
    .brand-boss { font-size: 1.4em; font-weight: 1000; margin: 2px 0; }
    .brand-loc { font-size: 1.1em; }

    .info-grid { margin-bottom: 20px; }
    .client-box { border: 2px solid #000; padding: 12px; border-radius: 12px; width: 350px; text-align: left; }
    .client-box b { text-decoration: underline; font-size: 1.25em; }

    table.items-table { width: 100%; border-collapse: collapse; margin-top: 10px; border: 2.5px solid #000; }
    table.items-table th, table.items-table td { border: 2px solid #000; padding: 8px 12px; text-align: left; }
    table.items-table th { background: #eee; font-weight: 1000; font-size: 0.95em; text-align: center; text-transform: uppercase; }
    .text-right { text-align: right; }
    .text-center { text-align: center; }
    
    .totals-area { display: flex; justify-content: flex-end; margin-top: 25px; }
    .totals-box { border: 2.5px solid #000; padding: 15px; border-radius: 12px; min-width: 300px; }
    .total-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 1.1em; }
    .total-row.grand-total { border-top: 2.5px solid #000; margin-top: 8px; padding-top: 10px; font-weight: 1000; font-size: 1.5em; }

    @media print {
      body { padding: 0mm; }
      @page { margin: 0; size: A4; }
    }
  </style>
</head>
<body>
  <div class="page-container">
    <div class="header-branding">
        <div class="branding-left"></div>
        <div class="branding-center">
            <div class="brand-corp">${config.companyName}</div>
            <div class="brand-boss">${config.companyPhone}</div>
            <div class="brand-loc">${config.companyAddress}</div>
        </div>
        <div class="branding-right">
            ${brandLogoImg(34)}
        </div>
    </div>

    <div class="info-grid">
        <div class="client-box">
            <b>${supplierName ? 'FOURNISSEUR:' : 'TOUS LES FOURNISSEURS:'}</b><br>
            <div style="font-size: 1.25em; font-weight: bold; margin-top: 5px;">${supplierName || 'Rapport Consolidé'}</div>
        </div>
    </div>

    <div class="main-content">
        <div style="text-align: center; margin-bottom: 25px;">
            <h1 style="margin: 0; font-size: 2.2em; text-decoration: underline; text-transform: uppercase;">BON DE RÈGLEMENT - ${year}</h1>
            <p style="margin-top: 10px; font-weight: bold; color: #444;">Résumé consolidé des règlements fournisseurs</p>
        </div>
        
        <table class="items-table">
          <thead>
            <tr>
              <th width="120px" class="text-center">Date</th>
              <th>Référence (N°)</th>
              <th>Fournisseur</th>
              <th width="150px" class="text-right">Montant (DZD)</th>
            </tr>
          </thead>
          <tbody>
            ${orders.length === 0 ? `<tr><td colspan="4" class="text-center" style="padding: 40px; color: #666;">Aucun règlement trouvé pour cette période.</td></tr>` : orders.map(o => `
              <tr>
                <td class="text-center">${new Date(o.date).toLocaleDateString('fr-FR')} ${new Date(o.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                <td><b>${o.ref.split('-').pop()}</b></td>
                <td>${o.supplier_name}</td>
                <td class="text-right"><b>${o.amount.toFixed(2)}</b></td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <div class="totals-area">
          <div class="totals-box">
            <div class="total-row">
              <span>Nombre de Règlements:</span>
              <span>${orders.length}</span>
            </div>
            <div class="total-row grand-total">
              <span>TOTAL GÉNÉRAL:</span>
              <span>${total.toFixed(2)} DZD</span>
            </div>
          </div>
        </div>

        <div style="margin-top: 50px; text-align: center; font-size: 0.85em; color: #666; font-style: italic;">
          Généré le ${new Date().toLocaleString('fr-FR')}
        </div>
  </div>
</body>
</html>
    `.trim()

    const tempPath = path.join(app.getPath('temp'), `yearly_settlement_${year}.html`)
    fs.writeFileSync(tempPath, html, 'utf-8')

    const printWin = new BrowserWindow({
      show: false,
      width: 800,
      height: 1000,
      webPreferences: { nodeIntegration: false }
    })

    await printWin.loadFile(tempPath)
    await new Promise<void>(resolve => setTimeout(resolve, 1500))

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
        printWin.close()
        resolve({ success, errorType })
      })
    })
  },

  getInventoryMovementStats(startDate: string, endDate: string) {
    const db = getDatabase()
    return db.prepare(`
      SELECT 
        p.name,
        p.sku,
        COALESCE(SUM(CASE WHEN sm.quantity > 0 THEN sm.quantity ELSE 0 END), 0) as qty_in,
        COALESCE(SUM(CASE WHEN sm.quantity < 0 THEN ABS(sm.quantity) ELSE 0 END), 0) as qty_out,
        COALESCE(si.quantity, 0) as current_stock
      FROM products p
      LEFT JOIN stock_movements sm ON p.id = sm.product_id 
        AND date(sm.created_at, 'localtime') >= ? 
        AND date(sm.created_at, 'localtime') <= ?
      LEFT JOIN stock_inventory si ON p.id = si.product_id AND si.variant_id IS NULL
      WHERE p.is_active = 1
      GROUP BY p.id
      HAVING qty_in > 0 OR qty_out > 0
      ORDER BY p.name ASC
    `).all(startDate, endDate)
  },

  async printInventoryMovementReport(startDate: string, endDate: string, periodType: string) {
    try {
      const stats = this.getInventoryMovementStats(startDate, endDate) as any[]
      console.log(`[ReportService] Found ${stats.length} movement records`)
      const config = ReceiptService.getConfig()

      const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 15mm; color: #000; line-height: 1.2; background: #fff; font-size: 12px; }
    .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 20px; }
    .company-name { font-size: 1.5em; font-weight: bold; }
    .report-title { font-size: 2em; text-decoration: underline; margin: 10px 0; text-transform: uppercase; }
    .period-info { font-size: 1.1em; font-weight: bold; color: #444; }
    
    table { width: 100%; border-collapse: collapse; margin-top: 20px; border: 1px solid #000; }
    th, td { border: 1px solid #000; padding: 6px 10px; text-align: left; }
    th { background: #f0f0f0; font-weight: bold; text-align: center; }
    .text-right { text-align: right; }
    .text-center { text-align: center; }
    
    .summary { margin-top: 30px; display: flex; justify-content: flex-end; }
    .summary-box { border: 2px solid #000; padding: 10px; border-radius: 8px; min-width: 250px; }
    .summary-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 1.1em; }
    .grand-total { border-top: 1px solid #000; margin-top: 5px; padding-top: 5px; font-weight: bold; }
    
    .footer { margin-top: 50px; text-align: center; font-size: 0.9em; color: #666; font-style: italic; }
  </style>
</head>
<body>
  <div class="header">
    <div class="company-name">${config.companyName}</div>
    <div class="report-title">Rapport de Mouvement de Stock</div>
    <div class="period-info">Période : ${new Date(startDate).toLocaleDateString('fr-FR')} au ${new Date(endDate).toLocaleDateString('fr-FR')} (${periodType})</div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Produit</th>
        <th>SKU</th>
        <th width="100" class="text-right">Entrées (+)</th>
        <th width="100" class="text-right">Sorties (-)</th>
        <th width="100" class="text-right">Stock Actuel</th>
      </tr>
    </thead>
    <tbody>
      ${stats.length === 0 ? '<tr><td colspan="5" class="text-center" style="padding: 20px;">Aucun mouvement enregistré pour cette période.</td></tr>' : stats.map(s => `
        <tr>
          <td>${s.name}</td>
          <td>${s.sku || '-'}</td>
          <td class="text-right">${s.qty_in > 0 ? `+${s.qty_in}` : '0'}</td>
          <td class="text-right">${s.qty_out > 0 ? `-${s.qty_out}` : '0'}</td>
          <td class="text-right"><b>${s.current_stock}</b></td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <div class="summary">
    <div class="summary-box">
      <div class="summary-row">
        <span>Total Produits avec Mouvement:</span>
        <span>${stats.length}</span>
      </div>
      <div class="summary-row">
        <span>Total Articles Entrés:</span>
        <span>${stats.reduce((sum, s) => sum + s.qty_in, 0)}</span>
      </div>
      <div class="summary-row">
        <span>Total Articles Vendus/Sortis:</span>
        <span>${stats.reduce((sum, s) => sum + s.qty_out, 0)}</span>
      </div>
    </div>
  </div>

  <div class="footer">
    Généré le ${new Date().toLocaleString('fr-FR')}
  </div>
</body>
</html>
    `.trim()

      const tempPath = path.join(app.getPath('temp'), `stock_report_${Date.now()}.html`)
      fs.writeFileSync(tempPath, html, 'utf-8')

      const printWin = new BrowserWindow({
        show: false,
        width: 800,
        height: 1000,
        webPreferences: { nodeIntegration: false }
      })

      await printWin.loadFile(tempPath)
      await new Promise<void>(resolve => setTimeout(resolve, 1500))

      const currentDb = getDatabase()
      const printerRow = currentDb.prepare("SELECT value FROM config WHERE key = 'printer_config'").get() as { value: string } | undefined
      let printerName = ''
      if (printerRow) {
        try {
          const pConfig = JSON.parse(printerRow.value)
          printerName = pConfig.order || pConfig.thermal || ''
        } catch (e) { }
      }

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
          printWin.close()
          resolve({ success, errorType })
        })
      })
    } catch (error: any) {
      console.error('[ReportService] Error generating report:', error)
      throw error
    }
  }
}
