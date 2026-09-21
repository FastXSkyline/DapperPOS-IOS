import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Path to the desktop database
const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'desktop', 'pos-system.db');
const masterPath = './master_data.json';

const args = process.argv.slice(2);
const command = args[0] || 'export';

console.log(`[MasterIO] Running ${command} mode...`);
console.log(`[MasterIO] Database Path: ${dbPath}`);

async function run() {
    try {
        const db = new Database(dbPath);

        if (command === 'export') {
            // 1. Export Suppliers
            const suppliers = db.prepare('SELECT company_name, contact_name, phone, email, address, city, country, tax_id FROM suppliers WHERE is_active = 1').all();

            // 2. Export Products
            const products = db.prepare(`
                SELECT p.name, p.retail_price as price, p.cost_price, 
                       c.name as category, s.company_name as supplier
                FROM products p 
                LEFT JOIN categories c ON p.category_id = c.id
                LEFT JOIN suppliers s ON p.supplier_id = s.id
            `).all();

            const data = {
                suppliers,
                products,
                exported_at: new Date().toISOString()
            };

            fs.writeFileSync(masterPath, JSON.stringify(data, null, 2));
            console.log(`[MasterIO] Exported ${products.length} products and ${suppliers.length} suppliers to ${masterPath}`);

        } else if (command === 'import') {
            if (!fs.existsSync(masterPath)) {
                console.error(`[MasterIO] File not found: ${masterPath}`);
                process.exit(1);
            }

            const data = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
            const suppliers = data.suppliers || [];
            const products = data.products || [];

            console.log(`[MasterIO] Importing ${products.length} products and ${suppliers.length} suppliers...`);

            db.transaction(() => {
                // 1. Import Suppliers
                const insertSupplier = db.prepare(`
                    INSERT OR IGNORE INTO suppliers (company_name, contact_name, phone, email, address, city, country, tax_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `);

                for (const s of suppliers) {
                    insertSupplier.run(s.company_name, s.contact_name || null, s.phone || null, s.email || null, s.address || null, s.city || null, s.country || null, s.tax_id || null);
                }

                // 2. Build Category Map & Insert New Categories
                const categoryNames = [...new Set(products.map(p => p.category).filter(Boolean))];
                const insertCategory = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
                for (const name of categoryNames) {
                    insertCategory.run(name);
                }

                const categoryMap = new Map(db.prepare('SELECT name, id FROM categories').all().map(c => [c.name.toLowerCase(), c.id]));
                const supplierMap = new Map(db.prepare('SELECT company_name, id FROM suppliers').all().map(s => [s.company_name.toLowerCase(), s.id]));

                // 3. Import Products
                const insertProduct = db.prepare(`
                    INSERT OR IGNORE INTO products (name, retail_price, cost_price, category_id, supplier_id)
                    VALUES (?, ?, ?, ?, ?)
                `);

                for (const p of products) {
                    const catId = p.category ? categoryMap.get(p.category.toLowerCase()) : null;
                    const supId = p.supplier ? supplierMap.get(p.supplier.toLowerCase()) : null;
                    insertProduct.run(p.name, p.price || 0, p.cost_price || 0, catId || null, supId || null);
                }
            })();

            console.log(`[MasterIO] Import completed successfully.`);
        }

        db.close();
    } catch (err) {
        console.error(`[MasterIO] Error:`, err);
        process.exit(1);
    }
}

run();
