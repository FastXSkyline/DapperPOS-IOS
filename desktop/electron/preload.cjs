// @ts-nocheck
const { contextBridge, ipcRenderer } = require('electron')

// Preload script exposing IPC - Pure CommonJS, no bundler
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
        fromTransaction: (transactionId) => ipcRenderer.invoke('receipt-from-transaction', transactionId),
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
        setSuppliers: (productId, suppliers) => ipcRenderer.invoke('product-set-suppliers', { productId, suppliers }),
        getVariants: (productId) => ipcRenderer.invoke('product-get-variants', productId),
        setVariants: (productId, variants) => ipcRenderer.invoke('product-set-variants', { productId, variants }),
        updateVariantStock: (variantId, quantity) => ipcRenderer.invoke('product-update-variant-stock', { variantId, quantity }),
        images: (productId) => ipcRenderer.invoke('product-images', productId),
        imageMap: (productIds) => ipcRenderer.invoke('product-image-map', productIds),
        pickImage: (productId, userId) => ipcRenderer.invoke('product-image-pick', { productId, userId }),
        setPrimaryImage: (imageId, userId) => ipcRenderer.invoke('product-image-set-primary', { imageId, userId }),
        removeImage: (imageId, userId) => ipcRenderer.invoke('product-image-remove', { imageId, userId })
    },
    category: {
        getAll: () => ipcRenderer.invoke('category-get-all'),
        getTree: () => ipcRenderer.invoke('category-get-tree'),
        create: (category) => ipcRenderer.invoke('category-create', category),
        update: (id, category) => ipcRenderer.invoke('category-update', { id, category }),
        delete: (id) => ipcRenderer.invoke('category-delete', id),
        pickImage: (categoryId, userId) => ipcRenderer.invoke('category-image-pick', { categoryId, userId }),
        clearImage: (categoryId, userId) => ipcRenderer.invoke('category-image-clear', { categoryId, userId })
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
        setEnabled: (on, userId) => ipcRenderer.invoke('payroll-set-enabled', { on, userId }),
        employees: (includeInactive) => ipcRenderer.invoke('payroll-employees', includeInactive),
        createEmployee: (data, userId) => ipcRenderer.invoke('payroll-employee-create', { data, userId }),
        updateEmployee: (id, data, userId) => ipcRenderer.invoke('payroll-employee-update', { id, data, userId }),
        deleteEmployee: (id, userId) => ipcRenderer.invoke('payroll-employee-delete', { id, userId }),
        run: (period, userId) => ipcRenderer.invoke('payroll-run', { period, userId }),
        payslips: (period) => ipcRenderer.invoke('payroll-payslips', period),
        postToExpenses: (period, userId) => ipcRenderer.invoke('payroll-post-expenses', { period, userId }),
        postingStatus: (period) => ipcRenderer.invoke('payroll-posting-status', period),
        wageBill: (from, to, storeId) => ipcRenderer.invoke('payroll-wage-bill', { from, to, storeId })
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
        importProducts: (userId) => ipcRenderer.invoke('maintenance-import-products', userId),
        resetDatabase: () => ipcRenderer.invoke('maintenance-reset-db')
    },
    network: {
        localStatus: () => ipcRenderer.invoke('network-local-status'),
        devices: () => ipcRenderer.invoke('network-devices'),
        importLogs: () => ipcRenderer.invoke('network-import-logs'),
        remoteStatus: () => ipcRenderer.invoke('network-remote-status'),
        remoteDevices: () => ipcRenderer.invoke('network-remote-devices'),
        remoteLogs: () => ipcRenderer.invoke('network-remote-logs')
    },
    expense: {
        list: (filters) => ipcRenderer.invoke('expense-list', filters),
        totals: (storeId) => ipcRenderer.invoke('expense-totals', storeId),
        byCategory: (filters) => ipcRenderer.invoke('expense-by-category', filters),
        create: (data) => ipcRenderer.invoke('expense-create', data),
        delete: (id) => ipcRenderer.invoke('expense-delete', id)
    },
    cloud: {
        getConfig: () => ipcRenderer.invoke('cloud-get-config'),
        setConfig: (patch) => ipcRenderer.invoke('cloud-set-config', patch),
        test: () => ipcRenderer.invoke('cloud-test'),
        pushCatalog: () => ipcRenderer.invoke('cloud-push-catalog'),
        pullTransactions: () => ipcRenderer.invoke('cloud-pull-transactions')
    },
    loyalty: {
        getConfig: () => ipcRenderer.invoke('loyalty-config-get'),
        setConfig: (cfg) => ipcRenderer.invoke('loyalty-config-set', cfg),
        balance: (customerId) => ipcRenderer.invoke('loyalty-balance', customerId),
        history: (customerId, limit) => ipcRenderer.invoke('loyalty-history', { customerId, limit }),
        redeem: (customerId, points, transactionId) => ipcRenderer.invoke('loyalty-redeem', { customerId, points, transactionId }),
        adjust: (customerId, points, note, userId) => ipcRenderer.invoke('loyalty-adjust', { customerId, points, note, userId }),
        top: (limit) => ipcRenderer.invoke('loyalty-top', limit),
        setCard: (customerId, cardNumber) => ipcRenderer.invoke('loyalty-set-card', { customerId, cardNumber }),
        findByCard: (cardNumber) => ipcRenderer.invoke('loyalty-find-card', cardNumber)
    },
    loss: {
        record: (input) => ipcRenderer.invoke('loss-record', input),
        list: (limit) => ipcRenderer.invoke('loss-list', limit),
        summary: (startDate, endDate) => ipcRenderer.invoke('loss-summary', { startDate, endDate }),
        revert: (id, userId) => ipcRenderer.invoke('loss-revert', { id, userId })
    },
    cashSession: {
        current: () => ipcRenderer.invoke('cash-session-current'),
        list: (limit) => ipcRenderer.invoke('cash-session-list', limit),
        open: (userId, openingFloat, notes) => ipcRenderer.invoke('cash-session-open', { userId, openingFloat, notes }),
        close: (userId, countedCash, notes) => ipcRenderer.invoke('cash-session-close', { userId, countedCash, notes }),
        report: (sessionId) => ipcRenderer.invoke('cash-session-report', sessionId),
        movement: (direction, amount, reason, userId) => ipcRenderer.invoke('cash-session-movement', { direction, amount, reason, userId })
    },
    store: {
        list: (includeInactive) => ipcRenderer.invoke('store-list', includeInactive),
        get: (id) => ipcRenderer.invoke('store-get', id),
        create: (data, userId) => ipcRenderer.invoke('store-create', { data, userId }),
        update: (id, data, userId) => ipcRenderer.invoke('store-update', { id, data, userId }),
        deactivate: (id, userId) => ipcRenderer.invoke('store-deactivate', { id, userId }),
        current: () => ipcRenderer.invoke('store-current'),
        currentId: () => ipcRenderer.invoke('store-current-id'),
        setCurrent: (storeId, userId) => ipcRenderer.invoke('store-set-current', { storeId, userId }),
        userStores: (userId) => ipcRenderer.invoke('store-user-stores', userId),
        setUserStores: (targetUserId, storeIds, userId) => ipcRenderer.invoke('store-set-user-stores', { targetUserId, storeIds, userId })
    },
    terminal: {
        list: (storeId) => ipcRenderer.invoke('terminal-list', storeId),
        currentId: () => ipcRenderer.invoke('terminal-current-id'),
        deviceId: () => ipcRenderer.invoke('terminal-device-id'),
        register: (storeId, name, isServer, userId) => ipcRenderer.invoke('terminal-register', { storeId, name, isServer, userId })
    },
    permission: {
        catalogue: () => ipcRenderer.invoke('permission-catalogue'),
        forUser: (userId) => ipcRenderer.invoke('permission-for-user', userId),
        forRole: (role) => ipcRenderer.invoke('permission-for-role', role),
        can: (userId, permission) => ipcRenderer.invoke('permission-can', { userId, permission }),
        limits: (userId) => ipcRenderer.invoke('permission-limits', userId),
        roleLimits: (role) => ipcRenderer.invoke('permission-role-limits', role),
        setRole: (role, codes, userId) => ipcRenderer.invoke('permission-set-role', { role, codes, userId }),
        setLimits: (role, limits, userId) => ipcRenderer.invoke('permission-set-limits', { role, limits, userId })
    },
    audit: {
        query: (filters, userId) => ipcRenderer.invoke('audit-query', { filters, userId }),
        history: (entityType, entityId, userId) => ipcRenderer.invoke('audit-history', { entityType, entityId, userId }),
        actions: () => ipcRenderer.invoke('audit-actions')
    },
    inventory: {
        stock: (storeId, productId, variantId) => ipcRenderer.invoke('inventory-stock', { storeId, productId, variantId }),
        acrossStores: (productId, variantId) => ipcRenderer.invoke('inventory-across-stores', { productId, variantId }),
        movements: (storeId, productId, variantId, limit) => ipcRenderer.invoke('inventory-movements', { storeId, productId, variantId, limit }),
        lowStock: (storeId) => ipcRenderer.invoke('inventory-low-stock', storeId),
        outOfStock: (storeId) => ipcRenderer.invoke('inventory-out-of-stock', storeId),
        deadStock: (storeId, days) => ipcRenderer.invoke('inventory-dead-stock', { storeId, days }),
        value: (storeId) => ipcRenderer.invoke('inventory-value', storeId),
        overview: (storeId, days) => ipcRenderer.invoke('inventory-overview', { storeId, days }),
        adjust: (input) => ipcRenderer.invoke('inventory-adjust', input)
    },
    user: {
        getAll: () => ipcRenderer.invoke('user-get-all')
    },
    cloudMirror: {
        status: () => ipcRenderer.invoke('cloud-push-status'),
        getConfig: () => ipcRenderer.invoke('cloud-push-get-config'),
        setConfig: (config, userId) => ipcRenderer.invoke('cloud-push-set-config', { config, userId }),
        test: () => ipcRenderer.invoke('cloud-push-test'),
        run: (userId) => ipcRenderer.invoke('cloud-push-run', userId)
    },
    target: {
        list: (filters) => ipcRenderer.invoke('target-list', filters),
        current: (storeId) => ipcRenderer.invoke('target-current', storeId),
        set: (input, userId) => ipcRenderer.invoke('target-set', { input, userId }),
        remove: (id, userId) => ipcRenderer.invoke('target-remove', { id, userId })
    },
    inventoryCount: {
        list: (storeId, limit) => ipcRenderer.invoke('count-list', { storeId, limit }),
        get: (id, filter) => ipcRenderer.invoke('count-get', { id, filter }),
        open: (storeId) => ipcRenderer.invoke('count-open', storeId),
        start: (input) => ipcRenderer.invoke('count-start', input),
        countLine: (itemId, countedQty, userId) => ipcRenderer.invoke('count-line', { itemId, countedQty, userId }),
        clearLine: (itemId, userId) => ipcRenderer.invoke('count-clear-line', { itemId, userId }),
        review: (id, userId) => ipcRenderer.invoke('count-review', { id, userId }),
        apply: (id, userId) => ipcRenderer.invoke('count-apply', { id, userId }),
        cancel: (id, userId, reason) => ipcRenderer.invoke('count-cancel', { id, userId, reason })
    },
    rpc: {
        status: () => ipcRenderer.invoke('rpc-status'),
        setMode: (mode, serverUrl, token, userId) => ipcRenderer.invoke('rpc-set-mode', { mode, serverUrl, token, userId }),
        testConnection: (serverUrl, token) => ipcRenderer.invoke('rpc-test-connection', { serverUrl, token })
    },
    realtime: {
        // Returns an unsubscribe. The wrapper is needed because ipcRenderer passes
        // an IpcRendererEvent first, which no consumer wants, and because handing
        // the raw listener back would let a caller remove someone else's.
        onEvent: (cb) => {
            const handler = (_e, event) => cb(event)
            ipcRenderer.on('retail-event', handler)
            return () => ipcRenderer.removeListener('retail-event', handler)
        }
    },
    notification: {
        list: (filters) => ipcRenderer.invoke('notification-list', filters),
        unreadCount: (storeId) => ipcRenderer.invoke('notification-unread-count', storeId),
        markRead: (id) => ipcRenderer.invoke('notification-mark-read', id),
        markAllRead: (storeId) => ipcRenderer.invoke('notification-mark-all-read', storeId),
        sweep: (storeId) => ipcRenderer.invoke('notification-sweep', storeId)
    },
    analytics: {
        summary: (period) => ipcRenderer.invoke('analytics-summary', period),
        bySize: (period) => ipcRenderer.invoke('analytics-by-size', period),
        byColor: (period) => ipcRenderer.invoke('analytics-by-color', period),
        byHour: (period) => ipcRenderer.invoke('analytics-by-hour', period),
        topProducts: (period, by, limit) => ipcRenderer.invoke('analytics-top-products', { period, by, limit }),
        topVariants: (period, limit) => ipcRenderer.invoke('analytics-top-variants', { period, limit }),
        storeComparison: (period) => ipcRenderer.invoke('analytics-store-comparison', period),
        periodComparison: (current, previous) => ipcRenderer.invoke('analytics-period-comparison', { current, previous }),
        revenueByDay: (period) => ipcRenderer.invoke('analytics-revenue-by-day', period),
        employees: (period) => ipcRenderer.invoke('analytics-employees', period),
        customerMix: (period) => ipcRenderer.invoke('analytics-customer-mix', period)
    },
    transfer: {
        list: (filters) => ipcRenderer.invoke('transfer-list', filters),
        get: (id) => ipcRenderer.invoke('transfer-get', id),
        inTransit: (storeId) => ipcRenderer.invoke('transfer-in-transit', storeId),
        create: (input) => ipcRenderer.invoke('transfer-create', input),
        approve: (id, userId) => ipcRenderer.invoke('transfer-approve', { id, userId }),
        ship: (id, userId, quantities) => ipcRenderer.invoke('transfer-ship', { id, userId, quantities }),
        receive: (id, userId, quantities) => ipcRenderer.invoke('transfer-receive', { id, userId, quantities }),
        cancel: (id, userId, reason) => ipcRenderer.invoke('transfer-cancel', { id, userId, reason })
    },
    salesReturn: {
        findSale: (transactionNumber) => ipcRenderer.invoke('return-find-sale', transactionNumber),
        getSale: (transactionId) => ipcRenderer.invoke('return-get-sale', transactionId),
        refund: (input) => ipcRenderer.invoke('return-create-refund', input),
        exchange: (input) => ipcRenderer.invoke('return-create-exchange', input),
        exchangeWithNewSale: (input) => ipcRenderer.invoke('return-exchange-new-sale', input),
        list: (filters) => ipcRenderer.invoke('return-list', filters),
        get: (returnId) => ipcRenderer.invoke('return-get', returnId),
        analytics: (filters) => ipcRenderer.invoke('return-analytics', filters)
    }
})
