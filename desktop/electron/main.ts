import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import * as dotenv from 'dotenv'
import path from 'node:path'

dotenv.config()
import { fileURLToPath } from 'node:url'
import { initDatabase, getDatabase, resetDatabaseFile } from './database'
import { ReceiptService } from './receiptService'
import { InvoiceService } from './invoiceService'
import { LabelService } from './labelService'
import { ReportService } from './reportService'
import { ExpenseService } from './expenseService'
import { CashSessionService } from './cashSessionService'
import { LoyaltyService } from './loyaltyService'
import { LossService } from './lossService'
import { CloudSync, getCloudConfig, setCloudConfig } from './cloudSync'
import { ingestMobileTransactions } from './mobileIngest'
import { runAssistant, executeConfirmed, getUsage } from './ai/orchestrator'
import { findActiveUserByPin, verifyOwnerPin, setOwnerPin, ownerPinIsDefault } from './authService'
import { ProductImageService, CategoryImageService, registerImageScheme, serveImages } from './productImageService'
import { transcribeAudio } from './voice/transcribe'
import { generateSpeech } from './voice/tts'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { ProductService, CategoryService, SupplierService } from './productService'
import { PurchaseOrderService } from './purchaseOrderService'
import { TransactionService, CustomerService } from './transactionService'
import { PricingService } from './pricingService'
import { WarehouseService } from './warehouseService'
import { DocumentService } from './documentService'
import { LedgerService } from './ledgerService'
import { ReservationService } from './reservationService'
import { AccountingService } from './accountingService'
import { PayrollService } from './payrollService'
import { StoreService } from './storeService'
import { PermissionService } from './permissionService'
import { AuditService } from './auditService'
import { InventoryService } from './inventoryService'
import { ReturnService } from './returnService'
import { TransferService } from './transferService'
import { AnalyticsService } from './analyticsService'
import { InventoryCountService } from './inventoryCountService'
import { NotificationService } from './notificationService'
import { TargetService } from './targetService'
import { CloudPushService } from './cloudPushService'
import { UserService } from './database'
import { EventBus } from './eventBus'
import { IpcRegistry } from './ipcRegistry'
import { isLocalChannel } from './rpcRouter'
import { TerminalMode } from './terminalMode'
import { RpcClient, RpcUnavailableError } from './rpcClient'
import { NetworkService } from './networkService'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.js
// │
process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public')

let win: BrowserWindow | null = null
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

// Initialize Database
initDatabase()

// --- Auth handlers (typed; replaces the removed arbitrary-SQL db-query/db-run bridge) ---
// SECURITY: the renderer can no longer run arbitrary SQL. PINs are bcrypt-hashed at rest
// (see authService + the hash migration in database.ts); raw PINs are compared server-side.
// ---------------------------------------------------------------------------
// Thin-client routing, installed once by wrapping ipcMain.handle.
//
// Wrapping the global rather than changing 250-odd call sites is deliberate: a
// handler added later is routed correctly without anyone remembering to opt in,
// and there is exactly one place where the client/server decision is made. It
// also builds the registry the /rpc route derives its allowlist from, so the
// server can only ever execute channels that genuinely exist.
//
// On a SERVER (the default, and every single-PC shop) this is a pass-through:
// TerminalMode.isClient() is false and the original handler runs unchanged.
// ---------------------------------------------------------------------------
const rawHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = ((channel: string, handler: (...a: any[]) => any) => {
    IpcRegistry.register(channel, handler)

    return rawHandle(channel, async (event: any, ...args: any[]) => {
        if (!isLocalChannel(channel) && TerminalMode.isClient()) {
            // Forwarded. A transport failure surfaces as SERVER_UNREACHABLE and is
            // NEVER answered from this machine's own database — see rpcClient.ts.
            return RpcClient.forward(channel, args)
        }
        return handler(event, ...args)
    })
}) as typeof ipcMain.handle

ipcMain.handle('auth-login', (_event, pin: string) => findActiveUserByPin(getDatabase(), pin))

ipcMain.handle('auth-verify-owner', (_event, pin: string) => verifyOwnerPin(getDatabase(), pin))

ipcMain.handle('auth-set-owner-pin', (_event, newPin: string) => {
    setOwnerPin(getDatabase(), newPin)
    return { success: true }
})

ipcMain.handle('auth-owner-pin-is-default', () => ownerPinIsDefault(getDatabase()))

// Receipt Handlers
ipcMain.handle('receipt-preview', (_, data) => {
    return ReceiptService.generateReceiptHTML(data)
})

ipcMain.handle('receipt-print', async (_, data) => {
    return ReceiptService.print(data)
})

/** Rebuild a completed sale's receipt from the ledger, for re-printing from the
 *  sales history. The renderer must NOT reassemble this from three separate
 *  calls: the discount, the timbre and the per-line original price all come
 *  from the stored rows, and a client-side reconstruction is how a reprint ends
 *  up disagreeing with the paper the customer already has. */
ipcMain.handle('receipt-from-transaction', async (_, transactionId: number) => {
    return ReceiptService.generateReceiptDataFromTransaction(transactionId)
})

ipcMain.handle('receipt-get-config', () => {
    return ReceiptService.getConfig()
})

ipcMain.handle('receipt-save-config', (_, config) => {
    return ReceiptService.saveConfig(config)
})

// Report Handlers
ipcMain.handle('report-stats', () => {
    return ReportService.getDashboardStats()
})

ipcMain.handle('report-chart', (_, range) => {
    return ReportService.getSalesChartData(range?.startDate, range?.endDate)
})

ipcMain.handle('report-top-products', (_, limit) => {
    return ReportService.getTopSellingProducts(limit || 5)
})

ipcMain.handle('report-low-stock', () => {
    return ReportService.getLowStockProducts()
})

ipcMain.handle('report-category-sales', (_, range) => {
    return ReportService.getCategorySales(range?.startDate, range?.endDate)
})

ipcMain.handle('report-payment-stats', (_, range) => {
    return ReportService.getPaymentMethodStats(range?.startDate, range?.endDate)
})


// Invoice Handlers
ipcMain.handle('invoice-pdf', async (_, data) => {
    try {
        const buffer = await InvoiceService.generateInvoicePDF(data)
        const { canceled, filePath } = await dialog.showSaveDialog(win!, {
            title: 'Save Invoice',
            defaultPath: `Invoice-${data.transactionNumber}.pdf`,
            filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
        })

        if (!canceled && filePath) {
            fs.writeFileSync(filePath, buffer)
            return { success: true, filePath }
        }
        return { success: false, error: 'Cancelled' }
    } catch (error: any) {
        console.error('Invoice generation failed:', error)
    }
})

// ipcMain.handle('invoice-print', (_, data) => InvoiceService.print(data))

// Label Handlers
ipcMain.handle('label-print', async (_, { product, config, preview }) => {
    return LabelService.printLabel(product, config, preview)
})

// Printer & Config Handlers
ipcMain.handle('get-printers', async () => {
    return win?.webContents.getPrintersAsync() || []
})

ipcMain.handle('settings-get-printer-config', () => {
    const db = getDatabase()
    const row = db.prepare("SELECT value FROM config WHERE key = 'printer_config'").get() as { value: string } | undefined
    return row ? JSON.parse(row.value) : { label: '', receipt: '', order: '' }
})

ipcMain.handle('settings-save-printer-config', (_, config) => {
    const db = getDatabase()
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('printer_config', ?)").run(JSON.stringify(config))
    return { success: true }
})



import { seedDatabase } from './seed'

ipcMain.handle('db-seed', () => {
    return seedDatabase()
})



ipcMain.handle('print-yearly-delivery-report', async (_, customerName?: string) => {
    const db = getDatabase()
    const currentYear = new Date().getFullYear()
    const startDate = `${currentYear}-01-01`
    const endDate = `${currentYear}-12-31`

    let query = `
        SELECT t.transaction_number as ref, t.created_at as date, t.total_amount as amount, 
               COALESCE(REPLACE(t.customer_notes, 'Name: ', ''), c.name, 'Client Comptant') as customer
        FROM transactions t
        LEFT JOIN customers c ON t.customer_id = c.id
        WHERE t.created_at BETWEEN ? AND ? AND t.status = 'completed'
        AND (t.customer_id IS NOT NULL OR t.customer_notes LIKE 'Name: %')
    `
    const params: any[] = [startDate, endDate]

    if (customerName) {
        query += ` AND (c.name = ? OR t.customer_notes = ?)`
        params.push(customerName, `Name: ${customerName}`)
    }

    query += ` ORDER BY t.created_at ASC`

    const deliveries = db.prepare(query).all(...params) as any[]
    return ReportService.printYearlyDeliveries(deliveries, currentYear)
})

