import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Loaded through createRequire rather than a static import: `node:sqlite` is newer
// than Vite's built-in module list, so Vite tries to resolve it from disk and fails.
// createRequire hands it straight to Node at runtime, past the transform.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

// ---------------------------------------------------------------------------
// Test harness for schema/SQL work.
//
// better-sqlite3 is compiled against Electron's ABI and cannot be required from
// plain node, so tests run the SAME SQL against node:sqlite instead. The two
// drivers share the SQLite engine and a near-identical prepare/run/get/all API;
// the only gap that matters here is `.transaction()`, which better-sqlite3 adds
// and node:sqlite does not — shimmed below.
//
// This is the bar PROJECT.md sets: money and stock SQL is verified against real
// SQLite, not just typechecked.
// ---------------------------------------------------------------------------

/**
 * better-sqlite3's `.transaction()` on top of node:sqlite.
 *
 * Nesting is modelled with SAVEPOINTs exactly as better-sqlite3 does, and that is
 * not a nicety: the real code nests. ReturnService wraps the whole refund in a
 * transaction and calls nextDocNumber(), which opens one of its own. A shim that
 * issued a bare inner BEGIN would fail with "cannot start a transaction within a
 * transaction" — reporting a bug the production driver does not have — while a
 * shim that ignored the inner transaction would hide a rollback that really does
 * need to unwind only part of the work.
 */
function addTransactionShim(db: any): any {
    let depth = 0
    db.transaction = (fn: (...args: any[]) => any) => (...args: any[]) => {
        const savepoint = `sp_${depth}`
        const outermost = depth === 0
        db.exec(outermost ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
        depth++
        try {
            const result = fn(...args)
            depth--
            db.exec(outermost ? 'COMMIT' : `RELEASE ${savepoint}`)
            return result
        } catch (e) {
            depth--
            db.exec(outermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
            throw e
        }
    }
    return db
}

/**
 * An in-memory database carrying the shared base schema plus the tables that
 * migrations 1–33 add in database.ts. The retail migrations guard every table
 * they touch, so this only has to be faithful enough to exercise the real paths.
 */
export function makeTestDb(): any {
    const db = new DatabaseSync(':memory:')
    const schemaPath = path.resolve(__dirname, '../../../core/schema.sql')
    db.exec(fs.readFileSync(schemaPath, 'utf8'))

    // Tables created by migrations 5, 28, 31 and 33 rather than by core/schema.sql.
    // Only the columns the retail migrations read or alter are reproduced.
    db.exec(`
        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            amount REAL NOT NULL,
            created_by INTEGER,
            category TEXT, notes TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        -- Migration 29: the payroll module. Reproduced because Migration 44 alters
        -- both tables and because PayrollService posts the wage bill into
        -- the expenses table — the one path where an off-by-one is a doubled salary.
        CREATE TABLE IF NOT EXISTS employees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            ncc TEXT,
            base_salary REAL DEFAULT 0,
            is_btp INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS payslips (
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
        );
        CREATE TABLE IF NOT EXISTS cash_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_number TEXT UNIQUE,
            opened_at TEXT DEFAULT (datetime('now')),
            closed_at TEXT, opening_float REAL DEFAULT 0,
            counted_cash REAL, expected_cash REAL, variance REAL,
            opened_by INTEGER, closed_by INTEGER, notes TEXT,
            status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed'))
        );
        CREATE TABLE IF NOT EXISTS stock_losses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL, variant_id INTEGER,
            quantity REAL NOT NULL, total_cost REAL DEFAULT 0,
            reason TEXT DEFAULT 'other',
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER, product_id INTEGER, variant_id INTEGER,
            quantity REAL DEFAULT 0, deposit REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS doc_sequences (
            doc_type TEXT NOT NULL, year INTEGER NOT NULL,
            last_number INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (doc_type, year)
        );
    `)

    // Columns that migrations 1–33 ADD to tables core/schema.sql already declares.
    // Without these the sale path fails on "no such column: unite" and similar —
    // failures that say nothing about the code under test, only that the fixture is
    // thinner than a real shop database. Grouped by the migration that introduced
    // them so the list stays traceable.
    const added: [string, string, string][] = [
        // Migration 7/10 — inventory fields inherited from the old distributor domain
        ['products', 'unite', "TEXT DEFAULT 'piece'"],
        ['products', 'reference', 'TEXT'],
        ['products', 'marque', 'TEXT'],
        ['products', 'devation', 'TEXT'],
        ['products', 'designation_fournisseur', 'TEXT'],
        ['products', 'qtes_cmnds', 'REAL DEFAULT 0'],
        ['products', 'delai_livraison', 'INTEGER DEFAULT 0'],
        // Migration 18 — dormant wholesale tiers, still written by ProductService.create
        ['products', 'semi_wholesale_price', 'REAL DEFAULT 0'],
        // Migration 17 — droit de timbre on cash invoices
        ['transactions', 'timbre', 'REAL DEFAULT 0'],
        // Migration 25 — commercial document flow
        ['transactions', 'doc_type', "TEXT DEFAULT 'sale'"],
        ['transactions', 'source_doc_id', 'INTEGER'],
        // Migrations 20 & 22 — pre-break unit price, and the selling unit per line
        ['transaction_items', 'base_unit_price', 'REAL'],
        ['transaction_items', 'unit', 'TEXT'],
        ['transaction_items', 'unit_factor', 'REAL DEFAULT 1'],
        // Migration 33 — loyalty balance on the customer
        ['customers', 'loyalty_points', 'REAL DEFAULT 0'],
        ['customers', 'loyalty_card_number', 'TEXT'],
    ]
    for (const [table, column, definition] of added) {
        const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name)
        if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }

    // Migration 33 — the loyalty ledger. UNIQUE(transaction_id, direction) is what
    // makes earning idempotent, so it must be reproduced exactly.
    db.exec(`CREATE TABLE IF NOT EXISTS loyalty_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        transaction_id INTEGER,
        direction TEXT NOT NULL CHECK(direction IN ('earn', 'redeem', 'adjust')),
        points REAL NOT NULL,
        note TEXT,
        user_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(transaction_id, direction)
    )`)

    // core/schema.sql declares product_variants in the legacy EAV shape; Migration
    // 30 replaces it with the size × colour shape everything now assumes.
    db.exec('DROP TABLE IF EXISTS product_variants')
    db.exec(`CREATE TABLE product_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        size TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '',
        sku TEXT, barcode TEXT,
        cost_price REAL, retail_price REAL,
        sort_order INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(product_id, size, color),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )`)

    return addTransactionShim(db)
}

/** Column names of a table — the assertion workhorse for additive migrations. */
export function columnsOf(db: any, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name)
}

export function tableExists(db: any, name: string): boolean {
    return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
}

export function indexExists(db: any, name: string): boolean {
    return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='index' AND name=?").get(name) !== undefined
}
