import { getDatabase } from './database'

export interface StockMovement {
    id: number
    product_id: number
    variant_id: number | null
    movement_type: 'in' | 'out' | 'adjustment' | 'transfer'
    quantity: number
    reason: string | null
    user_id: number | null
    notes: string | null
    created_at: string
}

export const StockService = {
    // Get current stock for a product
    async getStock(productId: number, variantId?: number) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        const sql = variantId
            ? 'SELECT quantity FROM stock_inventory WHERE product_id = ? AND variant_id = ?'
            : 'SELECT quantity FROM stock_inventory WHERE product_id = ? AND variant_id IS NULL'
        const params = variantId ? [productId, variantId] : [productId]
        const result = await db.getFirstAsync(sql, params) as { quantity: number } | null
        return result?.quantity ?? 0
    },

    // Adjust stock
    async adjustStock(
        productId: number,
        quantity: number,
        type: 'in' | 'out' | 'adjustment',
        userId: number,
        reason?: string,
        notes?: string,
        variantId?: number
    ) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        const currentStock = await this.getStock(productId, variantId)
        const newStock = type === 'out' ? currentStock - Math.abs(quantity) : currentStock + Math.abs(quantity)

        if (newStock < 0) {
            throw new Error('Insufficient stock')
        }

        // Update stock
        const updateSql = variantId
            ? "UPDATE stock_inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ? AND variant_id = ?"
            : "UPDATE stock_inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ? AND variant_id IS NULL"

        const updateParams = variantId ? [newStock, productId, variantId] : [newStock, productId]
        const result = await db.runAsync(updateSql, updateParams)

        // Insert if not exists
        if (result.changes === 0) {
            await db.runAsync(
                'INSERT INTO stock_inventory (product_id, variant_id, quantity) VALUES (?, ?, ?)',
                [productId, variantId || null, newStock]
            )
        }

        // Record movement
        await db.runAsync(`
      INSERT INTO stock_movements (product_id, variant_id, movement_type, quantity, reason, user_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
            productId,
            variantId || null,
            type,
            type === 'out' ? -Math.abs(quantity) : Math.abs(quantity),
            reason || null,
            userId,
            notes || null
        ])

        return newStock
    },

    // Get movement history
    async getMovementHistory(productId: number, limit: number = 50) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        return db.getAllAsync(`
      SELECT * FROM stock_movements 
      WHERE product_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `, [productId, limit]) as Promise<StockMovement[]>
    },

    // Get low stock products
    async getLowStockProducts() {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        return db.getAllAsync(`
      SELECT p.*, COALESCE(si.quantity, 0) as current_stock
      FROM products p
      LEFT JOIN stock_inventory si ON p.id = si.product_id AND si.variant_id IS NULL
      WHERE p.is_active = 1 
        AND COALESCE(si.quantity, 0) <= p.min_stock_level
        AND p.min_stock_level > 0
      ORDER BY COALESCE(si.quantity, 0) ASC
    `)
    }
}