// --- AI copilot: capability-registry + tool-calling orchestrator (see electron/ai/) ---
async function handleAIAction(text: string) {
    try {
        const result = await runAssistant(text, { userId: 1 })
        console.log(`[AI OS] Input: ${text} | tools: ${result.toolsUsed.join(', ') || 'none'}`)

        // Forward any UI events the capabilities emitted (navigation, cart add, theme, ...).
        if (win) {
            for (const ev of result.events) win.webContents.send(ev.channel, ev.payload)
        }

        const audio = await generateSpeech(result.reply)
        return {
            text,
            response: result.reply,
            audio,
            success: result.success,
            toolsUsed: result.toolsUsed,
            needsConfirmation: result.needsConfirmation,
            pendingAction: result.pendingAction,
        }
    } catch (error) {
        console.error('[AI OS] Error processing action:', error)
        return { error: 'System error' }
    }
}

ipcMain.handle('ai-get-usage', () => getUsage())

// Execute a destructive action the user just confirmed in the UI.
ipcMain.handle('ai-confirm-action', async (_, pending: { name: string; args: any }) => {
    try {
        const result = await executeConfirmed(pending, { userId: 1 })
        if (win) {
            for (const ev of result.events) win.webContents.send(ev.channel, ev.payload)
        }
        const audio = await generateSpeech(result.reply)
        return { response: result.reply, audio, success: result.success }
    } catch (error) {
        console.error('[AI OS] Confirm action error:', error)
        return { error: 'System error' }
    }
})

// --- AI OS IPC HANDLERS ---
ipcMain.handle('ai-process-voice', async (_, audioBuffer: Buffer) => {
    try {
        const text = await transcribeAudio(audioBuffer)
        if (!text) return { error: 'Could not transcribe audio' }
        return await handleAIAction(text)
    } catch (error) {
        return { error: 'Transcription failed' }
    }
})

ipcMain.handle('ai-process-text', async (_, text: string) => {
    console.log('[AI OS] IPC Received (Text):', text)
    return await handleAIAction(text)
})

// Product Handlers

ipcMain.handle('product-get-all', (_, filters) => ProductService.getAll(filters))
ipcMain.handle('product-get-by-id', (_, id) => ProductService.getById(id))
ipcMain.handle('product-get-by-barcode', (_, barcode) => ProductService.getByBarcode(barcode))
ipcMain.handle('product-create', (_, product) => ProductService.create(product))
ipcMain.handle('product-update', (_, { id, product }) => ProductService.update(id, product))
ipcMain.handle('product-delete', async (_, id) => {
    return ProductService.delete(id)
})
ipcMain.handle('product-update-stock', async (_, { id, qty }) => {
    return ProductService.updateStock(id, qty)
})
ipcMain.handle('product-get-count', (_, filters) => ProductService.getCount(filters))
ipcMain.handle('product-get-units', (_, productId) => ProductService.getUnits(productId))
ipcMain.handle('product-set-units', (_, { productId, units }) => ProductService.setUnits(productId, units))
ipcMain.handle('product-get-suppliers', (_, productId) => ProductService.getSuppliers(productId))
ipcMain.handle('product-set-suppliers', (_, { productId, suppliers }) => ProductService.setSuppliers(productId, suppliers))
ipcMain.handle('product-get-variants', (_, productId) => ProductService.getVariants(productId))
ipcMain.handle('product-set-variants', (_, { productId, variants }) => ProductService.setVariants(productId, variants))
ipcMain.handle('product-update-variant-stock', (_, { variantId, quantity }) => ProductService.updateVariantStock(variantId, quantity))

// Category Handlers
ipcMain.handle('category-get-all', () => CategoryService.getAll())
ipcMain.handle('category-get-tree', () => CategoryService.getTree())
ipcMain.handle('category-create', (_, category) => CategoryService.create(category))
ipcMain.handle('category-update', (_, { id, category }) => CategoryService.update(id, category))
ipcMain.handle('category-delete', (_, id) => CategoryService.delete(id))

// Tax categories (TVA rates)
ipcMain.handle('tax-category-get-all', () => getDatabase().prepare('SELECT * FROM tax_categories ORDER BY rate DESC').all())

// Generic config key/value (régime, prices_include_tax, fiscal identity, etc.)
ipcMain.handle('config-get', (_, key: string) => {
    const row = getDatabase().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
})
ipcMain.handle('config-set', (_, { key, value }: { key: string; value: string }) => {
    getDatabase().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value))
    return { success: true }
})

// Supplier Handlers
ipcMain.handle('supplier-get-all', () => SupplierService.getAll())
ipcMain.handle('supplier-get-by-id', (_, id) => SupplierService.getById(id))
ipcMain.handle('supplier-create', (_, supplier) => SupplierService.create(supplier))
ipcMain.handle('supplier-update', (_, { id, supplier }) => SupplierService.update(id, supplier))
ipcMain.handle('supplier-delete', (_, id) => SupplierService.delete(id))

// Transaction Handlers

// Customer Handlers
ipcMain.handle('customer-get-all', () => CustomerService.getAll())
ipcMain.handle('customer-get-by-id', (_, id) => CustomerService.getById(id))
ipcMain.handle('customer-search', (_, query) => CustomerService.search(query))
ipcMain.handle('customer-create', (_, customer) => CustomerService.create(customer))
ipcMain.handle('customer-update', (_, { id, customer }) => CustomerService.update(id, customer))
ipcMain.handle('customer-price-map', (_, customerId) => {
    const rows = getDatabase().prepare('SELECT product_id, price FROM customer_prices WHERE customer_id = ?').all(customerId) as { product_id: number; price: number }[]
    const map: Record<number, number> = {}
    for (const r of rows) map[r.product_id] = r.price
    return map
})
ipcMain.handle('customer-price-set', (_, { customerId, productId, price }) => {
    getDatabase().prepare('INSERT OR REPLACE INTO customer_prices (customer_id, product_id, price) VALUES (?, ?, ?)').run(customerId, productId, price)
    return { success: true }
})

// Accounting & declaration feeders (Phase 5)
ipcMain.handle('accounting-journal-ventes', (_, { year, month }) => AccountingService.journalVentes(year, month))
ipcMain.handle('accounting-journal-achats', (_, { year, month }) => AccountingService.journalAchats(year, month))
ipcMain.handle('accounting-journal-caisse', (_, { year, month }) => AccountingService.journalCaisse(year, month))
ipcMain.handle('accounting-g50', (_, { year, month }) => AccountingService.g50(year, month))
ipcMain.handle('accounting-etat104', (_, year) => AccountingService.etat104(year))
ipcMain.handle('accounting-jibayatic', (_, { year, month }) => AccountingService.jibayatic(year, month))
ipcMain.handle('accounting-inventory-valuation', () => AccountingService.inventoryValuation())
ipcMain.handle('accounting-physical-inventory', (_, { counts, userId }) => AccountingService.applyPhysicalInventory(counts, userId))
ipcMain.handle('accounting-liasse', (_, year) => AccountingService.liasse(year))
ipcMain.handle('accounting-export-csv', async (_, { filename, csv }) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Exporter (CSV)',
        defaultPath: path.join(app.getPath('desktop'), filename || 'export.csv'),
        filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (canceled || !filePath) return { success: false, error: 'cancelled' }
    fs.writeFileSync(filePath, '﻿' + csv, 'utf-8') // BOM so Excel reads UTF-8
    return { success: true, path: filePath }
})

// Employees + payroll.
//
// The register is guarded by `employees.manage` rather than by the payroll
// feature flag: knowing who works here is not optional, and a salary is one of
// the few numbers in this system that must not be visible to the person it
// belongs to.
ipcMain.handle('payroll-enabled', () => PayrollService.isEnabled())
ipcMain.handle('payroll-set-enabled', (_, { on, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'employees.manage')
    return PayrollService.setEnabled(on)
}))
ipcMain.handle('payroll-employees', (_, includeInactive?: boolean) => PayrollService.listEmployees(includeInactive))
ipcMain.handle('payroll-employee-create', (_, { data, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'employees.manage')
    const res = PayrollService.createEmployee(data)
    if (res.success) {
        AuditService.log({
            userId, action: 'employee.create', entityType: 'employee',
            entityId: res.id, newValue: data, severity: 'warning',
        })
    }
    return res
}))
ipcMain.handle('payroll-employee-update', (_, { id, data, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'employees.manage')
    const before = PayrollService.getEmployee(id)
    const res = PayrollService.updateEmployee(id, data)
    AuditService.logChange({
        userId, action: 'employee.update', entityType: 'employee', entityId: id,
        before, after: data as unknown as Record<string, unknown>, severity: 'warning',
    })
    return res
}))
ipcMain.handle('payroll-employee-delete', (_, { id, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'employees.manage')
    AuditService.log({
        userId, action: 'employee.deactivate', entityType: 'employee',
        entityId: id, severity: 'warning',
    })
    return PayrollService.deleteEmployee(id)
}))
ipcMain.handle('payroll-run', (_, { period, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'employees.manage')
    return PayrollService.runPayroll(period)
}))
ipcMain.handle('payroll-payslips', (_, period) => PayrollService.listPayslips(period))
/** Push a period's wage bill into the expense ledger. Idempotent — see
 *  PayrollService.postPeriodToExpenses. */
