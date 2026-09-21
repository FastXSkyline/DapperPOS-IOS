// @ts-nocheck
const { contextBridge, ipcRenderer } = require('electron')

// Preload script exposing IPC
// Updated for Debt Settlement and Reports

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    auth: {
        login: (pin) => ipcRenderer.invoke('auth-login', pin),
        verifyOwner: (pin) => ipcRenderer.invoke('auth-verify-owner', pin),
        setOwnerPin: (newPin) => ipcRenderer.invoke('auth-set-owner-pin', newPin),
        ownerPinIsDefault: () => ipcRenderer.invoke('auth-owner-pin-is-default')
    },
    receipt: {
        preview: (data) => ipcRenderer.invoke('receipt-preview', data),
        print: (data) => ipcRenderer.invoke('receipt-print', data),
        getConfig: () => ipcRenderer.invoke('receipt-get-config'),
        saveConfig: (config) => ipcRenderer.invoke('receipt-save-config', config)
    },
    invoice: {
        generate: (data) => ipcRenderer.invoke('invoice-pdf', data),
        print: (data) => ipcRenderer.invoke('invoice-print', data)
    },
    label: {
        print: (product, config, preview) => ipcRenderer.invoke('label-print', { product, config, preview })
    },
    report: {
        getStats: () => ipcRenderer.invoke('report-stats'),
        getChartData: (range) => ipcRenderer.invoke('report-chart', range),
        getTopProducts: (limit) => ipcRenderer.invoke('report-top-products', limit),
        getLowStock: () => ipcRenderer.invoke('report-low-stock'),
        getCategorySales: (range) => ipcRenderer.invoke('report-category-sales', range),
        getPaymentStats: (range) => ipcRenderer.invoke('report-payment-stats', range),
        printYearlyDelivery: (customerName) => ipcRenderer.invoke('print-yearly-delivery-report', customerName),
        printYearlySettlement: (supplierName) => ipcRenderer.invoke('print-yearly-settlement-report', supplierName),
        inventoryMovement: (startDate, endDate, periodType) => ipcRenderer.invoke('report-inventory-movement', { startDate, endDate, periodType })
    },
    product: {
        getAll: (filters) => ipcRenderer.invoke('product-get-all', filters),
        getById: (id) => ipcRenderer.invoke('product-get-by-id', id),
        getByBarcode: (barcode) => ipcRenderer.invoke('product-get-by-barcode', barcode),
        create: (product) => ipcRenderer.invoke('product-create', product),
        update: (id, product) => ipcRenderer.invoke('product-update', { id, product }),
        updateStock: (id, qty) => ipcRenderer.invoke('product-update-stock', { id, qty }),
        delete: (id) => ipcRenderer.invoke('product-delete', id),
        getCount: (filters) => ipcRenderer.invoke('product-get-count', filters),
        getUnits: (productId) => ipcRenderer.invoke('product-get-units', productId),
        setUnits: (productId, units) => ipcRenderer.invoke('product-set-units', { productId, units }),
        getSuppliers: (productId) => ipcRenderer.invoke('product-get-suppliers', productId),
        setSuppliers: (productId, suppliers) => ipcRenderer.invoke('product-set-suppliers', { productId, suppliers })
    },
    category: {
        getAll: () => ipcRenderer.invoke('category-get-all')
    },
    taxCategory: {
        getAll: () => ipcRenderer.invoke('tax-category-get-all')
    },
    supplier: {
        getAll: () => ipcRenderer.invoke('supplier-get-all'),
        create: (supplier) => ipcRenderer.invoke('supplier-create', supplier),
        update: (id, supplier) => ipcRenderer.invoke('supplier-update', { id, supplier }),
        delete: (id) => ipcRenderer.invoke('supplier-delete', id)
    },
    customer: {
        getAll: () => ipcRenderer.invoke('customer-get-all'),
        getById: (id) => ipcRenderer.invoke('customer-get-by-id', id),
        search: (query) => ipcRenderer.invoke('customer-search', query),
        create: (customer) => ipcRenderer.invoke('customer-create', customer),
        update: (id, customer) => ipcRenderer.invoke('customer-update', { id, customer }),
        priceMap: (customerId) => ipcRenderer.invoke('customer-price-map', customerId),
        setPrice: (customerId, productId, price) => ipcRenderer.invoke('customer-price-set', { customerId, productId, price })
    },
    pricing: {
        listRules: () => ipcRenderer.invoke('pricing-rule-list'),
        createRule: (rule) => ipcRenderer.invoke('pricing-rule-create', rule),
        deleteRule: (id) => ipcRenderer.invoke('pricing-rule-delete', id),
        setActive: (id, active) => ipcRenderer.invoke('pricing-rule-set-active', { id, active })
    },
    accounting: {
        journalVentes: (year, month) => ipcRenderer.invoke('accounting-journal-ventes', { year, month }),
        journalAchats: (year, month) => ipcRenderer.invoke('accounting-journal-achats', { year, month }),
        journalCaisse: (year, month) => ipcRenderer.invoke('accounting-journal-caisse', { year, month }),
        g50: (year, month) => ipcRenderer.invoke('accounting-g50', { year, month }),
        etat104: (year) => ipcRenderer.invoke('accounting-etat104', year),
        jibayatic: (year, month) => ipcRenderer.invoke('accounting-jibayatic', { year, month }),
        inventoryValuation: () => ipcRenderer.invoke('accounting-inventory-valuation'),
        physicalInventory: (counts, userId) => ipcRenderer.invoke('accounting-physical-inventory', { counts, userId }),
        liasse: (year) => ipcRenderer.invoke('accounting-liasse', year),
        exportCsv: (filename, csv) => ipcRenderer.invoke('accounting-export-csv', { filename, csv })
    },
    payroll: {
        enabled: () => ipcRenderer.invoke('payroll-enabled'),
        setEnabled: (on) => ipcRenderer.invoke('payroll-set-enabled', on),
        employees: () => ipcRenderer.invoke('payroll-employees'),
        createEmployee: (e) => ipcRenderer.invoke('payroll-employee-create', e),
        deleteEmployee: (id) => ipcRenderer.invoke('payroll-employee-delete', id),
        run: (period) => ipcRenderer.invoke('payroll-run', period),
        payslips: (period) => ipcRenderer.invoke('payroll-payslips', period)
    },
    reservation: {
        create: (customerId, productId, quantity, deposit, userId, notes) => ipcRenderer.invoke('reservation-create', { customerId, productId, quantity, deposit, userId, notes }),
        list: (status) => ipcRenderer.invoke('reservation-list', status),
        release: (id) => ipcRenderer.invoke('reservation-release', id),
        fulfill: (id, userId) => ipcRenderer.invoke('reservation-fulfill', { id, userId })
    },
    consignment: {
        receive: (supplierId, productId, quantity, unitCost, userId) => ipcRenderer.invoke('consignment-receive', { supplierId, productId, quantity, unitCost, userId }),
        list: (status) => ipcRenderer.invoke('consignment-list', status),
        settle: (id, quantity) => ipcRenderer.invoke('consignment-settle', { id, quantity })
    },
    ledger: {
        customerBalance: (customerId) => ipcRenderer.invoke('ledger-customer-balance', customerId),
        creditStatus: (customerId) => ipcRenderer.invoke('ledger-credit-status', customerId),
        customerStatement: (customerId) => ipcRenderer.invoke('ledger-customer-statement', customerId),
        aging: () => ipcRenderer.invoke('ledger-aging'),
        settlePartial: (transactionId, amount, method, reference) => ipcRenderer.invoke('ledger-settle-partial', { transactionId, amount, method, reference }),
        printStatement: (customerId) => ipcRenderer.invoke('ledger-print-statement', customerId),
        supplierBalance: (supplierId) => ipcRenderer.invoke('ledger-supplier-balance', supplierId),
        supplierStatement: (supplierId) => ipcRenderer.invoke('ledger-supplier-statement', supplierId),
        supplierPay: (supplierId, amount, method, reference, notes) => ipcRenderer.invoke('ledger-supplier-pay', { supplierId, amount, method, reference, notes }),
        chequeAdd: (c) => ipcRenderer.invoke('ledger-cheque-add', c),
        chequeList: (filter) => ipcRenderer.invoke('ledger-cheque-list', filter),
        chequeStatus: (id, status) => ipcRenderer.invoke('ledger-cheque-status', { id, status })
    },
    document: {
        create: (docType, customerId, userId, items, notes) => ipcRenderer.invoke('document-create', { docType, customerId, userId, items, notes }),
        get: (id) => ipcRenderer.invoke('document-get', id),
        list: (docType, limit) => ipcRenderer.invoke('document-list', { docType, limit }),
        convertToSale: (docId, userId) => ipcRenderer.invoke('document-convert-to-sale', { docId, userId }),
        recapitulative: (customerId, year, month, userId) => ipcRenderer.invoke('document-recapitulative', { customerId, year, month, userId }),
        print: (id) => ipcRenderer.invoke('document-print', id)
    },
    warehouse: {
        list: () => ipcRenderer.invoke('warehouse-list'),
        create: (w) => ipcRenderer.invoke('warehouse-create', w),
        deactivate: (id) => ipcRenderer.invoke('warehouse-deactivate', id),
        stock: (warehouseId) => ipcRenderer.invoke('warehouse-stock', warehouseId),
        createTransfer: (fromWarehouseId, toWarehouseId, items, userId, notes) => ipcRenderer.invoke('warehouse-transfer-create', { fromWarehouseId, toWarehouseId, items, userId, notes }),
        listTransfers: (limit) => ipcRenderer.invoke('warehouse-transfer-list', limit),
        getTransfer: (id) => ipcRenderer.invoke('warehouse-transfer-get', id),
        printTransfer: (id) => ipcRenderer.invoke('warehouse-transfer-print', id)
    },
    transaction: {
        create: (userId, customerId) => ipcRenderer.invoke('transaction-create', { userId, customerId }),
        setCustomer: (transactionId, customerId) => ipcRenderer.invoke('transaction-set-customer', { transactionId, customerId }),
        getById: (id) => ipcRenderer.invoke('transaction-get-by-id', id),
        addItem: (data) => ipcRenderer.invoke('transaction-add-item', data),
        updateItemQuantity: (itemId, quantity) => ipcRenderer.invoke('transaction-update-item-quantity', { itemId, quantity }),
        setItemUnit: (itemId, unit, unitFactor) => ipcRenderer.invoke('transaction-set-item-unit', { itemId, unit, unitFactor }),
        removeItem: (itemId) => ipcRenderer.invoke('transaction-remove-item', itemId),
        getItems: (transactionId) => ipcRenderer.invoke('transaction-get-items', transactionId),
        checkStock: (transactionId) => ipcRenderer.invoke('transaction-check-stock', transactionId),
        applyDiscount: (data) => ipcRenderer.invoke('transaction-apply-discount', data),
        addPayment: (data) => ipcRenderer.invoke('transaction-add-payment', data),
        getPayments: (transactionId) => ipcRenderer.invoke('transaction-get-payments', transactionId),
        complete: (data) => ipcRenderer.invoke('transaction-complete', data),
        void: (transactionId) => ipcRenderer.invoke('transaction-void', transactionId),
        createAvoir: (originalId, restock) => ipcRenderer.invoke('transaction-create-avoir', { originalId, restock }),
        getRecent: (limit) => ipcRenderer.invoke('transaction-get-recent', limit),
        getDebtors: () => ipcRenderer.invoke('transaction-get-debtors'),
        settleDebt: (transactionId) => ipcRenderer.invoke('transaction-settle-debt', transactionId),
        getDeliveries: (limit) => ipcRenderer.invoke('transaction-get-deliveries', limit)
    },
    purchaseOrder: {
        getAll: () => ipcRenderer.invoke('purchase-order-get-all'),
        getById: (id) => ipcRenderer.invoke('purchase-order-get-by-id', id),
        create: (data) => ipcRenderer.invoke('purchase-order-create', data),
        receive: (id, userId) => ipcRenderer.invoke('purchase-order-receive', { id, userId }),
        receivePartial: (id, userId, lines) => ipcRenderer.invoke('purchase-order-receive-partial', { id, userId, lines }),
        print: (id) => ipcRenderer.invoke('purchase-order-print', id),
        createReturn: (supplierId, items, userId, reason) => ipcRenderer.invoke('supplier-return-create', { supplierId, items, userId, reason }),
        listReturns: (limit) => ipcRenderer.invoke('supplier-return-list', limit),
        applyLandedCost: (poId, extraCost) => ipcRenderer.invoke('po-apply-landed-cost', { poId, extraCost })
    },
    app: {
        version: () => ipcRenderer.invoke('app-version'),
        checkUpdates: () => ipcRenderer.invoke('app-check-updates')
    },
    seed: () => ipcRenderer.invoke('db-seed'),
    getLocalIP: () => ipcRenderer.invoke('get-local-ip'),
    getSyncToken: () => ipcRenderer.invoke('get-sync-token'),
    getPrinters: () => ipcRenderer.invoke('get-printers'),
    settings: {
        getPrinterConfig: () => ipcRenderer.invoke('settings-get-printer-config'),
        savePrinterConfig: (config) => ipcRenderer.invoke('settings-save-printer-config', config)
    },
    config: {
        get: (key) => ipcRenderer.invoke('config-get', key),
        set: (key, value) => ipcRenderer.invoke('config-set', { key, value })
    },
    ai: {
        processVoice: (audioBuffer) => ipcRenderer.invoke('ai-process-voice', audioBuffer),
        processText: (text) => ipcRenderer.invoke('ai-process-text', text),
        confirmAction: (pending) => ipcRenderer.invoke('ai-confirm-action', pending),
        getUsage: () => ipcRenderer.invoke('ai-get-usage'),
        onViewChange: (callback) => {
            const listener = (_event, view) => callback(view)
            ipcRenderer.on('view-change', listener)
            return () => ipcRenderer.removeListener('view-change', listener)
        },
        onPOSAddProduct: (callback) => {
            const listener = (_event, product) => callback(product)
            ipcRenderer.on('pos-add-product', listener)
            return () => ipcRenderer.removeListener('pos-add-product', listener)
        },
        onInventoryFilter: (callback) => {
            const listener = (_event, filters) => callback(filters)
            ipcRenderer.on('inventory-filter', listener)
            return () => ipcRenderer.removeListener('inventory-filter', listener)
        },
        onInventorySearch: (callback) => {
            const listener = (_event, query) => callback(query)
            ipcRenderer.on('inventory-search', listener)
            return () => ipcRenderer.removeListener('inventory-search', listener)
        },
        onSettingsToggleTheme: (callback) => {
            const listener = () => callback()
            ipcRenderer.on('settings-toggle-theme', listener)
            return () => ipcRenderer.removeListener('settings-toggle-theme', listener)
        },
        onSettingsChangeLang: (callback) => {
            const listener = (_event, lang) => callback(lang)
            ipcRenderer.on('settings-change-lang', listener)
            return () => ipcRenderer.removeListener('settings-change-lang', listener)
        }
    },
    maintenance: {
        exportProducts: () => ipcRenderer.invoke('maintenance-export-products'),
        exportAllData: () => ipcRenderer.invoke('maintenance-export-all'),
        importProducts: () => ipcRenderer.invoke('maintenance-import-products'),
        resetDatabase: () => ipcRenderer.invoke('maintenance-reset-db')
    },
    expense: {
        list: () => ipcRenderer.invoke('expense-list'),
        totals: () => ipcRenderer.invoke('expense-totals'),
        create: (data) => ipcRenderer.invoke('expense-create', data),
        delete: (id) => ipcRenderer.invoke('expense-delete', id)
    }
})
