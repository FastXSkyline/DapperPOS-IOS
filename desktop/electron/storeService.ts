import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// Stores and POS terminals.
//
// A store is a selling location: its own stock, its own till, its own staff. This
// is NOT the dormant `warehouses` table from Migration 24 — that one is
// product-level and models dépôts for the retired B2B domain (see PROJECT.md §1).
//
// DEVICE IDENTITY: which store and terminal *this PC* is lives in the `config`
// table, not in a file the installer writes, because config already survives
// upgrades and is already where the LAN pairing token and cloud credentials live.
// A PC that has never been assigned falls back to the default store, so a fresh
// single-shop install works before anyone opens Settings.
// ---------------------------------------------------------------------------

export interface Store {
    id: number
    code: string
    name: string
    store_type: string
    address: string | null
    city: string | null
    phone: string | null
    email: string | null
    nif: string | null
    nis: string | null
    rc: string | null
    article_imposition: string | null
    is_default: number
    is_active: number
    sort_order: number
}

export interface PosTerminal {
    id: number
    store_id: number
    code: string
    name: string | null
    device_id: string | null
    is_server: number
    is_active: number
    last_seen_at: string | null
    store_name?: string
}

function readConfig(key: string): string | null {
    const row = getDatabase().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
}

function writeConfig(key: string, value: string): void {
    getDatabase().prepare(`
        INSERT INTO config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value)
}

export const StoreService = {
    list(includeInactive = false): Store[] {
        return getDatabase().prepare(`
            SELECT * FROM stores ${includeInactive ? '' : 'WHERE is_active = 1'}
            ORDER BY sort_order, id
        `).all() as Store[]
    },

    getById(id: number): Store | undefined {
        return getDatabase().prepare('SELECT * FROM stores WHERE id = ?').get(id) as Store | undefined
    },

    create(data: Partial<Store> & { code: string; name: string }): number {
        const db = getDatabase()
        const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM stores').get() as any).m
        const res = db.prepare(`
            INSERT INTO stores (code, name, store_type, address, city, phone, email,
                                nif, nis, rc, article_imposition, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            data.code.trim().toUpperCase(), data.name.trim(), data.store_type ?? 'retail',
            data.address ?? null, data.city ?? null, data.phone ?? null, data.email ?? null,
            data.nif ?? null, data.nis ?? null, data.rc ?? null, data.article_imposition ?? null,
            maxOrder + 1,
        )
        return Number(res.lastInsertRowid)
    },

    update(id: number, data: Partial<Store>): void {
        const allowed = ['code', 'name', 'store_type', 'address', 'city', 'phone', 'email',
                         'nif', 'nis', 'rc', 'article_imposition', 'is_active', 'sort_order'] as const
        const sets: string[] = []
        const params: any[] = []
        for (const k of allowed) {
            if (data[k] !== undefined) { sets.push(`${k} = ?`); params.push((data as any)[k]) }
        }
        if (!sets.length) return
        params.push(id)
        getDatabase().prepare(
            `UPDATE stores SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`
        ).run(...params)
    },

    /**
     * Deactivate, never delete. Sales, stock movements and cash sessions all point
     * at the store; deleting the row would orphan years of history and break every
     * report that groups by store. `is_active = 0` hides it from pickers instead.
     */
    deactivate(id: number): void {
        const remaining = (getDatabase().prepare(
            'SELECT COUNT(*) AS n FROM stores WHERE is_active = 1 AND id != ?'
        ).get(id) as any).n
        if (remaining === 0) throw new Error('Impossible de désactiver le dernier magasin actif')
        getDatabase().prepare("UPDATE stores SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(id)
    },

    // --- Device identity ----------------------------------------------------

    /** The store this PC sells for. Falls back to the default store so a fresh
     *  install is usable before anyone configures anything. */
    getCurrentStoreId(): number {
        const configured = readConfig('current_store_id')
        if (configured) {
            const exists = getDatabase()
                .prepare('SELECT 1 AS ok FROM stores WHERE id = ? AND is_active = 1')
                .get(Number(configured))
            if (exists) return Number(configured)
        }
        const def = getDatabase()
            .prepare('SELECT id FROM stores WHERE is_active = 1 ORDER BY is_default DESC, sort_order, id LIMIT 1')
            .get() as { id: number } | undefined
        return def?.id ?? 1
    },

    getCurrentStore(): Store | undefined {
        return this.getById(this.getCurrentStoreId())
    },

    setCurrentStore(storeId: number): void {
        if (!this.getById(storeId)) throw new Error(`Magasin ${storeId} introuvable`)
        writeConfig('current_store_id', String(storeId))
    },

    getCurrentTerminalId(): number | null {
        const configured = readConfig('current_terminal_id')
        if (!configured) return null
        const exists = getDatabase().prepare('SELECT 1 AS ok FROM pos_terminals WHERE id = ?').get(Number(configured))
        return exists ? Number(configured) : null
    },

    setCurrentTerminal(terminalId: number): void {
        const t = getDatabase().prepare('SELECT store_id FROM pos_terminals WHERE id = ?').get(terminalId) as any
        if (!t) throw new Error(`Terminal ${terminalId} introuvable`)
        writeConfig('current_terminal_id', String(terminalId))
        // A terminal belongs to exactly one store, so choosing the terminal settles
        // the store too. Keeping them in sync here removes a whole class of "sale
        // recorded against the wrong shop" bugs.
        writeConfig('current_store_id', String(t.store_id))
    },

    // --- Terminals ----------------------------------------------------------

    listTerminals(storeId?: number): PosTerminal[] {
        const where = storeId != null ? 'WHERE t.store_id = ?' : ''
        return getDatabase().prepare(`
            SELECT t.*, s.name AS store_name
            FROM pos_terminals t
            LEFT JOIN stores s ON s.id = t.store_id
            ${where}
            ORDER BY t.store_id, t.code
        `).all(...(storeId != null ? [storeId] : [])) as PosTerminal[]
    },

    /**
     * Register this PC as a terminal, keyed on a stable machine fingerprint so a
     * reinstall reclaims the same terminal instead of creating POS-01, POS-02,
     * POS-03… every time the app is reinstalled on the same machine.
     */
    registerTerminal(storeId: number, deviceId: string, name?: string, isServer = false): PosTerminal {
        const db = getDatabase()
        const existing = db.prepare('SELECT * FROM pos_terminals WHERE device_id = ?').get(deviceId) as PosTerminal | undefined
        if (existing) {
            db.prepare("UPDATE pos_terminals SET store_id = ?, last_seen_at = datetime('now'), is_active = 1 WHERE id = ?")
                .run(storeId, existing.id)
            return { ...existing, store_id: storeId }
        }

        const n = (db.prepare('SELECT COUNT(*) AS n FROM pos_terminals WHERE store_id = ?').get(storeId) as any).n
        const code = `POS-${String(n + 1).padStart(2, '0')}`
        const res = db.prepare(`
            INSERT INTO pos_terminals (store_id, code, name, device_id, is_server, last_seen_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
        `).run(storeId, code, name ?? `Caisse ${n + 1}`, deviceId, isServer ? 1 : 0)
        return db.prepare('SELECT * FROM pos_terminals WHERE id = ?').get(Number(res.lastInsertRowid)) as PosTerminal
    },

    touchTerminal(terminalId: number): void {
        getDatabase().prepare("UPDATE pos_terminals SET last_seen_at = datetime('now') WHERE id = ?").run(terminalId)
    },

    // --- Employee ↔ store ---------------------------------------------------

    /**
     * Stores this user may work in. An empty user_stores set means "no restriction",
     * so only the restrictive cases need rows — an owner is not required to be
     * enrolled in every store the business ever opens.
     */
    getUserStores(userId: number): Store[] {
        const db = getDatabase()
        const rows = db.prepare(`
            SELECT s.* FROM user_stores us
            JOIN stores s ON s.id = us.store_id
            WHERE us.user_id = ? AND s.is_active = 1
            ORDER BY s.sort_order, s.id
        `).all(userId) as Store[]
        return rows.length ? rows : this.list()
    },

    canAccessStore(userId: number, storeId: number): boolean {
        const restricted = getDatabase()
            .prepare('SELECT COUNT(*) AS n FROM user_stores WHERE user_id = ?')
            .get(userId) as any
        if (restricted.n === 0) return true
        return getDatabase()
            .prepare('SELECT 1 AS ok FROM user_stores WHERE user_id = ? AND store_id = ?')
            .get(userId, storeId) !== undefined
    },

    setUserStores(userId: number, storeIds: number[]): void {
        const db = getDatabase()
        db.transaction(() => {
            db.prepare('DELETE FROM user_stores WHERE user_id = ?').run(userId)
            const ins = db.prepare('INSERT OR IGNORE INTO user_stores (user_id, store_id) VALUES (?, ?)')
            for (const id of storeIds) ins.run(userId, id)
        })()
    },
}