ipcMain.handle('payroll-post-expenses', (_, { period, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'employees.manage')
    const res = PayrollService.postPeriodToExpenses(period, userId)
    if (res.success) {
        AuditService.log({
            userId, action: 'payroll.post', entityType: 'payroll', entityId: null,
            newValue: { period, posted: res.posted, total: res.total }, severity: 'warning',
        })
    }
    return res
}))
ipcMain.handle('payroll-posting-status', (_, period) => PayrollService.postingStatus(period))
ipcMain.handle('payroll-wage-bill', (_, { from, to, storeId }) => PayrollService.wageBill(from, to, storeId))

// Reservations / acompte + consignation (Phase 4.10)
ipcMain.handle('reservation-create', (_, { customerId, productId, quantity, deposit, userId, notes }) => ReservationService.reserve(customerId, productId, quantity, deposit, userId, notes))
ipcMain.handle('reservation-list', (_, status) => ReservationService.list(status))
ipcMain.handle('reservation-release', (_, id) => ReservationService.release(id))
ipcMain.handle('reservation-fulfill', (_, { id, userId }) => ReservationService.fulfill(id, userId))
ipcMain.handle('consignment-receive', (_, { supplierId, productId, quantity, unitCost, userId }) => ReservationService.consignmentReceive(supplierId, productId, quantity, unitCost, userId))
ipcMain.handle('consignment-list', (_, status) => ReservationService.consignmentList(status))
ipcMain.handle('consignment-settle', (_, { id, quantity }) => ReservationService.consignmentSettle(id, quantity))
ipcMain.handle('po-apply-landed-cost', (_, { poId, extraCost }) => PurchaseOrderService.applyLandedCost(poId, extraCost))

// Kredi ledger / AR + AP + cheques (Phase 4.9)
ipcMain.handle('ledger-customer-balance', (_, customerId) => LedgerService.customerBalance(customerId))
ipcMain.handle('ledger-credit-status', (_, customerId) => LedgerService.creditStatus(customerId))
ipcMain.handle('ledger-customer-statement', (_, customerId) => LedgerService.customerStatement(customerId))
ipcMain.handle('ledger-aging', () => LedgerService.aging())
ipcMain.handle('ledger-settle-partial', (_, { transactionId, amount, method, reference }) => LedgerService.settlePartial(transactionId, amount, method, reference))
ipcMain.handle('ledger-print-statement', (_, customerId) => LedgerService.printStatement(customerId))
ipcMain.handle('ledger-supplier-balance', (_, supplierId) => LedgerService.supplierBalance(supplierId))
ipcMain.handle('ledger-supplier-statement', (_, supplierId) => LedgerService.supplierStatement(supplierId))
ipcMain.handle('ledger-supplier-pay', (_, { supplierId, amount, method, reference, notes }) => LedgerService.addSupplierPayment(supplierId, amount, method, reference, notes))
ipcMain.handle('ledger-cheque-add', (_, c) => LedgerService.addCheque(c))
ipcMain.handle('ledger-cheque-list', (_, filter) => LedgerService.listCheques(filter))
ipcMain.handle('ledger-cheque-status', (_, { id, status }) => LedgerService.updateChequeStatus(id, status))

// Commercial documents (devis/proforma/BC/récapitulative — Phase 4.7)
ipcMain.handle('document-create', (_, { docType, customerId, userId, items, notes }) => DocumentService.create(docType, customerId, userId, items, notes))
ipcMain.handle('document-get', (_, id) => DocumentService.getById(id))
ipcMain.handle('document-list', (_, { docType, limit } = {}) => DocumentService.list(docType, limit))
ipcMain.handle('document-convert-to-sale', (_, { docId, userId }) => DocumentService.convertToSale(docId, userId))
ipcMain.handle('document-recapitulative', (_, { customerId, year, month, userId }) => DocumentService.createRecapitulative(customerId, year, month, userId))
ipcMain.handle('document-print', (_, id) => DocumentService.print(id))

// Warehouses / multi-depot + bon de transfert (Phase 4.6)
ipcMain.handle('warehouse-list', () => WarehouseService.list())
ipcMain.handle('warehouse-create', (_, w) => WarehouseService.create(w))
ipcMain.handle('warehouse-deactivate', (_, id) => WarehouseService.deactivate(id))
ipcMain.handle('warehouse-stock', (_, warehouseId) => WarehouseService.stock(warehouseId))
ipcMain.handle('warehouse-transfer-create', (_, { fromWarehouseId, toWarehouseId, items, userId, notes }) => WarehouseService.createTransfer(fromWarehouseId, toWarehouseId, items, userId, notes))
ipcMain.handle('warehouse-transfer-list', (_, limit) => WarehouseService.listTransfers(limit))
ipcMain.handle('warehouse-transfer-get', (_, id) => WarehouseService.getTransfer(id))
ipcMain.handle('warehouse-transfer-print', (_, id) => WarehouseService.printTransfer(id))

// Pricing rules (bulk / quantity breaks — Phase 4.3)
ipcMain.handle('pricing-rule-list', () => PricingService.listRules())
ipcMain.handle('pricing-rule-create', (_, rule) => PricingService.createRule(rule))
ipcMain.handle('pricing-rule-delete', (_, id) => PricingService.deleteRule(id))
ipcMain.handle('pricing-rule-set-active', (_, { id, active }) => PricingService.setActive(id, active))

// Transaction Handlers
ipcMain.handle('transaction-create', (_, { userId, customerId }) => TransactionService.create(userId, customerId))
ipcMain.handle('transaction-set-customer', (_, { transactionId, customerId }) => {
    getDatabase().prepare('UPDATE transactions SET customer_id = ? WHERE id = ?').run(customerId, transactionId)
    return { success: true }
})
ipcMain.handle('transaction-get-by-id', (_, id) => TransactionService.getById(id))
ipcMain.handle('transaction-add-item', (_, data) => TransactionService.addItem(data.transactionId, data.productId, data.productName, data.quantity, data.unitPrice, data.sku, data.variantId, data.unit, data.unitFactor))
ipcMain.handle('transaction-update-item-quantity', (_, { itemId, quantity }) => TransactionService.updateItemQuantity(itemId, quantity))
ipcMain.handle('transaction-set-item-unit', (_, { itemId, unit, unitFactor }) => TransactionService.setItemUnit(itemId, unit, unitFactor))
ipcMain.handle('transaction-remove-item', (_, itemId) => TransactionService.removeItem(itemId))
ipcMain.handle('transaction-get-items', (_, transactionId) => TransactionService.getItems(transactionId))
ipcMain.handle('transaction-check-stock', (_, transactionId) => TransactionService.checkStock(transactionId))
ipcMain.handle('transaction-apply-discount', (_, data) => TransactionService.applyDiscount(data.transactionId, data.discountType, data.discountValue))
ipcMain.handle('transaction-add-payment', (_, data) => TransactionService.addPayment(data.transactionId, data.method, data.amount, data.referenceNumber))
ipcMain.handle('transaction-get-payments', (_, transactionId) => TransactionService.getPayments(transactionId))
// Wrapped in guard(): since the oversell guard moved onto the sale path, completion
// can refuse for a real business reason (INSUFFICIENT_STOCK). Letting that reject
// would surface "Error invoking remote method" to a cashier; the envelope lets the
// till name the garment that is short instead.
ipcMain.handle('transaction-complete', (_, { transactionId, debtDueDate, customerNameOverride }) =>
    guardAndPublish(
        () => TransactionService.complete(transactionId, debtDueDate, customerNameOverride),
        () => {
            const txn = TransactionService.getById(transactionId) as any
            const storeId = txn?.store_id ?? null
            EventBus.publish('sale.created', storeId, {
                transactionId, transactionNumber: txn?.transaction_number,
            })
            // Stock moved too, and the screens that watch stock are not the same
            // ones that watch sales.
            EventBus.publish('inventory.updated', storeId, { reason: 'sale', transactionId })
        }))
ipcMain.handle('transaction-void', (_, transactionId) => TransactionService.void(transactionId))
ipcMain.handle('transaction-create-avoir', (_, { originalId, userId, restock }) => TransactionService.createAvoir(originalId, userId || 1, restock !== false))
ipcMain.handle('transaction-get-recent', (_, limit) => TransactionService.getRecentTransactions(limit))
ipcMain.handle('transaction-get-debtors', () => TransactionService.getDebtors())
ipcMain.handle('transaction-settle-debt', (_, transactionId) => TransactionService.settleDebt(transactionId))
ipcMain.handle('transaction-get-deliveries', (_, limit) => TransactionService.getDeliveries(limit))

