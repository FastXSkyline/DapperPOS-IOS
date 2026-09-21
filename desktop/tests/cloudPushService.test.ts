import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeTestDb } from './helpers/sqliteHarness'
import { runRetailMigrations } from '../electron/migrationsRetail'

let testDb: any
vi.mock('../electron/database', () => ({ getDatabase: () => testDb }))

const { CloudPushService } = await import('../electron/cloudPushService')

const originalFetch = globalThis.fetch

function stubFetch(impl: () => Promise<Partial<Response>>) {
    globalThis.fetch = (() => impl() as Promise<Response>) as typeof fetch
}
const okResponse = async (): Promise<Partial<Response>> => ({ ok: true, status: 200, text: async () => '' })

let txnSeq = 0
function sale(total = 1000, status = 'completed') {
    txnSeq++
    testDb.prepare(`
        INSERT INTO transactions (id, transaction_number, user_id, status, store_id, subtotal, total_amount, created_at)
        VALUES (?, ?, 1, ?, 1, ?, ?, datetime('now'))
    `).run(txnSeq, `BL-${String(txnSeq).padStart(4, '0')}`, status, total, total)
    testDb.prepare(`
        INSERT INTO transaction_items (transaction_id, product_id, variant_id, product_name, quantity, unit_price, line_total)
        VALUES (?, 1, 1, 'Costume Milano', 1, ?, ?)
    `).run(txnSeq, total, total)
    return txnSeq
}

function seed() {
    // user 1 ('Owner') is seeded by core/schema.sql.
    testDb.prepare("INSERT INTO products (id, name, cost_price, retail_price, updated_at) VALUES (1, 'Costume Milano', 18000, 35000, datetime('now'))").run()
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (1, 1, '52', 'Bleu Marine')").run()
    CloudPushService.setConfig({ url: 'https://boutique.dz/api/push', secret: 'k', shopId: 'dapper', enabled: true })
}

beforeEach(() => {
    testDb = makeTestDb()
    runRetailMigrations(testDb)
    seed()
    txnSeq = 0
    globalThis.fetch = originalFetch
})
afterEach(() => { globalThis.fetch = originalFetch })

describe('what goes in a batch', () => {
    it('sends completed sales with their line items in the same request', () => {
        // Splitting lines across batches could leave the mirror holding a sale with
        // no lines, which reads as a sale of nothing.
        sale(35000)
        const batch = CloudPushService.buildBatch()
        expect(batch.counts.sales).toBe(1)
        expect(batch.counts.saleItems).toBe(1)
        expect(batch.sales[0].transaction_number).toBe('BL-0001')
        expect(batch.saleItems[0].transaction_number).toBe('BL-0001')
    })

    it('leaves pending sales alone', () => {
        sale(1000, 'pending')
        expect(CloudPushService.buildBatch().counts.sales).toBe(0)
    })

    it('carries the natural key the far side upserts on', () => {
        sale()
        const batch = CloudPushService.buildBatch()
        expect(batch.sales[0]).toHaveProperty('transaction_number')
        expect(batch.stock.length >= 0).toBe(true)
        expect(batch.products[0]).toHaveProperty('sku')
    })

    it('sends every store on every push', () => {
        // Few, near-static, and it removes a whole class of "the mirror has a sale
        // from a shop it has never heard of".
        const batch = CloudPushService.buildBatch()
        expect(batch.counts.stores).toBe(2)
    })

    it('does not count stores towards emptiness, or the walk would never finish', async () => {
        // Stores ride along on every push. If they counted, `isEmpty` would never be
        // true and pushAll would loop until its cap on a shop with nothing to send.
        const busy = CloudPushService.buildBatch()
        expect(CloudPushService.isEmpty(busy.counts)).toBe(false)   // the seeded product

        stubFetch(okResponse)
        await CloudPushService.pushOnce()
        testDb.prepare("UPDATE products SET updated_at = datetime('now', '-2 hours')").run()

        const quiet = CloudPushService.buildBatch()
        expect(quiet.counts.stores).toBe(2)
        expect(CloudPushService.isEmpty(quiet.counts)).toBe(true)
    })
})

