import { describe, it, expect, beforeEach } from 'vitest'
import { runRetailMigrations } from '../electron/migrationsRetail'
import { makeTestDb, columnsOf, tableExists, indexExists } from './helpers/sqliteHarness'

// Migrations 34–41 run against real SQLite. The point of these tests is not that
// the SQL parses — it is that the migrations are safe to re-run every boot on a
// database that already holds a shop's data, which is the contract database.ts
// makes and the way a bad migration destroys a business.

describe('retail migrations — structure', () => {
    let db: any
    beforeEach(() => {
        db = makeTestDb()
        runRetailMigrations(db)
    })

    it('creates every new table', () => {
        for (const t of [
            'stores', 'pos_terminals', 'user_stores',
            'permissions', 'role_permissions', 'role_limits',
            'audit_logs', 'brands', 'sizes', 'colors',
            'sale_returns', 'sale_return_items',
            'stock_transfers', 'stock_transfer_items',
            'inventory_counts', 'inventory_count_items',
            'notifications', 'sales_targets', 'bundle_components',
        ]) {
            expect(tableExists(db, t), `missing table ${t}`).toBe(true)
        }
    })

    it('adds store_id to every store-scoped table', () => {
        for (const t of ['transactions', 'stock_inventory', 'stock_movements',
                         'expenses', 'cash_sessions', 'stock_losses', 'reservations']) {
            expect(columnsOf(db, t), `${t} missing store_id`).toContain('store_id')
        }
        expect(columnsOf(db, 'transactions')).toContain('terminal_id')
        expect(columnsOf(db, 'cash_sessions')).toContain('terminal_id')
    })

    it('adds the return-tracking columns without rebuilding transactions', () => {
        expect(columnsOf(db, 'transaction_items')).toContain('returned_quantity')
        expect(columnsOf(db, 'transactions')).toContain('return_status')
        // The original CHECK on status must be untouched — rebuilding that table is
        // exactly what these migrations promise not to do.
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='transactions'").get() as any).sql
        expect(sql).toContain("'refunded'")
    })

    it('seeds the two stores with Costume as default', () => {
        const stores = db.prepare('SELECT code, name, is_default FROM stores ORDER BY sort_order').all() as any[]
        expect(stores.map(s => s.code)).toEqual(['CST', 'CAS'])
        expect(stores[0].is_default).toBe(1)
        expect(stores[1].is_default).toBe(0)
    })

    it('seeds suit sizes as an ordered, separate scale from alpha sizes', () => {
        const suit = db.prepare("SELECT name FROM sizes WHERE size_group='suit' ORDER BY sort_order").all() as any[]
        expect(suit.map(s => s.name)).toEqual(['44', '46', '48', '50', '52', '54', '56', '58', '60'])

        const alpha = db.prepare("SELECT name FROM sizes WHERE size_group='alpha' ORDER BY sort_order").all() as any[]
        expect(alpha.map(s => s.name)).toEqual(['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'])
    })

    it('grants a cashier selling rights but not refunds, prices or audit', () => {
        const has = (role: string, code: string) =>
            db.prepare('SELECT 1 AS ok FROM role_permissions WHERE role=? AND permission_code=?').get(role, code) !== undefined

        expect(has('cashier', 'sales.create')).toBe(true)
        expect(has('cashier', 'sales.exchange')).toBe(true)
        expect(has('cashier', 'sales.refund')).toBe(false)
        expect(has('cashier', 'products.price')).toBe(false)
        expect(has('cashier', 'audit.view')).toBe(false)
        expect(has('cashier', 'inventory.adjust')).toBe(false)

        expect(has('manager', 'sales.refund')).toBe(true)
        expect(has('manager', 'settings.manage')).toBe(false)
        expect(has('owner', 'settings.manage')).toBe(true)
        expect(has('owner', 'audit.view')).toBe(true)
    })

    it('caps discounts per role as the brief specifies', () => {
        const cap = (role: string) =>
            (db.prepare('SELECT max_discount_percent AS p FROM role_limits WHERE role=?').get(role) as any).p
        expect(cap('cashier')).toBe(5)
        expect(cap('manager')).toBe(20)
        expect(cap('owner')).toBe(100)
    })

    it('refuses a transfer from a store to itself', () => {
        expect(() => db.prepare(
            `INSERT INTO stock_transfers (transfer_number, from_store_id, to_store_id) VALUES ('TRF-1', 1, 1)`
        ).run()).toThrow()
        expect(() => db.prepare(
            `INSERT INTO stock_transfers (transfer_number, from_store_id, to_store_id) VALUES ('TRF-2', 1, 2)`
        ).run()).not.toThrow()
    })

    it('refuses a bundle that contains itself', () => {
        db.prepare("INSERT INTO products (id, name) VALUES (1, 'Costume Milano')").run()
        expect(() => db.prepare(
            'INSERT INTO bundle_components (bundle_product_id, component_product_id) VALUES (1, 1)'
        ).run()).toThrow()
    })
})

