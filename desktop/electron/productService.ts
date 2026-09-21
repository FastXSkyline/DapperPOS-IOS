import { getDatabase } from './database'
// import type Database from 'better-sqlite3'

// Types
import type { Product, Category, Supplier, ProductVariant } from '../shared/types'

/**
 * Columns inherited from the retired electrical-distributor domain (PROJECT.md §1).
 * `create()` already defaults every one of them, so requiring callers to pass them
 * only forced new code — the AI capability registry, for one — to invent values for
 * columns nothing reads any more.
 */
type LegacyProductFields =
    'devation' | 'designation_fournisseur' | 'reference' | 'marque'
    | 'qtes_cmnds' | 'delai_livraison' | 'unite'

export type NewProduct =
    Omit<Product, 'id' | 'created_at' | 'updated_at' | 'category_name' | 'supplier_name' | LegacyProductFields>
    & Partial<Pick<Product, LegacyProductFields>>

export type { Product, Category, Supplier, ProductVariant }

// A product's sellable stock is the SUM of its stock_inventory rows: the base row
// (variant_id IS NULL) for a plain product, or one row per size×colour variant.
// Summing covers both shapes, so callers never branch on whether variants exist.
const STOCK_SUM_JOIN = `
      LEFT JOIN (
        SELECT product_id, SUM(quantity) AS quantity
        FROM stock_inventory GROUP BY product_id
      ) si ON si.product_id = p.id`

// has_variants is derived, never stored — Migration 7 strips any such column from products.
const HAS_VARIANTS_EXPR = `EXISTS(SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1) AS has_variants`

// Composite key for matching a variant by its natural key (size, colour).
// JSON-encoded rather than concatenated: a plain separator would let
// ("M", "Bleu ciel") and ("M Bleu", "ciel") collide.
function variantKey(size: string, color: string): string {
    return JSON.stringify([size, color])
}

// Absolute-set one variant's stock and record the delta as a movement.
// The caller owns the transaction so a whole matrix save commits atomically.
function setVariantQuantity(db: ReturnType<typeof getDatabase>, productId: number, variantId: number, quantity: number) {
    const row = db.prepare('SELECT quantity FROM stock_inventory WHERE variant_id = ?').get(variantId) as { quantity: number } | undefined
    const diff = quantity - (row?.quantity || 0)
    if (diff === 0) return

    if (row === undefined) {
        db.prepare("INSERT INTO stock_inventory (product_id, variant_id, quantity, updated_at) VALUES (?, ?, ?, datetime('now'))").run(productId, variantId, quantity)
    } else {
        db.prepare("UPDATE stock_inventory SET quantity = ?, updated_at = datetime('now') WHERE variant_id = ?").run(quantity, variantId)
    }
    db.prepare(`INSERT INTO stock_movements (product_id, variant_id, movement_type, quantity, reason) VALUES (?, ?, 'adjustment', ?, 'Variant stock adjustment')`).run(productId, variantId, diff)
}

