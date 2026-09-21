export interface Product {
    id: number
    sku: string | null
    barcode: string | null
    name: string
    // New inventory fields
    devation: string | null
    designation_fournisseur: string | null
    reference: string | null
    marque: string | null
    qtes_cmnds: number
    delai_livraison: number
    unite: string | null
    // Existing fields
    category_id: number | null
    supplier_id: number | null
    tax_category_id: number
    cost_price: number
    retail_price: number
    min_stock_level: number
    lead_time_days: number
    is_active: number
    created_at: string
    updated_at: string
    // Joined fields
    category_name?: string
    supplier_name?: string
    stock_quantity?: number
    /** Derived (not a column): 1 when the product has at least one active variant.
     *  Migration 7 strips any stored has_variants column, so this is computed per query. */
    has_variants?: number
}

/** One sellable size × colour combination. Either axis may be '' when the product
 *  does not use it (belt = size only, scarf = colour only, accessory = neither).
 *  Stock is NOT stored here — it lives in stock_inventory keyed by (product_id, variant_id). */
export interface ProductVariant {
    id: number
    product_id: number
    size: string
    color: string
    sku: string | null
    barcode: string | null
    /** NULL = inherit the parent product's price. */
    cost_price: number | null
    retail_price: number | null
    /** Index of this variant's size in the user's size list, so S < M < L < XL. */
    sort_order: number
    is_active: number
    created_at: string
    updated_at: string
    // Joined field
    stock_quantity?: number
}

export interface Category {
    id: number
    name: string
    parent_id: number | null
    icon: string | null
    image_path: string | null
    sort_order: number
    is_active: number
    children?: Category[]
}

export interface Supplier {
    id: number
    company_name: string
    contact_name: string | null
    phone: string | null
    email: string | null
    website: string | null
    address: string | null
    city: string | null
    country: string | null
    tax_id: string | null
    payment_terms: string | null
    credit_limit: number
    lead_time_days: number
    rating: number
    notes: string | null
    is_active: number
}

export interface Customer {
    id: number
    name: string
    phone: string | null
    email: string | null
    company_name: string | null
    tax_id: string | null
    customer_type: 'retail' | 'wholesale'
    billing_address: string | null
    shipping_address: string | null
    credit_limit: number
    current_balance: number
    is_active: number
}

export interface Transaction {
    id: number
    transaction_number: string
    customer_id: number | null
    user_id: number
    status: 'pending' | 'completed' | 'voided' | 'refunded'
    subtotal: number
    discount_amount: number
    discount_type: 'percentage' | 'fixed' | null
    discount_value: number
    tax_amount: number
    total_amount: number
    amount_paid: number
    change_due: number
    notes: string | null
    created_at: string
    completed_at: string | null
    debt_due_date: string | null
    debt_status: 'none' | 'unpaid' | 'partial' | 'paid'
    // Joined
    customer_name?: string
    customer_phone?: string
}

export interface TransactionItem {
    id: number
    transaction_id: number
    product_id: number
    variant_id: number | null
    product_name: string
    sku: string | null
    quantity: number
    unit_price: number
    discount_amount: number
    discount_type: 'percentage' | 'fixed' | null
    discount_value: number
    tax_rate: number
    tax_amount: number
    line_total: number
    notes: string | null
    /** Selling unit for display/print (Migration 22). quantity stays in base units. */
    unit?: string | null
    unit_factor?: number
}

export interface Payment {
    id: number
    transaction_id: number
    payment_method: 'cash' | 'card' | 'bank_transfer' | 'check' | 'store_credit' | 'loyalty_points'
    amount: number
    reference_number: string | null
}

export interface HeldTransaction {
    id: number
    user_id: number
    customer_id: number | null
    hold_name: string | null
    items_json: string
    subtotal: number
    notes: string | null
    created_at: string
}

export interface ReceiptConfig {
    companyName: string
    companyAddress: string
    companyPhone: string
    companyEmail: string
    logoPath: string | null
    taxId: string | null
    showTaxBreakdown: boolean
    footerMessage: string
    paperWidth: 58 | 80 // mm
    headerAlignment: 'left' | 'center' | 'right'
    fontSize: number
    showLogo: boolean
    customNote: string
}

export interface ReceiptData {
    transactionNumber: string
    date: string
    cashierName: string
    customerName: string | null
    items: {
        name: string
        quantity: number
        unitPrice: number
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
    // Optional buyer fiscal identifiers (B2B facture)
    fiscalId?: string
    rc?: string
    nis?: string
    ai?: string
    customerPhone?: string
}