// Purchase Order Handlers
ipcMain.handle('purchase-order-get-all', () => PurchaseOrderService.getAll())
ipcMain.handle('purchase-order-get-by-id', (_, id) => PurchaseOrderService.getById(id))
ipcMain.handle('purchase-order-create', (_, { userId, supplierId, items, notes }) => PurchaseOrderService.create(userId, supplierId, items, notes))
ipcMain.handle('purchase-order-receive', (_, { id, userId }) => PurchaseOrderService.receive(id, userId))
ipcMain.handle('purchase-order-receive-partial', (_, { id, userId, lines }) => PurchaseOrderService.receivePartial(id, userId, lines))
ipcMain.handle('supplier-return-create', (_, { supplierId, items, userId, reason }) => PurchaseOrderService.createReturn(supplierId, items, userId, reason))
ipcMain.handle('supplier-return-list', (_, limit) => PurchaseOrderService.listReturns(limit))
ipcMain.handle('purchase-order-print', (_, id) => PurchaseOrderService.printPO(id))
ipcMain.handle('report-inventory-movement', async (_, { startDate, endDate, periodType }) => {
    return ReportService.printInventoryMovementReport(startDate, endDate, periodType)
})

ipcMain.handle('invoice-print', async (_, data) => {
    // If data is already a ReceiptData object (from ReceiptPreview), use it directly
    if (data && typeof data === 'object' && data.transactionNumber) {
        // Ensure adminSignature is present
        if (!data.adminSignature) {
            data.adminSignature = (ReceiptService as any).getAdminSignature()
        }
        return InvoiceService.print(data)
    }

    // Legacy: if data is a transactionId number, fetch and build receipt data
    const transactionId = typeof data === 'number' ? data : data?.transactionId
    if (!transactionId) throw new Error('Invalid invoice-print data')

    const db = getDatabase()
    const txn = db.prepare(`
        SELECT t.*, c.name as customer_name
        FROM transactions t
        LEFT JOIN customers c ON t.customer_id = c.id
        WHERE t.id = ?
    `).get(transactionId) as any

    if (!txn) throw new Error('Transaction not found')

    // Parse customer name override from customer_notes if exists
    if (txn.customer_notes && txn.customer_notes.startsWith('Name: ')) {
        txn.customerName = txn.customer_notes.replace('Name: ', '')
    } else {
        txn.customerName = txn.customer_name || 'Client Comptant'
    }

    const items = db.prepare('SELECT * FROM transaction_items WHERE transaction_id = ?').all(transactionId) as any[]

    // Map items to match ReceiptData structure used by InvoiceService
    const receiptItems = items.map(item => ({
        name: item.product_name,
        quantity: item.quantity,
        unitPrice: item.unit_price,
        total: item.line_total,
        taxRate: item.tax_rate || 0,
        taxAmount: item.tax_amount || 0
    }))

    const receiptData = {
        transactionNumber: txn.transaction_number,
        date: txn.completed_at || txn.created_at || new Date().toLocaleString(),
        customerName: txn.customerName,
        cashierName: 'Admin',
        adminSignature: (ReceiptService as any).getAdminSignature(),
        items: receiptItems,
        subtotal: txn.subtotal,
        discount: txn.discount_amount,
        tax: txn.tax_amount || 0,
        total: txn.total_amount,
        timbre: txn.timbre || 0,
        amountPaid: txn.amount_paid,
        change: txn.change_due,
        payments: [] // Add empty payments if none
    }

    return InvoiceService.print(receiptData as any)
})

ipcMain.handle('print-yearly-settlement-report', async (_, supplierName) => {
    return ReportService.printYearlySettlement(supplierName)
})

import { startSyncServer, getLocalIP, getSyncToken } from './syncServer'

// Start Request Server
startSyncServer(4000).then((info) => {
    if (info) {
        console.log('Sync Service Started:', info)
    }
})

ipcMain.handle('get-local-ip', () => {
    return getLocalIP()
})

ipcMain.handle('get-sync-token', () => getSyncToken())

// Maintenance Handlers
ipcMain.handle('maintenance-export-products', async () => {
    try {
        console.log('[Maintenance] Starting export...')
        const db = getDatabase()
        const dbProducts = db.prepare(`
            SELECT p.name, p.retail_price as price, c.name as category 
            FROM products p 
            LEFT JOIN categories c ON p.category_id = c.id
        `).all() as any[]

        // Use a persistent path in userData for built app, or CWD for dev
        const masterPath = app.isPackaged
            ? path.join(app.getPath('userData'), 'products_master.json')
            : path.join(process.cwd(), 'products_master.json')

        console.log('[Maintenance] Export target:', masterPath)
        let merged = [...dbProducts]

        if (fs.existsSync(masterPath)) {
            console.log('[Maintenance] Found existing master file, merging...')
            const newProds = JSON.parse(fs.readFileSync(masterPath, 'utf-8'))
            const existingNames = new Set(dbProducts.map(p => p.name.toLowerCase()))
            for (const p of newProds) {
                if (!existingNames.has(p.name.toLowerCase())) {
                    merged.push(p)
                }
            }
        }

        fs.writeFileSync(masterPath, JSON.stringify(merged, null, 2))
        return { success: true, count: merged.length, path: masterPath }
    } catch (error: any) {
        console.error('[Maintenance] Export failed:', error)
        return { success: false, error: error.message }
    }
})

ipcMain.handle('maintenance-import-products', async (_e, userId?: number) => {
    try {
        console.log('[Maintenance] Starting import with file picker...')

        // Open file picker dialog
        const result = await dialog.showOpenDialog({
            title: 'Select Master Data JSON',
            filters: [{ name: 'JSON Files', extensions: ['json'] }],
            properties: ['openFile']
        })

        if (result.canceled || result.filePaths.length === 0) {
            console.log('[Maintenance] Import cancelled by user')
            return { success: false, error: 'cancelled' }
        }

        const selectedPath = result.filePaths[0]
        console.log('[Maintenance] Import source:', selectedPath)

        const fileContent = JSON.parse(fs.readFileSync(selectedPath, 'utf-8'))
        const db = getDatabase()

        // Determine structure: plain array or { products, suppliers }
        const products = Array.isArray(fileContent) ? fileContent : (fileContent.products || [])
        const suppliers = Array.isArray(fileContent) ? [] : (fileContent.suppliers || [])

        // Get or create Categories
        const insertCat = db.prepare('INSERT OR IGNORE INTO categories (name, icon) VALUES (?, ?)')
        const allCategories = new Set(products.map((p: any) => p.category).filter(Boolean))
        for (const catName of allCategories) {
            insertCat.run(catName, '📦')
        }

        // Refresh category map after potential inserts
        const categories = db.prepare('SELECT id, name FROM categories').all() as any[]
        const catMap = Object.fromEntries(categories.map(c => [c.name.toLowerCase(), c.id]))

        const insertProd = db.prepare(`
            INSERT OR IGNORE INTO products (name, retail_price, category_id, is_active) 
            VALUES (?, ?, ?, 1)
        `)
        const insertStock = db.prepare('INSERT OR IGNORE INTO stock_inventory (product_id, quantity) VALUES (?, 0)')

        let importedProducts = 0
        const prodTransaction = db.transaction((prods: any[]) => {
            for (const p of prods) {
                const catId = catMap[p.category?.toLowerCase()] || 1
                const res = insertProd.run(p.name, p.price || 0, catId)
                if (res.lastInsertRowid) {
                    insertStock.run(res.lastInsertRowid)
                    importedProducts++
                }
            }
        })
        prodTransaction(products)

        // Import suppliers if present
        let importedSuppliers = 0
        if (suppliers.length > 0) {
            const insertSup = db.prepare('INSERT OR IGNORE INTO suppliers (company_name, contact_name, phone, email, city, is_active) VALUES (?, ?, ?, ?, ?, 1)')
            const supTransaction = db.transaction((sups: any[]) => {
                for (const s of sups) {
                    const res = insertSup.run(s.company_name || s.name, s.contact_name || null, s.phone || null, s.email || null, s.city || null)
                    if (res.lastInsertRowid) importedSuppliers++
                }
            })
            supTransaction(suppliers)
        }

        console.log(`[Maintenance] Import complete: ${importedProducts} products, ${importedSuppliers} suppliers`)
        // Who imported what, from where — the Network screen's "logs" tab reads this
        // back. Severity is a warning because a bulk import rewrites the catalogue.
        AuditService.log({
            userId: userId ?? null,
            action: 'maintenance.import',
            entityType: 'product',
            summary: `Import catalogue : ${importedProducts} produit(s), ${importedSuppliers} fournisseur(s)`,
            deviceInfo: os.hostname(),
            severity: 'warning',
        })
        return { success: true, products: importedProducts, suppliers: importedSuppliers }
    } catch (error: any) {
        console.error('[Maintenance] Import error:', error)
        return { success: false, error: error.message }
    }
})

