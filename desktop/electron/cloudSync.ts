import { initializeApp, type FirebaseApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword, type Auth } from 'firebase/auth'
import {
    getFirestore, collection, doc, writeBatch, query, where,
    getDocs, orderBy, limit as fsLimit, Timestamp, type Firestore
} from 'firebase/firestore'
import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// Firestore cloud sync (desktop side).
//
// PURPOSE: let the phone work away from the shop. The LAN server stays the fast
// path when both devices are on shop wifi; the cloud is the fallback. This is a
// RELAY, not the database — SQLite remains the source of truth, so every
// migration, the gapless invoice numbering and the server-side TVA recompute
// are untouched.
//
// SECURITY: this uses the Firebase CLIENT SDK plus Firebase Auth, deliberately
// NOT firebase-admin. Admin bypasses Security Rules and needs a service-account
// JSON; shipping that inside a desktop installer on a shop PC would hand full
// database access to anyone who unpacked it. Rules are the boundary instead.
// The Firebase client config is public by design and safe to store locally, but
// it still lives in the `config` table rather than the repo.
//
// COST: Firestore bills per document read/write. Everything here is delta-based
// on `updatedAt` so a 1400-product catalogue is pushed once, then only changes.
// ---------------------------------------------------------------------------

export interface CloudConfig {
    apiKey: string
    authDomain: string
    projectId: string
    appId: string
    /** Which shop's data this device reads/writes — scopes every Security Rule. */
    shopId: string
    /** Firebase Auth account for this shop. Password is stored locally only. */
    email: string
    password: string
    enabled: boolean
}

let app: FirebaseApp | null = null
let db: Firestore | null = null
let auth: Auth | null = null
let signedInFor: string | null = null

const cfgKeys: Record<keyof Omit<CloudConfig, 'enabled'>, string> = {
    apiKey: 'cloud_api_key',
    authDomain: 'cloud_auth_domain',
    projectId: 'cloud_project_id',
    appId: 'cloud_app_id',
    shopId: 'cloud_shop_id',
    email: 'cloud_email',
    password: 'cloud_password',
}

function readConfig(): CloudConfig | null {
    const sql = getDatabase()
    const get = (k: string) => (sql.prepare('SELECT value FROM config WHERE key = ?').get(k) as { value: string } | undefined)?.value || ''
    const cfg: CloudConfig = {
        apiKey: get(cfgKeys.apiKey),
        authDomain: get(cfgKeys.authDomain),
        projectId: get(cfgKeys.projectId),
        appId: get(cfgKeys.appId),
        shopId: get(cfgKeys.shopId),
        email: get(cfgKeys.email),
        password: get(cfgKeys.password),
        enabled: get('cloud_enabled') === '1',
    }
    if (!cfg.apiKey || !cfg.projectId || !cfg.shopId || !cfg.email) return null
    return cfg
}

export function getCloudConfig(): Omit<CloudConfig, 'password'> & { hasPassword: boolean } | null {
    const cfg = readConfig()
    if (!cfg) return null
    const { password, ...rest } = cfg
    return { ...rest, hasPassword: !!password }
}

export function setCloudConfig(patch: Partial<CloudConfig>) {
    const sql = getDatabase()
    const put = sql.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    sql.transaction(() => {
        for (const [field, key] of Object.entries(cfgKeys)) {
            const v = (patch as Record<string, unknown>)[field]
            if (v != null) put.run(key, String(v))
        }
        if (patch.enabled != null) put.run('cloud_enabled', patch.enabled ? '1' : '0')
    })()
    // Force a fresh sign-in next call so credential changes take effect immediately.
    app = null; db = null; auth = null; signedInFor = null
    return { success: true }
}

/** Lazily connect + sign in. Returns null when the cloud isn't configured or enabled. */
async function connect(): Promise<{ db: Firestore; cfg: CloudConfig } | null> {
    const cfg = readConfig()
    if (!cfg || !cfg.enabled) return null

    if (!app) {
        app = initializeApp({
            apiKey: cfg.apiKey,
            authDomain: cfg.authDomain,
            projectId: cfg.projectId,
            appId: cfg.appId,
        }, 'dapper-desktop')
        db = getFirestore(app)
        auth = getAuth(app)
    }
    if (signedInFor !== cfg.email) {
        await signInWithEmailAndPassword(auth!, cfg.email, cfg.password)
        signedInFor = cfg.email
    }
    return { db: db!, cfg }
}

const shopRef = (fdb: Firestore, shopId: string, sub: string) =>
    collection(fdb, 'shops', shopId, sub)

/** Firestore rejects undefined; SQLite hands back nulls freely. */
function clean<T extends Record<string, unknown>>(row: T): T {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) out[k] = v === undefined ? null : v
    return out as T
}

