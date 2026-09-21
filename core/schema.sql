-- POS System Database Schema
-- Shared between Desktop (better-sqlite3) and Mobile (expo-sqlite)

-- Core Configuration
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Users Table (Owner, Manager, Cashier, Warehouse)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pin TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner', 'manager', 'cashier', 'warehouse')),
    biometric_enabled INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Activity Logs for Audit Trail
CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Sync Queue for Offline-First Operations
CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL CHECK(operation IN ('insert', 'update', 'delete')),
    table_name TEXT NOT NULL,
    record_id INTEGER NOT NULL,
    payload TEXT NOT NULL,
    synced INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    synced_at TEXT
);

-- Default Owner User (PIN: 1234)
INSERT OR IGNORE INTO users (id, name, pin, role) VALUES (1, 'Dapper', '1234', 'owner');

-- ============================================
-- PHASE 2: PRODUCT & INVENTORY MANAGEMENT
-- ============================================

-- Categories (hierarchical with parent_id)
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER,
    icon TEXT,
    image_path TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (parent_id) REFERENCES categories(id)
);




-- Suppliers
CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    contact_name TEXT,
    phone TEXT,
    email TEXT,
    website TEXT,
    address TEXT,
    city TEXT,
    country TEXT,
    tax_id TEXT,
    payment_terms TEXT,
    credit_limit REAL DEFAULT 0,
    lead_time_days INTEGER DEFAULT 0,
    rating INTEGER DEFAULT 0,
    notes TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Tax Categories
CREATE TABLE IF NOT EXISTS tax_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    rate REAL NOT NULL DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO tax_categories (id, name, rate, is_default) VALUES (1, 'Standard', 19, 1);
INSERT OR IGNORE INTO tax_categories (id, name, rate, is_default) VALUES (2, 'Réduit', 9, 0);
INSERT OR IGNORE INTO tax_categories (id, name, rate, is_default) VALUES (3, 'Exonéré', 0, 0);

-- Products
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE,
    barcode TEXT,
    name TEXT NOT NULL,
    description TEXT,
    technical_specs TEXT,
    category_id INTEGER,
    supplier_id INTEGER,
    tax_category_id INTEGER DEFAULT 1,
    cost_price REAL DEFAULT 0,
    retail_price REAL DEFAULT 0,
    wholesale_price REAL DEFAULT 0,
    min_stock_level INTEGER DEFAULT 0,
    max_stock_level INTEGER DEFAULT 0,
    reorder_point INTEGER DEFAULT 0,
    lead_time_days INTEGER DEFAULT 0,
    stock_location TEXT,
    has_variants INTEGER DEFAULT 0,
    track_serial_numbers INTEGER DEFAULT 0,
    track_expiration INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
    FOREIGN KEY (tax_category_id) REFERENCES tax_categories(id)
);

-- Product Images
CREATE TABLE IF NOT EXISTS product_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    image_path TEXT NOT NULL,
    is_primary INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- Product Variants — one row = one sellable SIZE × COLOUR combination.
-- Both axes are optional ('' = the product has no such axis), so a garment can be
-- size+colour, a belt size-only, a scarf colour-only, an accessory neither.
-- Empty string rather than NULL so UNIQUE(product_id, size, color) actually holds
-- (SQLite treats NULLs as distinct in UNIQUE constraints).
-- Stock lives in stock_inventory keyed by (product_id, variant_id), NOT here.
CREATE TABLE IF NOT EXISTS product_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    size TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    sku TEXT,
    barcode TEXT,
    cost_price REAL,
    retail_price REAL,
    -- Clothing sizes must display S < M < L < XL, not alphabetically. The form writes
    -- the index of each size in the user's own list here.
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(product_id, size, color),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_barcode ON product_variants(barcode);

-- Stock Inventory (current stock levels)
CREATE TABLE IF NOT EXISTS stock_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    variant_id INTEGER,
    quantity REAL DEFAULT 0,
    reserved_quantity INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE
);

