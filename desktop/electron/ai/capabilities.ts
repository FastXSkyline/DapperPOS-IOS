/**
 * Capability Registry — the single catalogue of everything the AI copilot can do.
 * Each capability wraps the SAME services the UI uses. Adding a feature = adding a
 * capability here, and the assistant can immediately use it. See docs/AI_ASSISTANT.md.
 */
import { getDatabase } from '../database'
import { ProductService, SupplierService } from '../productService'
import { TransactionService } from '../transactionService'
import { PricingService } from '../pricingService'
import { WarehouseService } from '../warehouseService'
import { DocumentService } from '../documentService'
import { LedgerService } from '../ledgerService'
import { ReservationService } from '../reservationService'
import { AccountingService } from '../accountingService'
import { ExpenseService } from '../expenseService'
import { PurchaseOrderService } from '../purchaseOrderService'
import { ReportService } from '../reportService'
import { ReceiptService } from '../receiptService'
import { InvoiceService } from '../invoiceService'
import { findBestMatch } from './match'

export interface CapabilityContext {
    userId: number
}

export interface UiEvent {
    channel: string
    payload?: any
}

export interface CapabilityResult {
    ok: boolean
    /** Short natural-language result the model uses to compose its reply (and for logs). */
    summary: string
    data?: any
    /** Events to forward to the renderer (navigation, cart add, theme, etc.). */
    events?: UiEvent[]
}

export interface Capability {
    name: string
    group: string
    description: string
    /** JSON-schema `properties` for the tool arguments. */
    params: Record<string, any>
    required?: string[]
    kind: 'read' | 'action'
    /** Destructive/financial actions should be confirmed by the UI before calling. */
    destructive?: boolean
    handler: (args: any, ctx: CapabilityContext) => Promise<CapabilityResult> | CapabilityResult
}

const VIEWS = ['pos', 'products', 'reports', 'debtors', 'orders', 'expenses', 'settlement', 'settings']

