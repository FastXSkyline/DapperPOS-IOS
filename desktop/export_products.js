import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Manual path construction since we're outside Electron
const dbPath = path.join(process.env.APPDATA, 'desktop', 'pos-system.db');

console.log('Opening database at:', dbPath);

try {
    const db = new Database(dbPath, { readonly: true });

    // Get products with categories and suppliers
    const products = db.prepare(`
        SELECT p.name, p.retail_price as price, p.cost_price,
               c.name as category, s.company_name as supplier
        FROM products p 
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN suppliers s ON p.supplier_id = s.id
    `).all();

    console.log(`Extracted ${products.length} products from database.`);

    // Get suppliers
    const suppliers = db.prepare(`
        SELECT company_name, contact_name, phone, email, address
        FROM suppliers
        WHERE is_active = 1
    `).all();

    console.log(`Extracted ${suppliers.length} suppliers from database.`);

    // Read the existing master file to merge
    const masterPath = './master_data.json';
    let existingData = { products: [], suppliers: [] };
    if (fs.existsSync(masterPath)) {
        existingData = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
        console.log(`Found ${existingData.products?.length || 0} existing products, ${existingData.suppliers?.length || 0} existing suppliers.`);
    }

    // Merge products (avoid duplicates by name)
    const existingProductNames = new Set((existingData.products || []).map(p => p.name.toLowerCase()));
    const allProducts = [...(existingData.products || [])];
    for (const p of products) {
        if (!existingProductNames.has(p.name.toLowerCase())) {
            allProducts.push(p);
        }
    }

    // Merge suppliers (avoid duplicates by company_name)
    const existingSupplierNames = new Set((existingData.suppliers || []).map(s => s.company_name.toLowerCase()));
    const allSuppliers = [...(existingData.suppliers || [])];
    for (const s of suppliers) {
        if (!existingSupplierNames.has(s.company_name.toLowerCase())) {
            allSuppliers.push(s);
        }
    }

    const masterData = {
        products: allProducts,
        suppliers: allSuppliers
    };

    console.log(`Total unique products: ${allProducts.length}`);
    console.log(`Total unique suppliers: ${allSuppliers.length}`);

    fs.writeFileSync(masterPath, JSON.stringify(masterData, null, 2));
    console.log('master_data.json has been created with products and suppliers.');

    db.close();
} catch (err) {
    console.error('Failed to export data:', err);
}
