import * as SQLite from 'expo-sqlite'

// Database singleton instance
let db: SQLite.SQLiteDatabase | null = null

// Initialize database
export async function initDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db

  db = await SQLite.openDatabaseAsync('pos-system.db')

  // Create tables
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      company_name TEXT,
      tax_id TEXT,
      customer_type TEXT DEFAULT 'retail',
      billing_address TEXT,
      shipping_address TEXT,
      credit_limit REAL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

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

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id INTEGER,
      icon TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );


    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY,
      company_name TEXT NOT NULL,
      contact_name TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      country TEXT,
      tax_id TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      sku TEXT,
      barcode TEXT,
      name TEXT NOT NULL,
      category_id INTEGER,
      supplier_id INTEGER,
      tax_category_id INTEGER DEFAULT 1,
      cost_price REAL DEFAULT 0,
      retail_price REAL DEFAULT 0,
      min_stock_level REAL DEFAULT 0,
      lead_time_days INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (category_id) REFERENCES categories(id),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );

    CREATE TABLE IF NOT EXISTS stock_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      variant_id INTEGER,
      batch_number TEXT,
      quantity INTEGER DEFAULT 0,
      location TEXT,
      expiry_date TEXT,
      last_checked_at TEXT,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    -- Size × colour variants, mirrored from the desktop (Dapper Phase 6).
    -- Read-only on mobile: the desktop owns the catalogue, this is a local cache
    -- so the till can ask for a size/colour while offline.
    CREATE TABLE IF NOT EXISTS product_variants (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL,
      size TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      sku TEXT,
      barcode TEXT,
      retail_price REAL,
      sort_order INTEGER DEFAULT 0,
      stock_quantity REAL DEFAULT 0,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS held_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      customer_id INTEGER,
      hold_name TEXT,
      items_json TEXT NOT NULL,
      subtotal REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      user_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number TEXT NOT NULL,
      supplier_id INTEGER NOT NULL,
      user_id INTEGER,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'received', 'cancelled')),
      subtotal REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      received_at TEXT,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      variant_id INTEGER,
      quantity REAL NOT NULL,
      unit TEXT DEFAULT 'piece',
      unit_cost REAL NOT NULL,
      total_cost REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_number TEXT NOT NULL,
      customer_id INTEGER,
      user_id INTEGER,
      status TEXT DEFAULT 'completed',
      subtotal REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      amount_paid REAL DEFAULT 0,
      change_due REAL DEFAULT 0,
      payment_method TEXT,
      sync_status INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS transaction_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      tax_rate REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      line_total REAL NOT NULL,
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tax_categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      rate REAL NOT NULL DEFAULT 0,
      is_default INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      amount REAL NOT NULL,
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    );
  `);

  // Migration Helper: Add columns if they don't exist (for older installations)
  const addColumnIfNotExists = async (tableName: string, columnName: string, columnDef: string) => {
    try {
      const info = await db!.getAllAsync(`PRAGMA table_info(${tableName})`) as any[]
      if (info.length > 0 && !info.some(col => col.name === columnName)) {
        console.log(`[DB] Migration: Adding missing column ${columnName} to ${tableName}`)
        await db!.execAsync(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`)
      }
    } catch (e) {
      console.warn(`[DB] Migration failed for ${tableName}.${columnName}:`, e)
    }
  }

  // Column Migrations
  await addColumnIfNotExists('suppliers', 'address', 'TEXT')
  await addColumnIfNotExists('suppliers', 'city', 'TEXT')
  await addColumnIfNotExists('suppliers', 'country', 'TEXT')
  await addColumnIfNotExists('suppliers', 'tax_id', 'TEXT')
  await addColumnIfNotExists('purchase_order_items', 'unit', "TEXT DEFAULT 'piece'")
  await addColumnIfNotExists('purchase_order_items', 'variant_id', 'INTEGER')
  // TVA: per-line tax columns + seed the Algerian tax categories (parity with desktop).
  await addColumnIfNotExists('transaction_items', 'tax_rate', 'REAL DEFAULT 0')
  await addColumnIfNotExists('transaction_items', 'tax_amount', 'REAL DEFAULT 0')
  // Which size/colour was sold — travels to the desktop on sync so the right
  // stock row is decremented there (Dapper Phase 6).
  await addColumnIfNotExists('transaction_items', 'variant_id', 'INTEGER')
  await db.execAsync('CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id)')
  await db.runAsync("INSERT OR IGNORE INTO tax_categories (id, name, rate, is_default) VALUES (1, 'Standard', 19, 1)")
  await db.runAsync("INSERT OR IGNORE INTO tax_categories (id, name, rate, is_default) VALUES (2, 'Réduit', 9, 0)")
  await db.runAsync("INSERT OR IGNORE INTO tax_categories (id, name, rate, is_default) VALUES (3, 'Exonéré', 0, 0)")

  // Check if default owner exists, if not create it
  const existingOwner = await db.getFirstAsync('SELECT id FROM users WHERE id = 1')
  if (!existingOwner) {
    await db.runAsync('INSERT INTO users (id, name, pin, role) VALUES (1, ?, ?, ?)', ['Owner', '1234', 'owner'])
  }

  return db
}