ipcMain.handle('maintenance-export-all', async () => {
    try {
        const db = getDatabase()
        const tables = [
            'users', 'categories', 'suppliers', 'products',
            'stock_inventory', 'customers', 'transactions',
            'transaction_items', 'payments', 'expenses', 'pricing_rules'
        ]

        const data: Record<string, any[]> = {}
        for (const table of tables) {
            try {
                data[table] = db.prepare(`SELECT * FROM ${table}`).all()
            } catch (err) {
                console.warn(`[Maintenance] Table ${table} not found or inaccessible`)
            }
        }

        const { filePath, canceled } = await dialog.showSaveDialog({
            title: 'Export Full Database',
            defaultPath: path.join(app.getPath('desktop'), `POS_Full_Backup_${new Date().toISOString().split('T')[0]}.json`),
            filters: [{ name: 'JSON Files', extensions: ['json'] }]
        })

        if (canceled || !filePath) return { success: false, error: 'cancelled' }

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
        return { success: true, path: filePath }
    } catch (error: any) {
        console.error('[Maintenance] Export All error:', error)
        return { success: false, error: error.message }
    }
})

ipcMain.handle('maintenance-reset-db', async () => {
    try {
        console.log('[Maintenance] Starting database reset...')
        resetDatabaseFile()

        // Reload the current window to reset frontend state
        if (win) {
            win.reload()
        }

        return { success: true }
    } catch (error: any) {
        console.error('[Maintenance] Reset failed:', error)
        return { success: false, error: error.message }
    }
})

// Firestore cloud relay — lets the phone work away from the shop.
// LAN stays the fast path; this is the fallback, and SQLite stays the source of truth.
ipcMain.handle('cloud-get-config', () => getCloudConfig())
ipcMain.handle('cloud-set-config', (_e, patch) => setCloudConfig(patch))
ipcMain.handle('cloud-test', () => CloudSync.test())
ipcMain.handle('cloud-push-catalog', () => CloudSync.pushCatalog())

/** Pull phone sales made off-wifi, ingest them locally, then mark them done. */
ipcMain.handle('cloud-pull-transactions', async () => {
    const pulled = await CloudSync.pullTransactions()
    if (!pulled.success) return pulled
    const txs = pulled.transactions || []
    if (txs.length === 0) return { success: true, success_count: 0, skipped: 0 }

    const result = ingestMobileTransactions(txs)
    // Only mark what actually landed. A failed ingest stays queued in the cloud so
    // the sale is retried rather than silently lost.
    await CloudSync.markIngested(result.ingested)
    return { success: true, success_count: result.success, skipped: result.skipped, failed: result.failed, errors: result.errors }
})

// Loyalty Handlers (Phase 3)
ipcMain.handle('loyalty-config-get', () => LoyaltyService.getConfig())
ipcMain.handle('loyalty-config-set', (_e, cfg) => LoyaltyService.setConfig(cfg))
ipcMain.handle('loyalty-balance', (_e, customerId) => LoyaltyService.balance(customerId))
ipcMain.handle('loyalty-history', (_e, { customerId, limit }) => LoyaltyService.history(customerId, limit))
ipcMain.handle('loyalty-redeem', (_e, { customerId, points, transactionId }) => LoyaltyService.redeem(customerId, points, transactionId))
ipcMain.handle('loyalty-adjust', (_e, { customerId, points, note, userId }) => LoyaltyService.adjust(customerId, points, note, userId))
ipcMain.handle('loyalty-top', (_e, limit) => LoyaltyService.topCustomers(limit))
ipcMain.handle('loyalty-set-card', (_e, { customerId, cardNumber }) => LoyaltyService.setCardNumber(customerId, cardNumber))
ipcMain.handle('loyalty-find-card', (_e, cardNumber) => LoyaltyService.findByCard(cardNumber))

// Pertes / shrinkage Handlers (Phase 3)
ipcMain.handle('loss-record', (_e, input) => LossService.record(input))
ipcMain.handle('loss-list', (_e, limit) => LossService.list(limit))
ipcMain.handle('loss-summary', (_e, { startDate, endDate } = {}) => LossService.summary(startDate, endDate))
ipcMain.handle('loss-revert', (_e, { id, userId }) => LossService.revert(id, userId))

// Cash session / Z-report Handlers (Phase 2)
ipcMain.handle('cash-session-current', () => CashSessionService.getCurrent())
ipcMain.handle('cash-session-list', (_e, limit) => CashSessionService.list(limit))
ipcMain.handle('cash-session-open', (_e, { userId, openingFloat, notes }) => {
    const r = CashSessionService.open(userId, openingFloat, notes)
    if ((r as any)?.success !== false) EventBus.publish('cash_session.updated', StoreService.getCurrentStoreId(), { action: 'open' })
    return r
})
ipcMain.handle('cash-session-close', (_e, { userId, countedCash, notes }) => {
    const r = CashSessionService.close(userId, countedCash, notes)
    if ((r as any)?.success !== false) EventBus.publish('cash_session.updated', StoreService.getCurrentStoreId(), { action: 'close' })
    return r
})
ipcMain.handle('cash-session-report', (_e, sessionId) => CashSessionService.report(sessionId))
ipcMain.handle('cash-session-movement', (_e, { direction, amount, reason, userId }) => CashSessionService.addMovement(direction, amount, reason, userId))

// Expense Handlers
ipcMain.handle('expense-list', async (_event, filters) => {
    try {
        return ExpenseService.getAll(filters || {})
    } catch (error: any) {
        console.error('[Expense] List error:', error)
        throw error
    }
})

ipcMain.handle('expense-totals', async (_event, storeId) => {
    try {
        return ExpenseService.getTotals(storeId ?? null)
    } catch (error: any) {
        console.error('[Expense] Totals error:', error)
        throw error
    }
})

ipcMain.handle('expense-create', async (_event, data) => {
    try {
        return ExpenseService.create(data.name, data.amount, data.userId, {
            category: data.category,
            storeId: data.storeId ?? null,
            spentAt: data.spentAt,
        })
    } catch (error: any) {
        console.error('[Expense] Create error:', error)
        throw error
    }
})

ipcMain.handle('expense-by-category', async (_event, filters) => {
    try {
        return ExpenseService.byCategory(filters || {})
    } catch (error: any) {
        console.error('[Expense] Category breakdown error:', error)
        throw error
    }
})

ipcMain.handle('expense-delete', async (_event, id) => {
    try {
        return ExpenseService.delete(id)
    } catch (error: any) {
        console.error('[Expense] Delete error:', error)
        throw error
    }
})

function createWindow() {
    win = new BrowserWindow({
        // White-label: neutral title; the renderer sets document.title to the client's
        // business name once config loads (see App.tsx).
        title: 'Dapper',
        icon: path.join(process.env.VITE_PUBLIC || '', 'electron-vite.svg'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        width: 1200,
        height: 800,
        show: false, // Don't show until maximized
    })

    // Allow microphone (for the AI voice assistant); deny other permission requests.
    win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(permission === 'media')
    })

    win.maximize()
    win.show()

    // Test active push message to Renderer-process.
    win.webContents.on('did-finish-load', () => {
        win?.webContents.send('main-process-message', (new Date).toLocaleString())
    })

    if (VITE_DEV_SERVER_URL) {
        win.loadURL(VITE_DEV_SERVER_URL)
        // win.webContents.openDevTools()
    } else {
        win.loadFile(path.join(process.env.DIST || '', 'index.html'))
    }
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
        win = null
    }
})

app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
    }
})

// --- Auto-update scaffold (Phase 6.3) ---
// In-app update flow: the renderer calls `app-check-updates`. Full auto-download
// requires the owner to (a) `npm i electron-updater`, (b) set a publish target in
// package.json build.publish, and (c) configure `update_feed_url` in config. Until
// then this reports the current version and a not-configured status (no crash).
ipcMain.handle('app-version', () => app.getVersion())
ipcMain.handle('app-check-updates', async () => {
    try {
        const feed = (getDatabase().prepare("SELECT value FROM config WHERE key = 'update_feed_url'").get() as { value: string } | undefined)?.value
        if (!feed) return { available: false, version: app.getVersion(), reason: 'not_configured' }
        // Owner has wired electron-updater + a publish target — load it dynamically
        // (indirection keeps the bundler from hard-requiring an optional dependency).
        const dynRequire = eval('require') as NodeRequire
        const { autoUpdater } = dynRequire('electron-updater')
        autoUpdater.setFeedURL(feed)
        const r = await autoUpdater.checkForUpdates()
        return { available: !!r?.updateInfo && r.updateInfo.version !== app.getVersion(), version: app.getVersion(), latest: r?.updateInfo?.version }
    } catch (e: any) {
        return { available: false, version: app.getVersion(), reason: 'updater_unavailable', error: e?.message }
    }
})