-- Stock Movements (history of all stock changes)
CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    variant_id INTEGER,
    movement_type TEXT NOT NULL CHECK(movement_type IN ('in', 'out', 'adjustment', 'transfer')),
    quantity REAL NOT NULL,
    reason TEXT,
    reference_type TEXT,
    reference_id INTEGER,
    batch_number TEXT,
    expiration_date TEXT,
    serial_number TEXT,
    user_id INTEGER,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (variant_id) REFERENCES product_variants(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Purchase Orders
CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_number TEXT UNIQUE NOT NULL,
    supplier_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'partial', 'received', 'cancelled')),
    order_date TEXT DEFAULT (datetime('now')),
    expected_date TEXT,
    received_date TEXT,
    subtotal REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    total_amount REAL DEFAULT 0,
    notes TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Purchase Order Items
CREATE TABLE IF NOT EXISTS purchase_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    variant_id INTEGER,
    quantity_ordered REAL NOT NULL,
    quantity_received REAL DEFAULT 0,
    unit TEXT DEFAULT 'piece',
    unit_cost REAL NOT NULL,
    total_cost REAL NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (variant_id) REFERENCES product_variants(id)
);

-- Bulk/Promotional Pricing Rules
CREATE TABLE IF NOT EXISTS pricing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    rule_type TEXT NOT NULL CHECK(rule_type IN ('bulk', 'promotional', 'wholesale_tier')),
    product_id INTEGER,
    category_id INTEGER,
    min_quantity INTEGER DEFAULT 1,
    discount_type TEXT CHECK(discount_type IN ('percentage', 'fixed', 'price_override')),
    discount_value REAL NOT NULL,
    start_date TEXT,
    end_date TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (category_id) REFERENCES categories(id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_inventory_product ON stock_inventory(product_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);

-- ============================================
-- PHASE 3: POS INTERFACE & TRANSACTIONS
-- ============================================

-- Customers
CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    company_name TEXT,
    tax_id TEXT,
    customer_type TEXT DEFAULT 'retail' CHECK(customer_type IN ('retail', 'wholesale')),
    billing_address TEXT,
    shipping_address TEXT,
    credit_limit REAL DEFAULT 0,
    current_balance REAL DEFAULT 0,
    payment_terms TEXT,
    notes TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Transactions (Sales)
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_number TEXT UNIQUE NOT NULL,
    customer_id INTEGER,
    user_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'voided', 'refunded')),
    subtotal REAL DEFAULT 0,
    discount_amount REAL DEFAULT 0,
    discount_type TEXT CHECK(discount_type IN ('percentage', 'fixed')),
    discount_value REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    total_amount REAL DEFAULT 0,
    amount_paid REAL DEFAULT 0,
    change_due REAL DEFAULT 0,
    customer_notes TEXT,
    debt_due_date TEXT,
    debt_status TEXT DEFAULT 'none',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Transaction Items (Line Items)
CREATE TABLE IF NOT EXISTS transaction_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    variant_id INTEGER,
    product_name TEXT NOT NULL,
    sku TEXT,
    quantity REAL NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL,
    discount_amount REAL DEFAULT 0,
    discount_type TEXT CHECK(discount_type IN ('percentage', 'fixed')),
    discount_value REAL DEFAULT 0,
    tax_rate REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    line_total REAL NOT NULL,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (variant_id) REFERENCES product_variants(id)
);

-- Payments
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    payment_method TEXT NOT NULL CHECK(payment_method IN ('cash', 'card', 'bank_transfer', 'check', 'store_credit', 'loyalty_points')),
    amount REAL NOT NULL,
    reference_number TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

-- Held Transactions (for hold/retrieve functionality)
CREATE TABLE IF NOT EXISTS held_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    customer_id INTEGER,
    hold_name TEXT,
    items_json TEXT NOT NULL,
    subtotal REAL DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (customer_id) REFERENCES customers(id)
);

-- Indexes for POS tables
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transaction_items_transaction ON transaction_items(transaction_id);
CREATE INDEX IF NOT EXISTS idx_payments_transaction ON payments(transaction_id);

-- Default walk-in customer
INSERT OR IGNORE INTO customers (id, name, customer_type) VALUES (1, 'Walk-in Customer', 'retail');
