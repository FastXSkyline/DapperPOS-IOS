import type Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Retail-management migrations 34–45 (docs/RETAIL_PLAN.md, Phase 0).
//
// These are a CONTINUATION of runMigrations() in database.ts — same contract:
// every one re-runs on every boot and must be idempotent. They live in their own
// file only because database.ts had already passed 1000 lines; database.ts calls
// runRetailMigrations() immediately before it stamps user_version.
//
// What they add: stores as a first-class entity, POS terminals, granular
// permissions, an audit trail with before/after values, configurable
// brands/sizes/colours, returns + exchanges, variant-level store transfers,
// inventory counts, notifications, sales targets, and suit bundles.
//
// GUIDING CONSTRAINT: nothing here rewrites an existing table. Every change is an
// additive column or a new table, because migrations 1–33 have already shipped
// against live shop data and a table rebuild is where data goes to die.
// ---------------------------------------------------------------------------

type DB = Database.Database

/** Column names of a table; empty array if the table does not exist. */
function cols(db: DB, table: string): string[] {
    try {
        return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name)
    } catch {
        return []
    }
}

/** ALTER TABLE ADD COLUMN, but only when the table exists and the column does not. */
function addColumn(db: DB, table: string, column: string, definition: string): void {
    const existing = cols(db, table)
    if (existing.length && !existing.includes(column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
}

export function runRetailMigrations(db: DB): void {
    migration34Stores(db)
    migration35Permissions(db)
    migration36AuditLog(db)
    migration37ReferenceData(db)
    migration38Returns(db)
    migration39Transfers(db)
    migration40InventoryCounts(db)
    migration41NotificationsTargetsBundles(db)
    migration42CostOfGoodsSold(db)
    migration43CloudPushState(db)
    migration44Employees(db)
    migration45DefaultAccountName(db)
    migration46SupplierColumns(db)
    migration47ConnectedDevices(db)
}

// ---------------------------------------------------------------------------
// Migration 34: stores and POS terminals as first-class entities.
//
// Until now the shop was implicit — one database, one till, one everything. The
// business runs two shops (Costume and Casual) on 2–3 PCs, so store has to key
// sales, stock, cash and expenses.
//
// This is deliberately NOT the dormant `warehouses` table from Migration 24. That
// one is product-level (no variant_id) and models dépôts for the retired B2B
// domain. A store is a selling location with its own till and its own staff, and
// its stock must be variant-level. Reusing `warehouses` would have meant carrying
// the old semantics forward; see docs/RETAIL_PLAN.md §1.
//
// BACKFILL: every pre-existing row is attributed to store 1. There is no other
// honest answer — the data was recorded before stores existed, and the shop the
// software was installed in is store 1 by definition.
// ---------------------------------------------------------------------------
function migration34Stores(db: DB): void {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS stores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            store_type TEXT DEFAULT 'retail',
            address TEXT,
            city TEXT,
            phone TEXT,
            email TEXT,
            -- Fiscal identifiers can differ per establishment (même NIF, RC par
            -- établissement). Kept per store so a facture prints the right ones.
            nif TEXT,
            nis TEXT,
            rc TEXT,
            article_imposition TEXT,
            is_default INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )`)

        // Seed the two real shops. INSERT OR IGNORE on the unique code makes this
        // safe to re-run and safe against the owner having renamed them.
        db.prepare(`INSERT OR IGNORE INTO stores (id, code, name, store_type, is_default, sort_order)
                    VALUES (1, 'CST', 'Costume', 'retail', 1, 1)`).run()
        db.prepare(`INSERT OR IGNORE INTO stores (id, code, name, store_type, is_default, sort_order)
                    VALUES (2, 'CAS', 'Casual', 'retail', 0, 2)`).run()

        // A terminal is one physical PC. `device_id` is a stable machine fingerprint
        // so a terminal keeps its identity across reinstalls; `is_server` marks the
        // PC that actually holds this store's SQLite file (see RETAIL_PLAN.md §2).
        db.exec(`CREATE TABLE IF NOT EXISTS pos_terminals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_id INTEGER NOT NULL,
            code TEXT NOT NULL,
            name TEXT,
            device_id TEXT UNIQUE,
            is_server INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            last_seen_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(store_id, code),
            FOREIGN KEY (store_id) REFERENCES stores(id)
        )`)
        db.prepare(`INSERT OR IGNORE INTO pos_terminals (id, store_id, code, name, is_server)
                    VALUES (1, 1, 'POS-01', 'Caisse 1', 1)`).run()

        // Which stores an employee may work in. An owner/manager with no rows here
        // is treated as "all stores" by the service layer, so this table only has to
        // carry the restrictive cases.
        db.exec(`CREATE TABLE IF NOT EXISTS user_stores (
            user_id INTEGER NOT NULL,
            store_id INTEGER NOT NULL,
            PRIMARY KEY (user_id, store_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        )`)

        addColumn(db, 'users', 'home_store_id', 'INTEGER REFERENCES stores(id)')
        db.exec('UPDATE users SET home_store_id = 1 WHERE home_store_id IS NULL')

        // --- store_id on everything the brief keys off store ---
        for (const table of ['transactions', 'stock_inventory', 'stock_movements',
                             'expenses', 'cash_sessions', 'stock_losses', 'reservations']) {
            addColumn(db, table, 'store_id', 'INTEGER REFERENCES stores(id)')
            if (cols(db, table).includes('store_id')) {
                db.exec(`UPDATE ${table} SET store_id = 1 WHERE store_id IS NULL`)
            }
        }
        addColumn(db, 'transactions', 'terminal_id', 'INTEGER REFERENCES pos_terminals(id)')
        addColumn(db, 'cash_sessions', 'terminal_id', 'INTEGER REFERENCES pos_terminals(id)')

        db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_store ON transactions(store_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_store_created ON transactions(store_id, created_at)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_stock_movements_store ON stock_movements(store_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_store ON expenses(store_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_cash_sessions_store ON cash_sessions(store_id)')

        // --- The unique index that makes the oversell guard possible ---------------
        //
        // stock_inventory shipped with no uniqueness at all, so a product could hold
        // several rows and "current stock" depended on which one you read. An atomic
        // `UPDATE ... WHERE quantity >= ?` is only a real guard if exactly one row can
        // match, so the index is a correctness prerequisite, not an optimisation.
        //
        // COALESCE(variant_id, 0) because SQLite treats NULLs as DISTINCT in a UNIQUE
        // index — without it, ten NULL-variant rows for one product all pass.
        const siCols = cols(db, 'stock_inventory')
        if (siCols.includes('store_id') && siCols.includes('variant_id')) {
            const hasIndex = (db.prepare(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_stock_inventory_unique'"
            ).get() as any) !== undefined

            if (!hasIndex) {
                // Merge any pre-existing duplicates before the index can reject them.
                // Quantities are SUMmed: two rows for the same variant both represent
                // real stock, so the total is the only defensible reconciliation.
                const dupes = db.prepare(`
                    SELECT store_id, product_id, COALESCE(variant_id, 0) AS vkey,
                           COUNT(*) AS n, SUM(quantity) AS total, MIN(id) AS keep_id
                    FROM stock_inventory
                    GROUP BY store_id, product_id, COALESCE(variant_id, 0)
                    HAVING COUNT(*) > 1
                `).all() as any[]

                if (dupes.length) {
                    console.log(`[Migration 34] Merging ${dupes.length} duplicate stock rows...`)
                    const merge = db.transaction(() => {
                        for (const d of dupes) {
                            db.prepare('UPDATE stock_inventory SET quantity = ? WHERE id = ?')
                                .run(d.total, d.keep_id)
                            db.prepare(`DELETE FROM stock_inventory
                                        WHERE store_id IS ? AND product_id = ?
                                          AND COALESCE(variant_id, 0) = ? AND id != ?`)
                                .run(d.store_id, d.product_id, d.vkey, d.keep_id)
                        }
                    })
                    merge()
                }

                db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_inventory_unique
                         ON stock_inventory(store_id, product_id, COALESCE(variant_id, 0))`)
            }
        }

        // Store 2 starts with no stock rows at all, which reads as zero everywhere —
        // correct, and cheaper than materialising a row per variant up front.
    } catch (e) {
        console.error('Migration 34 (stores/terminals) failed:', e)
    }
}

