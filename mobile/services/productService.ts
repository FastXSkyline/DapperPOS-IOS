import { getDatabase } from './database'

// Types
export interface Product {
    id: number
    sku: string | null
    barcode: string | null
    name: string
    category_id: number | null
    supplier_id: number | null
    tax_category_id: number
    cost_price: number
    retail_price: number
    min_stock_level: number
    lead_time_days: number
    is_active: number
    category_name?: string
    supplier_name?: string
    stock_quantity?: number
}

export interface Category {
    id: number
    name: string
    parent_id: number | null
    icon: string | null
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
    is_active: number
}

// Product Service
export const ProductService = {
    async getAll(filters?: { categoryId?: number; supplierId?: number; search?: string; limit?: number; offset?: number }) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        let sql = `
      SELECT p.*, 
             c.name as category_name, 
             s.company_name as supplier_name,
             COALESCE(si.quantity, 0) as stock_quantity
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      LEFT JOIN stock_inventory si ON p.id = si.product_id AND si.variant_id IS NULL
      WHERE p.is_active = 1
    `
        const params: any[] = []

        if (filters?.categoryId) {
            sql += ' AND p.category_id = ?'
            params.push(filters.categoryId)
        }
        if (filters?.supplierId) {
            sql += ' AND p.supplier_id = ?'
            params.push(filters.supplierId)
        }
        if (filters?.search) {
            sql += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)'
            const searchTerm = `%${filters.search}%`
            params.push(searchTerm, searchTerm, searchTerm)
        }

        sql += ' ORDER BY p.name ASC'

        if (filters?.limit) {
            sql += ` LIMIT ${filters.limit}`
            if (filters?.offset) {
                sql += ` OFFSET ${filters.offset}`
            }
        }

        return db.getAllAsync(sql, params) as Promise<Product[]>
    },

    async getById(id: number) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        const sql = `
      SELECT p.*, 
             c.name as category_name, 
             s.company_name as supplier_name,
             COALESCE(si.quantity, 0) as stock_quantity
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      LEFT JOIN stock_inventory si ON p.id = si.product_id AND si.variant_id IS NULL
      WHERE p.id = ?
    `
        return db.getFirstAsync(sql, [id]) as Promise<Product | null>
    },

    async getByBarcode(barcode: string) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        const sql = `
      SELECT p.*, COALESCE(si.quantity, 0) as stock_quantity
      FROM products p
      LEFT JOIN stock_inventory si ON p.id = si.product_id AND si.variant_id IS NULL
      WHERE p.barcode = ? AND p.is_active = 1
    `
        return db.getFirstAsync(sql, [barcode]) as Promise<Product | null>
    },

    async create(product: Partial<Product>) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        const result = await db.runAsync(`
      INSERT INTO products (sku, barcode, name, category_id, supplier_id, 
                           tax_category_id, cost_price, retail_price, min_stock_level, 
                           lead_time_days, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            product.sku || null, product.barcode || null, product.name,
            product.category_id || null, product.supplier_id || null,
            product.tax_category_id || 1,
            product.cost_price || 0, product.retail_price || 0,
            product.min_stock_level || 0, product.lead_time_days || 1, product.is_active ?? 1
        ])

        // Initialize stock inventory
        if (result.lastInsertRowId) {
            await db.runAsync('INSERT INTO stock_inventory (product_id, quantity) VALUES (?, 0)', [result.lastInsertRowId])
        }

        return result
    },

    async update(id: number, product: Partial<Product>) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        const fields = Object.keys(product).filter(k =>
            !['id', 'created_at', 'category_name', 'supplier_name', 'stock_quantity'].includes(k)
        )
        const sql = `UPDATE products SET ${fields.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
        const values = [...fields.map(f => (product as any)[f]), id]
        return db.runAsync(sql, values)
    },

    async delete(id: number) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')
        return db.runAsync("UPDATE products SET is_active = 0, updated_at = datetime('now') WHERE id = ?", [id])
    },

    async getLowStock() {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        const sql = `
      SELECT p.*, COALESCE(si.quantity, 0) as stock_quantity
      FROM products p
      LEFT JOIN stock_inventory si ON p.id = si.product_id AND si.variant_id IS NULL
      WHERE p.is_active = 1 AND COALESCE(si.quantity, 0) <= p.min_stock_level
      ORDER BY si.quantity ASC
    `
        return db.getAllAsync(sql) as Promise<Product[]>
    }
}

// Category Service
export const CategoryService = {
    async getAll() {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')
        return db.getAllAsync('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order, name') as Promise<Category[]>
    },

    async getTree() {
        const categories = await this.getAll()
        const map = new Map<number, Category>()
        const roots: Category[] = []

        categories.forEach(cat => {
            cat.children = []
            map.set(cat.id, cat)
        })

        categories.forEach(cat => {
            if (cat.parent_id) {
                const parent = map.get(cat.parent_id)
                if (parent) parent.children!.push(cat)
            } else {
                roots.push(cat)
            }
        })

        return roots
    },

    async create(category: Partial<Category>) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')
        return db.runAsync(
            'INSERT INTO categories (name, parent_id, icon, sort_order, is_active) VALUES (?, ?, ?, ?, ?)',
            [category.name, category.parent_id || null, category.icon || null, category.sort_order || 0, category.is_active ?? 1]
        )
    },

    async delete(id: number) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')
        return db.runAsync("UPDATE categories SET is_active = 0, updated_at = datetime('now') WHERE id = ?", [id])
    }
}

// Supplier Service
export const SupplierService = {
    async getAll() {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')
        return db.getAllAsync('SELECT * FROM suppliers WHERE is_active = 1 ORDER BY company_name') as Promise<Supplier[]>
    },

    async create(supplier: Partial<Supplier>) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')
        return db.runAsync(
            'INSERT INTO suppliers (company_name, contact_name, phone, email, is_active) VALUES (?, ?, ?, ?, ?)',
            [supplier.company_name, supplier.contact_name || null, supplier.phone || null, supplier.email || null, supplier.is_active ?? 1]
        )
    },

    async delete(id: number) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')
        return db.runAsync("UPDATE suppliers SET is_active = 0, updated_at = datetime('now') WHERE id = ?", [id])
    }
}