// ---------------------------------------------------------------------------
// Multi-store retail management (docs/RETAIL_PLAN.md phases 1, 3, 4).
//
// Service errors are translated into a standard envelope rather than allowed to
// propagate raw. Electron wraps a thrown error as "Error invoking remote method
// 'x': ..." on the renderer side, which is exactly the kind of message the brief
// forbids showing an employee (SS74, SS83). `ok:false` + a machine-readable `code`
// + a French message lets the UI choose between a toast, a dialog and a manager
// override prompt without parsing prose.
// ---------------------------------------------------------------------------
type ServiceResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

function guard<T>(fn: () => T): ServiceResult<T> {
    try {
        return { ok: true, data: fn() }
    } catch (e: any) {
        const code = e?.code && typeof e.code === 'string' ? e.code : 'UNEXPECTED_ERROR'
        // An unrecognised failure is a bug, not a business rule: log it here where the
        // stack still exists, since the renderer only ever sees the envelope.
        if (code === 'UNEXPECTED_ERROR') console.error('[ipc] unhandled service error:', e)
        return { ok: false, code, message: e?.message ?? 'Une erreur est survenue' }
    }
}

/**
 * guard(), then announce.
 *
 * `announce` runs only on success and only AFTER fn() has returned, which is what
 * makes it safe: the service's transaction has committed by then. Publishing from
 * inside a service would announce work that might still roll back, and every
 * subscriber would show stock that was never sold.
 */
function guardAndPublish<T>(
    fn: () => T,
    announce: (data: T) => void,
): ServiceResult<T> {
    const result = guard(fn)
    if (result.ok) {
        try {
            announce(result.data)
        } catch (e) {
            // A broadcast failure must never turn a completed sale into an error.
            console.error('[ipc] event publish failed:', e)
        }
    }
    return result
}

// --- Stores & terminals ---
ipcMain.handle('store-list', (_e, includeInactive?: boolean) => StoreService.list(includeInactive))
ipcMain.handle('store-get', (_e, id: number) => StoreService.getById(id))
ipcMain.handle('store-create', (_e, { data, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'stores.manage')
    const id = StoreService.create(data)
    AuditService.log({ userId, action: 'store.create', entityType: 'store', entityId: id, newValue: data, severity: 'warning' })
    return id
}))
ipcMain.handle('store-update', (_e, { id, data, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'stores.manage')
    const before = StoreService.getById(id)
    StoreService.update(id, data)
    AuditService.logChange({
        userId, action: 'store.update', entityType: 'store', entityId: id,
        before: before as any, after: StoreService.getById(id) as any, severity: 'warning',
    })
    return true
}))
ipcMain.handle('store-deactivate', (_e, { id, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'stores.manage')
    StoreService.deactivate(id)
    AuditService.log({ userId, action: 'store.deactivate', entityType: 'store', entityId: id, severity: 'critical' })
    return true
}))
ipcMain.handle('store-current', () => StoreService.getCurrentStore())
ipcMain.handle('store-current-id', () => StoreService.getCurrentStoreId())
/**
 * Which store this till sells for. The write is LOCAL (it is this box's identity)
 * but the permission must still be checked against the SHOP's roles — a client's
 * own database holds no real users, so checking it there would either wave
 * everyone through or refuse everyone.
 */
ipcMain.handle('store-set-current', async (_e, { storeId, userId }) => {
    try {
        const allowed = TerminalMode.isClient()
            ? await RpcClient.can(userId, 'settings.manage')
            : PermissionService.can(userId, 'settings.manage')
        if (!allowed) {
            return { ok: false, code: 'PERMISSION_DENIED', message: 'Action non autorisée' }
        }
        StoreService.setCurrentStore(storeId)
        if (!TerminalMode.isClient()) {
            AuditService.log({ userId, action: 'store.switch_device', entityType: 'store', entityId: storeId, severity: 'warning' })
        }
        return { ok: true, data: true }
    } catch (e: any) {
        if (e instanceof RpcUnavailableError) {
            return { ok: false, code: e.code, message: e.message }
        }
        return { ok: false, code: 'UNEXPECTED_ERROR', message: e?.message ?? 'Une erreur est survenue' }
    }
})
ipcMain.handle('store-user-stores', (_e, userId: number) => StoreService.getUserStores(userId))
ipcMain.handle('store-set-user-stores', (_e, { targetUserId, storeIds, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'employees.manage')
    StoreService.setUserStores(targetUserId, storeIds)
    AuditService.log({
        userId, action: 'user.set_stores', entityType: 'user', entityId: targetUserId,
        newValue: { storeIds }, severity: 'warning',
    })
    return true
}))
ipcMain.handle('terminal-list', (_e, storeId?: number) => StoreService.listTerminals(storeId))
ipcMain.handle('terminal-current-id', () => StoreService.getCurrentTerminalId())

/**
 * This machine's stable identity, minted once and kept in `config`.
 *
 * Derived here rather than passed in from the renderer: a device id the renderer
 * invents is a device id a second window can invent differently, and the whole
 * point is that a reinstall reclaims the SAME terminal instead of creating
 * POS-02, POS-03, POS-04 on the same physical PC.
 */
function deviceId(): string {
    const db = getDatabase()
    const existing = (db.prepare("SELECT value FROM config WHERE key = 'device_id'")
        .get() as { value: string } | undefined)?.value
    if (existing) return existing
    const minted = `${os.hostname()}-${crypto.randomUUID().slice(0, 8)}`
    db.prepare("INSERT INTO config (key, value) VALUES ('device_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(minted)
    return minted
}

ipcMain.handle('terminal-device-id', () => deviceId())
/**
 * Registering a terminal is the one action that must touch BOTH machines: the row
 * belongs in the store server's database, but the resulting identity has to be
 * written into THIS box's config or it forgets who it is on the next boot.
 *
 * So it is marked local in rpcRouter (the generic layer leaves it alone) and the
 * remote half is done explicitly here. On a server both halves are the same
 * machine and the behaviour is exactly what it was before.
 */
ipcMain.handle('terminal-register', async (_e, { storeId, name, isServer, userId }) => {
    try {
        let terminal: any
        if (TerminalMode.isClient()) {
            terminal = await RpcClient.forward('terminal-create-remote', [{ storeId, name, isServer, deviceId: deviceId(), userId }])
        } else {
            PermissionService.assertCan(userId, 'settings.manage')
            terminal = StoreService.registerTerminal(storeId, deviceId(), name, isServer)
            AuditService.log({ userId, action: 'terminal.register', entityType: 'pos_terminal', entityId: terminal.id, newValue: terminal, storeId })
        }
        // Always local: this is who THIS machine is.
        StoreService.setCurrentTerminal(terminal.id)
        return { ok: true, data: terminal }
    } catch (e: any) {
        const code = e?.code && typeof e.code === 'string' ? e.code : 'UNEXPECTED_ERROR'
        if (code === 'UNEXPECTED_ERROR') console.error('[ipc] terminal-register failed:', e)
        return { ok: false, code, message: e?.message ?? 'Une erreur est survenue' }
    }
})

/** The server-side half of the above. Only ever reached over /rpc. */
ipcMain.handle('terminal-create-remote', (_e, { storeId, name, isServer, deviceId: device, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'settings.manage')
    const t = StoreService.registerTerminal(storeId, device, name, isServer)
    AuditService.log({ userId, action: 'terminal.register', entityType: 'pos_terminal', entityId: t.id, newValue: t, storeId })
    return t
}))

// --- Permissions ---
ipcMain.handle('permission-catalogue', () => PermissionService.catalogue())
ipcMain.handle('permission-for-user', (_e, userId: number) => PermissionService.forUser(userId))
ipcMain.handle('permission-for-role', (_e, role: string) => PermissionService.forRole(role))
ipcMain.handle('permission-can', (_e, { userId, permission }) => PermissionService.can(userId, permission))
ipcMain.handle('permission-limits', (_e, userId: number) => PermissionService.limitsForUser(userId))
// The limits of a ROLE, not of the calling user — what the settings screen edits.
ipcMain.handle('permission-role-limits', (_e, role: string) => PermissionService.limits(role))
ipcMain.handle('permission-set-role', (_e, { role, codes, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'settings.manage')
    const before = PermissionService.forRole(role)
    PermissionService.setRolePermissions(role, codes)
    AuditService.log({
        userId, action: 'permissions.change_role', entityType: 'role', entityId: null,
        oldValue: { role, codes: before }, newValue: { role, codes }, severity: 'critical',
        summary: `Permissions du role ${role} modifiees`,
    })
    return true
}))
ipcMain.handle('permission-set-limits', (_e, { role, limits, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'settings.manage')
    const before = PermissionService.limits(role)
    PermissionService.setRoleLimits(role, limits)
    AuditService.logChange({
        userId, action: 'permissions.change_limits', entityType: 'role',
        before: before as any, after: PermissionService.limits(role) as any, severity: 'critical',
        summary: `Plafonds du role ${role} modifies`,
    })
    return true
}))

