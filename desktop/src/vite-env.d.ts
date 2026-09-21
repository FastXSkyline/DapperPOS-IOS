import type { ProductVariant, Category } from '../shared/types'
import type { CashSession, ZReport } from '../electron/cashSessionService'
import type { LoyaltyConfig } from '../electron/loyaltyService'
import type { StockLoss, LossReason } from '../electron/lossService'
import type { Store, PosTerminal } from '../electron/storeService'
import type { RoleLimits } from '../electron/permissionService'
export type { Store, PosTerminal, RoleLimits }
import type { MovementType, StockState, StockOverviewRow } from '../electron/inventoryService'
export type { StockState, StockOverviewRow }
import type {
    ReturnLineInput, CreateReturnInput, CreateExchangeInput,
    ExchangeWithNewSaleInput,
} from '../electron/returnService'
import type { TransferStatus, CreateTransferInput, QuantityMap } from '../electron/transferService'
import type { Period } from '../electron/analyticsService'
import type { CountStatus, CountScope, StartCountInput } from '../electron/inventoryCountService'
import type { Severity } from '../electron/notificationService'
import type { TargetScope, PeriodType, TargetInput, TargetProgress } from '../electron/targetService'
export type { TargetScope, PeriodType, TargetProgress }
import type { RetailEvent, RetailEventType } from '../electron/eventBus'
export type { RetailEvent, RetailEventType }
export type { Period, CountStatus, CountScope, Severity }
export type { TransferStatus }

/**
 * Every mutating call in the retail modules answers with this envelope rather than
 * rejecting, so the renderer can branch on a stable `code` (INSUFFICIENT_STOCK,
 * PERMISSION_DENIED, EXCEEDS_SOLD_QUANTITY, ...) instead of matching on prose.
 */
export type ServiceResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

export interface StoreStock {
    store_id: number
    store_name: string
    store_code: string
    quantity: number
}

export interface StockMovementRow {
    id: number
    product_id: number
    variant_id: number | null
    store_id: number | null
    movement_type: 'in' | 'out' | 'adjustment' | 'transfer'
    quantity: number
    reason: string | null
    reference_type: string | null
    reference_id: number | null
    user_id: number | null
    created_at: string
    product_name?: string
    user_name?: string
    store_name?: string
    size?: string | null
    color?: string | null
}

export interface AuditLogRow {
    id: number
    user_id: number | null
    user_name: string | null
    action: string
    entity_type: string | null
    entity_id: number | null
    old_value: string | null
    new_value: string | null
    summary: string | null
    store_id: number | null
    store_name?: string | null
    severity: 'info' | 'warning' | 'critical'
    created_at: string
}

/** A device seen talking to a sync server (this box, or a remote store server). */
export interface NetworkDevice {
    device_key: string
    device_id: string | null
    device_name: string | null
    device_type: string | null
    ip_address: string | null
    user_agent: string | null
    last_endpoint: string | null
    request_count: number
    first_seen_at: string | null
    last_seen_at: string | null
    online: boolean
    label: string
}

export interface NetworkImportLogRow {
    id: number
    created_at: string
    user_name: string | null
    action: string
    summary: string | null
    device_info: string | null
    ip_address: string | null
    entity_type: string | null
    entity_id: number | null
    severity: string
    store_name: string | null
    kind: 'import' | 'sync' | 'device' | 'other'
}

export interface NetworkDeviceIngestRow {
    source_device: string
    sales: number
    first_at: string
    last_at: string
    revenue: number | null
}

export interface NetworkLogs {
    logs: NetworkImportLogRow[]
    ingest: NetworkDeviceIngestRow[]
}

export interface NetworkLocalStatus {
    mode: 'server' | 'client'
    isClient: boolean
    devicesOnline: number
    devicesTotal: number
    ip: string
    port: number
}

export interface NetworkRemoteStatus {
    mode: 'server' | 'client'
    serverUrl: string
    isClient: boolean
    connected: boolean
    lastError: string
}

export interface SaleReturnRow {
    id: number
    return_number: string
    kind: 'refund' | 'exchange'
    original_transaction_id: number
    exchange_transaction_id: number | null
    store_id: number
    returned_value: number
    replacement_value: number
    /** Signed: > 0 the shop refunds the customer, < 0 the customer tops up. */
    balance: number
    refund_method: string | null
    reason: string | null
    created_at: string
    original_number?: string
    exchange_number?: string | null
    customer_name?: string | null
    user_name?: string | null
    store_name?: string | null
    item_count?: number
}

export interface ReturnResult {
    returnId: number
    returnNumber: string
    returnedValue: number
    replacementValue: number
    /** Signed: > 0 the shop refunds the customer, < 0 the customer tops up. */
    balance: number
    returnStatus: 'none' | 'partial' | 'full'
}

export interface ExchangeResult extends ReturnResult {
    replacementTransactionId: number
    replacementNumber: string
}

