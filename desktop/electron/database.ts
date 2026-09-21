import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { migratePlaintextPins, hashPin, verifyPin } from './authService'
import { runRetailMigrations } from './migrationsRetail'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Database singleton instance
let db: Database.Database | null = null

// Initialize database with schema
export function initDatabase(): Database.Database {
    if (db) return db

    const dbPath = path.join(app.getPath('userData'), 'pos-system.db')
    db = new Database(dbPath)

    // Read and execute schema
    const possiblePaths = [
        path.join(__dirname, '../../core/schema.sql'),        // Dev
        path.join(process.resourcesPath || '', 'schema.sql'), // Packaged (electron-builder extraResources)
        path.join(__dirname, 'schema.sql'),                   // Production (next to main.js)
        path.join(process.cwd(), 'schema.sql'),               // Backup
    ]

    let schemaExecuted = false
    for (const schemaPath of possiblePaths) {
        if (fs.existsSync(schemaPath)) {
            const schema = fs.readFileSync(schemaPath, 'utf-8')
            db.exec(schema)
            schemaExecuted = true
            console.log(`[Database] Schema executed from: ${schemaPath}`)
            break
        }
    }

    if (!schemaExecuted) {
        console.warn("[Database] Schema file not found, using robust fallback.")
        // Comprehensive fallback schema to prevent "no such table" errors
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                pin TEXT NOT NULL,
                role TEXT NOT NULL,
                is_active INTEGER DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                icon TEXT,
                is_active INTEGER DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS suppliers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                company_name TEXT NOT NULL,
                contact_name TEXT,
                phone TEXT,
                is_active INTEGER DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sku TEXT UNIQUE,
                barcode TEXT,
                name TEXT NOT NULL,
                category_id INTEGER,
                supplier_id INTEGER,
                retail_price REAL DEFAULT 0,
                is_active INTEGER DEFAULT 1,
                FOREIGN KEY(category_id) REFERENCES categories(id),
                FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
            );
            CREATE TABLE IF NOT EXISTS stock_inventory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                quantity REAL DEFAULT 0,
                FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT,
                customer_type TEXT DEFAULT 'retail',
                is_active INTEGER DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS activity_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                action TEXT NOT NULL,
                details TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            INSERT OR IGNORE INTO users (id, name, pin, role) VALUES (1, 'Dapper', '1234', 'owner');
            INSERT OR IGNORE INTO customers (id, name, customer_type) VALUES (1, 'Walk-in Customer', 'retail');
        `)
    }

    runMigrations(db)

    return db
}

function runMigrations(db: Database.Database) {
    // Migration 1: Add sync columns to transactions
    try {
        const tableInfo = db.prepare("PRAGMA table_info(transactions)").all() as any[]
        const hasSyncStatus = tableInfo.some(col => col.name === 'sync_status')
        const hasSource = tableInfo.some(col => col.name === 'source_device')

        if (!hasSyncStatus) {
            db.prepare("ALTER TABLE transactions ADD COLUMN sync_status INTEGER DEFAULT 0").run()
        }
        if (!hasSource) {
            db.prepare("ALTER TABLE transactions ADD COLUMN source_device TEXT DEFAULT 'desktop'").run()
        }
    } catch (e) {
        console.error("Migration failed:", e)
    }

    // Migration 2: Ensure products have updated_at (in case old schema didn't have it)
    try {
        const tableInfo = db.prepare("PRAGMA table_info(products)").all() as any[]
        const hasUpdatedAt = tableInfo.some(col => col.name === 'updated_at')
        if (!hasUpdatedAt) {
            db.prepare("ALTER TABLE products ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))").run()
        }
    } catch (e) {
        console.error("Migration 2 failed:", e)
    }

    // Migration 3: Add debt tracking columns
    try {
        const tableInfo = db.prepare("PRAGMA table_info(transactions)").all() as any[]
        const hasDueDate = tableInfo.some(col => col.name === 'debt_due_date')
        const hasDebtStatus = tableInfo.some(col => col.name === 'debt_status')

        if (!hasDueDate) {
            db.prepare("ALTER TABLE transactions ADD COLUMN debt_due_date TEXT").run()
        }
        if (!hasDebtStatus) {
            db.prepare("ALTER TABLE transactions ADD COLUMN debt_status TEXT DEFAULT 'none'").run()
        }
    } catch (e) {
        console.error("Migration 3 failed:", e)
    }

    // Migration 4: Add customer notes column for custom naming
    try {
        const tableInfo = db.prepare("PRAGMA table_info(transactions)").all() as any[]
        const hasNotes = tableInfo.some(col => col.name === 'customer_notes')
        if (!hasNotes) {
            db.prepare("ALTER TABLE transactions ADD COLUMN customer_notes TEXT").run()
        }
    } catch (e) {
        console.error("Migration 4 failed:", e)
    }

    // Migration 5: Create expenses table
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                amount REAL NOT NULL,
                created_by INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `)
    } catch (e) {
        console.error("Migration 5 (expenses) failed:", e)
    }

    // Migration 6: Support fractional quantities (REAL) for stock and transactions
    try {
        // SQLite doesn't support ALTER COLUMN type. 
        // We will recreate the tables with REAL for quantities.

        const tablesToUpdate = [
            { name: 'stock_inventory', col: 'quantity', type: 'REAL' },
            { name: 'stock_movements', col: 'quantity', type: 'REAL' },
            { name: 'transaction_items', col: 'quantity', type: 'REAL', default: '1' },
            { name: 'purchase_order_items', col: 'quantity_ordered', type: 'REAL' },
            { name: 'purchase_order_items', col: 'quantity_received', type: 'REAL', default: '0' }
        ];

        for (const table of tablesToUpdate) {
            const info = db.prepare(`PRAGMA table_info(${table.name})`).all() as any[];
            const column = info.find(c => c.name === table.col);
            if (column && column.type.toUpperCase() !== 'REAL') {
                console.log(`[Migration 6] Converting ${table.name}.${table.col} to REAL...`);

                // For safety in dev, we can sometimes just let SQLite's dynamic typing handle it,
                // but for a clean schema we do the recreate dance for the most critical ones.
                // However, PRAGMA legacy_alter_table can be complex.
                // Simple approach: ALTER TABLE is NOT possible for type change.
                // We'll perform a lighter version: just ensure we don't have constraints blocking floats.
                // SQLite actually allows REAL in INTEGER columns, but the manifest type might be preferred.

                // Since this is a live system, we'll use a transaction to be safe.
                db.transaction(() => {
                    // This is the "safe" way to change types in SQLite
                    const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${table.name}'`).get() as any;
                    if (schema && schema.sql) {
                        let newSql = schema.sql.replace(new RegExp(`${table.col}\\s+INTEGER`, 'i'), `${table.col} REAL`);

                        db.exec(`ALTER TABLE ${table.name} RENAME TO ${table.name}_old`);
                        db.exec(newSql);
                        db.exec(`INSERT INTO ${table.name} SELECT * FROM ${table.name}_old`);
                        db.exec(`DROP TABLE ${table.name}_old`);
                    }
                })();
            }
        }
    } catch (e) {
        console.error("Migration 6 (fractional quantities) failed:", e);
    }

    // Migration 7: Simplify products table (remove obsolete columns)
    try {
        const tableInfo = db.prepare("PRAGMA table_info(products)").all() as any[]
        const unwantedCols = ['brand_id', 'description', 'wholesale_price', 'max_stock_level', 'reorder_point', 'technical_specs', 'stock_location', 'has_variants', 'track_serial_numbers', 'track_expiration']
        const hasUnwanted = tableInfo.some(col => unwantedCols.includes(col.name))

        if (hasUnwanted) {
            console.log("[Migration 7] Simplifying products table...");
            db.pragma('foreign_keys = OFF');
            db.transaction(() => {
                // columns to keep
                const keep = ['id', 'sku', 'barcode', 'name', 'category_id', 'supplier_id', 'tax_category_id', 'cost_price', 'retail_price', 'min_stock_level', 'lead_time_days', 'is_active', 'created_at', 'updated_at']

                db.exec(`
                    CREATE TABLE products_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        sku TEXT UNIQUE,
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
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY(category_id) REFERENCES categories(id),
                        FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
                    )
                `);

                const colsToInsert = keep.filter(k => tableInfo.some(c => c.name === k)).join(', ')
                console.log(`[Migration 7] Columns to insert: ${colsToInsert}`);
                const sql = `INSERT INTO products_new (${colsToInsert}) SELECT ${colsToInsert} FROM products`;
                console.log(`[Migration 7] Executing: ${sql}`);
                db.exec(sql);
                db.exec("DROP TABLE products");
                db.exec("ALTER TABLE products_new RENAME TO products");
            })();
            db.pragma('foreign_keys = ON');
        }
    } catch (e) {
        console.error("Migration 7 (simplify products) failed:", e);
    }

    // Migration 8: Fix unintended UNIQUE constraint on barcode (from bug in Migration 7)
    try {
        const indexList = db.prepare("PRAGMA index_list(products)").all() as any[]
        // Check if there's a unique index on barcode (excluding the system one or checking explicitly)
        // Since it was defined as 'barcode TEXT UNIQUE', SQLite creates an implicit unique index.
        const barcodeUnique = indexList.some(idx => {
            if (idx.unique === 1) {
                const info = db.prepare(`PRAGMA index_info('${idx.name}')`).all() as any[]
                return info.some(col => col.name === 'barcode')
            }
            return false
        })

        if (barcodeUnique) {
            console.log("[Migration 8] Fixing UNIQUE constraint on barcode...");
            db.pragma('foreign_keys = OFF');
            db.transaction(() => {
                const tableInfo = db.prepare("PRAGMA table_info(products)").all() as any[]
                const keep = tableInfo.map(c => c.name)

                db.exec(`
                    CREATE TABLE products_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        sku TEXT UNIQUE,
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
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY(category_id) REFERENCES categories(id),
                        FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
                    )
                `);

                const cols = keep.join(', ')
                db.exec(`INSERT INTO products_new (${cols}) SELECT ${cols} FROM products`);
                db.exec("DROP TABLE products");
                db.exec("ALTER TABLE products_new RENAME TO products");

                // Re-create standard indexes
                db.exec("CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)");
                db.exec("CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku)");
            })();
            db.pragma('foreign_keys = ON');
        }
    } catch (e) {
        console.error("Migration 8 (fix barcode unique) failed:", e);
    }

    // Migration 9: Ensure stock_movements table exists (for existing DBs)
    try {
        db.exec(`
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
            CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
        `);
    } catch (e) {
        console.error("Migration 9 (stock_movements) failed:", e);
    }

    // Migration 10: Add new inventory fields to products table
    try {
        const tableInfo = db.prepare("PRAGMA table_info(products)").all() as any[]
        const columns = tableInfo.map(col => col.name)

        const newColumns = [
            { name: 'devation', definition: 'TEXT' },
            { name: 'designation_fournisseur', definition: 'TEXT' },
            { name: 'reference', definition: 'TEXT' },
            { name: 'marque', definition: 'TEXT' },
            { name: 'qtes_cmnds', definition: 'REAL DEFAULT 0' },
            { name: 'delai_livraison', definition: 'INTEGER DEFAULT 0' },
            { name: 'unite', definition: "TEXT DEFAULT 'piece'" }
        ]

        for (const col of newColumns) {
            if (!columns.includes(col.name)) {
                console.log(`[Migration 10] Adding column ${col.name} to products...`)
                db.prepare(`ALTER TABLE products ADD COLUMN ${col.name} ${col.definition}`).run()
            }
        }
    } catch (e) {
        console.error("Migration 10 (new inventory fields) failed:", e)
    }

    // Migration 11: Hash any plaintext PINs at rest (security). Idempotent — the seeded
    // default '1234' is hashed on first boot; existing plaintext PINs are upgraded in place.
    migratePlaintextPins(db)

    // Migration 12: Ensure Algerian TVA categories exist (19% standard, 9% reduced, 0% exempt).
    // Robust on fallback DBs that never created tax_categories.
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS tax_categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            rate REAL NOT NULL DEFAULT 0,
            is_default INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )`)
        db.prepare("INSERT OR IGNORE INTO tax_categories (id, name, rate, is_default) VALUES (1, 'Standard', 19, 1)").run()
        db.prepare("INSERT OR IGNORE INTO tax_categories (id, name, rate, is_default) VALUES (2, 'Réduit', 9, 0)").run()
        db.prepare("INSERT OR IGNORE INTO tax_categories (id, name, rate, is_default) VALUES (3, 'Exonéré', 0, 0)").run()
    } catch (e) {
        console.error('Migration 12 (tax categories) failed:', e)
    }

    // Migration 13: Backfill TVA columns on pre-existing DBs so per-line VAT works after upgrade.
    // (transaction_items.tax_rate/tax_amount are written by addItem; products.tax_category_id by getProductTaxRate.)
    try {
        const tiCols = (db.prepare("PRAGMA table_info(transaction_items)").all() as any[]).map(c => c.name)
        if (tiCols.length) {
            if (!tiCols.includes('tax_rate')) db.exec("ALTER TABLE transaction_items ADD COLUMN tax_rate REAL DEFAULT 0")
            if (!tiCols.includes('tax_amount')) db.exec("ALTER TABLE transaction_items ADD COLUMN tax_amount REAL DEFAULT 0")
        }
        const pCols = (db.prepare("PRAGMA table_info(products)").all() as any[]).map(c => c.name)
        if (pCols.length && !pCols.includes('tax_category_id')) {
            db.exec("ALTER TABLE products ADD COLUMN tax_category_id INTEGER DEFAULT 1")
        }
    } catch (e) {
        console.error('Migration 13 (TVA columns backfill) failed:', e)
    }

    // Migration 14: Gapless document numbering counters (per doc type, per year).
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS doc_sequences (
            doc_type TEXT NOT NULL,
            year INTEGER NOT NULL,
            last_number INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (doc_type, year)
        )`)
    } catch (e) {
        console.error('Migration 14 (doc_sequences) failed:', e)
    }

    // Migration 15: Buyer fiscal identifiers on customers (B2B factures + état 104).
    try {
        const cols = (db.prepare("PRAGMA table_info(customers)").all() as any[]).map(c => c.name)
        if (cols.length) {
            if (!cols.includes('nif')) db.exec("ALTER TABLE customers ADD COLUMN nif TEXT")
            if (!cols.includes('rc')) db.exec("ALTER TABLE customers ADD COLUMN rc TEXT")
            if (!cols.includes('nis')) db.exec("ALTER TABLE customers ADD COLUMN nis TEXT")
            if (!cols.includes('ai')) db.exec("ALTER TABLE customers ADD COLUMN ai TEXT")
        }
    } catch (e) {
        console.error('Migration 15 (customer fiscal ids) failed:', e)
    }

    // Migration 16: Relax the payments.payment_method CHECK so Algerian instruments
    // (cheque/virement/ccp/cib/edahabia) are storable. Recreate the table once (guarded).
    try {
        const done = db.prepare("SELECT value FROM config WHERE key = 'payments_v2'").get() as { value: string } | undefined
        const info = db.prepare("PRAGMA table_info(payments)").all() as any[]
        if (!done && info.length) {
            db.pragma('foreign_keys = OFF')
            db.transaction(() => {
                db.exec(`CREATE TABLE payments_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    transaction_id INTEGER NOT NULL,
                    payment_method TEXT NOT NULL,
                    amount REAL NOT NULL,
                    reference_number TEXT,
                    notes TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
                )`)
                const keep = info.map(c => c.name).filter(n => ['id', 'transaction_id', 'payment_method', 'amount', 'reference_number', 'notes', 'created_at'].includes(n)).join(', ')
                db.exec(`INSERT INTO payments_new (${keep}) SELECT ${keep} FROM payments`)
                db.exec('DROP TABLE payments')
                db.exec('ALTER TABLE payments_new RENAME TO payments')
                db.exec('CREATE INDEX IF NOT EXISTS idx_payments_transaction ON payments(transaction_id)')
            })()
            db.pragma('foreign_keys = ON')
        }
        db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('payments_v2', '1')").run()
    } catch (e) {
        console.error('Migration 16 (payment methods) failed:', e)
    }

    // Migration 17: droit de timbre (stamp duty) amount on transactions (cash invoices).
    try {
        const cols = (db.prepare("PRAGMA table_info(transactions)").all() as any[]).map(c => c.name)
        if (cols.length && !cols.includes('timbre')) {
            db.exec("ALTER TABLE transactions ADD COLUMN timbre REAL DEFAULT 0")
        }
    } catch (e) {
        console.error('Migration 17 (timbre) failed:', e)
    }

    // Migration 18: wholesale price tiers (gros/demi-gros/détail) + per-customer tier.
    try {
        const pcols = (db.prepare("PRAGMA table_info(products)").all() as any[]).map(c => c.name)
        if (pcols.length) {
            if (!pcols.includes('wholesale_price')) db.exec("ALTER TABLE products ADD COLUMN wholesale_price REAL DEFAULT 0")
            if (!pcols.includes('semi_wholesale_price')) db.exec("ALTER TABLE products ADD COLUMN semi_wholesale_price REAL DEFAULT 0")
        }
        const ccols = (db.prepare("PRAGMA table_info(customers)").all() as any[]).map(c => c.name)
        if (ccols.length && !ccols.includes('price_tier')) {
            // Free-text tier ('detail' | 'demi_gros' | 'gros') — avoids the customer_type CHECK.
            db.exec("ALTER TABLE customers ADD COLUMN price_tier TEXT DEFAULT 'detail'")
        }
    } catch (e) {
        console.error('Migration 18 (price tiers) failed:', e)
    }

    // Migration 19: per-customer negotiated prices (grilles tarifaires).
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS customer_prices (
            customer_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            price REAL NOT NULL,
            PRIMARY KEY (customer_id, product_id)
        )`)
    } catch (e) {
        console.error('Migration 19 (customer_prices) failed:', e)
    }

    // Migration 20: store the pre-bulk base unit price on each line so quantity
    // breaks (Phase 4.3) can be recomputed when the cart quantity changes.
    try {
        const cols = db.prepare("PRAGMA table_info(transaction_items)").all() as any[]
        if (!cols.some(c => c.name === 'base_unit_price')) {
            db.exec('ALTER TABLE transaction_items ADD COLUMN base_unit_price REAL')
        }
    } catch (e) {
        console.error('Migration 20 (base_unit_price) failed:', e)
    }

    // Migration 21: colisage (Phase 4.4). The base unit of measure already lives
    // on products.unite (Migration 10) and prints on every line; product_units
    // holds packaging tiers (carton, palette, bobine…) as conversion factors.
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS product_units (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            factor REAL NOT NULL DEFAULT 1,
            barcode TEXT,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_product_units_product ON product_units(product_id)')
    } catch (e) {
        console.error('Migration 21 (units/colisage) failed:', e)
    }

    // Migration 22: record the selling unit + conversion factor on each sold line.
    // quantity stays in BASE units (stock/tax/bulk math is single-unit); the
    // printed line shows quantity/unit_factor with the unit label.
    try {
        const cols = db.prepare("PRAGMA table_info(transaction_items)").all() as any[]
        if (!cols.some(c => c.name === 'unit')) {
            db.exec("ALTER TABLE transaction_items ADD COLUMN unit TEXT")
        }
        if (!cols.some(c => c.name === 'unit_factor')) {
            db.exec('ALTER TABLE transaction_items ADD COLUMN unit_factor REAL DEFAULT 1')
        }
    } catch (e) {
        console.error('Migration 22 (line units) failed:', e)
    }

    // Migration 23: multi-supplier per article (Phase 4.5). The product keeps a
    // primary supplier_id; this table holds alternates with their own ref/cost.
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS product_suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            supplier_id INTEGER NOT NULL,
            supplier_ref TEXT,
            cost_price REAL DEFAULT 0,
            lead_time_days INTEGER DEFAULT 0,
            is_preferred INTEGER DEFAULT 0,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_product_suppliers_product ON product_suppliers(product_id)')
    } catch (e) {
        console.error('Migration 23 (product_suppliers) failed:', e)
    }

    // Migration 24: multi-depot + bon de transfert (Phase 4.6). The main magasin
    // (warehouse id 1) keeps using stock_inventory (POS authoritative, untouched);
    // additional dépôts/chantiers hold stock in depot_stock. Transfers move stock
    // between any two locations and emit a numbered Bon de transfert.
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS warehouses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            type TEXT DEFAULT 'depot' CHECK(type IN ('magasin', 'depot', 'chantier')),
            address TEXT,
            is_default INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        )`)
        db.prepare("INSERT OR IGNORE INTO warehouses (id, name, type, is_default) VALUES (1, 'Magasin principal', 'magasin', 1)").run()
        db.exec(`CREATE TABLE IF NOT EXISTS depot_stock (
            warehouse_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            quantity REAL DEFAULT 0,
            updated_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (warehouse_id, product_id),
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        )`)
        db.exec(`CREATE TABLE IF NOT EXISTS transfer_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transfer_number TEXT UNIQUE NOT NULL,
            from_warehouse_id INTEGER NOT NULL,
            to_warehouse_id INTEGER NOT NULL,
            user_id INTEGER,
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )`)
        db.exec(`CREATE TABLE IF NOT EXISTS transfer_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transfer_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            product_name TEXT,
            quantity REAL NOT NULL,
            FOREIGN KEY (transfer_id) REFERENCES transfer_orders(id) ON DELETE CASCADE
        )`)
    } catch (e) {
        console.error('Migration 24 (warehouses/transfers) failed:', e)
    }

    // Migration 25: commercial document flow (Phase 4.7). doc_type distinguishes
    // devis / proforma / bon_commande / bon_livraison (default sale) / facture;
    // source_doc_id chains conversions (BC→BL→facture, devis→BL, recap→BLs).
    try {
        const cols = db.prepare("PRAGMA table_info(transactions)").all() as any[]
        if (!cols.some(c => c.name === 'doc_type')) {
            db.exec("ALTER TABLE transactions ADD COLUMN doc_type TEXT DEFAULT 'bon_livraison'")
        }
        if (!cols.some(c => c.name === 'source_doc_id')) {
            db.exec('ALTER TABLE transactions ADD COLUMN source_doc_id INTEGER')
        }
    } catch (e) {
        console.error('Migration 25 (document flow) failed:', e)
    }

    // Migration 26: supplier returns / retour fournisseur (Phase 4.8).
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS supplier_returns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            return_number TEXT UNIQUE NOT NULL,
            supplier_id INTEGER,
            user_id INTEGER,
            total_amount REAL DEFAULT 0,
            reason TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )`)
        db.exec(`CREATE TABLE IF NOT EXISTS supplier_return_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            return_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            product_name TEXT,
            quantity REAL NOT NULL,
            unit_cost REAL DEFAULT 0,
            FOREIGN KEY (return_id) REFERENCES supplier_returns(id) ON DELETE CASCADE
        )`)
    } catch (e) {
        console.error('Migration 26 (supplier_returns) failed:', e)
    }

    // Migration 27: supplier accounts payable + post-dated cheque register (Phase 4.9).
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS supplier_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            supplier_id INTEGER NOT NULL,
            amount REAL NOT NULL,
            payment_method TEXT DEFAULT 'cash',
            reference_number TEXT,
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
        )`)
        // Post-dated cheques (LCN / chèque à terme), both receivable and payable.
        db.exec(`CREATE TABLE IF NOT EXISTS post_dated_cheques (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
            party_type TEXT CHECK(party_type IN ('customer', 'supplier')),
            party_id INTEGER,
            cheque_number TEXT,
            bank TEXT,
            amount REAL NOT NULL,
            due_date TEXT,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'cashed', 'bounced', 'cancelled')),
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )`)
    } catch (e) {
        console.error('Migration 27 (AP + cheques) failed:', e)
    }

    // Migration 28: client reservations/acompte + consignation (Phase 4.10).
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER,
            product_id INTEGER NOT NULL,
            product_name TEXT,
            quantity REAL NOT NULL,
            deposit REAL DEFAULT 0,
            status TEXT DEFAULT 'active' CHECK(status IN ('active', 'fulfilled', 'cancelled')),
            notes TEXT,
            sale_id INTEGER,
            user_id INTEGER,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (product_id) REFERENCES products(id)
        )`)
        db.exec(`CREATE TABLE IF NOT EXISTS consignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            supplier_id INTEGER,
            product_id INTEGER NOT NULL,
            product_name TEXT,
            quantity REAL NOT NULL,
            quantity_settled REAL DEFAULT 0,
            unit_cost REAL DEFAULT 0,
            status TEXT DEFAULT 'open' CHECK(status IN ('open', 'settled')),
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (product_id) REFERENCES products(id)
        )`)
    } catch (e) {
        console.error('Migration 28 (reservations/consignation) failed:', e)
    }

    // Migration 29: optional payroll module (Phase 5.6) — off by default.
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS employees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            ncc TEXT,
            base_salary REAL DEFAULT 0,
            is_btp INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        )`)
        db.exec(`CREATE TABLE IF NOT EXISTS payslips (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER NOT NULL,
            period TEXT NOT NULL,
            gross REAL DEFAULT 0,
            cnas_employee REAL DEFAULT 0,
            cnas_employer REAL DEFAULT 0,
            cacobatph REAL DEFAULT 0,
            taxable REAL DEFAULT 0,
            irg REAL DEFAULT 0,
            net REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(employee_id, period),
            FOREIGN KEY (employee_id) REFERENCES employees(id)
        )`)
    } catch (e) {
        console.error('Migration 29 (payroll) failed:', e)
    }

    // Migration 30: real product variants — size × colour (Dapper Phase 1).
    //
    // A garment is only sellable/stockable as a SIZE+COLOUR combination, so one row
    // here = one sellable SKU. This deliberately replaces the EAV shape that
    // core/schema.sql historically declared (variant_name/variant_value, one row per
    // attribute), which could not express a *combination* as a single stock unit.
    // Nothing ever wrote to that table, so rebuilding it loses no data.
    //
    // Both axes are OPTIONAL: '' means "this product has no such axis" (a belt may be
    // size-only, a scarf colour-only, an accessory neither). Empty string rather than
    // NULL because SQLite treats NULLs as distinct in UNIQUE, which would let
    // duplicate (product, NULL, NULL) rows through.
    try {
        const variantCols = (db.prepare("PRAGMA table_info(product_variants)").all() as any[]).map(c => c.name)
        const isLegacyEav = variantCols.length > 0 && variantCols.includes('variant_name')
        if (isLegacyEav) {
            console.log('[Migration 30] Replacing legacy EAV product_variants with size/colour shape...')
            db.exec('DROP TABLE product_variants')
        }

        db.exec(`CREATE TABLE IF NOT EXISTS product_variants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            size TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL DEFAULT '',
            sku TEXT,
            barcode TEXT,
            cost_price REAL,
            retail_price REAL,
            sort_order INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(product_id, size, color),
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_product_variants_barcode ON product_variants(barcode)')

        // stock_inventory carries per-variant rows (variant_id NULL = the product's own
        // base row). The inline fallback schema in initDatabase() omits both columns, so
        // add them defensively — every stock query already assumes they exist.
        const siCols = (db.prepare("PRAGMA table_info(stock_inventory)").all() as any[]).map(c => c.name)
        if (siCols.length) {
            if (!siCols.includes('variant_id')) db.exec('ALTER TABLE stock_inventory ADD COLUMN variant_id INTEGER')
            if (!siCols.includes('updated_at')) db.exec("ALTER TABLE stock_inventory ADD COLUMN updated_at TEXT")
        }
        db.exec('CREATE INDEX IF NOT EXISTS idx_stock_inventory_product ON stock_inventory(product_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_stock_inventory_variant ON stock_inventory(variant_id)')
    } catch (e) {
        console.error('Migration 30 (product variants) failed:', e)
    }

    // Migration 31: cash sessions + drawer movements (Dapper Phase 2).
    //
    // One session = one till day: opened with a counted float, closed with a counted
    // drawer. The Z-report reconciles the two.
    //
    // Cash is attributed to a session by PAYMENT time, not sale time: a credit sale
    // settled in cash three days later moves that day's drawer, not the day the goods
    // left. payments.created_at is therefore the anchor, so no session_id column is
    // needed on transactions.
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS cash_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_number TEXT UNIQUE,
            opened_at TEXT DEFAULT (datetime('now')),
            closed_at TEXT,
            opening_float REAL DEFAULT 0,
            counted_cash REAL,
            expected_cash REAL,
            variance REAL,
            opened_by INTEGER,
            closed_by INTEGER,
            notes TEXT,
            status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed'))
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_cash_sessions_status ON cash_sessions(status)')

        // Manual drawer movements: petty-cash payouts, safe drops (coffre), top-ups.
        db.exec(`CREATE TABLE IF NOT EXISTS cash_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
            amount REAL NOT NULL,
            reason TEXT,
            user_id INTEGER,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (session_id) REFERENCES cash_sessions(id) ON DELETE CASCADE
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(session_id)')
    } catch (e) {
        console.error('Migration 31 (cash sessions) failed:', e)
    }

    // Migration 32: guarantee pricing_rules exists. It was only ever declared in
    // core/schema.sql, so a DB built from the inline fallback schema has no such table
    // and every PricingService call throws. Same defensive fix as Migration 12 for
    // tax_categories. Promotions (Phase 2) are stored here as rule_type='promotional'.
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS pricing_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            rule_type TEXT NOT NULL DEFAULT 'bulk',
            product_id INTEGER,
            category_id INTEGER,
            min_quantity REAL DEFAULT 1,
            discount_type TEXT DEFAULT 'percentage',
            discount_value REAL DEFAULT 0,
            start_date TEXT,
            end_date TEXT,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_pricing_rules_product ON pricing_rules(product_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_pricing_rules_category ON pricing_rules(category_id)')
    } catch (e) {
        console.error('Migration 32 (pricing_rules guard) failed:', e)
    }

    // Migration 33: loyalty, shrinkage and layaway variants (Dapper Phase 3).
    try {
        // --- Loyalty (points per DZD spent, redeemed as a discount) ---
        const cCols = (db.prepare("PRAGMA table_info(customers)").all() as any[]).map(c => c.name)
        if (cCols.length) {
            if (!cCols.includes('loyalty_points')) db.exec('ALTER TABLE customers ADD COLUMN loyalty_points REAL DEFAULT 0')
            if (!cCols.includes('loyalty_card_number')) db.exec('ALTER TABLE customers ADD COLUMN loyalty_card_number TEXT')
        }

        // Ledger behind the balance, so points can always be explained and audited.
        // UNIQUE(transaction_id, direction) makes earning IDEMPOTENT: a sale can never
        // award points twice even if completion is retried.
        db.exec(`CREATE TABLE IF NOT EXISTS loyalty_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            transaction_id INTEGER,
            direction TEXT NOT NULL CHECK(direction IN ('earn', 'redeem', 'adjust')),
            points REAL NOT NULL,
            note TEXT,
            user_id INTEGER,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(transaction_id, direction),
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_loyalty_entries_customer ON loyalty_entries(customer_id)')

        // --- Pertes / shrinkage: theft, damage, staining. Deliberately separate from
        // routine stock adjustments so it is reportable as a cost, not lost in noise. ---
        db.exec(`CREATE TABLE IF NOT EXISTS stock_losses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            variant_id INTEGER,
            product_name TEXT,
            quantity REAL NOT NULL,
            unit_cost REAL DEFAULT 0,
            total_cost REAL DEFAULT 0,
            reason TEXT NOT NULL DEFAULT 'other' CHECK(reason IN ('theft', 'damage', 'stain', 'expired', 'lost', 'other')),
            notes TEXT,
            user_id INTEGER,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (product_id) REFERENCES products(id)
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_stock_losses_created ON stock_losses(created_at)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_stock_losses_product ON stock_losses(product_id)')

        // --- Layaway (mise de côté) must reserve a specific size/colour, not just a product ---
        const rCols = (db.prepare("PRAGMA table_info(reservations)").all() as any[]).map(c => c.name)
        if (rCols.length && !rCols.includes('variant_id')) {
            db.exec('ALTER TABLE reservations ADD COLUMN variant_id INTEGER')
        }
    } catch (e) {
        console.error('Migration 33 (loyalty/losses/layaway) failed:', e)
    }

    // Migrations 34–43 (multi-store retail management) live in ./migrationsRetail.ts
    // purely to keep this file readable — same contract, same boot, same idempotency
    // rules. See docs/RETAIL_PLAN.md. Add new migrations THERE, not here.
    runRetailMigrations(db)

    // Schema-version stamp (Phase 6.7). Migrations are individually idempotent, so
    // they are safe to re-run every boot; user_version records the latest applied
    // migration for diagnostics and future gated migrations.
    try {
        db.pragma('user_version = 46')
    } catch (e) {
        console.error('Failed to stamp user_version:', e)
    }
}

export function getDatabase(): Database.Database {
    if (!db) {
        initDatabase()
    }
    return db!
}

// Close database connection
export function closeDatabase(): void {
    if (db) {
        db.close()
        db = null
    }
}

export function resetDatabaseFile(): Database.Database {
    if (db) {
        db.close()
        db = null
    }
    const dbPath = path.join(app.getPath('userData'), 'pos-system.db')
    if (fs.existsSync(dbPath)) {
        try {
            fs.unlinkSync(dbPath)
        } catch (e) {
            console.error("Failed to delete database file:", e)
            // If we can't delete it (likely file lock on Windows), clear all tables manually
            const tempDb = new Database(dbPath)
            try {
                tempDb.pragma('foreign_keys = OFF')
                const tables = tempDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'idx_%'").all() as any[]
                tempDb.transaction(() => {
                    for (const table of tables) {
                        tempDb.prepare(`DROP TABLE IF EXISTS ${table.name}`).run()
                    }
                })()
            } finally {
                tempDb.close()
            }
            return initDatabase() // This will now run and recreate the schema since db is null and tables are gone
        }
    }
    return initDatabase()
}

// User operations
export const UserService = {
    findByPin(pin: string) {
        const users = getDatabase().prepare('SELECT * FROM users WHERE is_active = 1').all() as any[]
        return users.find(u => verifyPin(pin, u.pin))
    },

    getAll() {
        const stmt = getDatabase().prepare('SELECT id, name, role, is_active FROM users')
        return stmt.all()
    },

    create(name: string, pin: string, role: string) {
        const stmt = getDatabase().prepare('INSERT INTO users (name, pin, role) VALUES (?, ?, ?)')
        return stmt.run(name, hashPin(pin), role)
    },

    logActivity(userId: number, action: string, entityType?: string, entityId?: number, details?: string) {
        const stmt = getDatabase().prepare(
            'INSERT INTO activity_logs (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)'
        )
        return stmt.run(userId, action, entityType || null, entityId || null, details || null)
    }
}
