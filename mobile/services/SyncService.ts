import { Platform } from 'react-native'
import { getDatabase } from './database'
import { Product } from './productService'
import { CloudSync } from './CloudSync'

/** Coarse device class for the desktop Network monitor's icon. */
function deviceType(): string {
    return Platform.OS === 'ios' || Platform.OS === 'android' ? 'phone' : Platform.OS
}

/** Best-effort human-readable name; falls back to a stable os+id tag. */
function deviceNameFromPlatform(): string {
    const c: any = (Platform as any).constants ?? {}
    if (Platform.OS === 'android' && c.Brand) {
        return `${String(c.Brand)} ${c.Model ?? ''}`.trim()
    }
    return `${Platform.OS} device`
}

/** Mint a short random id without pulling in a uuid dependency. */
function randomId(): string {
    return 'xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16))
}

export const SyncService = {
    async getServerUrl(): Promise<string | null> {
        const db = getDatabase()
        if (!db) return null
        const result = await db.getFirstAsync("SELECT value FROM config WHERE key = 'server_url'") as { value: string } | null
        return result?.value || null
    },

    async setServerUrl(url: string) {
        const db = getDatabase()
        if (!db) return
        await db.runAsync("INSERT OR REPLACE INTO config (key, value) VALUES ('server_url', ?)", [url])
    },

    async getSyncToken(): Promise<string | null> {
        const db = getDatabase()
        if (!db) return null
        const result = await db.getFirstAsync("SELECT value FROM config WHERE key = 'sync_token'") as { value: string } | null
        return result?.value || null
    },

    async setSyncToken(token: string) {
        const db = getDatabase()
        if (!db) return
        await db.runAsync("INSERT OR REPLACE INTO config (key, value) VALUES ('sync_token', ?)", [token])
    },

    /**
     * Stable per-install device id, minted on first use and persisted in config.
     * This is what lets the desktop Network monitor tell one phone from another —
     * the sync token alone is shared by every device in the shop.
     */
    async getDeviceId(): Promise<string> {
        const db = getDatabase()
        if (!db) return randomId()
        const row = await db.getFirstAsync("SELECT value FROM config WHERE key = 'device_id'") as { value: string } | null
        if (row?.value) return row.value
        const id = `${deviceType()}-${randomId()}`
        await db.runAsync("INSERT OR REPLACE INTO config (key, value) VALUES ('device_id', ?)", [id])
        return id
    },

    /**
     * Build request headers: the pairing token the desktop server requires, plus
     * the device identity the Network monitor records (x-device-*). Identity is
     * attached to EVERY request, not just sync, so any authenticated call shows
     * up as a connected device.
     */
    async authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
        const token = await this.getSyncToken()
        const deviceId = await this.getDeviceId()
        const identity = {
            'x-device-id': deviceId,
            'x-device-name': deviceNameFromPlatform(),
            'x-device-type': deviceType(),
        }
        return token ? { ...extra, ...identity, 'x-sync-token': token } : { ...extra, ...identity }
    },

    async getAdminSignature(): Promise<string | null> {
        const db = getDatabase()
        if (!db) return null
        const result = await db.getFirstAsync("SELECT value FROM config WHERE key = 'admin_signature'") as { value: string } | null
        return result?.value || null
    },

    async setAdminSignature(signature: string) {
        const db = getDatabase()
        if (!db) return
        await db.runAsync("INSERT OR REPLACE INTO config (key, value) VALUES ('admin_signature', ?)", [signature])
    },

    async checkConnection(): Promise<boolean> {
        const url = await this.getServerUrl()
        if (!url) return false
        try {
            // Short timeout: off the shop wifi this would otherwise hang for ~60s
            // before the cloud fallback ever got a chance to run.
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 3000)
            const res = await fetch(`${url}/health`, { signal: controller.signal })
            clearTimeout(timer)
            const data = await res.json()
            return data.status === 'ok'
        } catch {
            return false
        }
    },

    /**
     * Sync by whichever transport is available.
     *
     * LAN first — it is faster, works with no internet, and is the ONLY path that
     * can print (the receipt printer is wired to the PC). Firestore is the
     * fallback for when the phone is away from the shop.
     */
    async syncAuto(): Promise<{ success: boolean; via: 'lan' | 'cloud' | 'none'; products?: number; sent?: number; error?: string }> {
        if (await this.checkConnection()) {
            try {
                const sent = await this.syncTransactions()
                const products = await this.syncProducts()
                return { success: true, via: 'lan', products, sent }
            } catch (e) {
                return { success: false, via: 'lan', error: e instanceof Error ? e.message : 'Sync LAN échouée.' }
            }
        }

        if (await CloudSync.isConfigured()) {
            const r = await CloudSync.syncAll()
            return { ...r, via: 'cloud' }
        }

        return { success: false, via: 'none', error: "Ni le PC ni le cloud ne sont joignables." }
    },

    async syncSuppliers() {
        const url = await this.getServerUrl()
        if (!url) throw new Error('Server URL not set')

        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        const res = await fetch(`${url}/sync/suppliers`, { headers: await this.authHeaders() })
        if (!res.ok) throw new Error('Sync suppliers failed')

        const data = await res.json()
        const suppliers: any[] = data.suppliers

        await db.withTransactionAsync(async () => {
            for (const s of suppliers) {
                await db.runAsync(`
                    INSERT OR REPLACE INTO suppliers (id, company_name, contact_name, phone, email, address, city, country, tax_id, is_active)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [s.id, s.company_name, s.contact_name, s.phone, s.email, s.address, s.city, s.country, s.tax_id, s.is_active ?? 1])
            }
        })

        return suppliers.length
    },

    async syncProducts() {
        const url = await this.getServerUrl()
        if (!url) throw new Error('Server URL not set')

        // Automatically sync suppliers first to ensure foreign key constraints are met
        try {
            await this.syncSuppliers()
        } catch (e) {
            console.warn('Supplier sync failed, continuing with products:', e)
        }

        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        // 1. Get last sync time
        const lastSyncRow = await db.getFirstAsync("SELECT value FROM config WHERE key = 'last_product_sync'") as { value: string } | null
        const lastSync = lastSyncRow?.value || ''

        // 2. Fetch changes
        const res = await fetch(`${url}/sync/products?since=${lastSync}`, { headers: await this.authHeaders() })
        if (!res.ok) throw new Error('Sync failed')

        const data = await res.json()
        const products: Product[] = data.products
        const newTimestamp = data.timestamp

        // 3. Upsert Logic
        await db.withTransactionAsync(async () => {
            for (const p of products) {
                // Upsert Product
                await db.runAsync(`
                    INSERT INTO products (
                        id, sku, barcode, name, category_id, supplier_id, tax_category_id,
                        cost_price, retail_price, min_stock_level, is_active, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        sku=excluded.sku,
                        barcode=excluded.barcode,
                        name=excluded.name,
                        category_id=excluded.category_id,
                        supplier_id=excluded.supplier_id,
                        tax_category_id=excluded.tax_category_id,
                        retail_price=excluded.retail_price,
                        cost_price=excluded.cost_price,
                        min_stock_level=excluded.min_stock_level,
                        is_active=excluded.is_active,
                        updated_at=excluded.updated_at
                `, [
                    p.id, p.sku, p.barcode, p.name, p.category_id, p.supplier_id, (p as any).tax_category_id ?? 1,
                    p.cost_price, p.retail_price, p.min_stock_level, p.is_active, new Date().toISOString()
                ])

                // Handle Stock
                await db.runAsync(`
                    DELETE FROM stock_inventory WHERE product_id = ?
                `, [p.id])

                if (p.stock_quantity !== undefined) {
                    await db.runAsync(`
                        INSERT INTO stock_inventory (product_id, quantity) VALUES (?, ?)
                    `, [p.id, p.stock_quantity])
                }

                // Variants for this product are replaced wholesale below, from the
                // payload's full active set — see after the product loop.

                // Handle Categories
                if (p.category_id && p.category_name) {
                    await db.runAsync(`
                        INSERT OR IGNORE INTO categories (id, name) VALUES (?, ?)
                     `, [p.category_id, p.category_name])
                }

                // Handle Suppliers
                if (p.supplier_id && p.supplier_name) {
                    await db.runAsync(`
                        INSERT OR IGNORE INTO suppliers (id, company_name) VALUES (?, ?)
                    `, [p.supplier_id, p.supplier_name])
                }
            }

            // Variants: the payload carries the FULL active set (they are few), so the
            // local cache is replaced rather than merged. That way a size deleted on the
            // desktop disappears here too — a delta keyed on the product's updated_at
            // would leave it sellable on mobile forever.
            if (Array.isArray(data.variants)) {
                await db.runAsync('DELETE FROM product_variants')
                // Aggregate by variant id: if the payload ever carries the same variant
                // twice (e.g. stock split across depots), sum the quantities instead of
                // inserting a duplicate primary key, which would abort the whole sync.
                const byId = new Map<number, any>()
                for (const v of data.variants) {
                    const prev = byId.get(v.id)
                    const qty = Number(v.stock_quantity ?? 0) || 0
                    if (prev) {
                        prev.stock_quantity = (Number(prev.stock_quantity ?? 0) || 0) + qty
                    } else {
                        byId.set(v.id, { ...v, stock_quantity: qty })
                    }
                }
                for (const v of byId.values()) {
                    await db.runAsync(`
                        INSERT OR REPLACE INTO product_variants (id, product_id, size, color, sku, barcode, retail_price, sort_order, stock_quantity)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [v.id, v.product_id, v.size ?? '', v.color ?? '', v.sku ?? null, v.barcode ?? null,
                        v.retail_price ?? null, v.sort_order ?? 0, v.stock_quantity ?? 0])
                }
            }

            // Mirror the desktop's fiscal regime + pricing mode so mobile computes TVA identically.
            if (data.regime) await db.runAsync("INSERT OR REPLACE INTO config (key, value) VALUES ('regime', ?)", [data.regime])
            await db.runAsync("INSERT OR REPLACE INTO config (key, value) VALUES ('prices_include_tax', ?)", [data.pricesIncludeTax ? '1' : '0'])
            // White-label: mirror the shop's business name so mobile chrome shows it too.
            if (data.companyName) await db.runAsync("INSERT OR REPLACE INTO config (key, value) VALUES ('company_name', ?)", [data.companyName])

            // Update last sync
            await db.runAsync("INSERT OR REPLACE INTO config (key, value) VALUES ('last_product_sync', ?)", [newTimestamp])
        })

        return products.length
    },

    async syncTransactions() {
        const url = await this.getServerUrl()
        if (!url) return 0

        const db = getDatabase()
        if (!db) return 0

        // Get pending unsynced transactions (assuming sync_status = 0 or NULL)
        // Wait, mobile DB schema needs to track sync_status!
        // For now, let's assume we fetch all transactions created locally that haven't been synced?
        // Or simpler: The POS Screen will pass the transaction object directly to this method to sync immediately

        // Actually, better to query DB for reliability
        // But for this step, let's add the method signature first.
        // I will assume the caller passes the transaction data or I fetch it.
        // Let's implement robust sync: GET unsynced --> POST --> UPDATE synced

        const unsynced = await db.getAllAsync(`
            SELECT * FROM transactions WHERE sync_status = 0 OR sync_status IS NULL
        `) as any[]

        if (unsynced.length === 0) return 0

        // Get items and payments for these transactions
        const batch = []
        for (const tx of unsynced) {
            const items = await db.getAllAsync('SELECT * FROM transaction_items WHERE transaction_id = ?', [tx.id])
            const payments = await db.getAllAsync('SELECT * FROM payments WHERE transaction_id = ?', [tx.id])

            batch.push({
                ...tx,
                items,
                payments
            })
        }

        try {
            const res = await fetch(`${url}/sync/transactions`, {
                method: 'POST',
                headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ transactions: batch })
            })

            if (res.ok) {
                // Mark as synced
                await db.withTransactionAsync(async () => {
                    for (const tx of unsynced) {
                        await db.runAsync('UPDATE transactions SET sync_status = 1 WHERE id = ?', [tx.id])
                    }
                })
                return batch.length
            }
        } catch (e) {
            console.error('Sync transactions failed:', e)
        }
        return 0
    },

    async printReceipt(transactionId: number | string): Promise<boolean> {
        console.log(`[SyncService] Preparing to print receipt for ID: ${transactionId}`)
        const url = await this.getServerUrl()
        if (!url) throw new Error('Server URL not set')

        const db = getDatabase()
        if (!db) return false

        try {
            // Fetch transaction data locally
            const txn = await db.getFirstAsync('SELECT * FROM transactions WHERE id = ?', [transactionId]) as any
            if (!txn) {
                console.error('[SyncService] Transaction not found for printing')
                return false
            }

            // COALESCE, not p.name: the stored line name already carries the size/colour
            // ("T-shirt (M / Noir)"). Overriding it with the bare product name would
            // print a receipt that doesn't say which size the customer bought.
            const items = await db.getAllAsync(`
                SELECT ti.*, COALESCE(NULLIF(ti.product_name, ''), p.name) AS product_name
                FROM transaction_items ti
                LEFT JOIN products p ON ti.product_id = p.id
                WHERE ti.transaction_id = ?
            `, [transactionId]) as any[]

            const payments = await db.getAllAsync('SELECT * FROM payments WHERE transaction_id = ?', [transactionId]) as any[]

            const adminSignature = await this.getAdminSignature()

            // Map to ReceiptData format expected by Desktop
            const receiptData = {
                transactionNumber: txn.transaction_number,
                date: txn.created_at,
                cashierName: 'System',
                customerName: null,
                adminSignature: adminSignature,
                items: items.map(i => ({
                    name: i.product_name || 'Produit inconnu',
                    quantity: i.quantity,
                    unitPrice: i.unit_price,
                    total: i.line_total
                })),
                subtotal: txn.subtotal,
                discount: txn.discount_amount || 0,
                tax: txn.tax_amount || 0,
                total: txn.total_amount,
                payments: payments.map(p => ({
                    method: p.payment_method,
                    amount: p.amount
                })),
                change: txn.change_due || 0
            }

            console.log(`[SyncService] Pushing raw receipt to ${url}/print/raw/receipt`)
            const res = await fetch(`${url}/print/raw/receipt`, {
                method: 'POST',
                headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(receiptData)
            })

            console.log(`[SyncService] Print raw receipt response: ${res.status}`)
            return res.ok
        } catch (e) {
            console.error('[SyncService] Print receipt raw failed:', e)
            return false
        }
    },

    async printInvoice(transactionId: number | string): Promise<boolean> {
        console.log(`[SyncService] Preparing to print A4 invoice for ID: ${transactionId}`)
        const url = await this.getServerUrl()
        if (!url) throw new Error('Server URL not set')

        const db = getDatabase()
        if (!db) return false

        try {
            // Fetch transaction data locally (same mapping as printReceipt)
            const txn = await db.getFirstAsync('SELECT * FROM transactions WHERE id = ?', [transactionId]) as any
            if (!txn) return false

            // COALESCE, not p.name: the stored line name already carries the size/colour
            // ("T-shirt (M / Noir)"). Overriding it with the bare product name would
            // print a receipt that doesn't say which size the customer bought.
            const items = await db.getAllAsync(`
                SELECT ti.*, COALESCE(NULLIF(ti.product_name, ''), p.name) AS product_name
                FROM transaction_items ti
                LEFT JOIN products p ON ti.product_id = p.id
                WHERE ti.transaction_id = ?
            `, [transactionId]) as any[]

            const payments = await db.getAllAsync('SELECT * FROM payments WHERE transaction_id = ?', [transactionId]) as any[]
            const adminSignature = await this.getAdminSignature()

            const receiptData = {
                transactionNumber: txn.transaction_number,
                date: txn.created_at,
                cashierName: 'System',
                customerName: null,
                adminSignature: adminSignature,
                items: items.map(i => ({
                    name: i.product_name || 'Produit inconnu',
                    quantity: i.quantity,
                    unitPrice: i.unit_price,
                    total: i.line_total
                })),
                subtotal: txn.subtotal,
                discount: txn.discount_amount || 0,
                tax: txn.tax_amount || 0,
                total: txn.total_amount,
                payments: payments.map(p => ({
                    method: p.payment_method,
                    amount: p.amount
                })),
                change: txn.change_due || 0
            }

            console.log(`[SyncService] Pushing raw invoice to ${url}/print/raw/invoice`)
            const res = await fetch(`${url}/print/raw/invoice`, {
                method: 'POST',
                headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(receiptData)
            })

            return res.ok
        } catch (e) {
            console.error('[SyncService] Print invoice raw failed:', e)
            return false
        }
    },

    async printOrder(orderId: number | string): Promise<boolean> {
        console.log(`[SyncService] Preparing to print order for ID: ${orderId}`)
        const url = await this.getServerUrl()
        if (!url) throw new Error('Server URL not set')

        const db = getDatabase()
        if (!db) return false

        try {
            // Fetch order data locally
            const order = await db.getFirstAsync(`
                SELECT po.*, s.company_name as supplier_name, s.phone as supplier_phone
                FROM purchase_orders po
                LEFT JOIN suppliers s ON po.supplier_id = s.id
                WHERE po.id = ?
            `, [orderId]) as any

            if (!order) {
                console.error('[SyncService] Order not found for printing')
                return false
            }

            const items = await db.getAllAsync(`
                SELECT poi.*, p.name as product_name
                FROM purchase_order_items poi
                LEFT JOIN products p ON poi.product_id = p.id
                WHERE poi.purchase_order_id = ?
            `, [orderId]) as any[]

            const adminSignature = await this.getAdminSignature()

            // Map to PO format expected by Desktop (PurchaseOrderItem mapping)
            const poData = {
                ...order,
                adminSignature: adminSignature,
                items: items.map(i => ({
                    ...i,
                    product_name: i.product_name,
                    quantity_ordered: i.quantity, // Template expects quantity_ordered
                    unit: i.unit
                }))
            }

            console.log(`[SyncService] Pushing raw order to ${url}/print/raw/order`)
            const res = await fetch(`${url}/print/raw/order`, {
                method: 'POST',
                headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(poData)
            })

            console.log(`[SyncService] Print raw order response: ${res.status}`)
            return res.ok
        } catch (e) {
            console.error('[SyncService] Print order raw failed:', e)
            return false
        }
    }
}