export const CAPABILITIES: Capability[] = [
    // ---- Navigation & settings ----
    {
        name: 'ui_navigate',
        group: 'nav',
        description: 'Open/switch to a screen of the app (POS, products/stock, reports, debtors/credit, purchase orders, expenses, settlement, settings). Use for "warini/montre/go to X".',
        params: { view: { type: 'string', enum: VIEWS, description: 'Target screen' } },
        required: ['view'],
        kind: 'action',
        handler: (args) => {
            const view = VIEWS.includes(args.view) ? args.view : 'pos'
            return { ok: true, summary: `Navigated to ${view}.`, events: [{ channel: 'view-change', payload: view }] }
        },
    },
    {
        name: 'ui_toggle_theme',
        group: 'settings',
        description: 'Toggle light/dark appearance ("badel couleur", "mode nuit").',
        params: {},
        kind: 'action',
        handler: () => ({ ok: true, summary: 'Theme toggled.', events: [{ channel: 'settings-toggle-theme' }] }),
    },
    {
        name: 'ui_change_language',
        group: 'settings',
        description: 'Change the app UI language. fr=French, ar=Arabic, en=English ("red bel 3arbiya", "en français").',
        params: { language: { type: 'string', enum: ['fr', 'ar', 'en'] } },
        required: ['language'],
        kind: 'action',
        handler: (args) => {
            const lang = ['fr', 'ar', 'en'].includes(args.language) ? args.language : 'fr'
            return { ok: true, summary: `Language set to ${lang}.`, events: [{ channel: 'settings-change-lang', payload: lang }] }
        },
    },

    // ---- Products / inventory ----
    {
        name: 'products_search',
        group: 'products',
        description: 'Search the catalogue for a product by name and open the products screen filtered to it ("7owess 3la / cherche X").',
        params: { query: { type: 'string', description: 'Product name or keywords' } },
        required: ['query'],
        kind: 'read',
        handler: (args) => {
            const products = ProductService.getAll({}) as any[]
            const match = findBestMatch(args.query, products, (p) => p.name)
            return {
                ok: true,
                summary: match ? `Found "${match.name}" (price ${match.retail_price}, stock ${match.stock_quantity ?? '?'}).` : `No product matched "${args.query}".`,
                data: match || null,
                events: [{ channel: 'view-change', payload: 'products' }, { channel: 'inventory-search', payload: args.query }],
            }
        },
    },
    {
        name: 'products_low_stock',
        group: 'products',
        description: 'List products at or below their minimum stock level ("ach naqes f stock", "low stock").',
        params: {},
        kind: 'read',
        handler: () => {
            const low = ReportService.getLowStockProducts() as any[]
            return {
                ok: true,
                summary: low.length ? `${low.length} product(s) low on stock: ${low.slice(0, 10).map((p) => p.name).join(', ')}.` : 'No products are low on stock.',
                data: low,
                events: [{ channel: 'view-change', payload: 'products' }, { channel: 'inventory-filter', payload: { lowStock: true } }],
            }
        },
    },
    {
        name: 'products_create',
        group: 'products',
        description: 'Add a new product to inventory ("zid produit X b <price>").',
        params: {
            product_name: { type: 'string' },
            price: { type: 'number', description: 'Retail price in DZD (optional)' },
            cost_price: { type: 'number', description: 'Cost price in DZD (optional)' },
            stock: { type: 'number', description: 'Initial stock quantity (optional)' },
        },
        required: ['product_name'],
        kind: 'action',
        handler: async (args) => {
            const res: any = await ProductService.create({
                name: args.product_name,
                retail_price: args.price || 0,
                cost_price: args.cost_price || 0,
                category_id: 1,
                sku: '', barcode: '',
                supplier_id: null, tax_category_id: 1,
                min_stock_level: 5, is_active: 1, lead_time_days: 1,
            })
            if (args.stock && res?.lastInsertRowid) {
                try { await ProductService.updateStock(Number(res.lastInsertRowid), args.stock) } catch { /* ignore */ }
            }
            return { ok: true, summary: `Created product "${args.product_name}".`, events: [{ channel: 'view-change', payload: 'products' }] }
        },
    },
    {
        name: 'products_update_price',
        group: 'products',
        description: 'Change a product\'s retail price ("badel prix ta3 X l <price>").',
        params: { product_name: { type: 'string' }, price: { type: 'number' } },
        required: ['product_name', 'price'],
        kind: 'action',
        handler: async (args) => {
            const products = ProductService.getAll({}) as any[]
            const p = findBestMatch(args.product_name, products, (x) => x.name)
            if (!p) return { ok: false, summary: `Product "${args.product_name}" not found.` }
            await ProductService.update(p.id, { retail_price: args.price })
            return { ok: true, summary: `Updated price of "${p.name}" to ${args.price} DZD.`, events: [{ channel: 'view-change', payload: 'products' }] }
        },
    },
    {
        name: 'products_update_stock',
        group: 'products',
        description: 'Set/adjust the stock quantity of a product ("zid 10 f stock ta3 X").',
        params: { product_name: { type: 'string' }, stock: { type: 'number' } },
        required: ['product_name', 'stock'],
        kind: 'action',
        handler: async (args) => {
            const products = ProductService.getAll({}) as any[]
            const p = findBestMatch(args.product_name, products, (x) => x.name)
            if (!p) return { ok: false, summary: `Product "${args.product_name}" not found.` }
            await ProductService.updateStock(p.id, args.stock)
            return { ok: true, summary: `Set stock of "${p.name}" to ${args.stock}.`, events: [{ channel: 'view-change', payload: 'products' }] }
        },
    },
    {
        name: 'products_delete',
        group: 'products',
        description: 'Delete a product from inventory ("n7i produit X"). Destructive — confirm with the user first.',
        params: { product_name: { type: 'string' } },
        required: ['product_name'],
        kind: 'action',
        destructive: true,
        handler: async (args) => {
            const products = ProductService.getAll({}) as any[]
            const p = findBestMatch(args.product_name, products, (x) => x.name)
            if (!p) return { ok: false, summary: `Product "${args.product_name}" not found.` }
            await ProductService.delete(p.id)
            return { ok: true, summary: `Deleted "${p.name}".`, events: [{ channel: 'view-change', payload: 'products' }] }
        },
    },

    {
        name: 'pricing_set_customer_price',
        group: 'products',
        description: 'Set a negotiated unit price for a specific product for a specific customer (grille tarifaire). e.g. "prix ta3 cable l Ahmed b 1500".',
        params: { customer_name: { type: 'string' }, product_name: { type: 'string' }, price: { type: 'number' } },
        required: ['customer_name', 'product_name', 'price'],
        kind: 'action',
        handler: (args) => {
            const db = getDatabase()
            const customers = db.prepare('SELECT id, name FROM customers WHERE is_active = 1').all() as any[]
            const customer = findBestMatch(args.customer_name, customers, (c) => c.name)
            const product = findBestMatch(args.product_name, ProductService.getAll({}) as any[], (p) => p.name)
            if (!customer || !product) return { ok: false, summary: `Could not find ${!customer ? 'customer' : 'product'}.` }
            db.prepare('INSERT OR REPLACE INTO customer_prices (customer_id, product_id, price) VALUES (?, ?, ?)').run(customer.id, product.id, args.price)
            return { ok: true, summary: `Set price of "${product.name}" for ${customer.name} to ${args.price} DZD.` }
        },
    },

    {
        name: 'pricing_set_bulk_rule',
        group: 'products',
        description: 'Create a quantity/bulk price break for a product ("ki yechri 10 wla ktherr, remise 5%"). discount_type: percentage|fixed|price_override.',
        params: {
            product_name: { type: 'string' },
            min_quantity: { type: 'number', description: 'Minimum quantity to trigger the break' },
            discount_type: { type: 'string', enum: ['percentage', 'fixed', 'price_override'] },
            discount_value: { type: 'number', description: 'Percent, dinars off, or override price depending on discount_type' },
        },
        required: ['product_name', 'min_quantity', 'discount_value'],
        kind: 'action',
        handler: (args) => {
            const product = findBestMatch(args.product_name, ProductService.getAll({}) as any[], (p) => p.name)
            if (!product) return { ok: false, summary: `Product "${args.product_name}" not found.` }
            PricingService.createRule({
                name: `Remise ${product.name} ≥${args.min_quantity}`,
                rule_type: 'bulk',
                product_id: product.id,
                min_quantity: args.min_quantity,
                discount_type: args.discount_type || 'percentage',
                discount_value: args.discount_value,
            })
            return { ok: true, summary: `Bulk rule set: "${product.name}" from ${args.min_quantity} units → ${args.discount_value}${(args.discount_type || 'percentage') === 'percentage' ? '%' : ' DZD'}.` }
        },
    },

    {
        name: 'reserve_stock',
        group: 'sales',
        description: 'Reserve stock for a customer with an optional deposit/acompte ("habsli 3 cable l Ahmed, acompte 1000").',
        params: {
            product_name: { type: 'string' },
            quantity: { type: 'number' },
            customer_name: { type: 'string' },
            deposit: { type: 'number', description: 'Deposit / acompte in DZD (optional)' },
        },
        required: ['product_name', 'quantity'],
        kind: 'action',
        handler: (args) => {
            const product = findBestMatch(args.product_name, ProductService.getAll({}) as any[], (p) => p.name)
            if (!product) return { ok: false, summary: `Product "${args.product_name}" not found.` }
            let customerId: number | null = null
            if (args.customer_name) {
                const db = getDatabase()
                const c = findBestMatch(args.customer_name, db.prepare('SELECT id, name FROM customers WHERE is_active = 1').all() as any[], (x) => x.name)
                customerId = c ? c.id : null
            }
            const res = ReservationService.reserve(customerId, product.id, args.quantity, args.deposit || 0, 1)
            if (!res.success) return { ok: false, summary: res.error || 'Reservation failed.' }
            return { ok: true, summary: `Réservé ${args.quantity} × "${product.name}"${args.deposit ? ` (acompte ${args.deposit} DA)` : ''}.` }
        },
    },
    {
        name: 'customer_balance',
        group: 'debts',
        description: "Check how much a customer owes (kredi balance). e.g. \"chhal 3lih Ahmed?\"",
        params: { customer_name: { type: 'string' } },
        required: ['customer_name'],
        kind: 'read',
        handler: (args) => {
            const db = getDatabase()
            const customers = db.prepare('SELECT id, name FROM customers WHERE is_active = 1').all() as any[]
            const c = findBestMatch(args.customer_name, customers, (x) => x.name)
            if (!c) return { ok: false, summary: `Customer "${args.customer_name}" not found.` }
            const status = LedgerService.creditStatus(c.id)
            return { ok: true, summary: `${c.name} owes ${status.balance.toLocaleString()} DA${status.limit > 0 ? ` (limit ${status.limit.toLocaleString()}, ${status.over ? 'OVER LIMIT' : 'within limit'})` : ''}.`, data: status }
        },
    },
    {
        name: 'customer_statement_print',
        group: 'debts',
        description: 'Print a stamped relevé de compte (account statement) for a customer.',
        params: { customer_name: { type: 'string' } },
        required: ['customer_name'],
        kind: 'action',
        handler: async (args) => {
            const db = getDatabase()
            const customers = db.prepare('SELECT id, name FROM customers WHERE is_active = 1').all() as any[]
            const c = findBestMatch(args.customer_name, customers, (x) => x.name)
            if (!c) return { ok: false, summary: `Customer "${args.customer_name}" not found.` }
            await LedgerService.printStatement(c.id)
            return { ok: true, summary: `Printed relevé de compte for ${c.name}.` }
        },
    },
    {
        name: 'supplier_return_create',
        group: 'products',
        description: 'Return goods to a supplier and reduce stock ("rajja3 5 cable l fournisseur X"). Records a retour fournisseur.',
        params: {
            supplier_name: { type: 'string' },
            product_name: { type: 'string' },
            quantity: { type: 'number' },
            reason: { type: 'string' },
        },
        required: ['product_name', 'quantity'],
        kind: 'action',
        handler: (args) => {
            const product = findBestMatch(args.product_name, ProductService.getAll({}) as any[], (p) => p.name)
            if (!product) return { ok: false, summary: `Product "${args.product_name}" not found.` }
            let supplierId: number | null = null
            if (args.supplier_name) {
                const sup = findBestMatch(args.supplier_name, SupplierService.getAll() as any[], (s: any) => s.company_name)
                supplierId = sup ? sup.id : null
            }
            const res = PurchaseOrderService.createReturn(supplierId, [{ product_id: product.id, quantity: args.quantity, unit_cost: product.cost_price || 0 }], 1, args.reason)
            if (!res.success) return { ok: false, summary: res.error || 'Return failed.' }
            return { ok: true, summary: `Retour fournisseur ${res.return_number}: ${args.quantity} × "${product.name}".` }
        },
    },

    {
        name: 'inventory_transfer_stock',
        group: 'products',
        description: 'Transfer stock of a product between two dépôts/magasins and print a Bon de transfert. e.g. "7awel 10 cable men magasin l dépôt 2".',
        params: {
            product_name: { type: 'string' },
            quantity: { type: 'number' },
            from_warehouse: { type: 'string', description: 'Source depot/magasin name' },
            to_warehouse: { type: 'string', description: 'Destination depot/magasin name' },
        },
        required: ['product_name', 'quantity', 'from_warehouse', 'to_warehouse'],
        kind: 'action',
        handler: (args) => {
            const product = findBestMatch(args.product_name, ProductService.getAll({}) as any[], (p) => p.name)
            if (!product) return { ok: false, summary: `Product "${args.product_name}" not found.` }
            const warehouses = WarehouseService.list()
            const from = findBestMatch(args.from_warehouse, warehouses, (w) => w.name)
            const to = findBestMatch(args.to_warehouse, warehouses, (w) => w.name)
            if (!from || !to) return { ok: false, summary: `Could not resolve ${!from ? 'source' : 'destination'} dépôt.` }
            const res = WarehouseService.createTransfer(from.id, to.id, [{ product_id: product.id, quantity: args.quantity }])
            if (!res.success) return { ok: false, summary: res.error || 'Transfer failed.' }
            return { ok: true, summary: `Transferred ${args.quantity} × "${product.name}" ${from.name} → ${to.name} (${res.transfer_number}).` }
        },
    },

    {
        name: 'document_create_quote',
        group: 'sales',
        description: 'Create a devis/proforma for a customer with one product line ("dir devis l Ahmed 5 cable"). doc_type: devis|proforma|bon_commande.',
        params: {
            customer_name: { type: 'string' },
            product_name: { type: 'string' },
            quantity: { type: 'number' },
            doc_type: { type: 'string', enum: ['devis', 'proforma', 'bon_commande'] },
        },
        required: ['product_name', 'quantity'],
        kind: 'action',
        handler: (args) => {
            const product = findBestMatch(args.product_name, ProductService.getAll({}) as any[], (p) => p.name)
            if (!product) return { ok: false, summary: `Product "${args.product_name}" not found.` }
            let customerId: number | null = null
            if (args.customer_name) {
                const db = getDatabase()
                const customers = db.prepare('SELECT id, name FROM customers WHERE is_active = 1').all() as any[]
                const c = findBestMatch(args.customer_name, customers, (x) => x.name)
                customerId = c ? c.id : null
            }
            const res = DocumentService.create((args.doc_type || 'devis'), customerId, 1, [{ productId: product.id, quantity: args.quantity }])
            return { ok: true, summary: `${args.doc_type === 'proforma' ? 'Proforma' : args.doc_type === 'bon_commande' ? 'Bon de commande' : 'Devis'} ${res.transaction_number} créé.` }
        },
    },

    // ---- Sales ----
    {
        name: 'sales_add_to_cart',
        group: 'sales',
        description: 'Add a product to the current POS cart ("zid/bi3 X", optional quantity). Opens the POS screen.',
        params: { product_name: { type: 'string' }, quantity: { type: 'number', description: 'Quantity (default 1; supports fractional metres)' } },
        required: ['product_name'],
        kind: 'action',
        handler: (args) => {
            const products = ProductService.getAll({}) as any[]
            const p = findBestMatch(args.product_name, products, (x) => x.name)
            if (!p) return { ok: false, summary: `Product "${args.product_name}" not found to sell.` }
            return {
                ok: true,
                summary: `Added ${args.quantity || 1} × "${p.name}" to the cart.`,
                events: [{ channel: 'view-change', payload: 'pos' }, { channel: 'pos-add-product', payload: { ...p, _qty: args.quantity || 1 } }],
            }
        },
    },

    // ---- Expenses ----
    {
        name: 'expenses_add',
        group: 'expenses',
        description: 'Record a business expense ("zid masrouf <name> <amount>").',
        params: { name: { type: 'string' }, amount: { type: 'number' } },
        required: ['name', 'amount'],
        kind: 'action',
        handler: async (args, ctx) => {
            await ExpenseService.create(args.name, args.amount, ctx.userId)
            return { ok: true, summary: `Recorded expense "${args.name}" of ${args.amount} DZD.`, events: [{ channel: 'view-change', payload: 'expenses' }] }
        },
    },
    {
        name: 'expenses_totals',
        group: 'expenses',
        description: 'Show expense totals over recent periods ("ch7al masrouf").',
        params: {},
        kind: 'read',
        handler: () => {
            const totals = ExpenseService.getTotals()
            return { ok: true, summary: `Expense totals: ${JSON.stringify(totals)}.`, data: totals, events: [{ channel: 'view-change', payload: 'expenses' }] }
        },
    },

    // ---- Purchasing ----
    {
        name: 'purchasing_create_order',
        group: 'purchasing',
        description: 'Create a purchase order to a supplier for a product ("dir commande l <supplier> ta3 <qty> <product>"). Optionally print it.',
        params: {
            supplier_name: { type: 'string' },
            product_name: { type: 'string' },
            quantity: { type: 'number' },
            print: { type: 'boolean', description: 'Print the PO after creating' },
        },
        required: ['supplier_name', 'product_name'],
        kind: 'action',
        handler: async (args, ctx) => {
            const supplier = findBestMatch(args.supplier_name, SupplierService.getAll() as any[], (s) => s.company_name)
            const product = findBestMatch(args.product_name, ProductService.getAll({}) as any[], (p) => p.name)
            if (!supplier || !product) {
                return { ok: false, summary: `Could not find ${!supplier ? 'supplier' : 'product'} for the order.` }
            }
            const po: any = await PurchaseOrderService.create(ctx.userId, supplier.id, [
                { productId: product.id, quantity: args.quantity || 1, unitCost: product.cost_price || 0 },
            ])
            if (args.print) { try { await PurchaseOrderService.printPO(po.id) } catch { /* ignore */ } }
            return { ok: true, summary: `Created purchase order for ${supplier.company_name} (${product.name}).`, events: [{ channel: 'view-change', payload: 'orders' }] }
        },
    },

    // ---- Debts / credit ----
    {
        name: 'debts_list',
        group: 'debts',
        description: 'List customers who owe money / unpaid credit ("chkoun li kraydin", "les dettes").',
        params: {},
        kind: 'read',
        handler: () => {
            const debtors = TransactionService.getDebtors() as any[]
            const total = debtors.reduce((s, d) => s + ((d.total_amount || 0) - (d.amount_paid || 0)), 0)
            return {
                ok: true,
                summary: debtors.length ? `${debtors.length} debtor(s), total outstanding ${total.toFixed(2)} DZD.` : 'No outstanding debts.',
                data: debtors,
                events: [{ channel: 'view-change', payload: 'debtors' }],
            }
        },
    },
    {
        name: 'debts_settle',
        group: 'debts',
        description: 'Settle (pay off) a customer\'s outstanding debt ("khallas kredi ta3 <name>"). Destructive — confirm first.',
        params: { customer_name: { type: 'string' } },
        required: ['customer_name'],
        kind: 'action',
        destructive: true,
        handler: async (args) => {
            const debtors = TransactionService.getDebtors() as any[]
            const match = findBestMatch(args.customer_name, debtors, (d) => d.customer_name)
            if (!match) return { ok: false, summary: `No debtor named "${args.customer_name}" found.` }
            await TransactionService.settleDebt(match.id)
            return { ok: true, summary: `Settled the debt of ${match.customer_name}.`, events: [{ channel: 'view-change', payload: 'debtors' }] }
        },
    },

    // ---- Reports / analytics ----
    {
        name: 'reports_today',
        group: 'reports',
        description: 'Today\'s business summary: revenue, number of sales, etc. ("ch7al rebe7na lyoum", "report lyoum").',
        params: {},
        kind: 'read',
        handler: () => {
            const stats = ReportService.getDashboardStats()
            return { ok: true, summary: `Today's stats: ${JSON.stringify(stats)}.`, data: stats, events: [{ channel: 'view-change', payload: 'reports' }] }
        },
    },
    {
        name: 'reports_top_products',
        group: 'reports',
        description: 'Best-selling products ("ach mn produit li mša akthar").',
        params: { limit: { type: 'number', description: 'How many (default 5)' } },
        kind: 'read',
        handler: (args) => {
            const top = ReportService.getTopSellingProducts(args.limit || 5) as any[]
            return { ok: true, summary: `Top products: ${JSON.stringify(top)}.`, data: top, events: [{ channel: 'view-change', payload: 'reports' }] }
        },
    },

    {
        name: 'accounting_g50',
        group: 'reports',
        description: 'Summarize the monthly G50 (TVA collectée, déductible, net, timbre) for a given month/year.',
        params: { year: { type: 'number' }, month: { type: 'number' } },
        required: ['year', 'month'],
        kind: 'read',
        handler: (args) => {
            const g = AccountingService.g50(args.year, args.month)
            const s = g.summary
            return { ok: true, summary: `G50 ${s.period}: TVA collectée ${s.tvaCollectee.toFixed(0)} DA, déductible ${s.tvaDeductible.toFixed(0)} DA, ${s.tvaNet > 0 ? `net à payer ${s.tvaNet.toFixed(0)} DA` : `crédit ${s.tvaCredit.toFixed(0)} DA`}, timbre ${s.timbre.toFixed(0)} DA.`, data: s }
        },
    },

    // ---- Printing ----
    {
        name: 'print_last_invoice',
        group: 'documents',
        description: 'Print the most recent completed sale as an A4 invoice ("imprimi/kherjli lafacture").',
        params: {},
        kind: 'action',
        handler: async () => {
            const last = getDatabase().prepare("SELECT id FROM transactions WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1").get() as { id: number } | undefined
            if (!last) return { ok: false, summary: 'No completed sale found to print.' }
            const data = await ReceiptService.generateReceiptDataFromTransaction(last.id)
            await InvoiceService.print(data)
            return { ok: true, summary: 'Printed the last invoice.' }
        },
    },
    {
        name: 'print_last_purchase_order',
        group: 'documents',
        description: 'Print the most recent purchase order ("kherjli bon de commande").',
        params: {},
        kind: 'action',
        handler: async () => {
            const last = getDatabase().prepare('SELECT id FROM purchase_orders ORDER BY created_at DESC LIMIT 1').get() as { id: number } | undefined
            if (!last) return { ok: false, summary: 'No purchase order found to print.' }
            await PurchaseOrderService.printPO(last.id)
            return { ok: true, summary: 'Printed the last purchase order.' }
        },
    },
    {
        name: 'sales_create_avoir',
        group: 'documents',
        description: "Create a credit note (facture d'avoir) that cancels/refunds an existing invoice by its number — reverses the TVA. By default the goods are restocked; set restock=false to scrap them (damaged/defective). Destructive — confirm first.",
        params: {
            invoice_number: { type: 'string', description: 'The facture/sale number to credit (e.g. BL-2026-000012)' },
            restock: { type: 'boolean', description: 'true (default) = return goods to stock; false = scrap (damaged)' },
        },
        required: ['invoice_number'],
        kind: 'action',
        destructive: true,
        handler: (args, ctx) => {
            const row = getDatabase().prepare('SELECT id FROM transactions WHERE transaction_number = ?').get(args.invoice_number) as { id: number } | undefined
            if (!row) return { ok: false, summary: `No invoice "${args.invoice_number}" found.` }
            const avoir = TransactionService.createAvoir(row.id, ctx.userId, args.restock !== false)
            return { ok: true, summary: `Created credit note ${avoir.transaction_number} for ${args.invoice_number}${args.restock === false ? ' (goods scrapped)' : ''}.`, events: [{ channel: 'view-change', payload: 'reports' }] }
        },
    },
]

export function getCapability(name: string): Capability | undefined {
    return CAPABILITIES.find((c) => c.name === name)
}
