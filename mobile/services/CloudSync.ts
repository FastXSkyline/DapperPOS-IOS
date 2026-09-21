import { initializeApp, getApps, type FirebaseApp } from 'firebase/app'
import * as fbAuth from 'firebase/auth'
import {
    getFirestore, collection, doc, getDocs, query, where, writeBatch,
    Timestamp, type Firestore
} from 'firebase/firestore'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// Firestore cloud sync (mobile side).
//
// The LAN server is still the preferred path when the phone is on shop wifi —
// it's faster, works with no internet, and is the only way to print. This is the
// fallback for when the phone is away from the shop.
//
// SQLite stays the local source of truth; Firestore is a relay.
// The Firebase client config is public by design — Security Rules
// (firestore.rules) are what actually protect the data.
// ---------------------------------------------------------------------------

export interface CloudConfig {
    apiKey: string
    authDomain: string
    projectId: string
    appId: string
    shopId: string
    email: string
    password: string
    enabled: boolean
}

let app: FirebaseApp | null = null
let fdb: Firestore | null = null
let signedInFor: string | null = null

const KEYS: Record<keyof Omit<CloudConfig, 'enabled'>, string> = {
    apiKey: 'cloud_api_key',
    authDomain: 'cloud_auth_domain',
    projectId: 'cloud_project_id',
    appId: 'cloud_app_id',
    shopId: 'cloud_shop_id',
    email: 'cloud_email',
    password: 'cloud_password',
}

async function readConfig(): Promise<CloudConfig | null> {
    const db = getDatabase()
    if (!db) return null
    const get = async (k: string) => {
        const r = await db.getFirstAsync('SELECT value FROM config WHERE key = ?', [k]) as { value: string } | null
        return r?.value || ''
    }
    const cfg: CloudConfig = {
        apiKey: await get(KEYS.apiKey),
        authDomain: await get(KEYS.authDomain),
        projectId: await get(KEYS.projectId),
        appId: await get(KEYS.appId),
        shopId: await get(KEYS.shopId),
        email: await get(KEYS.email),
        password: await get(KEYS.password),
        enabled: (await get('cloud_enabled')) === '1',
    }
    if (!cfg.apiKey || !cfg.projectId || !cfg.shopId || !cfg.email) return null
    return cfg
}

/** Auth in React Native needs explicit AsyncStorage persistence, or the session
 *  is lost on every app restart and the shop has to sign in again. */
function buildAuth(a: FirebaseApp) {
    const anyAuth = fbAuth as unknown as Record<string, any>
    try {
        if (typeof anyAuth.getReactNativePersistence === 'function') {
            return anyAuth.initializeAuth(a, {
                persistence: anyAuth.getReactNativePersistence(AsyncStorage),
            })
        }
    } catch {
        // initializeAuth throws if it already ran for this app — fall through.
    }
    return fbAuth.getAuth(a)
}

async function connect(): Promise<{ db: Firestore; cfg: CloudConfig } | null> {
    const cfg = await readConfig()
    if (!cfg || !cfg.enabled) return null

    if (!app) {
        app = getApps().find(x => x.name === 'dapper-mobile')
            ?? initializeApp({
                apiKey: cfg.apiKey,
                authDomain: cfg.authDomain,
                projectId: cfg.projectId,
                appId: cfg.appId,
            }, 'dapper-mobile')
        fdb = getFirestore(app)
    }
    if (signedInFor !== cfg.email) {
        const auth = buildAuth(app)
        await fbAuth.signInWithEmailAndPassword(auth, cfg.email, cfg.password)
        signedInFor = cfg.email
    }
    return { db: fdb!, cfg }
}

const shopRef = (d: Firestore, shopId: string, sub: string) => collection(d, 'shops', shopId, sub)