export const CloudSync = {
    isConfigured(): boolean {
        return readConfig() !== null
    },

    /** Verify credentials + rules without syncing anything (used by the Settings test button). */
    async test(): Promise<{ success: boolean; error?: string }> {
        try {
            const conn = await connect()
            if (!conn) return { success: false, error: 'Cloud non configuré ou désactivé.' }
            await getDocs(query(shopRef(conn.db, conn.cfg.shopId, 'products'), fsLimit(1)))
            return { success: true }
        } catch (e: unknown) {
            return { success: false, error: e instanceof Error ? e.message : 'Connexion impossible.' }
        }
    },

    /**
     * Push the catalogue (products + variants + suppliers) to the cloud so the phone
     * can read it off-wifi. Delta: only rows touched since the last push.
     */
    async pushCatalog(): Promise<{ success: boolean; pushed?: number; error?: string }> {
        try {
            const conn = await connect()
            if (!conn) return { success: false, error: 'Cloud désactivé.' }
            const { db: fdb, cfg } = conn
            const sql = getDatabase()

            const since = (sql.prepare("SELECT value FROM config WHERE key = 'cloud_last_push'").get() as { value: string } | undefined)?.value || '1970-01-01'

            const products = sql.prepare(`
                SELECT p.id, p.sku, p.barcode, p.name, p.category_id, p.supplier_id, p.tax_category_id,
                       p.cost_price, p.retail_price, p.min_stock_level, p.is_active, p.updated_at,
                       COALESCE(si.quantity, 0) AS stock_quantity,
                       EXISTS(SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1) AS has_variants
                FROM products p
                LEFT JOIN (SELECT product_id, SUM(quantity) AS quantity FROM stock_inventory GROUP BY product_id) si
                  ON si.product_id = p.id
                WHERE p.updated_at > ?
            `).all(since) as Record<string, unknown>[]

            // Variants are pushed whole (they are few) so a size deleted on the desktop
            // also disappears on the phone — a delta would leave it sellable forever.
            const variants = sql.prepare(`
                SELECT pv.id, pv.product_id, pv.size, pv.color, pv.sku, pv.barcode,
                       pv.retail_price, pv.sort_order, COALESCE(si.quantity, 0) AS stock_quantity
                FROM product_variants pv
                LEFT JOIN stock_inventory si ON si.variant_id = pv.id
                WHERE pv.is_active = 1
            `).all() as Record<string, unknown>[]

            const suppliers = sql.prepare(
                'SELECT id, company_name, contact_name, phone, email, address, is_active FROM suppliers WHERE is_active = 1'
            ).all() as Record<string, unknown>[]

            const stamp = Timestamp.now()
            let pushed = 0
            // Firestore caps a batch at 500 writes.
            const flushInChunks = async (rows: Record<string, unknown>[], sub: string) => {
                for (let i = 0; i < rows.length; i += 400) {
                    const batch = writeBatch(fdb)
                    for (const row of rows.slice(i, i + 400)) {
                        batch.set(doc(shopRef(fdb, cfg.shopId, sub), String(row.id)), { ...clean(row), syncedAt: stamp })
                    }
                    await batch.commit()
                    pushed += Math.min(400, rows.length - i)
                }
            }

            await flushInChunks(products, 'products')
            await flushInChunks(variants, 'variants')
            await flushInChunks(suppliers, 'suppliers')

            sql.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('cloud_last_push', datetime('now'))").run()
            return { success: true, pushed }
        } catch (e: unknown) {
            return { success: false, error: e instanceof Error ? e.message : 'Envoi impossible.' }
        }
    },

    /**
     * Pull sales the phone recorded off-wifi and ingest them locally.
     * Returns the raw payloads; main.ts hands them to the same ingest routine the
     * LAN endpoint uses, so cloud and LAN sales are recomputed identically.
     */
    async pullTransactions(): Promise<{ success: boolean; transactions?: Record<string, unknown>[]; error?: string }> {
        try {
            const conn = await connect()
            if (!conn) return { success: false, error: 'Cloud désactivé.' }
            const { db: fdb, cfg } = conn

            const snap = await getDocs(query(
                shopRef(fdb, cfg.shopId, 'transactions'),
                where('ingested', '==', false),
                orderBy('createdAt'),
                fsLimit(200)
            ))
            const transactions = snap.docs.map(d => d.data() as Record<string, unknown>)
            return { success: true, transactions }
        } catch (e: unknown) {
            return { success: false, error: e instanceof Error ? e.message : 'Réception impossible.' }
        }
    },

    /** Mark cloud sales as ingested so they are not pulled again. */
    async markIngested(transactionNumbers: string[]): Promise<void> {
        const conn = await connect()
        if (!conn || transactionNumbers.length === 0) return
        const { db: fdb, cfg } = conn
        for (let i = 0; i < transactionNumbers.length; i += 400) {
            const batch = writeBatch(fdb)
            for (const n of transactionNumbers.slice(i, i + 400)) {
                batch.set(doc(shopRef(fdb, cfg.shopId, 'transactions'), n), { ingested: true }, { merge: true })
            }
            await batch.commit()
        }
    }
}