export interface TransferRow {
    id: number
    transfer_number: string
    from_store_id: number
    to_store_id: number
    status: TransferStatus
    notes: string | null
    created_at: string
    shipped_at: string | null
    received_at: string | null
    from_store_name?: string
    to_store_name?: string
    requested_by_name?: string | null
    shipped_by_name?: string | null
    received_by_name?: string | null
    line_count?: number
    total_requested?: number
    total_shipped?: number
    total_received?: number
}

export interface TransferItemRow {
    id: number
    transfer_id: number
    product_id: number
    variant_id: number | null
    product_name: string
    size: string | null
    color: string | null
    sku: string | null
    quantity_requested: number
    quantity_shipped: number
    quantity_received: number
    unit_cost: number
    /** Source store's stock right now — so the packer sees shortfalls before shipping. */
    source_stock: number
}

export interface AnalyticsSummary {
    transactions: number
    itemsSold: number
    /** TTC total of completed sales in the window. */
    grossRevenue: number
    returnsValue: number
    /** grossRevenue − returnsValue. */
    netRevenue: number
    cogs: number
    /** netRevenue − cogs. Expenses are NOT deducted — this is never "net profit". */
    grossProfit: number
    grossMargin: number
    discounts: number
    avgBasket: number
    returnsCount: number
    refundsCount: number
    exchangesCount: number
    returnRate: number
    /** Sold lines with no frozen cost, whose margin is therefore an estimate. */
    estimatedCostLines: number
}

export interface StoreComparisonRow extends AnalyticsSummary {
    storeId: number
    storeName: string
    storeCode: string
    stockValue: number
    newCustomers: number
    returningCustomers: number
}

export interface CountRow {
    id: number
    count_number: string
    store_id: number
    scope: CountScope
    status: CountStatus
    category_id: number | null
    started_at: string
    applied_at: string | null
    notes: string | null
    store_name?: string
    category_name?: string | null
    started_by_name?: string | null
    applied_by_name?: string | null
    line_count?: number
    counted_lines?: number
    net_difference?: number
    net_value?: number
}

export interface CountItemRow {
    id: number
    count_id: number
    product_id: number
    variant_id: number | null
    product_name: string
    size: string | null
    color: string | null
    sku: string | null
    /** What the system believed WHEN THE LINE WAS COUNTED, not at session start. */
    expected_qty: number
    counted_qty: number | null
    difference: number | null
    unit_cost: number
    /** Live stock now — may differ from expected_qty if the shop kept selling. */
    current_stock: number
}

export interface CountTotals {
    lines: number
    counted: number
    with_difference: number
    expected_total: number
    counted_total: number
    net_difference: number
    net_value: number
}

export interface NotificationRow {
    id: number
    type: string
    severity: Severity
    title: string
    body: string | null
    store_id: number | null
    entity_type: string | null
    entity_id: number | null
    read_at: string | null
    created_at: string
    store_name?: string | null
}

/* ---- Employees, payroll and expenses (Migration 44) ---- */

export interface EmployeeInput {
    name: string
    position?: string | null
    base_salary?: number
    /** Standing monthly indemnity, separate from a one-off bonus on a payslip. */
    allowances?: number
    phone?: string | null
    email?: string | null
    address?: string | null
    national_id?: string | null
    ncc?: string | null
    hire_date?: string | null
    end_date?: string | null
    contract_type?: string | null
    store_id?: number | null
    /** The till login this person uses, when they have one. Null for staff who
     *  never touch the POS — a tailor is on payroll and has no account. */
    user_id?: number | null
    notes?: string | null
    is_btp?: boolean
}

export interface EmployeeRow extends EmployeeInput {
    id: number
    is_active: number
    created_at: string
    updated_at: string | null
    store_name?: string | null
    user_name?: string | null
    user_role?: string | null
}

export interface PayslipRow {
    id?: number
    employee_id?: number
    employeeId?: number
    employee_name?: string
    employee?: string
    period: string
    gross: number
    cnas_employee?: number
    cnasEmployee?: number
    cnas_employer?: number
    cnasEmployer?: number
    cacobatph: number
    taxable: number
    irg: number
    net: number
    bonus?: number
    allowances?: number
    deductions?: number
    /** gross + employer CNAS + CACOBATPH — what the shop actually spends, and
     *  what gets posted to the expense ledger. Never `net`. */
    employer_cost?: number
    employerCost?: number
    store_id?: number | null
    store_name?: string | null
}

export interface PayrollTotals {
    gross: number
    cnasEmployee: number
    cnasEmployer: number
    cacobatph: number
    irg: number
    net: number
    employerCost: number
}

export interface ExpenseFilters {
    from?: string
    to?: string
    storeId?: number | null
    category?: string | null
}

export interface ExpenseRow {
    id: number
    name: string
    amount: number
    category: string | null
    store_id: number | null
    /** When the cost was INCURRED. A September bill typed in October is a
     *  September cost, so every filter reads this, not created_at. */
    spent_at: string | null
    /** 'payroll' for a generated row; null when somebody typed it in. */
    source_type: string | null
    source_ref: string | null
    created_by: number | null
    created_at: string
    store_name?: string | null
}

export interface Delta {
    current: number
    previous: number
    change: number
    /** null when the previous period was zero — a rise from nothing has no ratio. */
    percent: number | null
}

