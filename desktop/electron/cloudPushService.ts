import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// Push to the central PostgreSQL mirror behind the owner's website (Phase 10).
//
// WHY AN HTTP ENDPOINT AND NOT A DIRECT POSTGRES CONNECTION. cPanel binds
// PostgreSQL to localhost; opening it to the internet means a host allowlist that
// a shop's dynamic ADSL address keeps invalidating, and it would put database
// credentials inside a desktop installer anyone can unpack. So the shop POSTs
// batches to a small endpoint on the site, and the site — which is already next to
// the database — writes them. See docs/CLOUD_MIRROR.md for the contract and the
// PostgreSQL DDL.
//
// THE MIRROR IS READ-ONLY, DOWNSTREAM, AND NEVER AUTHORITATIVE. SQLite in the shop
// stays the system of record. Nothing here reads back; nothing in the shop waits
// on it. A push that fails is retried, and the tills never notice.
//
// IDEMPOTENCY IS THE FAR SIDE'S JOB, BY NATURAL KEY. Every row carries a stable
// business key — `transaction_number`, `return_number`, `sku` — and the endpoint
// upserts on it. That is what makes a retry safe: the same batch sent twice is the
// same rows written twice, not duplicated. It is also why a failed push can simply
// resend rather than needing to work out what got through.
//
// BATCHES ARE BOUNDED. A shop that has been offline for a month must not try to
// POST a year of sales in one request and time out forever, so each entity is
// capped and the watermark walks forward one batch at a time.
// ---------------------------------------------------------------------------

export interface PushConfig {
    url: string
    secret: string
    /** Identifies this business on a shared endpoint. */
    shopId: string
    enabled: boolean
}

/** Per entity: how many rows go in one request. */
const BATCH_LIMIT = 500

/** How many rows of each entity a batch carries. Named so `isEmpty` can be typed
 *  without referring back to `buildBatch`'s return type, which would make the
 *  service object self-referential and untypeable. */
export interface BatchCounts {
    stores: number
    sales: number
    saleItems: number
    returns: number
    products: number
    variants: number
    stock: number
}

/**
 * Re-read window for mutable tables, in minutes.
 *
 * A row updated while a push was in flight can carry a timestamp fractionally
 * before the mark we are about to write, and would then never be sent again.
 * Overlapping the read closes that hole; re-sending is free because the far side
 * upserts.
 */
const OVERLAP_MINUTES = 10

const cfgKeys: Record<keyof Omit<PushConfig, 'enabled'>, string> = {
    url: 'cloud_push_url',
    secret: 'cloud_push_secret',
    shopId: 'cloud_push_shop_id',
}

function readCfg(key: string): string {
    const row = getDatabase().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? ''
}