// --- Audit log ---
ipcMain.handle('audit-query', (_e, { filters, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'audit.view')
    return AuditService.query(filters ?? {})
}))
ipcMain.handle('audit-history', (_e, { entityType, entityId, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'audit.view')
    return AuditService.historyOf(entityType, entityId)
}))
ipcMain.handle('audit-actions', () => AuditService.actions())

// --- Inventory (store-scoped) ---
ipcMain.handle('inventory-stock', (_e, { storeId, productId, variantId }) =>
    InventoryService.getStock(storeId ?? StoreService.getCurrentStoreId(), productId, variantId ?? null))
ipcMain.handle('inventory-across-stores', (_e, { productId, variantId }) =>
    InventoryService.getStockAcrossStores(productId, variantId ?? null))
ipcMain.handle('inventory-movements', (_e, { storeId, productId, variantId, limit }) =>
    InventoryService.getMovements(storeId ?? null, productId, variantId, limit))
ipcMain.handle('inventory-low-stock', (_e, storeId?: number) => InventoryService.getLowStock(storeId ?? null))
ipcMain.handle('inventory-out-of-stock', (_e, storeId?: number) => InventoryService.getOutOfStock(storeId ?? null))
ipcMain.handle('inventory-dead-stock', (_e, { storeId, days }) =>
    InventoryService.getDeadStock(storeId ?? null, days ?? 90))
ipcMain.handle('inventory-value', (_e, storeId?: number) => InventoryService.getStockValue(storeId ?? null))
/** Every stock line with ONE health state each — the Inventaire screen's single
 *  source, so its health bar and its table can never disagree. */
// Product photographs. A clothing shop sells by eye, so these are read by the
// POS grid, the product list and the cart — see productImageService.ts for why
// they are served over a protocol rather than as data URIs.
// Category artwork. Same store, same protocol — see productImageService.ts.
ipcMain.handle('category-image-pick', async (_e, { categoryId, userId }) => {
    try {
        PermissionService.assertCan(userId, 'products.update')
        return { ok: true, data: await CategoryImageService.pickAndSet(categoryId) }
    } catch (e: any) {
        const code = typeof e?.code === 'string' ? e.code : 'UNEXPECTED_ERROR'
        if (code === 'UNEXPECTED_ERROR') console.error('[images] category pick failed:', e)
        return { ok: false, code, message: e?.message ?? 'Une erreur est survenue' }
    }
})
ipcMain.handle('category-image-clear', (_e, { categoryId, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'products.update')
    return CategoryImageService.clear(categoryId)
}))
ipcMain.handle('product-images', (_e, productId: number) => ProductImageService.list(productId))
ipcMain.handle('product-image-map', (_e, productIds?: number[]) => ProductImageService.primaryMap(productIds))
// NOT wrapped in guard(): the picker is async, and guard() is synchronous — it
// would hand back { ok: true, data: Promise } and the promise would fail to
// serialise across IPC rather than being awaited.
ipcMain.handle('product-image-pick', async (_e, { productId, userId }) => {
    try {
        PermissionService.assertCan(userId, 'products.update')
        return { ok: true, data: await ProductImageService.pickAndAdd(productId) }
    } catch (e: any) {
        const code = typeof e?.code === 'string' ? e.code : 'UNEXPECTED_ERROR'
        if (code === 'UNEXPECTED_ERROR') console.error('[images] pick failed:', e)
        return { ok: false, code, message: e?.message ?? 'Une erreur est survenue' }
    }
})
ipcMain.handle('product-image-set-primary', (_e, { imageId, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'products.update')
    return ProductImageService.setPrimary(imageId)
}))
ipcMain.handle('product-image-remove', (_e, { imageId, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'products.update')
    return ProductImageService.remove(imageId)
}))

ipcMain.handle('inventory-overview', (_e, { storeId, days }) =>
    InventoryService.getOverview(storeId ?? null, days ?? 90))
ipcMain.handle('inventory-adjust', (_e, { storeId, productId, variantId, newQuantity, reason, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'inventory.adjust')
    const store = storeId ?? StoreService.getCurrentStoreId()
    const before = InventoryService.getStock(store, productId, variantId ?? null)
    const after = InventoryService.setAbsolute(productId, variantId ?? null, newQuantity, {
        storeId: store, userId, reason: reason ?? 'Ajustement manuel',
    }, 'adjustment')
    AuditService.log({
        userId, action: 'inventory.adjust', entityType: 'stock_inventory', entityId: productId,
        oldValue: { quantity: before }, newValue: { quantity: after, reason },
        storeId: store, severity: 'warning',
    })
    EventBus.publish('inventory.updated', store, { reason: 'adjustment', productId, variantId, quantity: after })
    return after
}))

// --- Returns & exchanges ---
ipcMain.handle('return-find-sale', (_e, transactionNumber: string) => ReturnService.findSaleByNumber(transactionNumber))
ipcMain.handle('return-get-sale', (_e, transactionId: number) => ReturnService.getReturnableSale(transactionId))
ipcMain.handle('return-create-refund', (_e, input) => guardAndPublish(
    () => ReturnService.createRefund(input),
    data => {
        EventBus.publish('sale.returned', input.storeId ?? null, { returnId: data.returnId, returnNumber: data.returnNumber })
        EventBus.publish('inventory.updated', input.storeId ?? null, { reason: 'return' })
    }))
ipcMain.handle('return-create-exchange', (_e, input) => guard(() => ReturnService.createExchange(input)))
// Builds, pays for and completes the replacement sale AND records the return as one
// atomic step — see ReturnService.exchangeWithNewSale for why the UI must not do
// those four calls itself.
ipcMain.handle('return-exchange-new-sale', (_e, input) => guardAndPublish(
    () => ReturnService.exchangeWithNewSale(input),
    data => {
        EventBus.publish('sale.returned', input.storeId ?? null, { returnId: data.returnId, returnNumber: data.returnNumber })
        EventBus.publish('sale.created', input.storeId ?? null, { transactionId: data.replacementTransactionId })
        EventBus.publish('inventory.updated', input.storeId ?? null, { reason: 'exchange' })
    }))
ipcMain.handle('return-list', (_e, filters) => ReturnService.list(filters ?? {}))
ipcMain.handle('return-get', (_e, returnId: number) => ReturnService.getById(returnId))
ipcMain.handle('return-analytics', (_e, filters) => ReturnService.analytics(filters ?? {}))

// --- Stock transfers between stores ---
// Every state change is guarded, so a double-clicked button reaches here and is
// refused as INVALID_TRANSITION rather than moving stock twice.
ipcMain.handle('transfer-list', (_e, filters) => TransferService.list(filters ?? {}))
ipcMain.handle('transfer-get', (_e, id: number) => TransferService.getById(id))
ipcMain.handle('transfer-in-transit', (_e, storeId?: number) => TransferService.listInTransit(storeId))
ipcMain.handle('transfer-create', (_e, input) => guardAndPublish(
    () => TransferService.create(input),
    data => {
        // Announced to BOTH ends: the destination needs to know something is coming.
        EventBus.publish('transfer.created', input.fromStoreId, { transferId: data.id, transferNumber: data.transferNumber })
        EventBus.publish('transfer.created', input.toStoreId, { transferId: data.id, transferNumber: data.transferNumber })
    }))
ipcMain.handle('transfer-approve', (_e, { id, userId }) => guard(() => TransferService.approve(id, userId)))
ipcMain.handle('transfer-ship', (_e, { id, userId, quantities }) => guardAndPublish(
    () => TransferService.ship(id, userId, quantities),
    () => {
        const t = TransferService.getById(id) as any
        EventBus.publish('transfer.shipped', t?.from_store_id ?? null, { transferId: id })
        EventBus.publish('transfer.shipped', t?.to_store_id ?? null, { transferId: id })
        EventBus.publish('inventory.updated', t?.from_store_id ?? null, { reason: 'transfer_out' })
    }))
ipcMain.handle('transfer-receive', (_e, { id, userId, quantities }) => guardAndPublish(
    () => TransferService.receive(id, userId, quantities),
    () => {
        const t = TransferService.getById(id) as any
        EventBus.publish('transfer.received', t?.from_store_id ?? null, { transferId: id })
        EventBus.publish('transfer.received', t?.to_store_id ?? null, { transferId: id })
        EventBus.publish('inventory.updated', t?.to_store_id ?? null, { reason: 'transfer_in' })
    }))
ipcMain.handle('transfer-cancel', (_e, { id, userId, reason }) => guard(() => TransferService.cancel(id, userId, reason)))