describe('the watermark only advances on success', () => {
    it('advances past the sales it sent', async () => {
        sale(); sale()
        stubFetch(okResponse)
        await CloudPushService.pushOnce()

        const mark = testDb.prepare("SELECT last_id, rows_pushed FROM cloud_push_state WHERE entity='sales'").get() as any
        expect(mark.last_id).toBe(2)
        expect(mark.rows_pushed).toBe(2)
        expect(CloudPushService.buildBatch().counts.sales).toBe(0)
    })

    it('leaves the watermark alone when the endpoint fails, so the rows go again', async () => {
        sale()
        stubFetch(async () => ({ ok: false, status: 500, text: async () => 'boom' }))
        await expect(CloudPushService.pushOnce()).rejects.toThrow(/500/)

        const mark = testDb.prepare("SELECT last_id, last_error FROM cloud_push_state WHERE entity='sales'").get() as any
        expect(mark.last_id).toBe(0)
        expect(mark.last_error).toContain('500')
        expect(CloudPushService.buildBatch().counts.sales).toBe(1)
    })

    it('leaves the watermark alone when the network is down', async () => {
        sale()
        stubFetch(async () => { throw new Error('ENOTFOUND boutique.dz') })
        await expect(CloudPushService.pushOnce()).rejects.toThrow(/ENOTFOUND/)
        expect(CloudPushService.buildBatch().counts.sales).toBe(1)
    })

    it('does not resend a sale that already went', async () => {
        sale()
        stubFetch(okResponse)
        await CloudPushService.pushOnce()
        const second = CloudPushService.buildBatch()
        expect(second.counts.sales).toBe(0)
        expect(second.counts.saleItems).toBe(0)
    })

    it('picks up a sale made after the last push', async () => {
        sale()
        stubFetch(okResponse)
        await CloudPushService.pushOnce()
        sale()
        expect(CloudPushService.buildBatch().counts.sales).toBe(1)
        expect(CloudPushService.buildBatch().sales[0].transaction_number).toBe('BL-0002')
    })

    it('clears a previous error once a push succeeds', async () => {
        sale()
        stubFetch(async () => ({ ok: false, status: 502, text: async () => '' }))
        await expect(CloudPushService.pushOnce()).rejects.toThrow()
        stubFetch(okResponse)
        await CloudPushService.pushOnce()
        const mark = testDb.prepare("SELECT last_error, last_success_at FROM cloud_push_state WHERE entity='sales'").get() as any
        expect(mark.last_error).toBeNull()
        expect(mark.last_success_at).not.toBeNull()
    })
})

describe('mutable rows and the overlap window', () => {
    it('re-sends a product that changed just before the last mark', async () => {
        // A row updated while a push was in flight can carry a timestamp
        // fractionally before the new mark and would otherwise never go again.
        // Re-sending is free because the far side upserts.
        stubFetch(okResponse)
        await CloudPushService.pushOnce()

        // Nothing changed, but the overlap means the product is still in range.
        expect(CloudPushService.buildBatch().counts.products).toBe(1)
    })

    it('stops re-sending once the product is older than the overlap', async () => {
        stubFetch(okResponse)
        await CloudPushService.pushOnce()
        testDb.prepare("UPDATE products SET updated_at = datetime('now', '-2 hours')").run()
        expect(CloudPushService.buildBatch().counts.products).toBe(0)
    })

    it('sends a product’s variants alongside it', () => {
        const batch = CloudPushService.buildBatch()
        expect(batch.counts.products).toBe(1)
        expect(batch.counts.variants).toBe(1)
        expect(batch.variants[0].size).toBe('52')
    })
})

describe('reporting', () => {
    it('reports what is still waiting, so quiet can be told from stuck', async () => {
        sale(); sale(); sale()
        expect(CloudPushService.pendingCounts().sales).toBe(3)
        stubFetch(okResponse)
        await CloudPushService.pushOnce()
        expect(CloudPushService.pendingCounts().sales).toBe(0)
    })

    it('refuses to push when it has not been configured', async () => {
        CloudPushService.setConfig({ url: '', secret: '' })
        await expect(CloudPushService.pushOnce()).rejects.toThrow(/pas configuré/)
    })

    it('reports configuration state without leaking the key', () => {
        const s = CloudPushService.status()
        expect(s.configured).toBe(true)
        expect(s.enabled).toBe(true)
        expect(s.url).toBe('https://boutique.dz/api/push')
        expect(JSON.stringify(s)).not.toContain('"k"')
    })

    it('walks batches until nothing is left', async () => {
        sale(); sale()
        stubFetch(okResponse)
        const res = await CloudPushService.pushAll()
        expect(res.totals.sales).toBe(2)
        expect(res.remaining.sales).toBe(0)
    })

    it('reports a refused key as a failed test, not an outage', async () => {
        stubFetch(async () => ({ ok: false, status: 401, text: async () => '' }))
        expect(await CloudPushService.test()).toEqual({ ok: false, message: 'Clé refusée par le serveur.' })
    })
})