export interface InTransitRow {
    id: number
    transfer_number: string
    shipped_at: string
    from_store_name: string
    to_store_name: string
    days_in_transit: number
    quantity: number
    value: number
}

/** getVariants always joins stock_inventory, so stock_quantity is guaranteed here. */
export type VariantWithStock = ProductVariant & { stock_quantity: number }

/** A row submitted from the variant matrix editor. `quantity` is optional:
 *  present syncs that variant's stock, absent leaves it untouched. */
export interface VariantInput {
    size?: string
    color?: string
    quantity?: number
    sku?: string | null
    barcode?: string | null
    cost_price?: number | null
    retail_price?: number | null
    sort_order?: number
}

export interface ElectronAPI {
    auth: {
        login: (pin: string) => Promise<{ id: number; name: string; role: string } | null>
        verifyOwner: (pin: string) => Promise<boolean>
        setOwnerPin: (newPin: string) => Promise<{ success: boolean }>
        ownerPinIsDefault: () => Promise<boolean>
    }
    receipt: {
        preview: (data: any) => Promise<string>
        print: (data: any) => Promise<{ success: boolean; error?: string }>
        fromTransaction: (transactionId: number) => Promise<import('../shared/types').ReceiptData>
        getConfig: () => Promise<any>
        saveConfig: (config: any) => Promise<any>
    }
    invoice: {
        generate: (data: any) => Promise<{ success: boolean; filePath?: string; error?: string }>
        print: (data: any) => Promise<{ success: boolean; error?: string }>
    }
    label: {
        print: (product: any, config: any, preview: boolean) => Promise<{ success: boolean; error?: string }>
    }
    report: {
        getStats: () => Promise<any>
        getChartData: (range: { startDate?: string; endDate?: string }) => Promise<any[]>
        getTopProducts: (limit?: number) => Promise<any[]>
        getLowStock: () => Promise<any[]>
        getCategorySales: (range: { startDate?: string; endDate?: string }) => Promise<any[]>
        getPaymentStats: (range: { startDate?: string; endDate?: string }) => Promise<any[]>
        printYearlyDelivery: (customerName?: string) => Promise<{ success: boolean; errorType?: string }>
        printYearlySettlement: (supplierName?: string) => Promise<any>
        inventoryMovement: (startDate: string, endDate: string, periodType: string) => Promise<{ success: boolean; errorType?: string }>
    }
    product: {
        getAll: (filters?: any) => Promise<any[]>
        getById: (id: number) => Promise<any>
        getByBarcode: (barcode: string) => Promise<any>
        create: (product: any) => Promise<any>
        update: (id: number, product: any) => Promise<any>
        updateStock: (id: number, quantity: number) => Promise<any>
        delete: (id: number) => Promise<any>
        getCount: (filters?: any) => Promise<number>
        getUnits: (productId: number) => Promise<{ id: number; product_id: number; name: string; factor: number; barcode: string | null }[]>
        setUnits: (productId: number, units: { name: string; factor: number; barcode?: string | null }[]) => Promise<{ success: boolean }>
        getSuppliers: (productId: number) => Promise<any[]>
        setSuppliers: (productId: number, suppliers: { supplier_id: number; supplier_ref?: string | null; cost_price?: number; lead_time_days?: number; is_preferred?: boolean }[]) => Promise<{ success: boolean }>
        getVariants: (productId: number) => Promise<VariantWithStock[]>
        setVariants: (productId: number, variants: VariantInput[]) => Promise<{ success: boolean }>
        updateVariantStock: (variantId: number, quantity: number) => Promise<{ changes: number }>
        /** Every photo attached to a product, primary first. */
        images: (productId: number) => Promise<{ id: number; product_id: number; image_path: string; is_primary: number; sort_order: number }[]>
        /** productId -> primary photo file name, for a whole grid in one call. */
        imageMap: (productIds?: number[]) => Promise<Record<number, string>>
        pickImage: (productId: number, userId: number) => Promise<ServiceResult<{ success: boolean; added?: number; error?: string }>>
        setPrimaryImage: (imageId: number, userId: number) => Promise<ServiceResult<{ success: boolean; error?: string }>>
        removeImage: (imageId: number, userId: number) => Promise<ServiceResult<{ success: boolean; error?: string }>>
    }
    category: {
        getAll: () => Promise<Category[]>
        getTree: () => Promise<Category[]>
        create: (category: Partial<Category>) => Promise<{ lastInsertRowid?: number; changes: number }>
        update: (id: number, category: Partial<Category>) => Promise<{ changes: number }>
        delete: (id: number) => Promise<{ changes: number }>
        pickImage: (categoryId: number, userId: number) => Promise<ServiceResult<{ success: boolean; fileName?: string; error?: string }>>
        clearImage: (categoryId: number, userId: number) => Promise<ServiceResult<{ success: boolean }>>
    }
    taxCategory: {
        getAll: () => Promise<{ id: number; name: string; rate: number; is_default: number }[]>
    }
    supplier: {
        getAll: () => Promise<any[]>
        create: (supplier: any) => Promise<any>
        update: (id: number, supplier: any) => Promise<any>
        delete: (id: number) => Promise<any>
    }
    customer: {
        getAll: () => Promise<any[]>
        getById: (id: number) => Promise<any>
        search: (query: string) => Promise<any[]>
        create: (customer: any) => Promise<any>
        update: (id: number, customer: any) => Promise<any>
        priceMap: (customerId: number) => Promise<Record<number, number>>
        setPrice: (customerId: number, productId: number, price: number) => Promise<{ success: boolean }>
    }
    pricing: {
        listRules: () => Promise<any[]>
        createRule: (rule: any) => Promise<{ id: number }>
        deleteRule: (id: number) => Promise<{ success: boolean }>
        setActive: (id: number, active: boolean) => Promise<{ success: boolean }>
    }
    accounting: {
        journalVentes: (year: number, month?: number) => Promise<{ rows: any[]; csv: string }>
        journalAchats: (year: number, month?: number) => Promise<{ rows: any[]; csv: string }>
        journalCaisse: (year: number, month?: number) => Promise<{ rows: any[]; csv: string }>
        g50: (year: number, month: number) => Promise<{ summary: any; csv: string }>
        etat104: (year: number) => Promise<{ rows: any[]; csv: string }>
        jibayatic: (year: number, month: number) => Promise<{ csv: string; g50: any }>
        inventoryValuation: () => Promise<{ rows: any[]; total: number; csv: string }>
        physicalInventory: (counts: { product_id: number; counted: number }[], userId: number) => Promise<{ success: boolean; ecarts: any[] }>
        liasse: (year: number) => Promise<{ figures: any; csv: string }>
        exportCsv: (filename: string, csv: string) => Promise<{ success: boolean; path?: string; error?: string }>
    }
    payroll: {
        enabled: () => Promise<boolean>
        setEnabled: (on: boolean, userId: number) => Promise<ServiceResult<{ success: boolean }>>
        employees: (includeInactive?: boolean) => Promise<EmployeeRow[]>
        createEmployee: (data: EmployeeInput, userId: number) => Promise<ServiceResult<{ success: boolean; id?: number; error?: string }>>
        updateEmployee: (id: number, data: EmployeeInput, userId: number) => Promise<ServiceResult<{ success: boolean; error?: string }>>
        deleteEmployee: (id: number, userId: number) => Promise<ServiceResult<{ success: boolean }>>
        run: (period: string, userId: number) => Promise<ServiceResult<{ slips: PayslipRow[]; totals: PayrollTotals }>>
        payslips: (period: string) => Promise<PayslipRow[]>
        postToExpenses: (period: string, userId: number) => Promise<ServiceResult<{ success: boolean; posted?: number; total?: number; error?: string }>>
        postingStatus: (period: string) => Promise<{ posted: boolean; count: number; total: number }>
        wageBill: (from?: string, to?: string, storeId?: number | null) => Promise<{ total: number; lines: number }>
    }
    reservation: {
        create: (customerId: number | null, productId: number, quantity: number, deposit: number, userId: number, notes?: string) => Promise<{ success: boolean; id?: number; error?: string }>
        list: (status?: string) => Promise<any[]>
        release: (id: number) => Promise<{ success: boolean; error?: string }>
        fulfill: (id: number, userId: number) => Promise<{ success: boolean; sale_id?: number; transaction_number?: string; error?: string }>
    }
    consignment: {
        receive: (supplierId: number | null, productId: number, quantity: number, unitCost: number, userId: number) => Promise<{ success: boolean; id?: number; error?: string }>
        list: (status?: string) => Promise<any[]>
        settle: (id: number, quantity: number) => Promise<{ success: boolean; settled?: number; amount?: number; error?: string }>
    }
    ledger: {
        customerBalance: (customerId: number) => Promise<number>
        creditStatus: (customerId: number) => Promise<{ balance: number; limit: number; available: number; over: boolean }>
        customerStatement: (customerId: number) => Promise<{ customer: any; lines: any[]; balance: number }>
        aging: () => Promise<any[]>
        settlePartial: (transactionId: number, amount: number, method: string, reference?: string) => Promise<{ success: boolean; paid?: number; remaining?: number; error?: string }>
        printStatement: (customerId: number) => Promise<{ success: boolean; error?: string }>
        supplierBalance: (supplierId: number) => Promise<number>
        supplierStatement: (supplierId: number) => Promise<{ supplier: any; orders: any[]; payments: any[]; balance: number }>
        supplierPay: (supplierId: number, amount: number, method?: string, reference?: string, notes?: string) => Promise<{ success: boolean; balance: number }>
        chequeAdd: (c: any) => Promise<{ id: number }>
        chequeList: (filter?: { direction?: string; status?: string }) => Promise<any[]>
        chequeStatus: (id: number, status: string) => Promise<{ success: boolean }>
    }
    document: {
        create: (docType: string, customerId: number | null, userId: number, items: { productId: number; quantity: number; unitPrice?: number }[], notes?: string) => Promise<{ id: number; transaction_number: string; doc_type: string }>
        get: (id: number) => Promise<any>
        list: (docType?: string, limit?: number) => Promise<any[]>
        convertToSale: (docId: number, userId: number) => Promise<{ success: boolean; id?: number; transaction_number?: string; error?: string }>
        recapitulative: (customerId: number, year: number, month: number, userId: number) => Promise<{ success: boolean; id?: number; transaction_number?: string; bl_count?: number; error?: string }>
        print: (id: number) => Promise<{ success: boolean; error?: string }>
    }
    warehouse: {
        list: () => Promise<any[]>
        create: (w: { name: string; type?: string; address?: string }) => Promise<{ id: number }>
        deactivate: (id: number) => Promise<{ success: boolean; error?: string }>
        stock: (warehouseId: number) => Promise<{ product_id: number; product_name: string; quantity: number }[]>
        createTransfer: (fromWarehouseId: number, toWarehouseId: number, items: { product_id: number; quantity: number }[], userId?: number, notes?: string) => Promise<{ success: boolean; id?: number; transfer_number?: string; error?: string }>
        listTransfers: (limit?: number) => Promise<any[]>
        getTransfer: (id: number) => Promise<any>
        printTransfer: (id: number) => Promise<{ success: boolean; error?: string }>
    }
    transaction: {
        create: (userId: number, customerId: number | null) => Promise<any>
        setCustomer: (transactionId: number, customerId: number | null) => Promise<{ success: boolean }>
        getById: (id: number) => Promise<any>
        addItem: (data: any) => Promise<any>
        updateItemQuantity: (itemId: number, quantity: number) => Promise<any>
        setItemUnit: (itemId: number, unit: string, unitFactor: number) => Promise<{ success: boolean }>
        removeItem: (itemId: number) => Promise<any>
        getItems: (transactionId: number) => Promise<any[]>
        checkStock: (transactionId: number) => Promise<{ product_id: number; product_name: string; requested: number; available: number }[]>
        applyDiscount: (data: any) => Promise<any>
        addPayment: (data: any) => Promise<any>
        getPayments: (transactionId: number) => Promise<any[]>
        /** Returns the envelope: `ok:false` with code INSUFFICIENT_STOCK when another
         *  terminal took the last one first. Never treat a rejection as a completed sale. */
        complete: (data: { transactionId: number; debtDueDate?: string; customerNameOverride?: string }) => Promise<ServiceResult<void>>
        void: (transactionId: number) => Promise<any>
        createAvoir: (originalId: number, restock?: boolean) => Promise<{ id: number; transaction_number: string }>
        getRecent: (limit: number) => Promise<any[]>
        getDebtors: () => Promise<any[]>
        settleDebt: (transactionId: number) => Promise<any>
        getDeliveries: (limit?: number) => Promise<any[]>
    }
    purchaseOrder: {
        getAll: () => Promise<any[]>
        getById: (id: number) => Promise<any>
        create: (data: { userId: number; supplierId: number; items: any[]; notes?: string }) => Promise<any>
        receive: (id: number, userId: number) => Promise<{ success: boolean; error?: string }>
        receivePartial: (id: number, userId: number, lines: { item_id: number; quantity: number }[]) => Promise<{ success: boolean; status?: string; error?: string }>
        print: (id: number) => Promise<{ success: boolean; error?: string }>
        createReturn: (supplierId: number | null, items: { product_id: number; quantity: number; unit_cost?: number }[], userId: number, reason?: string) => Promise<{ success: boolean; id?: number; return_number?: string; error?: string }>
        listReturns: (limit?: number) => Promise<any[]>
        applyLandedCost: (poId: number, extraCost: number) => Promise<{ success: boolean; allocated?: number; error?: string }>
    }
    expense: {
        create: (data: {
            name: string; amount: number; userId?: number
            category?: string; storeId?: number | null; spentAt?: string
        }) => Promise<{ id: number }>
        list: (filters?: ExpenseFilters) => Promise<ExpenseRow[]>
        totals: (storeId?: number | null) => Promise<{ total7D: number; total1M: number; total6M: number; total1Y: number }>
        byCategory: (filters?: ExpenseFilters) => Promise<{ category: string; total: number; lines: number }[]>
        delete: (id: number) => Promise<{ success: boolean; error?: string }>
    }
    cloud: {
        getConfig: () => Promise<{ apiKey: string; authDomain: string; projectId: string; appId: string; shopId: string; email: string; enabled: boolean; hasPassword: boolean } | null>
        setConfig: (patch: Record<string, string | boolean>) => Promise<{ success: boolean }>
        test: () => Promise<{ success: boolean; error?: string }>
        pushCatalog: () => Promise<{ success: boolean; pushed?: number; error?: string }>
        pullTransactions: () => Promise<{ success: boolean; success_count?: number; skipped?: number; failed?: number; error?: string }>
    }
    loyalty: {
        getConfig: () => Promise<LoyaltyConfig>
        setConfig: (cfg: Partial<LoyaltyConfig>) => Promise<{ success: boolean }>
        balance: (customerId: number) => Promise<number>
        history: (customerId: number, limit?: number) => Promise<any[]>
        redeem: (customerId: number, points: number, transactionId?: number) => Promise<{ success: boolean; points?: number; discount?: number; error?: string }>
        adjust: (customerId: number, points: number, note: string, userId?: number) => Promise<{ success: boolean; error?: string }>
        top: (limit?: number) => Promise<{ id: number; name: string; phone: string | null; loyalty_card_number: string | null; loyalty_points: number }[]>
        setCard: (customerId: number, cardNumber: string) => Promise<{ success: boolean }>
        findByCard: (cardNumber: string) => Promise<any>
    }
    loss: {
        record: (input: { productId: number; variantId?: number | null; quantity: number; reason: LossReason; notes?: string; userId?: number }) => Promise<{ success: boolean; id?: number; error?: string }>
        list: (limit?: number) => Promise<(StockLoss & { user_name?: string })[]>
        summary: (startDate?: string, endDate?: string) => Promise<{ byReason: { reason: string; entries: number; quantity: number; cost: number }[]; totalCost: number; totalEntries: number }>
        revert: (id: number, userId?: number) => Promise<{ success: boolean; error?: string }>
    }
    cashSession: {
        current: () => Promise<CashSession | undefined>
        list: (limit?: number) => Promise<(CashSession & { opened_by_name?: string })[]>
        open: (userId: number, openingFloat: number, notes?: string) => Promise<{ success: boolean; id?: number; error?: string }>
        close: (userId: number, countedCash: number, notes?: string) => Promise<{ success: boolean; error?: string; session_number?: string; expected?: number; counted?: number; variance?: number }>
        report: (sessionId?: number) => Promise<ZReport | { error: string }>
        movement: (direction: 'in' | 'out', amount: number, reason: string, userId: number) => Promise<{ success: boolean; error?: string }>
    }
    ai: {
        processVoice: (audioBuffer: Uint8Array) => Promise<{
            text: string;
            response: string;
            audio: string | null;
            success: boolean;
            toolsUsed?: string[];
            needsConfirmation?: boolean;
            pendingAction?: { name: string; args: any };
        } | { error: string }>
        processText: (text: string) => Promise<{
            text: string;
            response: string;
            audio: string | null;
            success: boolean;
            toolsUsed?: string[];
            needsConfirmation?: boolean;
            pendingAction?: { name: string; args: any };
        } | { error: string }>
        confirmAction: (pending: { name: string; args: any }) => Promise<{
            response: string;
            audio: string | null;
            success: boolean;
        } | { error: string }>
        getUsage: () => Promise<{ tokens: number; calls: number }>
        onViewChange: (callback: (view: string) => void) => () => void
        onPOSAddProduct: (callback: (product: any) => void) => () => void
        onInventoryFilter: (callback: (filters: any) => void) => () => void
        onInventorySearch: (callback: (query: string) => void) => () => void
        onSettingsToggleTheme: (callback: () => void) => () => void
        onSettingsChangeLang: (callback: (lang: string) => void) => () => void
    }
    app: {
        version: () => Promise<string>
        checkUpdates: () => Promise<{ available: boolean; version: string; latest?: string; reason?: string; error?: string }>
    }
    seed: () => Promise<any>
    getLocalIP: () => Promise<string>
    getSyncToken: () => Promise<string>
    getPrinters: () => Promise<any[]>
    settings: {
        getPrinterConfig: () => Promise<any>
        savePrinterConfig: (config: any) => Promise<any>
    }
    config: {
        get: (key: string) => Promise<string | null>
        set: (key: string, value: string) => Promise<{ success: boolean }>
    }
    maintenance: {
        exportProducts: () => Promise<any>
        exportAllData: () => Promise<any>
        importProducts: (userId?: number) => Promise<any>
        resetDatabase: () => Promise<any>
    }
    network: {
        localStatus: () => Promise<NetworkLocalStatus>
        devices: () => Promise<NetworkDevice[]>
        importLogs: () => Promise<NetworkLogs>
        remoteStatus: () => Promise<NetworkRemoteStatus>
        remoteDevices: () => Promise<NetworkDevice[] | { error: string; code?: string }>
        remoteLogs: () => Promise<NetworkLogs | { error: string; code?: string }>
    }
    store: {
        list: (includeInactive?: boolean) => Promise<Store[]>
        get: (id: number) => Promise<Store | undefined>
        create: (data: Partial<Store> & { code: string; name: string }, userId: number) => Promise<ServiceResult<number>>
        update: (id: number, data: Partial<Store>, userId: number) => Promise<ServiceResult<boolean>>
        deactivate: (id: number, userId: number) => Promise<ServiceResult<boolean>>
        current: () => Promise<Store | undefined>
        currentId: () => Promise<number>
        setCurrent: (storeId: number, userId: number) => Promise<ServiceResult<boolean>>
        userStores: (userId: number) => Promise<Store[]>
        setUserStores: (targetUserId: number, storeIds: number[], userId: number) => Promise<ServiceResult<boolean>>
    }
    terminal: {
        list: (storeId?: number) => Promise<PosTerminal[]>
        currentId: () => Promise<number | null>
        /** This machine's stable id, minted and kept by the main process. */
        deviceId: () => Promise<string>
        register: (storeId: number, name: string | undefined, isServer: boolean, userId: number) => Promise<ServiceResult<PosTerminal>>
    }
    permission: {
        catalogue: () => Promise<{ code: string; category: string; label_fr: string; label_ar: string; is_sensitive: number }[]>
        forUser: (userId: number) => Promise<string[]>
        forRole: (role: string) => Promise<string[]>
        can: (userId: number, permission: string) => Promise<boolean>
        limits: (userId: number) => Promise<RoleLimits>
        /** A role's own limits, for the settings screen. `limits` answers for a USER. */
        roleLimits: (role: string) => Promise<RoleLimits>
        setRole: (role: string, codes: string[], userId: number) => Promise<ServiceResult<boolean>>
        setLimits: (role: string, limits: Partial<Omit<RoleLimits, 'role'>>, userId: number) => Promise<ServiceResult<boolean>>
    }
    audit: {
        query: (filters: {
            userId?: number; storeId?: number; action?: string; entityType?: string
            entityId?: number; severity?: 'info' | 'warning' | 'critical'
            from?: string; to?: string; search?: string; limit?: number; offset?: number
        }, userId: number) => Promise<ServiceResult<{ rows: AuditLogRow[]; total: number }>>
        history: (entityType: string, entityId: number, userId: number) => Promise<ServiceResult<AuditLogRow[]>>
        actions: () => Promise<string[]>
    }
    inventory: {
        stock: (storeId: number | null, productId: number, variantId?: number | null) => Promise<number>
        acrossStores: (productId: number, variantId?: number | null) => Promise<StoreStock[]>
        movements: (storeId: number | null, productId?: number, variantId?: number | null, limit?: number) => Promise<StockMovementRow[]>
        lowStock: (storeId?: number) => Promise<any[]>
        outOfStock: (storeId?: number) => Promise<any[]>
        deadStock: (storeId: number | null, days?: number) => Promise<any[]>
        value: (storeId?: number) => Promise<{ total_quantity: number; total_cost_value: number; total_retail_value: number }>
        overview: (storeId: number | null, days?: number) => Promise<StockOverviewRow[]>
        adjust: (input: {
            storeId?: number; productId: number; variantId?: number | null
            newQuantity: number; reason?: string; userId: number
        }) => Promise<ServiceResult<number>>
    }
    user: {
        getAll: () => Promise<{ id: number; name: string; role: string; is_active: number }[]>
    }
    cloudMirror: {
        status: () => Promise<{
            configured: boolean
            enabled: boolean
            url: string
            shopId: string
            entities: { entity: string; last_id: number; last_at: string | null; last_success_at: string | null; last_error: string | null; rows_pushed: number }[]
            pendingTotal: Record<string, number>
        }>
        /** The secret never crosses the bridge — only whether one is set. */
        getConfig: () => Promise<{ url: string; shopId: string; enabled: boolean; hasSecret: boolean }>
        setConfig: (config: { url?: string; secret?: string; shopId?: string; enabled?: boolean }, userId: number) =>
            Promise<ServiceResult<boolean>>
        test: () => Promise<{ ok: boolean; message: string }>
        run: (userId: number) => Promise<ServiceResult<{ batches: number; totals: Record<string, number>; remaining: Record<string, number> }>>
    }
    target: {
        list: (filters?: { scope?: TargetScope; storeId?: number; activeOnly?: boolean }) => Promise<TargetProgress[]>
        current: (storeId?: number) => Promise<{
            company: TargetProgress | null
            stores: TargetProgress[]
            employees: TargetProgress[]
            /** Sum of store targets minus the company target. Reported, not enforced. */
            storeGap: number | null
        }>
        set: (input: TargetInput, userId: number) => Promise<ServiceResult<{ ok: boolean }>>
        remove: (id: number, userId: number) => Promise<ServiceResult<{ ok: boolean }>>
    }
    inventoryCount: {
        list: (storeId?: number, limit?: number) => Promise<CountRow[]>
        get: (id: number, filter?: 'all' | 'uncounted' | 'differences') =>
            Promise<(CountRow & { items: CountItemRow[]; totals: CountTotals }) | null>
        open: (storeId: number) => Promise<(CountRow & { items: CountItemRow[]; totals: CountTotals }) | null>
        start: (input: StartCountInput) => Promise<ServiceResult<{ id: number; countNumber: string; lineCount: number }>>
        countLine: (itemId: number, countedQty: number, userId: number) =>
            Promise<ServiceResult<{ expected: number; counted: number; difference: number }>>
        clearLine: (itemId: number, userId: number) => Promise<ServiceResult<{ ok: boolean }>>
        review: (id: number, userId: number) => Promise<ServiceResult<{ ok: boolean }>>
        apply: (id: number, userId: number) =>
            Promise<ServiceResult<{ adjusted: number; netUnits: number; netValue: number; linesCounted: number }>>
        cancel: (id: number, userId: number, reason?: string) => Promise<ServiceResult<{ ok: boolean }>>
    }
    rpc: {
        status: () => Promise<{
            mode: 'server' | 'client'
            serverUrl: string
            isClient: boolean
            connected: boolean
            lastError: string
        }>
        setMode: (mode: 'server' | 'client', serverUrl: string, token: string, userId: number) =>
            Promise<ServiceResult<{ mode: 'server' | 'client'; serverUrl: string; token: string }>>
        testConnection: (serverUrl: string, token: string) => Promise<{ ok: boolean; message: string }>
    }
    realtime: {
        /** Subscribe to changes made anywhere in this store. Returns an unsubscribe.
         *  An event is a HINT that something changed — always re-read, never trust
         *  the payload as a value. */
        onEvent: (cb: (event: RetailEvent) => void) => () => void
    }
    notification: {
        list: (filters?: { storeId?: number; unreadOnly?: boolean; limit?: number }) => Promise<NotificationRow[]>
        unreadCount: (storeId?: number) => Promise<number>
        markRead: (id: number) => Promise<{ ok: boolean }>
        markAllRead: (storeId?: number) => Promise<{ ok: boolean; marked: number }>
        /** Re-evaluate every rule against the CURRENT state and raise what is true. */
        sweep: (storeId?: number | null) => Promise<{ raised: number }>
    }
    analytics: {
        summary: (period?: Period) => Promise<AnalyticsSummary>
        bySize: (period?: Period) => Promise<{ label: string; size_group: string; units: number; revenue: number }[]>
        byColor: (period?: Period) => Promise<{ label: string; hex: string | null; units: number; revenue: number }[]>
        byHour: (period?: Period) => Promise<{ hour: number; transactions: number; revenue: number; items: number }[]>
        topProducts: (period?: Period, by?: 'units' | 'revenue' | 'profit', limit?: number) =>
            Promise<{ product_id: number; product_name: string; units: number; revenue: number; profit: number }[]>
        topVariants: (period?: Period, limit?: number) =>
            Promise<{ product_name: string; size: string; color: string; units: number; revenue: number }[]>
        storeComparison: (period?: Omit<Period, 'storeId'>) => Promise<StoreComparisonRow[]>
        periodComparison: (current: Period, previous: Period) => Promise<{
            revenue: Delta; grossProfit: Delta; transactions: Delta
            itemsSold: Delta; avgBasket: Delta; returnsValue: Delta
        }>
        revenueByDay: (period?: Period) => Promise<{ day: string; transactions: number; revenue: number }[]>
        employees: (period?: Period) => Promise<{
            user_id: number; user_name: string; transactions: number; revenue: number
            discounts: number; avg_basket: number; items_sold: number; returns_handled: number
        }[]>
        customerMix: (period?: Period) => Promise<{
            newCustomers: number; returningCustomers: number; totalCustomers: number; walkInSales: number
        }>
    }
    transfer: {
        list: (filters?: { storeId?: number; status?: TransferStatus; limit?: number }) => Promise<TransferRow[]>
        get: (id: number) => Promise<(TransferRow & { items: TransferItemRow[] }) | null>
        inTransit: (storeId?: number) => Promise<InTransitRow[]>
        create: (input: CreateTransferInput) => Promise<ServiceResult<{ id: number; transferNumber: string }>>
        approve: (id: number, userId: number) => Promise<ServiceResult<{ ok: boolean }>>
        ship: (id: number, userId: number, quantities?: QuantityMap) => Promise<ServiceResult<{ ok: boolean }>>
        receive: (id: number, userId: number, quantities?: QuantityMap) => Promise<ServiceResult<{ ok: boolean; discrepancy: number }>>
        cancel: (id: number, userId: number, reason?: string) => Promise<ServiceResult<{ ok: boolean }>>
    }
    salesReturn: {
        findSale: (transactionNumber: string) => Promise<any | null>
        getSale: (transactionId: number) => Promise<any | null>
        refund: (input: CreateReturnInput) => Promise<ServiceResult<ReturnResult>>
        exchange: (input: CreateExchangeInput) => Promise<ServiceResult<ReturnResult>>
        exchangeWithNewSale: (input: ExchangeWithNewSaleInput) => Promise<ServiceResult<ExchangeResult>>
        list: (filters?: { storeId?: number; from?: string; to?: string; kind?: 'refund' | 'exchange'; limit?: number }) => Promise<SaleReturnRow[]>
        get: (returnId: number) => Promise<any | null>
        analytics: (filters?: { storeId?: number; from?: string; to?: string }) => Promise<{
            salesCount: number; salesRevenue: number; returnsCount: number
            refundsCount: number; exchangesCount: number; returnedValue: number
            refundedCash: number; returnRate: number; exchangeRate: number; valueRate: number
            byReason: { reason: string; n: number; value: number }[]
            topProducts: { product_name: string; size: string | null; color: string | null; quantity: number; value: number }[]
            byEmployee: { user_name: string | null; n: number; value: number }[]
        }>
    }
    invoke: (channel: string, ...args: any[]) => Promise<any>
}

declare global {
    interface Window {
        electron: ElectronAPI
    }
}