describe('retail migrations — idempotency', () => {
    // Every migration re-runs on every boot. This is the property that matters most:
    // the third boot must leave the database exactly as the first one did.
    it('survives three consecutive runs without duplicating seed data', () => {
        const db = makeTestDb()
        runRetailMigrations(db)
        runRetailMigrations(db)
        runRetailMigrations(db)

        const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n
        expect(count('stores')).toBe(2)
        expect(count('pos_terminals')).toBe(1)
        expect(count('sizes')).toBe(7 + 9 + 11 + 8 + 1)  // alpha + suit + numeric + shoe + unique
        expect(count('colors')).toBe(15)
        expect(count('role_limits')).toBe(5)
    })

    it('does not restore a permission the owner revoked', () => {
        const db = makeTestDb()
        runRetailMigrations(db)

        db.prepare("DELETE FROM role_permissions WHERE role='cashier' AND permission_code='sales.discount'").run()
        runRetailMigrations(db)

        const back = db.prepare(
            "SELECT 1 AS ok FROM role_permissions WHERE role='cashier' AND permission_code='sales.discount'"
        ).get()
        expect(back, 'a reboot silently re-granted a revoked permission').toBeUndefined()
    })

    it('does not rename stores the owner has renamed', () => {
        const db = makeTestDb()
        runRetailMigrations(db)
        db.prepare("UPDATE stores SET name='Elegance Costume' WHERE code='CST'").run()
        runRetailMigrations(db)
        const name = (db.prepare("SELECT name FROM stores WHERE code='CST'").get() as any).name
        expect(name).toBe('Elegance Costume')
    })
})

describe('retail migrations — existing data', () => {
    it('attributes pre-existing rows to store 1', () => {
        const db = makeTestDb()
        // user 1 ('Owner') is seeded by core/schema.sql — a genuinely pre-existing row.
        db.prepare("INSERT INTO products (id, name) VALUES (1, 'Chemise Oxford')").run()
        db.prepare(`INSERT INTO transactions (id, transaction_number, user_id, status)
                    VALUES (1, 'TX-1', 1, 'completed')`).run()
        db.prepare('INSERT INTO stock_inventory (product_id, quantity) VALUES (1, 7)').run()

        runRetailMigrations(db)

        expect((db.prepare('SELECT store_id AS s FROM transactions WHERE id=1').get() as any).s).toBe(1)
        expect((db.prepare('SELECT store_id AS s FROM stock_inventory WHERE product_id=1').get() as any).s).toBe(1)
        expect((db.prepare('SELECT home_store_id AS s FROM users WHERE id=1').get() as any).s).toBe(1)
    })

    it('merges duplicate stock rows before enforcing uniqueness, preserving total quantity', () => {
        // The live database has no uniqueness on stock_inventory, so duplicates are
        // possible and their quantities are both real stock. Summing is the only
        // reconciliation that does not lose goods.
        const db = makeTestDb()
        db.prepare("INSERT INTO products (id, name) VALUES (1, 'Polo Premium')").run()
        db.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (1, 1, 'M', 'Noir')").run()
        db.prepare('INSERT INTO stock_inventory (product_id, variant_id, quantity) VALUES (1, 1, 4)').run()
        db.prepare('INSERT INTO stock_inventory (product_id, variant_id, quantity) VALUES (1, 1, 3)').run()
        db.prepare('INSERT INTO stock_inventory (product_id, variant_id, quantity) VALUES (1, NULL, 2)').run()
        db.prepare('INSERT INTO stock_inventory (product_id, variant_id, quantity) VALUES (1, NULL, 5)').run()

        runRetailMigrations(db)

        const rows = db.prepare(
            'SELECT variant_id, quantity FROM stock_inventory WHERE product_id=1 ORDER BY variant_id'
        ).all() as any[]
        expect(rows).toHaveLength(2)
        expect(rows.find(r => r.variant_id === 1).quantity).toBe(7)
        expect(rows.find(r => r.variant_id === null).quantity).toBe(7)
        expect(indexExists(db, 'idx_stock_inventory_unique')).toBe(true)
    })

    it('makes a second stock row for the same variant in the same store impossible', () => {
        const db = makeTestDb()
        db.prepare("INSERT INTO products (id, name) VALUES (1, 'Veste Slim')").run()
        db.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (1, 1, '50', 'Bleu Marine')").run()
        runRetailMigrations(db)

        db.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (1, 1, 1, 3)').run()
        expect(() => db.prepare(
            'INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (1, 1, 1, 9)'
        ).run(), 'duplicate variant stock row was allowed').toThrow()

        // NULL variant_id must collide too — SQLite treats NULLs as distinct in a
        // plain UNIQUE index, which is why the index is on COALESCE(variant_id, 0).
        db.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (1, 1, NULL, 1)').run()
        expect(() => db.prepare(
            'INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (1, 1, NULL, 1)'
        ).run(), 'duplicate NULL-variant stock row was allowed').toThrow()

        // The same variant in the OTHER store is a different row, and must be allowed.
        expect(() => db.prepare(
            'INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (2, 1, 1, 4)'
        ).run()).not.toThrow()
    })

    it('backfills sizes and colours the catalogue already uses', () => {
        const db = makeTestDb()
        db.prepare("INSERT INTO products (id, name) VALUES (1, 'Chemise Lin')").run()
        db.prepare("INSERT INTO product_variants (product_id, size, color) VALUES (1, 'M', 'Corail')").run()
        db.prepare("INSERT INTO product_variants (product_id, size, color) VALUES (1, '37', 'Corail')").run()

        runRetailMigrations(db)

        // A colour the seed palette does not know about is adopted.
        expect(db.prepare("SELECT 1 AS ok FROM colors WHERE name='Corail'").get()).toBeDefined()
        // A size that matches nothing known lands in 'other' rather than being guessed
        // into the wrong scale — 37 could be a shoe or a waist.
        const s37 = db.prepare("SELECT size_group AS g FROM sizes WHERE name='37'").get() as any
        expect(s37.g).toBe('other')
        // 'M' already exists in the alpha scale and must not be duplicated into 'other'.
        const mRows = db.prepare("SELECT COUNT(*) AS n FROM sizes WHERE name='M'").get() as any
        expect(mRows.n).toBe(1)
    })

    it('deduplicates unread notifications by key but allows a re-alert after dismissal', () => {
        const db = makeTestDb()
        runRetailMigrations(db)
        const ins = db.prepare(
            "INSERT INTO notifications (type, severity, title, dedupe_key) VALUES ('low_stock','warning',?,?)"
        )
        ins.run('Stock bas: Costume Milano 52', 'low_stock:1:52')
        expect(() => ins.run('Stock bas: Costume Milano 52', 'low_stock:1:52')).toThrow()

        db.prepare("UPDATE notifications SET read_at = datetime('now')").run()
        expect(() => ins.run('Stock bas: Costume Milano 52', 'low_stock:1:52')).not.toThrow()
    })
})

