import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Manual path construction since we're outside Electron
const dbPath = path.join(process.env.APPDATA, 'desktop', 'pos-system.db');

console.log('Opening database at:', dbPath);

try {
    const db = new Database(dbPath);

    // Read the master data file
    const masterPath = './master_data.json';
    if (!fs.existsSync(masterPath)) {
        console.error('master_data.json not found!');
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
    const products = data.products || [];
    const suppliers = data.suppliers || [];

    console.log(`Found ${products.length} products and ${suppliers.length} suppliers to import.`);

    // Begin transaction
    db.exec('BEGIN TRANSACTION');

    // Import suppliers first
    const insertSupplier = db.prepare(`
        INSERT OR IGNORE INTO suppliers (company_name, contact_name, phone, email, address, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
    `);

    for (const s of suppliers) {
        insertSupplier.run(s.company_name, s.contact_name || null, s.phone || null, s.email || null, s.address || null);
    }
    console.log(`Imported ${suppliers.length} suppliers.`);

    // Build supplier lookup map
    const supplierMap = new Map();
    const allSuppliers = db.prepare('SELECT id, company_name FROM suppliers').all();
    for (const s of allSuppliers) {
        supplierMap.set(s.company_name.toLowerCase(), s.id);
    }

    // Build category lookup map  
    const categoryMap = new Map();
    const allCategories = db.prepare('SELECT id, name FROM categories').all();
    for (const c of allCategories) {
        categoryMap.set(c.name.toLowerCase(), c.id);
    }

    // Insert missing categories and update map
    const insertCategory = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
    for (const p of products) {
        if (p.category && !categoryMap.has(p.category.toLowerCase())) {
            insertCategory.run(p.category);
            const id = db.prepare('SELECT id FROM categories WHERE name = ?').get(p.category);
            if (id) categoryMap.set(p.category.toLowerCase(), id.id);
        }
    }

    // Import products
    const insertProduct = db.prepare(`
        INSERT OR IGNORE INTO products (name, retail_price, cost_price, category_id, supplier_id)
        VALUES (?, ?, ?, ?, ?)
    `);

    for (const p of products) {
        const categoryId = p.category ? categoryMap.get(p.category.toLowerCase()) : null;
        const supplierId = p.supplier ? supplierMap.get(p.supplier.toLowerCase()) : null;
        insertProduct.run(p.name, p.price || 0, p.cost_price || 0, categoryId, supplierId);
    }
    console.log(`Imported ${products.length} products.`);

    db.exec('COMMIT');
    console.log('Import completed successfully!');

    db.close();
} catch (err) {
    console.error('Failed to import data:', err);
}