function writeCfg(key: string, value: string): void {
    getDatabase().prepare(`
        INSERT INTO config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value)
}

function state(entity: string): { last_id: number; last_at: string | null } {
    const db = getDatabase()
    db.prepare('INSERT OR IGNORE INTO cloud_push_state (entity) VALUES (?)').run(entity)
    return db.prepare('SELECT last_id, last_at FROM cloud_push_state WHERE entity = ?')
        .get(entity) as { last_id: number; last_at: string | null }
}

function advance(entity: string, lastId: number, lastAt: string | null, rows: number): void {
    getDatabase().prepare(`
        UPDATE cloud_push_state
           SET last_id = ?, last_at = ?, last_success_at = datetime('now'),
               last_error = NULL, rows_pushed = rows_pushed + ?
         WHERE entity = ?
    `).run(lastId, lastAt, rows, entity)
}

function recordError(entity: string, message: string): void {
    const db = getDatabase()
    db.prepare('INSERT OR IGNORE INTO cloud_push_state (entity) VALUES (?)').run(entity)
    db.prepare('UPDATE cloud_push_state SET last_error = ? WHERE entity = ?').run(message, entity)
}

/** `datetime` minus the overlap, in SQLite's text format. */
function withOverlap(at: string | null): string {
    if (!at) return '1970-01-01 00:00:00'
    return (getDatabase()
        .prepare(`SELECT datetime(?, '-${OVERLAP_MINUTES} minutes') AS v`)
        .get(at) as { v: string }).v
}

export const CloudPushService = {
    getConfig(): PushConfig {
        return {
            url: readCfg(cfgKeys.url),
            secret: readCfg(cfgKeys.secret),
            shopId: readCfg(cfgKeys.shopId),
            enabled: readCfg('cloud_push_enabled') === '1',
        }
    },

    setConfig(cfg: Partial<PushConfig>): void {
        const db = getDatabase()
        db.transaction(() => {
            if (cfg.url !== undefined) writeCfg(cfgKeys.url, cfg.url.replace(/\/+$/, ''))
            if (cfg.secret !== undefined) writeCfg(cfgKeys.secret, cfg.secret)
            if (cfg.shopId !== undefined) writeCfg(cfgKeys.shopId, cfg.shopId)
            if (cfg.enabled !== undefined) writeCfg('cloud_push_enabled', cfg.enabled ? '1' : '0')
        })()
    },

    status() {
        const rows = getDatabase()
            .prepare('SELECT * FROM cloud_push_state ORDER BY entity')
            .all() as { entity: string; last_id: number; last_at: string | null; last_success_at: string | null; last_error: string | null; rows_pushed: number }[]
        const cfg = this.getConfig()
        return {
            configured: !!cfg.url && !!cfg.secret,
            enabled: cfg.enabled,
            url: cfg.url,
            shopId: cfg.shopId,
            entities: rows,
            pendingTotal: this.pendingCounts(),
        }
    },

    /** How much is waiting to go, so the owner can tell "quiet" from "stuck". */
    pendingCounts(): Record<string, number> {
        const db = getDatabase()
        const sales = state('sales')
        const returns = state('returns')
        const count = (sql: string, ...params: any[]) =>
            (db.prepare(sql).get(...params) as any).n as number

        return {
            sales: count("SELECT COUNT(*) AS n FROM transactions WHERE id > ? AND status = 'completed'", sales.last_id),
            returns: count("SELECT COUNT(*) AS n FROM sale_returns WHERE id > ? AND status = 'completed'", returns.last_id),
            products: count('SELECT COUNT(*) AS n FROM products WHERE updated_at > ?', withOverlap(state('products').last_at)),
            stock: count('SELECT COUNT(*) AS n FROM stock_inventory WHERE COALESCE(updated_at, \'1970-01-01\') > ?', withOverlap(state('stock').last_at)),
        }
    },

    /**
     * Collect the next batch for every entity.
     *
     * Exposed separately from `push` so the payload can be inspected — and tested —
     * without a network call.
     */
    buildBatch() {
        const db = getDatabase()

        // --- Append-only: exact, by id ---
        const salesMark = state('sales')
        const sales = db.prepare(`
            SELECT t.id, t.transaction_number, t.store_id, t.terminal_id, t.user_id, t.customer_id,
                   t.status, t.return_status, t.subtotal, t.discount_amount, t.tax_amount,
                   t.timbre, t.total_amount, t.amount_paid, t.created_at, t.completed_at,
                   s.code AS store_code, u.name AS user_name, c.name AS customer_name
            FROM transactions t
            LEFT JOIN stores s ON s.id = t.store_id
            LEFT JOIN users u ON u.id = t.user_id
            LEFT JOIN customers c ON c.id = t.customer_id
            WHERE t.id > ? AND t.status = 'completed'
            ORDER BY t.id LIMIT ?
        `).all(salesMark.last_id, BATCH_LIMIT) as any[]

        // Line items travel WITH their sale, in the same request. Splitting them
        // across batches could leave the mirror holding a sale with no lines, which
        // reads as a sale of nothing rather than as an incomplete transfer.
        const saleIds = sales.map(s => s.id)
        const saleItems = saleIds.length
            ? db.prepare(`
                SELECT ti.transaction_id, t.transaction_number, ti.product_id, ti.variant_id,
                       ti.product_name, ti.sku, pv.size, pv.color,
                       ti.quantity, ti.unit_price, ti.unit_cost, ti.discount_amount,
                       ti.tax_rate, ti.tax_amount, ti.line_total, ti.returned_quantity
                FROM transaction_items ti
                JOIN transactions t ON t.id = ti.transaction_id
                LEFT JOIN product_variants pv ON pv.id = ti.variant_id
                WHERE ti.transaction_id IN (${saleIds.map(() => '?').join(',')})
                ORDER BY ti.id
            `).all(...saleIds) as any[]
            : []

        const returnsMark = state('returns')
        const returns = db.prepare(`
            SELECT r.id, r.return_number, r.kind, r.store_id, r.user_id, r.customer_id,
                   r.returned_value, r.replacement_value, r.balance, r.refund_method,
                   r.reason, r.created_at,
                   o.transaction_number AS original_number,
                   x.transaction_number AS replacement_number
            FROM sale_returns r
            LEFT JOIN transactions o ON o.id = r.original_transaction_id
            LEFT JOIN transactions x ON x.id = r.exchange_transaction_id
            WHERE r.id > ? AND r.status = 'completed'
            ORDER BY r.id LIMIT ?
        `).all(returnsMark.last_id, BATCH_LIMIT) as any[]

        // --- Mutable: by timestamp, with overlap ---
        const productsMark = state('products')
        const productsSince = withOverlap(productsMark.last_at)
        const products = db.prepare(`
            SELECT p.id, p.sku, p.barcode, p.name, p.category_id, c.name AS category_name,
                   p.brand_id, p.cost_price, p.retail_price, p.min_stock_level,
                   p.is_active, p.updated_at
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.updated_at > ?
            ORDER BY p.updated_at, p.id LIMIT ?
        `).all(productsSince, BATCH_LIMIT) as any[]

        const variants = products.length
            ? db.prepare(`
                SELECT pv.id, pv.product_id, pv.sku, pv.barcode, pv.size, pv.color,
                       pv.cost_price, pv.retail_price, pv.is_active
                FROM product_variants pv
                WHERE pv.product_id IN (${products.map(() => '?').join(',')})
            `).all(...products.map(p => p.id)) as any[]
            : []

        const stockMark = state('stock')
        const stockSince = withOverlap(stockMark.last_at)
        const stock = db.prepare(`
            SELECT si.store_id, s.code AS store_code, si.product_id, si.variant_id,
                   p.sku AS product_sku, pv.sku AS variant_sku,
                   pv.size, pv.color, si.quantity, si.updated_at
            FROM stock_inventory si
            LEFT JOIN stores s ON s.id = si.store_id
            LEFT JOIN products p ON p.id = si.product_id
            LEFT JOIN product_variants pv ON pv.id = si.variant_id
            WHERE COALESCE(si.updated_at, '1970-01-01') > ?
            ORDER BY si.updated_at, si.id LIMIT ?
        `).all(stockSince, BATCH_LIMIT) as any[]

        // Stores are few and change almost never; sending them whole every time
        // costs nothing and removes a whole class of "the mirror has a sale from a
        // shop it has never heard of" problems.
        const stores = db.prepare('SELECT id, code, name, city, is_active FROM stores').all() as any[]

        return {
            stores, sales, saleItems, returns, products, variants, stock,
            marks: {
                sales: sales.length ? sales[sales.length - 1].id : salesMark.last_id,
                returns: returns.length ? returns[returns.length - 1].id : returnsMark.last_id,
                products: products.length ? products[products.length - 1].updated_at : productsMark.last_at,
                stock: stock.length ? stock[stock.length - 1].updated_at : stockMark.last_at,
            },
            counts: {
                stores: stores.length, sales: sales.length, saleItems: saleItems.length,
                returns: returns.length, products: products.length,
                variants: variants.length, stock: stock.length,
            } as BatchCounts,
        }
    },

    /** True when a batch holds nothing new — the caller can stop walking.
     *  `stores` is excluded on purpose: it is sent in full every time, so counting
     *  it would make every batch look non-empty and the walk would never finish. */
    isEmpty(counts: BatchCounts): boolean {
        return counts.sales + counts.returns + counts.products + counts.stock === 0
    },

    /**
     * Send one batch. Returns what was sent, or throws.
     *
     * The watermark advances ONLY after the endpoint confirms. Anything else — a
     * timeout, a 500, a truncated response — leaves it untouched, and the same rows
     * go again next time.
     */
    async pushOnce(): Promise<{ pushed: BatchCounts; done: boolean }> {
        const cfg = this.getConfig()
        if (!cfg.url || !cfg.secret) {
            throw new Error('Le miroir central n’est pas configuré (adresse ou clé manquante).')
        }

        const batch = this.buildBatch()
        if (this.isEmpty(batch.counts)) return { pushed: batch.counts, done: true }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 60_000)
        try {
            const res = await fetch(cfg.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-dapper-secret': cfg.secret,
                },
                body: JSON.stringify({
                    shopId: cfg.shopId,
                    pushedAt: new Date().toISOString(),
                    stores: batch.stores,
                    products: batch.products,
                    variants: batch.variants,
                    stock: batch.stock,
                    sales: batch.sales,
                    saleItems: batch.saleItems,
                    returns: batch.returns,
                }),
                signal: controller.signal,
            })

            if (!res.ok) {
                const body = await res.text().catch(() => '')
                throw new Error(`Le serveur a répondu ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`)
            }

            // Only now: the far side has it.
            if (batch.counts.sales) advance('sales', batch.marks.sales as number, null, batch.counts.sales)
            if (batch.counts.returns) advance('returns', batch.marks.returns as number, null, batch.counts.returns)
            if (batch.counts.products) advance('products', 0, batch.marks.products as string, batch.counts.products)
            if (batch.counts.stock) advance('stock', 0, batch.marks.stock as string, batch.counts.stock)

            // A full batch means there is probably more behind it.
            const done = batch.counts.sales < BATCH_LIMIT
                && batch.counts.returns < BATCH_LIMIT
                && batch.counts.products < BATCH_LIMIT
                && batch.counts.stock < BATCH_LIMIT
            return { pushed: batch.counts, done }
        } catch (e: any) {
            const message = e?.name === 'AbortError' ? 'délai dépassé' : (e?.message ?? 'erreur réseau')
            for (const entity of ['sales', 'returns', 'products', 'stock']) recordError(entity, message)
            throw new Error(`Envoi au miroir central échoué : ${message}`)
        } finally {
            clearTimeout(timer)
        }
    },

    /**
     * Walk batches until there is nothing left, or the cap is hit.
     *
     * Capped so a shop that has been offline for a month cannot spend an hour
     * pushing while the owner waits on a progress spinner. What is left simply goes
     * on the next run.
     */
    async pushAll(maxBatches = 20) {
        const totals: Record<string, number> = {}
        let batches = 0
        for (; batches < maxBatches; batches++) {
            const { pushed, done } = await this.pushOnce()
            for (const [k, v] of Object.entries(pushed)) totals[k] = (totals[k] ?? 0) + v
            if (done) break
        }
        return { batches: batches + 1, totals, remaining: this.pendingCounts() }
    },

    /** Does the endpoint answer, and does it accept our key? */
    async test(): Promise<{ ok: boolean; message: string }> {
        const cfg = this.getConfig()
        if (!cfg.url || !cfg.secret) return { ok: false, message: 'Adresse ou clé manquante.' }
        try {
            const res = await fetch(cfg.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-dapper-secret': cfg.secret },
                // An empty batch: valid, changes nothing, and proves the round trip.
                body: JSON.stringify({ shopId: cfg.shopId, pushedAt: new Date().toISOString(), ping: true }),
            })
            if (res.status === 401 || res.status === 403) return { ok: false, message: 'Clé refusée par le serveur.' }
            if (!res.ok) return { ok: false, message: `Le serveur a répondu ${res.status}.` }
            return { ok: true, message: 'Miroir central joignable.' }
        } catch (e: any) {
            return { ok: false, message: `Injoignable : ${e?.message ?? 'erreur réseau'}` }
        }
    },
}