// Get database instance
export function getDatabase(): SQLite.SQLiteDatabase | null {
  return db
}

// Customer operations
export const CustomerService = {
  async getAll() {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    return database.getAllAsync('SELECT * FROM customers WHERE is_active = 1 ORDER BY name')
  },

  async search(query: string) {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    return database.getAllAsync(
      `SELECT * FROM customers 
       WHERE is_active = 1 AND (name LIKE ? OR phone LIKE ?) 
       ORDER BY name LIMIT 20`,
      [`%${query}%`, `%${query}%`]
    )
  },

  async create(data: { name: string, phone?: string, email?: string, address?: string }) {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    return database.runAsync(
      `INSERT INTO customers (name, phone, email, billing_address, is_active)
       VALUES (?, ?, ?, ?, 1)`,
      [data.name, data.phone || null, data.email || null, data.address || null]
    )
  }
}

// User operations
export const UserService = {
  async findByPin(pin: string) {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    return database.getFirstAsync('SELECT * FROM users WHERE pin = ? AND is_active = 1', [pin])
  },

  async getAll() {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    return database.getAllAsync('SELECT id, name, role, is_active FROM users')
  },

  async create(name: string, pin: string, role: string) {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    return database.runAsync('INSERT INTO users (name, pin, role) VALUES (?, ?, ?)', [name, pin, role])
  },

  async logActivity(userId: number, action: string, entityType?: string, entityId?: number, details?: string) {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    return database.runAsync(
      'INSERT INTO activity_logs (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)',
    )
  },

  async updateBiometric(userId: number, enabled: number) {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    return database.runAsync('UPDATE users SET biometric_enabled = ?, updated_at = datetime("now") WHERE id = ?', [enabled, userId])
  }
}

// Expense operations
export const ExpenseService = {
  async list() {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    return database.getAllAsync('SELECT * FROM expenses ORDER BY created_at DESC')
  },

  async totals() {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    const result = await database.getFirstAsync<{
      total7D: number, total1M: number, total6M: number, total1Y: number
    }>(`
  SELECT
  COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN amount ELSE 0 END), 0) as total7D,
    COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-1 month') THEN amount ELSE 0 END), 0) as total1M,
    COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-6 months') THEN amount ELSE 0 END), 0) as total6M,
    COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-1 year') THEN amount ELSE 0 END), 0) as total1Y
      FROM expenses
    `)
    return result || { total7D: 0, total1M: 0, total6M: 0, total1Y: 0 }
  },

  async create(name: string, amount: number, userId?: number) {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    return database.runAsync(
      'INSERT INTO expenses (name, amount, user_id) VALUES (?, ?, ?)',
      [name, amount, userId || null]
    )
  },

  async delete(id: number) {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    return database.runAsync('DELETE FROM expenses WHERE id = ?', [id])
  }
}