// ---------------------------------------------------------------------------
// Migration 35: granular permissions.
//
// core/permissions.ts hardcodes ten booleans in a TypeScript object, which means
// the owner cannot change what a cashier may do without a rebuild, and the rules
// are only in the renderer — where they are decoration, not enforcement.
//
// The catalogue moves into the database so the service layer can consult it, and
// role_limits carries the NUMERIC rules (max discount) the brief asks for in §31.
// ---------------------------------------------------------------------------
function migration35Permissions(db: DB): void {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS permissions (
            code TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            label_fr TEXT NOT NULL,
            label_ar TEXT,
            is_sensitive INTEGER DEFAULT 0
        )`)

        db.exec(`CREATE TABLE IF NOT EXISTS role_permissions (
            role TEXT NOT NULL,
            permission_code TEXT NOT NULL,
            PRIMARY KEY (role, permission_code),
            FOREIGN KEY (permission_code) REFERENCES permissions(code) ON DELETE CASCADE
        )`)

        db.exec(`CREATE TABLE IF NOT EXISTS role_limits (
            role TEXT PRIMARY KEY,
            max_discount_percent REAL DEFAULT 0,
            max_refund_amount REAL,
            can_override_stock INTEGER DEFAULT 0
        )`)

        // code, category, French label, Arabic label, sensitive?
        const catalogue: [string, string, string, string, number][] = [
            ['sales.create', 'sales', 'Encaisser une vente', 'إتمام عملية بيع', 0],
            ['sales.view', 'sales', 'Consulter les ventes', 'عرض المبيعات', 0],
            ['sales.view_all_users', 'sales', 'Voir les ventes des autres vendeurs', 'عرض مبيعات البائعين الآخرين', 0],
            ['sales.cancel', 'sales', 'Annuler une vente', 'إلغاء عملية بيع', 1],
            ['sales.refund', 'sales', 'Rembourser une vente', 'استرجاع مبلغ', 1],
            ['sales.exchange', 'sales', 'Effectuer un échange', 'إجراء تبديل', 0],
            ['sales.discount', 'sales', 'Appliquer une remise', 'تطبيق تخفيض', 0],
            ['sales.price_override', 'sales', 'Modifier le prix de vente', 'تعديل سعر البيع', 1],
            ['products.view', 'products', 'Consulter le catalogue', 'عرض المنتجات', 0],
            ['products.create', 'products', 'Créer un produit', 'إنشاء منتج', 0],
            ['products.update', 'products', 'Modifier un produit', 'تعديل منتج', 0],
            ['products.delete', 'products', 'Supprimer un produit', 'حذف منتج', 1],
            ['products.price', 'products', 'Modifier les prix', 'تعديل الأسعار', 1],
            ['inventory.view', 'inventory', 'Consulter le stock', 'عرض المخزون', 0],
            ['inventory.adjust', 'inventory', 'Ajuster le stock', 'تعديل المخزون', 1],
            ['inventory.count', 'inventory', 'Faire un inventaire', 'إجراء جرد', 0],
            ['inventory.transfer', 'inventory', 'Créer un transfert', 'إنشاء تحويل', 0],
            ['inventory.transfer_approve', 'inventory', 'Approuver un transfert', 'الموافقة على تحويل', 1],
            ['inventory.loss', 'inventory', 'Déclarer une perte', 'تسجيل خسارة', 1],
            ['purchases.view', 'purchases', 'Consulter les achats', 'عرض المشتريات', 0],
            ['purchases.create', 'purchases', 'Créer une commande fournisseur', 'إنشاء طلب مورد', 0],
            ['purchases.receive', 'purchases', 'Réceptionner une commande', 'استلام طلبية', 0],
            ['customers.view', 'customers', 'Consulter les clients', 'عرض الزبائن', 0],
            ['customers.manage', 'customers', 'Gérer les clients', 'إدارة الزبائن', 0],
            ['employees.view', 'employees', 'Consulter les employés', 'عرض الموظفين', 0],
            ['employees.manage', 'employees', 'Gérer les employés', 'إدارة الموظفين', 1],
            ['cash.open', 'cash', 'Ouvrir la caisse', 'فتح الصندوق', 0],
            ['cash.close', 'cash', 'Clôturer la caisse', 'إغلاق الصندوق', 0],
            ['cash.movement', 'cash', 'Entrée / sortie de caisse', 'حركة الصندوق', 1],
            ['expenses.manage', 'finance', 'Gérer les dépenses', 'إدارة المصاريف', 0],
            ['reports.view', 'reports', 'Consulter les rapports', 'عرض التقارير', 0],
            ['reports.profit', 'reports', 'Voir la marge et le bénéfice', 'عرض الهامش والربح', 1],
            ['reports.export', 'reports', 'Exporter les rapports', 'تصدير التقارير', 0],
            ['stores.view_all', 'stores', 'Voir tous les magasins', 'عرض كل المحلات', 0],
            ['stores.manage', 'stores', 'Gérer les magasins', 'إدارة المحلات', 1],
            ['settings.manage', 'settings', 'Modifier les paramètres', 'تعديل الإعدادات', 1],
            ['audit.view', 'settings', 'Consulter le journal d’audit', 'عرض سجل التدقيق', 1],
        ]
        const insPerm = db.prepare(
            'INSERT OR IGNORE INTO permissions (code, category, label_fr, label_ar, is_sensitive) VALUES (?, ?, ?, ?, ?)'
        )
        for (const p of catalogue) insPerm.run(...p)

        const grants: Record<string, string[]> = {
            owner: catalogue.map(p => p[0]),
            manager: [
                'sales.create', 'sales.view', 'sales.view_all_users', 'sales.cancel', 'sales.refund',
                'sales.exchange', 'sales.discount', 'sales.price_override',
                'products.view', 'products.create', 'products.update', 'products.price',
                'inventory.view', 'inventory.adjust', 'inventory.count', 'inventory.transfer',
                'inventory.transfer_approve', 'inventory.loss',
                'purchases.view', 'purchases.create', 'purchases.receive',
                'customers.view', 'customers.manage', 'employees.view',
                'cash.open', 'cash.close', 'cash.movement', 'expenses.manage',
                'reports.view', 'reports.profit', 'reports.export', 'stores.view_all',
            ],
            cashier: [
                'sales.create', 'sales.view', 'sales.exchange', 'sales.discount',
                'products.view', 'inventory.view',
                'customers.view', 'customers.manage',
                'cash.open', 'cash.close',
            ],
            stock_manager: [
                'products.view', 'products.create', 'products.update',
                'inventory.view', 'inventory.adjust', 'inventory.count', 'inventory.transfer',
                'inventory.loss',
                'purchases.view', 'purchases.create', 'purchases.receive',
                'reports.view', 'stores.view_all',
            ],
        }
        // `warehouse` IS the brief's STOCK_MANAGER, under the name this database
        // already uses. It is not a synonym kept for tidiness: `users.role` carries a
        // CHECK constraint allowing only ('owner','manager','cashier','warehouse'), so
        // `warehouse` is the only one of the two a user row can actually hold, and
        // widening that CHECK would mean rebuilding the table every PIN and every
        // foreign key points at.
        //
        // The `stock_manager` grants are still seeded so that if the CHECK is ever
        // widened the permissions are already correct — but nothing can use them today.
        // Anything that lists roles for the owner to edit must read the CHECK's four
        // values, never this object's keys.
        grants.warehouse = grants.stock_manager

        // Default grants are applied ONCE PER PERMISSION CODE, never on every boot.
        //
        // INSERT OR IGNORE is not sufficient here, and the difference is a security
        // hole rather than a nicety: once the owner revokes a permission its row is
        // gone, so OR IGNORE cheerfully re-inserts it and the next restart silently
        // hands a cashier back the access that was deliberately taken away.
        //
        // Recording which codes have had their defaults seeded gives both halves of
        // the behaviour that is actually wanted: a revocation sticks forever, while a
        // permission introduced by a LATER release still arrives with its defaults.
        db.exec(`CREATE TABLE IF NOT EXISTS permission_defaults_applied (
            permission_code TEXT PRIMARY KEY,
            applied_at TEXT DEFAULT (datetime('now'))
        )`)
        const seeded = new Set(
            (db.prepare('SELECT permission_code FROM permission_defaults_applied').all() as any[])
                .map(r => r.permission_code)
        )
        const insGrant = db.prepare('INSERT OR IGNORE INTO role_permissions (role, permission_code) VALUES (?, ?)')
        const markSeeded = db.prepare('INSERT OR IGNORE INTO permission_defaults_applied (permission_code) VALUES (?)')
        const applyDefaults = db.transaction(() => {
            for (const [role, codes] of Object.entries(grants)) {
                for (const code of codes) {
                    if (!seeded.has(code)) insGrant.run(role, code)
                }
            }
            for (const p of catalogue) markSeeded.run(p[0])
        })
        applyDefaults()

        // Discount ceilings straight from the brief §31: cashier 5 %, manager 20 %.
        const insLimit = db.prepare(
            'INSERT OR IGNORE INTO role_limits (role, max_discount_percent, max_refund_amount, can_override_stock) VALUES (?, ?, ?, ?)'
        )
        insLimit.run('owner', 100, null, 1)
        insLimit.run('manager', 20, null, 1)
        insLimit.run('cashier', 5, 0, 0)
        insLimit.run('stock_manager', 0, 0, 1)
        insLimit.run('warehouse', 0, 0, 1)
    } catch (e) {
        console.error('Migration 35 (permissions) failed:', e)
    }
}

// ---------------------------------------------------------------------------
// Migration 36: the audit trail.
//
// `activity_logs` already exists but records only an action string, which cannot
// answer the question an audit log exists to answer: what did this value used to
// be? old_value/new_value are JSON so any entity fits without a schema change.
//
// Deliberately append-only by convention and by API: auditService exposes no
// update or delete. SQLite cannot revoke DELETE from the process that owns the
// file, so this is a discipline, not a hard guarantee — stated rather than
// pretended (brief §59, §60).
// ---------------------------------------------------------------------------
function migration36AuditLog(db: DB): void {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            user_name TEXT,
            action TEXT NOT NULL,
            entity_type TEXT,
            entity_id INTEGER,
            old_value TEXT,
            new_value TEXT,
            summary TEXT,
            store_id INTEGER,
            terminal_id INTEGER,
            device_info TEXT,
            ip_address TEXT,
            severity TEXT DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'critical')),
            created_at TEXT DEFAULT (datetime('now'))
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_audit_store ON audit_logs(store_id)')
    } catch (e) {
        console.error('Migration 36 (audit log) failed:', e)
    }
}

// ---------------------------------------------------------------------------
// Migration 37: configurable brands, sizes and colours.
//
// product_variants.size/color are free TEXT today. That is why "Bleu Marine" and
// "bleu marine" split a colour report in two, and why sizes sort alphabetically —
// putting 10 before 8, and XL before XS.
//
// The text columns STAY. They are what 33 migrations of history and the
// UNIQUE(product_id,size,color) constraint are built on, and rewriting them would
// orphan every sold line. The reference tables add what text cannot carry:
// ordering, a swatch, and a canonical spelling to converge on.
// ---------------------------------------------------------------------------
function migration37ReferenceData(db: DB): void {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS brands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            logo_path TEXT,
            is_active INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )`)
        addColumn(db, 'products', 'brand_id', 'INTEGER REFERENCES brands(id)')

        // size_group separates the scales that must never be mixed in a picker:
        // 'alpha' (S/M/L) for casual, 'suit' (44–60) for costume, 'numeric' for
        // trousers, 'shoe', and 'unique' for one-size items.
        db.exec(`CREATE TABLE IF NOT EXISTS sizes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            size_group TEXT NOT NULL DEFAULT 'alpha',
            sort_order INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            UNIQUE(name, size_group)
        )`)

        db.exec(`CREATE TABLE IF NOT EXISTS colors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            name_ar TEXT,
            hex TEXT,
            sort_order INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1
        )`)

        const sizeCount = (db.prepare('SELECT COUNT(*) AS n FROM sizes').get() as any).n
        if (sizeCount === 0) {
            const ins = db.prepare('INSERT OR IGNORE INTO sizes (name, size_group, sort_order) VALUES (?, ?, ?)')
            const seed = db.transaction(() => {
                const alpha = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']
                alpha.forEach((n, i) => ins.run(n, 'alpha', i + 1))
                // Algerian/EU suit sizing, even numbers only.
                for (let s = 44, i = 1; s <= 60; s += 2, i++) ins.run(String(s), 'suit', i)
                // Trouser waist sizing.
                for (let s = 36, i = 1; s <= 56; s += 2, i++) ins.run(String(s), 'numeric', i)
                for (let s = 39, i = 1; s <= 46; s++, i++) ins.run(String(s), 'shoe', i)
                ins.run('Unique', 'unique', 1)
            })
            seed()
        }

        const colorCount = (db.prepare('SELECT COUNT(*) AS n FROM colors').get() as any).n
        if (colorCount === 0) {
            const ins = db.prepare('INSERT OR IGNORE INTO colors (name, name_ar, hex, sort_order) VALUES (?, ?, ?, ?)')
            const palette: [string, string, string][] = [
                ['Noir', 'أسود', '#111111'],
                ['Blanc', 'أبيض', '#FFFFFF'],
                ['Bleu Marine', 'كحلي', '#1B2A4A'],
                ['Bleu', 'أزرق', '#2563EB'],
                ['Bleu Ciel', 'أزرق فاتح', '#93C5FD'],
                ['Gris', 'رمادي', '#6B7280'],
                ['Gris Anthracite', 'رمادي داكن', '#374151'],
                ['Beige', 'بيج', '#D6C7AE'],
                ['Marron', 'بني', '#6B4423'],
                ['Bordeaux', 'خمري', '#6B1F2E'],
                ['Vert', 'أخضر', '#166534'],
                ['Rouge', 'أحمر', '#B91C1C'],
                ['Rose', 'وردي', '#EC9DBA'],
                ['Kaki', 'كاكي', '#78716C'],
                ['Écru', 'عاجي', '#F1E9DA'],
            ]
            const seed = db.transaction(() => {
                palette.forEach((c, i) => ins.run(c[0], c[1], c[2], i + 1))
            })
            seed()
        }

        // Backfill from what the catalogue already uses, so the reference lists start
        // out describing this shop rather than a generic template. Unknown sizes land
        // in 'other' — the owner reclassifies them in Settings; guessing the scale
        // from a bare string would mis-file a "34" as a waist when it is a shoe.
        try {
            const usedSizes = db.prepare(
                "SELECT DISTINCT size FROM product_variants WHERE size IS NOT NULL AND size != ''"
            ).all() as any[]
            const insSize = db.prepare('INSERT OR IGNORE INTO sizes (name, size_group, sort_order) VALUES (?, ?, 999)')
            for (const s of usedSizes) {
                const known = db.prepare('SELECT 1 FROM sizes WHERE name = ?').get(s.size)
                if (!known) insSize.run(s.size, 'other')
            }
            const usedColors = db.prepare(
                "SELECT DISTINCT color FROM product_variants WHERE color IS NOT NULL AND color != ''"
            ).all() as any[]
            const insColor = db.prepare('INSERT OR IGNORE INTO colors (name, sort_order) VALUES (?, 999)')
            for (const c of usedColors) insColor.run(c.color)
        } catch { /* product_variants may be empty on a fresh install */ }

        // Backfill brands from the legacy free-text column, if Migration 10 added one.
        try {
            if (cols(db, 'products').includes('brand')) {
                const brands = db.prepare(
                    "SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND brand != ''"
                ).all() as any[]
                const insBrand = db.prepare('INSERT OR IGNORE INTO brands (name) VALUES (?)')
                for (const b of brands) insBrand.run(b.brand)
                db.exec(`UPDATE products SET brand_id = (SELECT id FROM brands WHERE brands.name = products.brand)
                         WHERE brand_id IS NULL AND brand IS NOT NULL AND brand != ''`)
            }
        } catch { /* no legacy brand column */ }
    } catch (e) {
        console.error('Migration 37 (reference data) failed:', e)
    }
}