// Product Service
export const ProductService = {
    // Get all products with optional filters
    getAll(filters?: { categoryId?: number; supplierId?: number; search?: string; limit?: number; offset?: number; lowStock?: boolean }) {
        const db = getDatabase()
        let sql = `
      SELECT p.*,
             c.name as category_name,
             s.company_name as supplier_name,
             COALESCE(si.quantity, 0) as stock_quantity,
             ${HAS_VARIANTS_EXPR}
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN suppliers s ON p.supplier_id = s.id${STOCK_SUM_JOIN}
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
            sql += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ? OR p.marque LIKE ? OR p.reference LIKE ?)'
            const searchTerm = `%${filters.search}%`
            params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm)
        }
        if (filters?.lowStock) {
            sql += ' AND COALESCE(si.quantity, 0) <= p.min_stock_level'
        }

        sql += ' ORDER BY p.name ASC'

        if (filters?.limit) {
            sql += ' LIMIT ?'
            params.push(filters.limit)
            if (filters?.offset) {
                sql += ' OFFSET ?'
                params.push(filters.offset)
            }
        }

        return db.prepare(sql).all(...params) as Product[]
    },

    // Get single product by ID
    getById(id: number) {
        const db = getDatabase()
        const sql = `
      SELECT p.*,
             c.name as category_name,
             s.company_name as supplier_name,
             COALESCE(si.quantity, 0) as stock_quantity,
             ${HAS_VARIANTS_EXPR}
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN suppliers s ON p.supplier_id = s.id${STOCK_SUM_JOIN}
      WHERE p.id = ?
    `
        return db.prepare(sql).get(id) as Product | undefined
    },

    // Get by barcode
    getByBarcode(barcode: string) {
        const db = getDatabase()
        // Phase 1 decision: one shared barcode per product. Scanning resolves to the
        // product; the till then prompts for size/colour when has_variants is 1.
        const sql = `
      SELECT p.*, COALESCE(si.quantity, 0) as stock_quantity,
             ${HAS_VARIANTS_EXPR}
      FROM products p${STOCK_SUM_JOIN}
      WHERE p.barcode = ? AND p.is_active = 1
    `
        return db.prepare(sql).get(barcode) as Product | undefined
    },

    // Create product
    create(product: NewProduct) {
        const db = getDatabase()
        const sql = `
      INSERT INTO products (sku, barcode, name, category_id, supplier_id,
                           tax_category_id, cost_price, retail_price, wholesale_price, semi_wholesale_price, min_stock_level, lead_time_days, is_active,
                           reference, marque, devation, designation_fournisseur, unite, qtes_cmnds, delai_livraison)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
        const result = db.prepare(sql).run(
            product.sku, product.barcode, product.name,
            product.category_id, product.supplier_id, product.tax_category_id,
            product.cost_price, product.retail_price,
            (product as any).wholesale_price || 0, (product as any).semi_wholesale_price || 0,
            product.min_stock_level, product.lead_time_days, product.is_active,
            product.reference || null, product.marque || null, product.devation || null,
            product.designation_fournisseur || null, product.unite || 'piece',
            product.qtes_cmnds || 0, product.delai_livraison || 0
        )

        // Initialize stock inventory
        // If stock_quantity is passed in the product object (from UI), use it. Otherwise 0.
        const initialStock = (product as any).initial_stock || 0

        if (result.lastInsertRowid) {
            db.prepare('INSERT INTO stock_inventory (product_id, quantity) VALUES (?, ?)').run(result.lastInsertRowid, initialStock)
        }

        return result
    },

    // Update product
    update(id: number, product: Partial<Product>) {
        const db = getDatabase()
        // strict whitelist of columns to avoid "no such column" errors
        const validColumns = [
            'sku', 'barcode', 'name',
            'category_id', 'supplier_id', 'tax_category_id',
            'cost_price', 'retail_price', 'wholesale_price', 'semi_wholesale_price',
            'min_stock_level',
            'lead_time_days',
            'is_active',
            // New inventory fields
            'reference', 'marque', 'devation', 'designation_fournisseur',
            'unite', 'qtes_cmnds', 'delai_livraison'
        ]

        const fields = Object.keys(product).filter(k => validColumns.includes(k))
        if (fields.length === 0) return { changes: 0 }

        const sql = `UPDATE products SET ${fields.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
        const values = fields.map(f => (product as any)[f])
        return db.prepare(sql).run(...values, id)
    },

    // Update stock quantity directly (the product's own base row — variant_id IS NULL).
    // For a product WITH variants, stock is per size×colour: use updateVariantStock instead,
    // otherwise the quantity would land on the base row and never be sellable.
    updateStock(productId: number, quantity: number) {
        const db = getDatabase()
        const current = db.prepare('SELECT quantity FROM stock_inventory WHERE product_id = ? AND variant_id IS NULL').get(productId) as { quantity: number } | undefined
        const diff = quantity - (current?.quantity || 0)

        if (diff !== 0) {
            db.transaction(() => {
                if (current === undefined) {
                    // No base row yet (legacy/imported product) — create it rather than
                    // silently updating zero rows.
                    db.prepare("INSERT INTO stock_inventory (product_id, variant_id, quantity, updated_at) VALUES (?, NULL, ?, datetime('now'))").run(productId, quantity)
                } else {
                    db.prepare("UPDATE stock_inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ? AND variant_id IS NULL").run(quantity, productId)
                }
                db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, reason, created_at) VALUES (?, 'adjustment', ?, 'Manual Adjustment', datetime('now'))`).run(productId, diff)
            })()
        }
        return { changes: 1 }
    },

    // Delete (soft delete)
    delete(id: number) {
        const db = getDatabase()
        return db.prepare("UPDATE products SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(id)
    },

    // --- Size × colour variants (Dapper Phase 1) ---

    /** Active variants for a product with their own stock, ordered S < M < L < XL. */
    getVariants(productId: number) {
        const db = getDatabase()
        return db.prepare(`
            SELECT pv.*, COALESCE(si.quantity, 0) AS stock_quantity
            FROM product_variants pv
            LEFT JOIN stock_inventory si ON si.variant_id = pv.id
            WHERE pv.product_id = ? AND pv.is_active = 1
            ORDER BY pv.sort_order, pv.size, pv.color
        `).all(productId) as ProductVariant[]
    },

    /**
     * Save the full size×colour matrix for a product.
     *
     * Upserts on the natural key (size, color) rather than the DELETE+INSERT used by
     * setUnits/setSuppliers: transaction_items.variant_id and stock_movements.variant_id
     * point at these rows and stock_inventory cascades on delete, so recreating rows would
     * orphan sale history and wipe stock. Combinations the user removes are deactivated,
     * never dropped.
     *
     * `quantity` is optional per entry — provided syncs that variant's stock (with an audit
     * movement for the delta); omitted leaves stock untouched.
     */
    setVariants(productId: number, variants: { size?: string; color?: string; quantity?: number; sku?: string | null; barcode?: string | null; cost_price?: number | null; retail_price?: number | null; sort_order?: number }[]) {
        const db = getDatabase()

        db.transaction(() => {
            const existing = db.prepare('SELECT id, size, color, is_active FROM product_variants WHERE product_id = ?').all(productId) as { id: number; size: string; color: string; is_active: number }[]
            // 0000 separator: can't occur in a size or colour, so the key is unambiguous.
            const byKey = new Map(existing.map(v => [variantKey(v.size, v.color), v]))
            const keptIds = new Set<number>()

            variants.forEach((v, index) => {
                const size = (v.size || '').trim()
                const color = (v.color || '').trim()
                // Neither axis set = the product itself, not a variant. Skip.
                if (!size && !color) return

                const prior = byKey.get(variantKey(size, color))
                const sortOrder = v.sort_order ?? index
                let variantId: number

                if (prior) {
                    // Reactivates the row if it had been soft-deleted earlier.
                    variantId = prior.id
                    db.prepare(`UPDATE product_variants SET sku = ?, barcode = ?, cost_price = ?, retail_price = ?, sort_order = ?, is_active = 1, updated_at = datetime('now') WHERE id = ?`)
                        .run(v.sku ?? null, v.barcode ?? null, v.cost_price ?? null, v.retail_price ?? null, sortOrder, variantId)
                } else {
                    const res = db.prepare(`INSERT INTO product_variants (product_id, size, color, sku, barcode, cost_price, retail_price, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                        .run(productId, size, color, v.sku ?? null, v.barcode ?? null, v.cost_price ?? null, v.retail_price ?? null, sortOrder)
                    variantId = res.lastInsertRowid as number
                    db.prepare("INSERT INTO stock_inventory (product_id, variant_id, quantity, updated_at) VALUES (?, ?, 0, datetime('now'))").run(productId, variantId)
                }
                keptIds.add(variantId)

                if (typeof v.quantity === 'number' && Number.isFinite(v.quantity)) {
                    setVariantQuantity(db, productId, variantId, v.quantity)
                }
            })

            // Combinations the user dropped: deactivate, keeping the row and its history.
            for (const v of existing) {
                if (!keptIds.has(v.id) && v.is_active === 1) {
                    db.prepare("UPDATE product_variants SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(v.id)
                }
            }

            // Once stock lives per-variant, anything left on the base row would count toward
            // the product total while being unsellable at the till — drain it, with an audit row.
            if (keptIds.size > 0) {
                const base = db.prepare('SELECT quantity FROM stock_inventory WHERE product_id = ? AND variant_id IS NULL').get(productId) as { quantity: number } | undefined
                if (base && base.quantity !== 0) {
                    db.prepare("UPDATE stock_inventory SET quantity = 0, updated_at = datetime('now') WHERE product_id = ? AND variant_id IS NULL").run(productId)
                    db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, reason) VALUES (?, 'adjustment', ?, 'Stock moved to size/colour variants')`).run(productId, -base.quantity)
                }
            }
        })()

        return { success: true }
    },

    /** Set a single variant's stock to an absolute quantity (used by the stock grid). */
    updateVariantStock(variantId: number, quantity: number) {
        const db = getDatabase()
        const variant = db.prepare('SELECT product_id FROM product_variants WHERE id = ?').get(variantId) as { product_id: number } | undefined
        if (!variant) return { changes: 0 }

        db.transaction(() => {
            setVariantQuantity(db, variant.product_id, variantId, quantity)
        })()
        return { changes: 1 }
    },

    // --- Colisage / packaging units (Phase 4.4) ---
    getUnits(productId: number) {
        const db = getDatabase()
        return db.prepare('SELECT * FROM product_units WHERE product_id = ? ORDER BY factor ASC').all(productId) as { id: number; product_id: number; name: string; factor: number; barcode: string | null }[]
    },
    // Replace the full packaging set for a product (idempotent save from the form).
    setUnits(productId: number, units: { name: string; factor: number; barcode?: string | null }[]) {
        const db = getDatabase()
        db.transaction(() => {
            db.prepare('DELETE FROM product_units WHERE product_id = ?').run(productId)
            const ins = db.prepare('INSERT INTO product_units (product_id, name, factor, barcode) VALUES (?, ?, ?, ?)')
            for (const u of units) {
                if (u.name && u.factor > 0) ins.run(productId, u.name, u.factor, u.barcode || null)
            }
        })()
        return { success: true }
    },

    // --- Multi-supplier per article (Phase 4.5) ---
    getSuppliers(productId: number) {
        const db = getDatabase()
        return db.prepare(`
            SELECT ps.*, s.company_name AS supplier_name
            FROM product_suppliers ps
            LEFT JOIN suppliers s ON s.id = ps.supplier_id
            WHERE ps.product_id = ?
            ORDER BY ps.is_preferred DESC, s.company_name
        `).all(productId) as any[]
    },
    setSuppliers(productId: number, list: { supplier_id: number; supplier_ref?: string | null; cost_price?: number; lead_time_days?: number; is_preferred?: boolean }[]) {
        const db = getDatabase()
        db.transaction(() => {
            db.prepare('DELETE FROM product_suppliers WHERE product_id = ?').run(productId)
            const ins = db.prepare('INSERT INTO product_suppliers (product_id, supplier_id, supplier_ref, cost_price, lead_time_days, is_preferred) VALUES (?, ?, ?, ?, ?, ?)')
            for (const s of list) {
                if (s.supplier_id) ins.run(productId, s.supplier_id, s.supplier_ref || null, s.cost_price || 0, s.lead_time_days || 0, s.is_preferred ? 1 : 0)
            }
        })()
        return { success: true }
    },

    // Get low stock products
    getLowStock() {
        const db = getDatabase()
        const sql = `
      SELECT p.*, COALESCE(si.quantity, 0) as stock_quantity,
             ${HAS_VARIANTS_EXPR}
      FROM products p${STOCK_SUM_JOIN}
      WHERE p.is_active = 1 AND COALESCE(si.quantity, 0) <= p.min_stock_level
      ORDER BY COALESCE(si.quantity, 0) ASC
    `
        return db.prepare(sql).all() as Product[]
    },

    // Get products count
    getCount(filters?: { categoryId?: number; search?: string; lowStock?: boolean }) {
        const db = getDatabase()
        let sql = 'SELECT COUNT(*) as count FROM products WHERE is_active = 1'
        const params: any[] = []

        if (filters?.categoryId) {
            sql += ' AND category_id = ?'
            params.push(filters.categoryId)
        }
        if (filters?.search) {
            sql += ' AND (name LIKE ? OR sku LIKE ? OR barcode LIKE ?)'
            const searchTerm = `%${filters.search}%`
            params.push(searchTerm, searchTerm, searchTerm)
        }
        if (filters?.lowStock) {
            // Compare the product's TOTAL stock (summed across variants) to its threshold,
            // matching getAll/getLowStock — a per-row compare would flag every small variant.
            sql += ` AND id IN (
                SELECT product_id FROM stock_inventory
                GROUP BY product_id
                HAVING SUM(quantity) <= (SELECT min_stock_level FROM products WHERE id = product_id)
            )`
        }

        const result = db.prepare(sql).get(...params) as { count: number }
        return result.count
    }
}

// Category Service
export const CategoryService = {
    getAll() {
        const db = getDatabase()
        return db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order, name').all() as Category[]
    },

    getTree() {
        const categories = this.getAll()
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

    create(category: Omit<Category, 'id' | 'children'>) {
        const db = getDatabase()
        return db.prepare('INSERT INTO categories (name, parent_id, icon, image_path, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?)').run(
            category.name, category.parent_id, category.icon, category.image_path, category.sort_order, category.is_active
        )
    },

    update(id: number, category: Partial<Category>) {
        const db = getDatabase()
        // Whitelist: these column names are interpolated into the SQL, and this is now
        // reachable from the renderer over IPC — an unfiltered Object.keys() would let a
        // crafted payload inject. Mirrors the same guard in ProductService.update.
        const validColumns = ['name', 'parent_id', 'icon', 'image_path', 'sort_order', 'is_active']
        const fields = Object.keys(category).filter(k => validColumns.includes(k))
        if (fields.length === 0) return { changes: 0 }

        const sql = `UPDATE categories SET ${fields.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
        const values = fields.map(f => (category as any)[f])
        return db.prepare(sql).run(...values, id)
    },

    delete(id: number) {
        const db = getDatabase()
        return db.prepare("UPDATE categories SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(id)
    }
}

// Supplier Service
export const SupplierService = {
    getAll() {
        const db = getDatabase()
        return db.prepare('SELECT * FROM suppliers WHERE is_active = 1 ORDER BY company_name').all() as Supplier[]
    },

    getById(id: number) {
        const db = getDatabase()
        return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as Supplier | undefined
    },

    create(supplier: Omit<Supplier, 'id'>) {
        const db = getDatabase()
        return db.prepare(`
      INSERT INTO suppliers (company_name, contact_name, phone, email, website, address, city, country, 
                            tax_id, payment_terms, credit_limit, lead_time_days, rating, notes, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
            supplier.company_name, supplier.contact_name, supplier.phone, supplier.email, supplier.website,
            supplier.address, supplier.city, supplier.country, supplier.tax_id, supplier.payment_terms,
            supplier.credit_limit, supplier.lead_time_days, supplier.rating, supplier.notes, supplier.is_active
        )
    },

    update(id: number, supplier: Partial<Supplier>) {
        const db = getDatabase()
        const fields = Object.keys(supplier).filter(k => k !== 'id')
        const sql = `UPDATE suppliers SET ${fields.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
        const values = fields.map(f => (supplier as any)[f])
        return db.prepare(sql).run(...values, id)
    },

    delete(id: number) {
        const db = getDatabase()
        return db.prepare("UPDATE suppliers SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(id)
    }
}