export const CloudSync = {
    async isConfigured(): Promise<boolean> {
        return (await readConfig()) !== null
    },

    async setConfig(patch: Partial<CloudConfig>) {
        const db = getDatabase()
        if (!db) return { success: false }
        for (const [field, key] of Object.entries(KEYS)) {
            const v = (patch as any)[field]
            if (v != null) await db.runAsync('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, String(v)])
        }
        if (patch.enabled != null) {
            await db.runAsync('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', ['cloud_enabled', patch.enabled ? '1' : '0'])
        }
        app = null; fdb = null; signedInFor = null
        return { success: true }
    },

    async getConfig(): Promise<Omit<CloudConfig, 'password'> & { hasPassword: boolean } | null> {
        const cfg = await readConfig()
        if (!cfg) return null
        const { password, ...rest } = cfg
        return { ...rest, hasPassword: !!password }
    },

    /**
     * Pull the catalogue the desktop published. Mirrors the LAN pull so the local
     * tables end up in exactly the same shape whichever transport was used.
     */
    async pullCatalog(): Promise<number> {
        const conn = await connect()
        if (!conn) return 0
        const db = getDatabase()
        if (!db) return 0
        const { db: cloud, cfg } = conn

        const [prodSnap, varSnap, supSnap] = await Promise.all([
            getDocs(shopRef(cloud, cfg.shopId, 'products')),
            getDocs(shopRef(cloud, cfg.shopId, 'variants')),
            getDocs(shopRef(cloud, cfg.shopId, 'suppliers')),
        ])

        await db.withTransactionAsync(async () => {
            for (const d of prodSnap.docs) {
                const p = d.data() as any
                await db.runAsync(`
                    INSERT INTO products (id, sku, barcode, name, category_id, supplier_id, tax_category_id,
                        cost_price, retail_price, min_stock_level, is_active, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        sku=excluded.sku, barcode=excluded.barcode, name=excluded.name,
                        category_id=excluded.category_id, supplier_id=excluded.supplier_id,
                        tax_category_id=excluded.tax_category_id, retail_price=excluded.retail_price,
                        cost_price=excluded.cost_price, min_stock_level=excluded.min_stock_level,
                        is_active=excluded.is_active, updated_at=excluded.updated_at
                `, [p.id, p.sku ?? null, p.barcode ?? null, p.name, p.category_id ?? null, p.supplier_id ?? null,
                    p.tax_category_id ?? 1, p.cost_price ?? 0, p.retail_price ?? 0, p.min_stock_level ?? 0,
                    p.is_active ?? 1, new Date().toISOString()])

                await db.runAsync('DELETE FROM stock_inventory WHERE product_id = ? AND variant_id IS NULL', [p.id])
                await db.runAsync('INSERT INTO stock_inventory (product_id, variant_id, quantity) VALUES (?, NULL, ?)',
                    [p.id, p.has_variants ? 0 : (p.stock_quantity ?? 0)])
            }

            // Replaced wholesale, same as the LAN path: a size deleted on the desktop
            // must stop being sellable here rather than lingering forever.
            await db.runAsync('DELETE FROM product_variants')
            for (const d of varSnap.docs) {
                const v = d.data() as any
                await db.runAsync(`
                    INSERT INTO product_variants (id, product_id, size, color, sku, barcode, retail_price, sort_order, stock_quantity)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [v.id, v.product_id, v.size ?? '', v.color ?? '', v.sku ?? null, v.barcode ?? null,
                    v.retail_price ?? null, v.sort_order ?? 0, v.stock_quantity ?? 0])
                await db.runAsync('DELETE FROM stock_inventory WHERE variant_id = ?', [v.id])
                await db.runAsync('INSERT INTO stock_inventory (product_id, variant_id, quantity) VALUES (?, ?, ?)',
                    [v.product_id, v.id, v.stock_quantity ?? 0])
            }

            for (const d of supSnap.docs) {
                const s = d.data() as any
                await db.runAsync('INSERT OR REPLACE INTO suppliers (id, company_name, contact_name, phone, email, address, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [s.id, s.company_name, s.contact_name ?? null, s.phone ?? null, s.email ?? null, s.address ?? null, s.is_active ?? 1])
            }
        })

        return prodSnap.size
    },

    /**
     * Queue unsynced local sales in the cloud for the desktop to ingest.
     *
     * The document id is the transaction_number, so re-uploading the same sale
     * overwrites its own document instead of creating a duplicate — the relay is
     * idempotent by construction. `ingested` stays false until the DESKTOP flips
     * it, so a failed ingest leaves the sale queued for retry rather than lost.
     */
    async pushTransactions(): Promise<number> {
        const conn = await connect()
        if (!conn) return 0
        const db = getDatabase()
        if (!db) return 0
        const { db: cloud, cfg } = conn

        const unsynced = await db.getAllAsync(
            'SELECT * FROM transactions WHERE sync_status = 0 OR sync_status IS NULL'
        ) as any[]
        if (unsynced.length === 0) return 0

        let sent = 0
        for (let i = 0; i < unsynced.length; i += 100) {
            const chunk = unsynced.slice(i, i + 100)
            const batch = writeBatch(cloud)
            for (const tx of chunk) {
                const items = await db.getAllAsync('SELECT * FROM transaction_items WHERE transaction_id = ?', [tx.id])
                const payments = await db.getAllAsync('SELECT * FROM payments WHERE transaction_id = ?', [tx.id])
                batch.set(doc(shopRef(cloud, cfg.shopId, 'transactions'), tx.transaction_number), {
                    ...tx,
                    items,
                    payments,
                    ingested: false,
                    createdAt: Timestamp.now(),
                })
            }
            await batch.commit()
            sent += chunk.length
        }

        // Only mark local rows sent once the cloud write succeeded.
        for (const tx of unsynced) {
            await db.runAsync('UPDATE transactions SET sync_status = 1 WHERE id = ?', [tx.id])
        }
        return sent
    },

    /** Round trip used by the Settings "sync now" button when off shop wifi. */
    async syncAll(): Promise<{ success: boolean; products?: number; sent?: number; error?: string }> {
        try {
            const sent = await this.pushTransactions()
            const products = await this.pullCatalog()
            return { success: true, products, sent }
        } catch (e: unknown) {
            return { success: false, error: e instanceof Error ? e.message : 'Synchronisation cloud impossible.' }
        }
    },
}