describe('the default account name (migration 45)', () => {
    let db: any
    beforeEach(() => { db = makeTestDb() })

    const nameOfUser1 = () =>
        (db.prepare('SELECT name FROM users WHERE id = 1').get() as { name: string } | undefined)?.name

    it('renames the seeded Owner account to the shop', () => {
        db.prepare("INSERT OR REPLACE INTO users (id, name, pin, role) VALUES (1, 'Owner', '1234', 'owner')").run()
        runRetailMigrations(db)
        expect(nameOfUser1()).toBe('Dapper')
    })

    // THE POINT OF THE GUARD. This migration re-runs on every boot like every
    // other one. Keying it on the id alone would rewrite the shop's own name for
    // that account every single launch — the owner types "Ilyes", and it is
    // "Dapper" again tomorrow morning with no explanation.
    it('never overwrites a name the shop has chosen', () => {
        db.prepare("INSERT OR REPLACE INTO users (id, name, pin, role) VALUES (1, 'Ilyes', '1234', 'owner')").run()
        runRetailMigrations(db)
        runRetailMigrations(db)
        expect(nameOfUser1()).toBe('Ilyes')
    })

    it('is safe to re-run once it has already renamed', () => {
        db.prepare("INSERT OR REPLACE INTO users (id, name, pin, role) VALUES (1, 'Owner', '1234', 'owner')").run()
        runRetailMigrations(db)
        runRetailMigrations(db)
        expect(nameOfUser1()).toBe('Dapper')
        expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n).toBe(1)
    })

    it('leaves other users alone', () => {
        db.prepare("INSERT OR REPLACE INTO users (id, name, pin, role) VALUES (1, 'Owner', '1234', 'owner')").run()
        db.prepare("INSERT INTO users (id, name, pin, role) VALUES (2, 'Owner', '5678', 'cashier')").run()
        runRetailMigrations(db)
        expect(nameOfUser1()).toBe('Dapper')
        // Only the seeded id-1 account is the app's own default; a second person
        // who happens to share the name is a real employee.
        expect((db.prepare('SELECT name FROM users WHERE id = 2').get() as any).name).toBe('Owner')
    })
})