// ---------------------------------------------------------------------------
// Migration 38: returns, refunds and exchanges.
//
// The single biggest hole in the schema for a clothing shop. A return is NEVER a
// deletion or an edit of the original sale — it is a new document that references
// it. That is both the brief's §16 rule and Algerian law (facture d'avoir is the
// only legal way to reverse an issued invoice; see ALGERIA_REQUIREMENTS.md).
//
// One table covers refunds and exchanges because an exchange IS a return plus a
// replacement sale: `kind` distinguishes them and `exchange_transaction_id` points
// at the new sale. `balance` is SIGNED — positive means the shop owes the customer,
// negative means the customer still owes the shop (brief §17, both directions).
//
// transactions.status is left alone: its CHECK constraint predates this work and
// widening it would mean rebuilding the table that every sale lives in. A separate
// `return_status` column carries none/partial/full instead.
// ---------------------------------------------------------------------------
function migration38Returns(db: DB): void {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS sale_returns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            return_number TEXT UNIQUE NOT NULL,
            kind TEXT NOT NULL DEFAULT 'refund' CHECK(kind IN ('refund', 'exchange')),
            original_transaction_id INTEGER NOT NULL,
            exchange_transaction_id INTEGER,
            store_id INTEGER NOT NULL,
            terminal_id INTEGER,
            user_id INTEGER,
            customer_id INTEGER,
            -- Value of the goods coming back, at the price actually paid.
            returned_value REAL DEFAULT 0,
            -- Value of the replacement goods (exchanges only).
            replacement_value REAL DEFAULT 0,
            -- Signed: > 0 shop refunds the customer, < 0 customer tops up.
            balance REAL DEFAULT 0,
            refund_method TEXT,
            reason TEXT,
            notes TEXT,
            status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('draft', 'completed', 'cancelled')),
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (original_transaction_id) REFERENCES transactions(id),
            FOREIGN KEY (exchange_transaction_id) REFERENCES transactions(id),
            FOREIGN KEY (store_id) REFERENCES stores(id)
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_returns_original ON sale_returns(original_transaction_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_returns_created ON sale_returns(created_at)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_returns_store ON sale_returns(store_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_returns_customer ON sale_returns(customer_id)')

        // unit_price is COPIED from the original line, never looked up. A shirt bought
        // at 4 500 DA and returned after a price rise to 5 200 refunds 4 500 (§92).
        // `restock` is false for damaged goods: they come back into the shop but not
        // into sellable stock — they go to stock_losses instead.
        db.exec(`CREATE TABLE IF NOT EXISTS sale_return_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            return_id INTEGER NOT NULL,
            original_item_id INTEGER,
            product_id INTEGER NOT NULL,
            variant_id INTEGER,
            product_name TEXT,
            size TEXT,
            color TEXT,
            quantity REAL NOT NULL,
            unit_price REAL NOT NULL,
            line_total REAL NOT NULL,
            tax_rate REAL DEFAULT 0,
            tax_amount REAL DEFAULT 0,
            restock INTEGER DEFAULT 1,
            item_condition TEXT DEFAULT 'resellable' CHECK(item_condition IN ('resellable', 'damaged')),
            reason TEXT,
            FOREIGN KEY (return_id) REFERENCES sale_returns(id) ON DELETE CASCADE
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_return_items_return ON sale_return_items(return_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_return_items_variant ON sale_return_items(variant_id)')

        // Guards against returning more than was sold — the running total lives on
        // the original line so the check is a single read, not an aggregate.
        addColumn(db, 'transaction_items', 'returned_quantity', 'REAL DEFAULT 0')
        addColumn(db, 'transactions', 'return_status', "TEXT DEFAULT 'none'")
        db.exec("UPDATE transactions SET return_status = 'none' WHERE return_status IS NULL")
        db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_return_status ON transactions(return_status)')
    } catch (e) {
        console.error('Migration 38 (returns/exchanges) failed:', e)
    }
}

// ---------------------------------------------------------------------------
// Migration 39: variant-level stock transfers between stores.
//
// New tables rather than reusing Migration 24's transfer_orders/transfer_items,
// which are product-level and warehouse-scoped. Moving "5 shirts" between shops is
// meaningless — it has to be "5 × M / Black".
//
// Two-phase on purpose: goods physically travel, so there is a window where stock
// has left the source and not yet arrived. Source decrements on SHIPPED, destination
// increments on RECEIVED, and the gap is visible as in-transit rather than silently
// vanishing (brief §20, and the "shipped but never received" edge case in §92).
// ---------------------------------------------------------------------------
function migration39Transfers(db: DB): void {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS stock_transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transfer_number TEXT UNIQUE NOT NULL,
            from_store_id INTEGER NOT NULL,
            to_store_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft'
                CHECK(status IN ('draft', 'requested', 'approved', 'prepared', 'shipped', 'received', 'cancelled')),
            requested_by INTEGER,
            approved_by INTEGER,
            shipped_by INTEGER,
            received_by INTEGER,
            requested_at TEXT,
            approved_at TEXT,
            prepared_at TEXT,
            shipped_at TEXT,
            received_at TEXT,
            cancelled_at TEXT,
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            CHECK (from_store_id != to_store_id),
            FOREIGN KEY (from_store_id) REFERENCES stores(id),
            FOREIGN KEY (to_store_id) REFERENCES stores(id)
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_transfers_status ON stock_transfers(status)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_transfers_from ON stock_transfers(from_store_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_transfers_to ON stock_transfers(to_store_id)')

        // Three quantities, not one: what was asked for, what actually left, and what
        // actually arrived. They differ in real life, and a single column would hide
        // exactly the discrepancy the owner needs to see.
        db.exec(`CREATE TABLE IF NOT EXISTS stock_transfer_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transfer_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            variant_id INTEGER,
            product_name TEXT,
            size TEXT,
            color TEXT,
            sku TEXT,
            quantity_requested REAL NOT NULL DEFAULT 0,
            quantity_shipped REAL DEFAULT 0,
            quantity_received REAL DEFAULT 0,
            unit_cost REAL DEFAULT 0,
            FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_transfer_items_transfer ON stock_transfer_items(transfer_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_transfer_items_variant ON stock_transfer_items(variant_id)')
    } catch (e) {
        console.error('Migration 39 (stock transfers) failed:', e)
    }
}

// ---------------------------------------------------------------------------
// Migration 40: inventory count sessions.
//
// A count is a draft until it is APPLIED. Nothing touches live stock while the shop
// is still counting, because the count takes hours and the shop keeps selling —
// expected_qty is snapshotted per line at the moment that line is counted, and the
// adjustment is the difference against that snapshot (brief §21, §92).
// ---------------------------------------------------------------------------
function migration40InventoryCounts(db: DB): void {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS inventory_counts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            count_number TEXT UNIQUE NOT NULL,
            store_id INTEGER NOT NULL,
            scope TEXT NOT NULL DEFAULT 'full' CHECK(scope IN ('full', 'category', 'selection')),
            category_id INTEGER,
            status TEXT NOT NULL DEFAULT 'draft'
                CHECK(status IN ('draft', 'counting', 'review', 'applied', 'cancelled')),
            started_by INTEGER,
            applied_by INTEGER,
            started_at TEXT DEFAULT (datetime('now')),
            applied_at TEXT,
            notes TEXT,
            FOREIGN KEY (store_id) REFERENCES stores(id)
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_counts_store ON inventory_counts(store_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_counts_status ON inventory_counts(status)')

        db.exec(`CREATE TABLE IF NOT EXISTS inventory_count_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            count_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            variant_id INTEGER,
            product_name TEXT,
            size TEXT,
            color TEXT,
            sku TEXT,
            expected_qty REAL DEFAULT 0,
            counted_qty REAL,
            difference REAL,
            unit_cost REAL DEFAULT 0,
            counted_by INTEGER,
            counted_at TEXT,
            UNIQUE(count_id, product_id, variant_id),
            FOREIGN KEY (count_id) REFERENCES inventory_counts(id) ON DELETE CASCADE
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_count_items_count ON inventory_count_items(count_id)')
    } catch (e) {
        console.error('Migration 40 (inventory counts) failed:', e)
    }
}

// ---------------------------------------------------------------------------
// Migration 43: where the push to the central mirror got up to.
//
// One row per entity, holding a HIGH-WATER MARK rather than a queue of pending
// rows. A queue would need every writer in the app to remember to enqueue, and the
// first one that forgot would silently stop mirroring that table. A watermark is
// derived from the data itself, so nothing can be missed by omission.
//
// Two kinds of mark, because the tables differ:
//
//   • APPEND-ONLY tables (sales, returns) advance on `last_id`. A row id is
//     monotonic and assigned by the database, so `id > last_id` is exact — no
//     clock, no overlap, no possibility of skipping a row written during a push.
//
//   • MUTABLE tables (products, stock) advance on `last_at`, with a deliberate
//     overlap on re-read. A row updated while a push was in flight could otherwise
//     carry a timestamp just before the new mark and never be sent again. Re-sending
//     is free because the far side upserts on a natural key.
//
// The mark advances ONLY after the server confirms the batch. A failed push leaves
// it where it was and the same rows go again.
// ---------------------------------------------------------------------------
function migration43CloudPushState(db: DB): void {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS cloud_push_state (
            entity TEXT PRIMARY KEY,
            last_id INTEGER NOT NULL DEFAULT 0,
            last_at TEXT,
            last_success_at TEXT,
            last_error TEXT,
            rows_pushed INTEGER NOT NULL DEFAULT 0
        )`)
    } catch (e) {
        console.error('Migration 43 (cloud push state) failed:', e)
    }
}

// ---------------------------------------------------------------------------
// Migration 42: freeze cost of goods on the sale line.
//
// THE BUG THIS FIXES. Profit was computed by joining `products` and reading
// `cost_price` — TODAY's purchase price. So the moment a supplier raised a price,
// every margin the shop had ever earned on that garment silently rewrote itself.
// Last month's reported profit changed because of something that happened this
// month, which makes the figure worthless for deciding anything.
//
// The selling price was already frozen on the line (that is why a return refunds
// what was actually paid); the buying price was not. This closes that asymmetry.
//
// NOT BACKFILLED, deliberately. There is no record of what a garment cost when it
// was sold last year, and writing today's cost into those rows would dress a guess
// up as history. Old lines stay NULL and the reports fall back to the current cost
// via COALESCE, exactly as before — but they can now say which rows are estimates.
// ---------------------------------------------------------------------------
function migration42CostOfGoodsSold(db: DB): void {
    try {
        addColumn(db, 'transaction_items', 'unit_cost', 'REAL')
        addColumn(db, 'sale_return_items', 'unit_cost', 'REAL')
    } catch (e) {
        console.error('Migration 42 (COGS snapshot) failed:', e)
    }
}

// ---------------------------------------------------------------------------
// Migration 41: notifications, sales targets, and suit bundles.
// ---------------------------------------------------------------------------
function migration41NotificationsTargetsBundles(db: DB): void {
    try {
        // `dedupe_key` is what stops the notification centre becoming noise: the
        // low-stock sweep runs repeatedly and must re-raise the same alert as ONE
        // row, not one per sweep. Uniqueness is partial (only while unread) so the
        // alert can legitimately fire again after the owner has dismissed it.
        db.exec(`CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'critical', 'success')),
            title TEXT NOT NULL,
            body TEXT,
            store_id INTEGER,
            entity_type TEXT,
            entity_id INTEGER,
            dedupe_key TEXT,
            read_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, created_at)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_store ON notifications(store_id)')
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
                 ON notifications(dedupe_key) WHERE read_at IS NULL AND dedupe_key IS NOT NULL`)

        db.exec(`CREATE TABLE IF NOT EXISTS sales_targets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL CHECK(scope IN ('company', 'store', 'employee')),
            store_id INTEGER,
            user_id INTEGER,
            period_type TEXT NOT NULL DEFAULT 'month' CHECK(period_type IN ('day', 'week', 'month', 'year')),
            period_start TEXT NOT NULL,
            period_end TEXT NOT NULL,
            target_amount REAL NOT NULL,
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(scope, store_id, user_id, period_type, period_start)
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_targets_period ON sales_targets(period_start, period_end)')

        // --- Suits: components + optional set (RETAIL_PLAN.md §3) ---
        //
        // A "Costume Milano" set is a product of type 'bundle' whose components are
        // the jacket product and the trouser product. Selling the set explodes into
        // one sale line per component, each with its OWN variant, so a 52 jacket with
        // a 48 trouser is expressible and both stocks move correctly.
        addColumn(db, 'products', 'product_type', "TEXT DEFAULT 'simple'")
        db.exec("UPDATE products SET product_type = 'simple' WHERE product_type IS NULL")

        db.exec(`CREATE TABLE IF NOT EXISTS bundle_components (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bundle_product_id INTEGER NOT NULL,
            component_product_id INTEGER NOT NULL,
            quantity REAL NOT NULL DEFAULT 1,
            -- 'veste' | 'pantalon' | 'gilet' | 'chemise' | free text. Drives the label
            -- above each size picker at the till, so the cashier is never guessing
            -- which of two identical-looking size dropdowns is the jacket.
            component_role TEXT,
            sort_order INTEGER DEFAULT 0,
            UNIQUE(bundle_product_id, component_product_id),
            CHECK (bundle_product_id != component_product_id),
            FOREIGN KEY (bundle_product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (component_product_id) REFERENCES products(id)
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_bundle_components_bundle ON bundle_components(bundle_product_id)')

        // Links an exploded component line back to the set line it came from, so a
        // receipt can print "Costume Milano" once with its parts indented, and a
        // return can take the whole set back as a unit.
        addColumn(db, 'transaction_items', 'bundle_parent_item_id', 'INTEGER')
        db.exec(`CREATE INDEX IF NOT EXISTS idx_transaction_items_bundle
                 ON transaction_items(bundle_parent_item_id)`)
    } catch (e) {
        console.error('Migration 41 (notifications/targets/bundles) failed:', e)
    }
}

// ---------------------------------------------------------------------------
// Migration 44: employees as real records, and payroll that reaches the books.
//
// `employees` existed from Migration 29 as four columns behind an off-by-default
// payroll flag: name, NCC, base salary, is_btp. That is enough to compute a
// payslip and nothing else — you could not say who someone is, which shop they
// work in, when they were hired, or which till login is theirs.
//
// It also never touched the money. A payslip was computed, stored, and then sat
// in its own table: the shop's expenses did not know salaries existed, so every
// figure that subtracted expenses was wrong by the largest cost the business
// has. That is what `expenses.source_type/source_ref` fixes below.
//
// THE IDEMPOTENCY POINT: the unique index on (source_type, source_ref) is what
// makes "run payroll" safe to press twice. Without it, a second run in the same
// month silently doubles the wage bill, and nothing on screen would say so.
// ---------------------------------------------------------------------------
function migration44Employees(db: DB): void {
    try {
        // -- Who the person is -------------------------------------------------
        addColumn(db, 'employees', 'position', 'TEXT')
        addColumn(db, 'employees', 'phone', 'TEXT')
        addColumn(db, 'employees', 'email', 'TEXT')
        addColumn(db, 'employees', 'address', 'TEXT')
        addColumn(db, 'employees', 'national_id', 'TEXT')
        addColumn(db, 'employees', 'hire_date', 'TEXT')
        addColumn(db, 'employees', 'end_date', 'TEXT')
        // 'cdi' | 'cdd' | 'essai' | 'saisonnier'. Free text rather than a CHECK:
        // Algerian contract vocabulary is not our call to freeze.
        addColumn(db, 'employees', 'contract_type', "TEXT DEFAULT 'cdi'")
        addColumn(db, 'employees', 'notes', 'TEXT')
        addColumn(db, 'employees', 'updated_at', 'TEXT')

        // Which shop pays them. Salaries are a store-scoped cost like every other
        // expense, or the two shops' profitability cannot be compared honestly.
        addColumn(db, 'employees', 'store_id', 'INTEGER')

        // The till login this person uses, when they have one. Nullable on purpose:
        // a cleaner or a tailor is on payroll and never touches the POS, and a
        // seasonal login may outlive the person. Linking them is what lets the
        // Employés screen show sales performance beside the salary.
        addColumn(db, 'employees', 'user_id', 'INTEGER')

        // Recurring pay components, kept apart from the one-off bonus on a payslip
        // so "why is this month different" always has an answer.
        addColumn(db, 'employees', 'allowances', 'REAL DEFAULT 0')

        db.exec('CREATE INDEX IF NOT EXISTS idx_employees_store ON employees(store_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_employees_user ON employees(user_id)')

        // -- Payslip detail ----------------------------------------------------
        addColumn(db, 'payslips', 'bonus', 'REAL DEFAULT 0')
        addColumn(db, 'payslips', 'allowances', 'REAL DEFAULT 0')
        addColumn(db, 'payslips', 'deductions', 'REAL DEFAULT 0')
        // The employer's TOTAL cost: gross + employer CNAS + CACOBATPH. This, not
        // net, is what the business actually spends, and it is what gets posted to
        // expenses. Net is what the employee receives; the difference goes to the
        // state, but it leaves the shop's bank account either way.
        addColumn(db, 'payslips', 'employer_cost', 'REAL DEFAULT 0')
        addColumn(db, 'payslips', 'paid_at', 'TEXT')
        addColumn(db, 'payslips', 'notes', 'TEXT')

        // -- Expenses grow the columns a real ledger needs ---------------------
        addColumn(db, 'expenses', 'category', "TEXT DEFAULT 'divers'")
        addColumn(db, 'expenses', 'store_id', 'INTEGER')
        addColumn(db, 'expenses', 'spent_at', 'TEXT')
        // Provenance. NULL for an expense somebody typed in; 'payroll' for a row
        // this system generated, with source_ref identifying exactly what it came
        // from ('2026-09:7' = September's slip for employee 7).
        addColumn(db, 'expenses', 'source_type', 'TEXT')
        addColumn(db, 'expenses', 'source_ref', 'TEXT')

        // Backfill so date filters and store reports do not silently drop every
        // expense recorded before this migration.
        db.exec("UPDATE expenses SET spent_at = COALESCE(spent_at, created_at)")
        db.exec("UPDATE expenses SET category = 'divers' WHERE category IS NULL")

        db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_spent_at ON expenses(spent_at)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_store ON expenses(store_id)')

        // One generated expense per source. PARTIAL, so the hundreds of manually
        // entered expenses (source_type NULL) are unaffected — SQLite treats NULLs
        // as distinct in a UNIQUE index anyway, but saying it explicitly documents
        // that the constraint is about generated rows only.
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_source
                 ON expenses(source_type, source_ref)
                 WHERE source_type IS NOT NULL`)
    } catch (e) {
        console.error('Migration 44 (employees/payroll-to-expenses) failed:', e)
    }
}

// ---------------------------------------------------------------------------
// Migration 45: the default account carries the shop's name, not "Owner".
//
// The first user was seeded as 'Owner' — English, in a French app, and shown in
// the sidebar, on every sale as the vendeur, and in the audit trail.
//
// Guarded on the CURRENT name, not just the id: this re-runs on every boot like
// every other migration, and once the shop renames the account to a real
// person's name we must never overwrite that on the next launch.
// ---------------------------------------------------------------------------
function migration45DefaultAccountName(db: DB): void {
    try {
        db.prepare("UPDATE users SET name = 'Dapper' WHERE id = 1 AND name = 'Owner'").run()
    } catch (e) {
        console.error('Migration 45 (default account name) failed:', e)
    }
}

// ---------------------------------------------------------------------------
// Migration 46: guarantee the suppliers table carries every column the LAN sync
// reads. core/schema.sql declares the full supplier record, but the inline
// fallback schema in initDatabase() only creates id/company_name/contact_name/
// phone/is_active. A database born from that fallback (or an old one persisted
// through a reinstall) makes `/sync/suppliers` throw "no such column: email"
// and return 500, which the phone surfaces as "Sync suppliers failed".
// ---------------------------------------------------------------------------
function migration46SupplierColumns(db: DB): void {
    try {
        addColumn(db, 'suppliers', 'contact_name', 'TEXT')
        addColumn(db, 'suppliers', 'phone', 'TEXT')
        addColumn(db, 'suppliers', 'email', 'TEXT')
        addColumn(db, 'suppliers', 'website', 'TEXT')
        addColumn(db, 'suppliers', 'address', 'TEXT')
        addColumn(db, 'suppliers', 'city', 'TEXT')
        addColumn(db, 'suppliers', 'country', 'TEXT')
        addColumn(db, 'suppliers', 'tax_id', 'TEXT')
        addColumn(db, 'suppliers', 'is_active', 'INTEGER DEFAULT 1')
    } catch (e) {
        console.error('Migration 46 (supplier columns) failed:', e)
    }
}

// ---------------------------------------------------------------------------
// Migration 47: who is talking to THIS machine's LAN sync server.
//
// `pos_terminals` records the desktop tills a shop has deliberately registered.
// It says nothing about the phones and tablets that hit the Fastify server on
// port 4000 to pull the catalogue, push a sale, or ask for a print — those never
// register, they just present the shared pairing token. The Network screen needs
// to answer "which devices are on my shop wifi right now, and what did each one
// last do", so every authenticated request upserts a row here.
//
// Keyed on the device's own stable id when it sends one (the mobile app mints and
// stores one), and on the IP+user-agent otherwise, so an older client that sends
// no identity still shows up instead of being invisible. This is a MONITOR, not
// an auth boundary: it records who said they were where, and the pairing token is
// still what actually guards the data.
//
// Deliberately NOT keyed on a foreign key to anything: a phone is not a store,
// not a terminal and not a user, and forcing it into one of those would mislabel
// it. It stands alone and is pruned by age, not by cascade.
// ---------------------------------------------------------------------------
function migration47ConnectedDevices(db: DB): void {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS connected_devices (
            device_key TEXT PRIMARY KEY,
            device_id TEXT,
            device_name TEXT,
            device_type TEXT,
            ip_address TEXT,
            user_agent TEXT,
            last_endpoint TEXT,
            request_count INTEGER NOT NULL DEFAULT 0,
            first_seen_at TEXT DEFAULT (datetime('now')),
            last_seen_at TEXT DEFAULT (datetime('now'))
        )`)
        db.exec('CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON connected_devices(last_seen_at)')
    } catch (e) {
        console.error('Migration 47 (connected devices) failed:', e)
    }
}
