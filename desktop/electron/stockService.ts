import { getDatabase } from './database'

export interface StockMovement {
    id: number
    product_id: number
    variant_id: number | null
    movement_type: 'in' | 'out' | 'adjustment' | 'transfer'
    quantity: number
    reason: string | null
    reference_type: string | null
    reference_id: number | null
    batch_number: string | null
    expiration_date: string | null
    serial_number: string | null
    user_id: number | null
    notes: string | null
    created_at: string
    // Joined
    product_name?: string
}

export const StockService = {
    // Get current stock for a product
    getStock(productId: number, variantId?: number) {
        const db = getDatabase()
        const sql = variantId
            ? 'SELECT quantity FROM stock_inventory WHERE product_id = ? AND variant_id = ?'
            : 'SELECT quantity FROM stock_inventory WHERE product_id = ? AND variant_id IS NULL'
        const params = variantId ? [productId, variantId] : [productId]
        const result = db.prepare(sql).get(...params) as { quantity: number } | undefined
        return result?.quantity ?? 0
    },

    // Adjust stock (add or subtract)
    adjustStock(
        productId: number,
        quantity: number,
        type: 'in' | 'out' | 'adjustment',
        userId: number,
        reason?: string,
        notes?: string,
        variantId?: number
    ) {
        const db = getDatabase()

        // Get current stock
        const currentStock = this.getStock(productId, variantId)
        const newStock = type === 'out' ? currentStock - Math.abs(quantity) : currentStock + Math.abs(quantity)

        if (newStock < 0) {
            throw new Error('Insufficient stock')
        }

        // Update stock inventory
        const updateSql = variantId
            ? "UPDATE stock_inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ? AND variant_id = ?"
            : "UPDATE stock_inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ? AND variant_id IS NULL"

        const updateParams = variantId ? [newStock, productId, variantId] : [newStock, productId]
        const updateResult = db.prepare(updateSql).run(...updateParams)

        // If no row was updated, insert
        if (updateResult.changes === 0) {
            db.prepare('INSERT INTO stock_inventory (product_id, variant_id, quantity) VALUES (?, ?, ?)').run(
                productId, variantId || null, newStock
            )
        }

        // Record movement
        db.prepare(`
      INSERT INTO stock_movements (product_id, variant_id, movement_type, quantity, reason, user_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
            productId,
            variantId || null,
            type,
            type === 'out' ? -Math.abs(quantity) : Math.abs(quantity),
            reason || null,
            userId,
            notes || null
        )

        return newStock
    },

    // Receive stock from purchase order
    receiveStock(
        productId: number,
        quantity: number,
        purchaseOrderId: number,
        userId: number,
        batchNumber?: string,
        expirationDate?: string,
        variantId?: number
    ) {
        const db = getDatabase()

        // Update stock
        this.adjustStock(productId, quantity, 'in', userId, 'Purchase Order Received', undefined, variantId)

        // Record detailed movement with PO reference
        db.prepare(`
      UPDATE stock_movements 
      SET reference_type = 'purchase_order', reference_id = ?, batch_number = ?, expiration_date = ?
      WHERE id = (SELECT MAX(id) FROM stock_movements WHERE product_id = ?)
    `).run(purchaseOrderId, batchNumber || null, expirationDate || null, productId)
    },

    // Get movement history for a product
    getMovementHistory(productId: number, limit: number = 50) {
        const db = getDatabase()
        return db.prepare(`
      SELECT sm.*, p.name as product_name, u.name as user_name
      FROM stock_movements sm
      LEFT JOIN products p ON sm.product_id = p.id
      LEFT JOIN users u ON sm.user_id = u.id
      WHERE sm.product_id = ?
      ORDER BY sm.created_at DESC
      LIMIT ?
    `).all(productId, limit) as StockMovement[]
    },

    // Get all recent movements
    getRecentMovements(limit: number = 100) {
        const db = getDatabase()
        return db.prepare(`
      SELECT sm.*, p.name as product_name, u.name as user_name
      FROM stock_movements sm
      LEFT JOIN products p ON sm.product_id = p.id
      LEFT JOIN users u ON sm.user_id = u.id
      ORDER BY sm.created_at DESC
      LIMIT ?
    `).all(limit) as StockMovement[]
    },

    // Get low stock products.
    // Sums every stock_inventory row for the product (the base row for a plain product,
    // one per size×colour otherwise) — reading only the variant_id IS NULL row would
    // report 0 for every garment and flag them all as permanently low.
    getLowStockProducts() {
        const db = getDatabase()
        return db.prepare(`
      SELECT p.*, COALESCE(si.quantity, 0) as current_stock
      FROM products p
      LEFT JOIN (
        SELECT product_id, SUM(quantity) AS quantity
        FROM stock_inventory GROUP BY product_id
      ) si ON si.product_id = p.id
      WHERE p.is_active = 1
        AND COALESCE(si.quantity, 0) <= p.min_stock_level
        AND p.min_stock_level > 0
      ORDER BY COALESCE(si.quantity, 0) ASC
    `).all()
    }
}
