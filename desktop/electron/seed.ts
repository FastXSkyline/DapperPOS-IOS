import { getDatabase } from './database'

export function seedDatabase() {
    const db = getDatabase()

    // START BY CLEARING PREVIOUS SEEDED DATA (Avoid duplicates)
    try {
        db.prepare('DELETE FROM stock_movements').run()
        db.prepare('DELETE FROM stock_inventory').run()
        db.prepare('DELETE FROM transaction_items').run()
        db.prepare('DELETE FROM transactions').run()
        db.prepare('DELETE FROM products').run()
        db.prepare('DELETE FROM category_id > 5').run()
        db.prepare('DELETE FROM suppliers').run()
        db.prepare('DELETE FROM customers WHERE id > 1').run()
    } catch (e) {
        console.log('Cleanup before seed failed (likely first run):', e)
    }

    // Categories
    const categories = [
        { id: 1, name: 'Electrical', icon: '⚡' },
        { id: 2, name: 'Plumbing', icon: '🚰' },
        { id: 3, name: 'Hardware Tools', icon: '🛠️' },
        { id: 4, name: 'Safety Equipment', icon: '🦺' },
        { id: 5, name: 'Consumables', icon: '📦' }
    ]

    const insertCat = db.prepare('INSERT OR REPLACE INTO categories (id, name, icon) VALUES (?, ?, ?)')
    categories.forEach(c => insertCat.run(c.id, c.name, c.icon))

    const catRows = db.prepare('SELECT id, name FROM categories').all() as { id: number, name: string }[]
    const catMap = Object.fromEntries(catRows.map(r => [r.name, r.id]))


    // Suppliers
    const suppliers = ['Global Tools Ltd', 'Electric Pro Supply', 'Industrial Direct']
    const insertSup = db.prepare('INSERT OR IGNORE INTO suppliers (company_name) VALUES (?)')
    suppliers.forEach(s => insertSup.run(s))
    const supRows = db.prepare('SELECT id, company_name FROM suppliers').all() as { id: number, company_name: string }[]

    // Products
    const products = [
        { name: 'Hammer Drill 800W', sku: 'HD-800', price: 12500, cost: 9000, stock: 12, cat: 'Hardware Tools' },
        { name: 'Angle Grinder 4.5"', sku: 'AG-45', price: 8500, cost: 6200, stock: 8, cat: 'Hardware Tools' },
        { name: 'Screwdriver Set (12pc)', sku: 'SD-SET', price: 2400, cost: 1500, stock: 25, cat: 'Hardware Tools' },
        { name: 'Copper Cable 2.5mm (100m)', sku: 'CAB-25', price: 7500, cost: 5800, stock: 15, cat: 'Electrical' },
        { name: 'Circuit Breaker 16A', sku: 'CB-16', price: 850, cost: 450, stock: 50, cat: 'Electrical' },
        { name: 'PVC Pipe 32mm (4m)', sku: 'PVC-32', price: 1200, cost: 700, stock: 40, cat: 'Plumbing' },
        { name: 'Water Pump 1HP', sku: 'WP-1', price: 18500, cost: 14000, stock: 5, cat: 'Plumbing' },
        { name: 'Safety Helmet', sku: 'SAF-01', price: 1800, cost: 1100, stock: 20, cat: 'Safety Equipment' },
        { name: 'Work Gloves (Leather)', sku: 'SAF-02', price: 650, cost: 350, stock: 100, cat: 'Safety Equipment' },
        { name: 'WD-40 Spray 400ml', sku: 'CONS-01', price: 1100, cost: 750, stock: 30, cat: 'Consumables' },
        { name: 'Duct Tape (Silver)', sku: 'CONS-02', price: 450, cost: 250, stock: 60, cat: 'Consumables' }
    ]

    const insertProd = db.prepare(`
        INSERT OR IGNORE INTO products (
            name, sku, category_id, supplier_id, cost_price, retail_price, min_stock_level, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `)

    const insertStock = db.prepare('INSERT OR REPLACE INTO stock_inventory (product_id, quantity) VALUES (?, ?)')

    products.forEach(p => {
        const result = insertProd.run(
            p.name, p.sku, catMap[p.cat], supRows[0].id,
            p.cost, p.price, 5
        )
        if (result.lastInsertRowid) {
            insertStock.run(result.lastInsertRowid, p.stock)
        }
    })

    // Transactions (Dummy data for reports)
    const txns = [
        { date: "date('now', '-2 days')", total: 25000, items: 3 },
        { date: "date('now', '-1 days')", total: 42000, items: 5 },
        { date: "date('now')", total: 15500, items: 2 },
    ]

    const insertTxn = db.prepare(`
        INSERT INTO transactions (transaction_number, user_id, status, total_amount, subtotal, discount_amount, payment_status, created_at)
        VALUES (?, 1, 'completed', ?, ?, 0, 'paid', ?)
    `)

    const insertTi = db.prepare(`
        INSERT INTO transaction_items (transaction_id, product_id, product_name, quantity, unit_price, line_total)
        VALUES (?, ?, ?, ?, ?, ?)
    `)

    const prodRows = db.prepare('SELECT id, name, retail_price FROM products LIMIT 5').all() as any[]

    txns.forEach((t, i) => {
        const txnNum = `TXN-SEED-${i}`
        const dateVal = db.prepare(`SELECT ${t.date} as d`).get() as any
        const result = insertTxn.run(txnNum, t.total, t.total, dateVal.d)
        const txnId = result.lastInsertRowid

        prodRows.forEach(p => {
            insertTi.run(txnId, p.id, p.name, 1, p.retail_price, p.retail_price)
        })
    })

    console.log('Database cleared and re-seeded successfully with demo transactions!')
    return true
}