// Supplier operations
export const SupplierService = {
  async getAll() {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    return database.getAllAsync('SELECT * FROM suppliers WHERE is_active = 1 ORDER BY company_name')
  },

  async create(data: {
    company_name: string,
    contact_name: string | null,
    phone: string | null,
    email: string | null,
    address: string | null,
    city: string | null,
    payment_terms: string | null,
    credit_limit: number
  }) {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    return database.runAsync(
      `INSERT INTO suppliers (
        company_name, contact_name, phone, email, address, city, 
        payment_terms, credit_limit, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        data.company_name, data.contact_name, data.phone, data.email,
        data.address, data.city, data.payment_terms, data.credit_limit
      ]
    )
  },

  async delete(id: number) {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    // Soft delete
    return database.runAsync('UPDATE suppliers SET is_active = 0 WHERE id = ?', [id])
  }
}

// Purchase Order operations
export const OrderService = {
  async list() {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    return database.getAllAsync(`
      SELECT po.*, s.company_name as supplier_name
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      ORDER BY po.created_at DESC
    `)
  },

  async getById(id: number) {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')
    const order = await database.getFirstAsync('SELECT * FROM purchase_orders WHERE id = ?', [id])
    const items = await database.getAllAsync(`
      SELECT poi.*, p.name as product_name
      FROM purchase_order_items poi
      LEFT JOIN products p ON poi.product_id = p.id
      WHERE poi.purchase_order_id = ?
    `, [id])
    return { order, items }
  },

  async create(supplierId: number, items: { productId: number, quantity: number, unitCost: number, unit?: string }[], userId?: number, notes?: string) {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')

    const poNumber = `PO - ${Date.now()} `
    const subtotal = items.reduce((sum, i) => sum + (i.quantity * i.unitCost), 0)

    const result = await database.runAsync(
      'INSERT INTO purchase_orders (po_number, supplier_id, user_id, subtotal, total_amount, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [poNumber, supplierId, userId || null, subtotal, subtotal, notes || null]
    )

    const orderId = result.lastInsertRowId

    for (const item of items) {
      await database.runAsync(
        'INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit, unit_cost, total_cost) VALUES (?, ?, ?, ?, ?, ?)',
        [orderId, item.productId, item.quantity, item.unit || 'piece', item.unitCost, item.quantity * item.unitCost]
      )
    }

    return orderId
  },

  async receive(orderId: number) {
    const database = getDatabase()
    if (!database) throw new Error('Database not initialized')

    // Update order status
    await database.runAsync(
      "UPDATE purchase_orders SET status = 'received', received_at = datetime('now') WHERE id = ?",
      [orderId]
    )

    // Get items and update stock
    const items = await database.getAllAsync<{ product_id: number, quantity: number }>(
      'SELECT product_id, quantity FROM purchase_order_items WHERE purchase_order_id = ?',
      [orderId]
    )

    for (const item of items) {
      // Check if stock entry exists
      const existing = await database.getFirstAsync<{ id: number, quantity: number }>(
        'SELECT id, quantity FROM stock_inventory WHERE product_id = ?',
        [item.product_id]
      )

      if (existing) {
        await database.runAsync(
          'UPDATE stock_inventory SET quantity = quantity + ? WHERE id = ?',
          [item.quantity, existing.id]
        )
      } else {
        await database.runAsync(
          'INSERT INTO stock_inventory (product_id, quantity) VALUES (?, ?)',
          [item.product_id, item.quantity]
        )
      }
    }

    return true
  }
}

// Transaction operations
/** One sellable size × colour, mirrored from the desktop (read-only on mobile). */
export interface ProductVariant {
  id: number
  product_id: number
  size: string
  color: string
  sku: string | null
  barcode: string | null
  retail_price: number | null
  sort_order: number
  stock_quantity: number
}

export const VariantService = {
  /** Active variants for a product, ordered S < M < L < XL (sort_order from desktop). */
  async forProduct(productId: number): Promise<ProductVariant[]> {
    const db = getDatabase()
    if (!db) return []
    return await db.getAllAsync(
      'SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, size, color',
      [productId]
    ) as ProductVariant[]
  },

  /** True when this product must be sold as a specific size/colour. */
  async hasVariants(productId: number): Promise<boolean> {
    const db = getDatabase()
    if (!db) return false
    const row = await db.getFirstAsync(
      'SELECT COUNT(*) AS n FROM product_variants WHERE product_id = ?', [productId]
    ) as { n: number } | null
    return (row?.n || 0) > 0
  }
}

export const TaxService = {
  async getRates(): Promise<Record<number, number>> {
    const db = getDatabase()
    if (!db) return {}
    const rows = await db.getAllAsync('SELECT id, rate FROM tax_categories') as { id: number; rate: number }[]
    const map: Record<number, number> = {}
    for (const r of rows) map[r.id] = r.rate
    return map
  },
  async getRegime(): Promise<string> {
    const db = getDatabase()
    if (!db) return 'reel'
    const r = await db.getFirstAsync("SELECT value FROM config WHERE key = 'regime'") as { value: string } | null
    return r?.value || 'reel'
  },
  async pricesIncludeTax(): Promise<boolean> {
    const db = getDatabase()
    if (!db) return false
    const r = await db.getFirstAsync("SELECT value FROM config WHERE key = 'prices_include_tax'") as { value: string } | null
    return r?.value === '1'
  }
}

export const ConfigService = {
  async get(key: string): Promise<string | null> {
    const db = getDatabase()
    if (!db) return null
    const r = await db.getFirstAsync('SELECT value FROM config WHERE key = ?', [key]) as { value: string } | null
    return r?.value ?? null
  }
}

export const TransactionService = {
  async create(data: {
    // `variant` is the chosen size/colour for a garment, null for a plain product.
    items: { product: any, quantity: number, variant?: ProductVariant | null }[],
    subtotal: number,
    total: number,
    discount: number,
    paid: number,
    change: number,
    userId: number,
    customerId?: number
  }) {
    const db = getDatabase()
    if (!db) throw new Error('Database not initialized')

    const txNumber = `TX-${Date.now()}`

    // Compute per-line TVA, mirroring desktop: IFU regime → 0%; TTC pricing → split HT out of gross.
    const rateMap = await TaxService.getRates()
    const ifu = (await TaxService.getRegime()) === 'ifu'
    const ttc = await TaxService.pricesIncludeTax()
    let subtotal = 0
    let rawTax = 0
    const lines = data.items.map(item => {
      const rate = ifu ? 0 : (rateMap[item.product.tax_category_id] ?? 0)
      const gross = item.product.retail_price * item.quantity
      let ht: number, tax: number
      if (!rate) { ht = gross; tax = 0 }
      else if (ttc) { ht = gross / (1 + rate / 100); tax = gross - ht }
      else { ht = gross; tax = ht * rate / 100 }
      subtotal += ht
      rawTax += tax
      return { item, rate, tax, ht }
    })
    const discount = data.discount || 0
    const taxableRatio = subtotal > 0 ? Math.max(0, subtotal - discount) / subtotal : 1
    const taxAmount = rawTax * taxableRatio
    const total = (subtotal - discount) + taxAmount
    const paid = data.paid ?? total

    // Create transaction (TTC total, with TVA)
    const result = await db.runAsync(`
      INSERT INTO transactions(
      transaction_number, user_id, customer_id, subtotal, discount_amount, tax_amount, total_amount,
      amount_paid, change_due, sync_status
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `, [
      txNumber, data.userId, data.customerId || null, subtotal, discount, taxAmount, total,
      paid, data.change
    ])

    const txId = result.lastInsertRowId

    // Insert Items (with per-line TVA) and Update Stock
    for (const ln of lines) {
      const variant = ln.item.variant || null
      const label = variant ? [variant.size, variant.color].filter(Boolean).join(' / ') : ''
      await db.runAsync(`
        INSERT INTO transaction_items(
        transaction_id, product_id, variant_id, product_name, quantity, unit_price, tax_rate, tax_amount, line_total
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
        txId, ln.item.product.id, variant?.id ?? null,
        label ? `${ln.item.product.name} (${label})` : ln.item.product.name,
        ln.item.quantity, ln.item.product.retail_price, ln.rate, ln.tax, ln.ht
      ])

      // Target the sold size/colour. A variant-blind "WHERE product_id = ?" would
      // decrement every size of the garment for a single sale.
      if (variant) {
        await db.runAsync(`UPDATE stock_inventory SET quantity = quantity - ? WHERE product_id = ? AND variant_id = ?`,
          [ln.item.quantity, ln.item.product.id, variant.id])
        await db.runAsync(`UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ?`,
          [ln.item.quantity, variant.id])
      } else {
        await db.runAsync(`UPDATE stock_inventory SET quantity = quantity - ? WHERE product_id = ? AND variant_id IS NULL`,
          [ln.item.quantity, ln.item.product.id])
      }
    }

    // Insert Payment (Assume Cash for now or split later)
    await db.runAsync(`
      INSERT INTO payments(transaction_id, payment_method, amount) VALUES(?, ?, ?)
    `, [txId, 'cash', paid])

    return { id: txId, transaction_number: txNumber }
  },

  async holdTransaction(userId: number, items: any[], subtotal: number, customerId?: number, holdName?: string) {
    const db = getDatabase()
    if (!db) throw new Error('Database not initialized')
    return db.runAsync(`
      INSERT INTO held_transactions (user_id, customer_id, hold_name, items_json, subtotal)
      VALUES (?, ?, ?, ?, ?)
    `, [userId, customerId || null, holdName || null, JSON.stringify(items), subtotal])
  },

  async getHeldTransactions(userId?: number) {
    const db = getDatabase()
    if (!db) throw new Error('Database not initialized')
    if (userId) {
      return db.getAllAsync('SELECT * FROM held_transactions WHERE user_id = ? ORDER BY created_at DESC', [userId])
    }
    return db.getAllAsync('SELECT * FROM held_transactions ORDER BY created_at DESC')
  },

  async retrieveHeldTransaction(heldId: number) {
    const db = getDatabase()
    if (!db) throw new Error('Database not initialized')
    const held = await db.getFirstAsync<{ id: number, items_json: string }>('SELECT * FROM held_transactions WHERE id = ?', [heldId])
    if (held) {
      await db.runAsync('DELETE FROM held_transactions WHERE id = ?', [heldId])
    }
    return held
  }
}