// --- Retail analytics ---
// Read-only, so no guard() envelope: nothing here can fail for a business reason.
ipcMain.handle('analytics-summary', (_e, period) => AnalyticsService.summary(period ?? {}))
ipcMain.handle('analytics-by-size', (_e, period) => AnalyticsService.salesBySize(period ?? {}))
ipcMain.handle('analytics-by-color', (_e, period) => AnalyticsService.salesByColor(period ?? {}))
ipcMain.handle('analytics-by-hour', (_e, period) => AnalyticsService.salesByHour(period ?? {}))
ipcMain.handle('analytics-top-products', (_e, { period, by, limit }) => AnalyticsService.topProducts(period ?? {}, by, limit))
ipcMain.handle('analytics-top-variants', (_e, { period, limit }) => AnalyticsService.topVariants(period ?? {}, limit))
ipcMain.handle('analytics-store-comparison', (_e, period) => AnalyticsService.storeComparison(period ?? {}))
ipcMain.handle('analytics-period-comparison', (_e, { current, previous }) => AnalyticsService.periodComparison(current, previous))
ipcMain.handle('analytics-revenue-by-day', (_e, period) => AnalyticsService.revenueByDay(period ?? {}))
ipcMain.handle('analytics-employees', (_e, period) => AnalyticsService.employeePerformance(period ?? {}))
ipcMain.handle('analytics-customer-mix', (_e, period) => AnalyticsService.customerMix(period ?? {}))

// Employee list — needed wherever a person has to be chosen (targets, store
// assignment). Active only: a deactivated employee must not be assignable.
ipcMain.handle('user-get-all', () => (UserService.getAll() as any[]).filter(u => u.is_active !== 0))

// --- Central mirror (cPanel PostgreSQL behind the owner's website) ---
// Never on the sale path: pushing is manual or on a timer, and a failure is
// recorded rather than raised at whoever happens to be at the till.
ipcMain.handle('cloud-push-status', () => CloudPushService.status())
ipcMain.handle('cloud-push-get-config', () => {
    const c = CloudPushService.getConfig()
    // The key never leaves the main process — the panel only needs to know
    // whether one is set.
    return { url: c.url, shopId: c.shopId, enabled: c.enabled, hasSecret: !!c.secret }
})
ipcMain.handle('cloud-push-set-config', (_e, { config, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'settings.manage')
    CloudPushService.setConfig(config)
    AuditService.log({ userId, action: 'cloud_mirror.configure', entityType: 'config', severity: 'critical',
        summary: `Miroir central : ${config.url ?? '(inchangé)'}` })
    return true
}))
ipcMain.handle('cloud-push-test', () => CloudPushService.test())
ipcMain.handle('cloud-push-run', (_e, userId: number) => guard(async () => {
    PermissionService.assertCan(userId, 'settings.manage')
    return CloudPushService.pushAll()
}))

// --- Sales targets ---
ipcMain.handle('target-list', (_e, filters) => TargetService.list(filters ?? {}))
ipcMain.handle('target-current', (_e, storeId?: number) => TargetService.current(storeId))
ipcMain.handle('target-set', (_e, { input, userId }) => guard(() => TargetService.set(input, userId)))
ipcMain.handle('target-remove', (_e, { id, userId }) => guard(() => TargetService.remove(id, userId)))

// --- Inventory counts ---
ipcMain.handle('count-list', (_e, { storeId, limit }) => InventoryCountService.list(storeId, limit))
ipcMain.handle('count-get', (_e, { id, filter }) => InventoryCountService.getById(id, filter))
ipcMain.handle('count-open', (_e, storeId: number) => InventoryCountService.getOpen(storeId))
ipcMain.handle('count-start', (_e, input) => guard(() => InventoryCountService.start(input)))
ipcMain.handle('count-line', (_e, { itemId, countedQty, userId }) => guard(() => InventoryCountService.countLine(itemId, countedQty, userId)))
ipcMain.handle('count-clear-line', (_e, { itemId, userId }) => guard(() => InventoryCountService.clearLine(itemId, userId)))
ipcMain.handle('count-review', (_e, { id, userId }) => guard(() => InventoryCountService.review(id, userId)))
ipcMain.handle('count-apply', (_e, { id, userId }) => guardAndPublish(
    () => InventoryCountService.apply(id, userId),
    data => {
        const c = InventoryCountService.getById(id) as any
        EventBus.publish('count.applied', c?.store_id ?? null, { countId: id, adjusted: data.adjusted })
        if (data.adjusted > 0) EventBus.publish('inventory.updated', c?.store_id ?? null, { reason: 'inventory_count' })
    }))
ipcMain.handle('count-cancel', (_e, { id, userId, reason }) => guard(() => InventoryCountService.cancel(id, userId, reason)))

// --- Notifications ---
ipcMain.handle('notification-list', (_e, filters) => NotificationService.list(filters ?? {}))
ipcMain.handle('notification-unread-count', (_e, storeId?: number) => NotificationService.unreadCount(storeId))
ipcMain.handle('notification-mark-read', (_e, id: number) => NotificationService.markRead(id))
ipcMain.handle('notification-mark-all-read', (_e, storeId?: number) => NotificationService.markAllRead(storeId))
ipcMain.handle('notification-sweep', (_e, storeId?: number | null) => {
    const r = NotificationService.sweep(storeId)
    // Only when something new was actually raised — a sweep that finds nothing must
    // not make every badge in the shop flicker.
    if (r.raised > 0) EventBus.publish('notification.created', storeId ?? null, { raised: r.raised })
    return r
})

// --- Realtime fan-out ------------------------------------------------------
//
// Every event the bus publishes is forwarded to every open window. Subscribing
// here rather than inside createWindow() means one subscription for the process,
// not one per window, so a reopened window cannot double-deliver.
EventBus.onEvent(event => {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('retail-event', event)
    }
})

// Keeps idle LAN subscribers attached. 25 s is comfortably inside the usual
// 60 s idle reap and costs two bytes a minute per client.
setInterval(() => EventBus.heartbeat(), 25_000)

// --- Thin-client configuration -------------------------------------------
ipcMain.handle('rpc-status', async () => {
    if (TerminalMode.isClient()) await RpcClient.probe()
    return RpcClient.status()
})

ipcMain.handle('rpc-set-mode', (_e, { mode, serverUrl, token, userId }) => guard(() => {
    PermissionService.assertCan(userId, 'settings.manage')
    TerminalMode.set({ mode, serverUrl, token })
    // Re-point the event stream at whatever the box now is.
    RpcClient.stopEventStream()
    if (TerminalMode.isClient()) RpcClient.startEventStream()
    return TerminalMode.get()
}))

ipcMain.handle('rpc-test-connection', async (_e, { serverUrl, token }) => {
    try {
        const res = await fetch(`${String(serverUrl).replace(/\/+$/, '')}/sync/products?since=2099-01-01`, {
            headers: { 'x-sync-token': token },
        })
        if (res.status === 401) return { ok: false, message: 'Jeton d’appairage refusé par le serveur.' }
        if (!res.ok) return { ok: false, message: `Le serveur a répondu ${res.status}.` }
        return { ok: true, message: 'Connexion au serveur du magasin établie.' }
    } catch (e: any) {
        return { ok: false, message: `Injoignable : ${e?.message ?? 'erreur réseau'}` }
    }
})

// --- Network monitor -------------------------------------------------------
// The Network screen's data. The *-devices / *-import-logs / *-local-status
// channels answer from THIS machine (they are marked local-only in rpcRouter),
// so a client terminal shows its own state; the *-remote-* channels are the ones
// that cross the wire — they forward to the store server this box talks to, which
// is how the "Remote server" tab shows the SERVER's devices and logs rather than
// the (empty) client's own.
ipcMain.handle('network-local-status', () => ({
    ...NetworkService.localStatus(),
    ip: getLocalIP(),
    port: 4000,
}))
ipcMain.handle('network-devices', () => NetworkService.devices())
ipcMain.handle('network-import-logs', () => ({
    logs: NetworkService.importLogs(),
    ingest: NetworkService.deviceIngest(),
}))

ipcMain.handle('network-remote-status', async () => {
    if (TerminalMode.isClient()) await RpcClient.probe()
    return RpcClient.status()
})
ipcMain.handle('network-remote-devices', async () => {
    // A server IS the store server, so "remote" and "local" are the same box.
    if (!TerminalMode.isClient()) return NetworkService.devices()
    try {
        return await RpcClient.forward('network-devices', [])
    } catch (e: any) {
        return { error: e?.message ?? 'Serveur injoignable', code: e?.code }
    }
})
ipcMain.handle('network-remote-logs', async () => {
    if (!TerminalMode.isClient()) {
        return { logs: NetworkService.importLogs(), ingest: NetworkService.deviceIngest() }
    }
    try {
        return await RpcClient.forward('network-import-logs', [])
    } catch (e: any) {
        return { error: e?.message ?? 'Serveur injoignable', code: e?.code }
    }
})

// Privileged scheme registration has to happen before the app is ready; the
// handler itself is installed once it is.
registerImageScheme()

app.whenReady().then(() => {
    serveImages()
    createWindow()
    // A client attaches to the server's event stream so its screens react to a
    // sale rung up on another till exactly as they would to one rung up here.
    if (TerminalMode.isClient()) RpcClient.startEventStream()
})
