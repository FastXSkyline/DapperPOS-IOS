import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from './helpers/sqliteHarness'
import { runRetailMigrations } from '../electron/migrationsRetail'

let testDb: any
vi.mock('../electron/database', () => ({ getDatabase: () => testDb }))

const { NotificationService } = await import('../electron/notificationService')

const COSTUME = 1
const CASUAL = 2

function seed() {
    testDb.prepare("INSERT INTO users (id, name, pin, role) VALUES (10, 'Nabil', 'x', 'warehouse')").run()
    testDb.prepare("INSERT INTO products (id, name, min_stock_level, cost_price) VALUES (1, 'Costume Milano', 3, 18000)").run()
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (1, 1, '52', 'Bleu Marine')").run()
    testDb.prepare("INSERT INTO product_variants (id, product_id, size, color) VALUES (2, 1, '54', 'Bleu Marine')").run()
}

const stock = (variantId: number, qty: number, storeId = COSTUME) =>
    testDb.prepare('INSERT INTO stock_inventory (store_id, product_id, variant_id, quantity) VALUES (?, 1, ?, ?)')
        .run(storeId, variantId, qty)

beforeEach(() => {
    testDb = makeTestDb()
    runRetailMigrations(testDb)
    seed()
})

describe('deduplication', () => {
    // The reason the centre is usable at all: the sweep runs on every boot, and
    // without a key one low-stock condition becomes forty identical rows in a week.
    it('raises one row per condition however often the sweep runs', () => {
        stock(1, 1)
        NotificationService.sweep()
        NotificationService.sweep()
        NotificationService.sweep()
        expect(NotificationService.unreadCount()).toBe(1)
    })

    it('lets the same condition alert again once it has been dismissed', () => {
        // Dismissing means "I have seen this", not "never tell me again".
        stock(1, 1)
        NotificationService.sweep()
        NotificationService.markAllRead()
        NotificationService.sweep()
        expect(NotificationService.unreadCount()).toBe(1)
        expect((testDb.prepare('SELECT COUNT(*) AS n FROM notifications').get() as any).n).toBe(2)
    })

    it('keys on the condition, not the moment, so an ageing transfer stays one alert', () => {
        testDb.prepare(`INSERT INTO stock_transfers (id, transfer_number, from_store_id, to_store_id, status, shipped_at)
                        VALUES (1, 'TRF-1', 1, 2, 'shipped', datetime('now','-4 days'))`).run()
        NotificationService.sweep()
        testDb.prepare("UPDATE stock_transfers SET shipped_at = datetime('now','-5 days')").run()
        NotificationService.sweep()
        expect(testDb.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type='transfer_stuck'").get().n).toBe(1)
    })

    it('reports whether a raise actually landed', () => {
        expect(NotificationService.raise({ type: 't', severity: 'info', title: 'A', dedupeKey: 'k' })).toBe(true)
        expect(NotificationService.raise({ type: 't', severity: 'info', title: 'A', dedupeKey: 'k' })).toBe(false)
    })

    it('does not dedupe rows that carry no key', () => {
        NotificationService.raise({ type: 't', severity: 'info', title: 'ponctuel' })
        NotificationService.raise({ type: 't', severity: 'info', title: 'ponctuel' })
        expect(NotificationService.unreadCount()).toBe(2)
    })
})

describe('stock rules', () => {
    it('reports a rupture as critical and low stock as a warning', () => {
        stock(1, 0)   // rupture
        stock(2, 2)   // below the minimum of 3
        NotificationService.sweep()

        const rows = NotificationService.list({}) as any[]
        expect(rows.find(r => r.type === 'out_of_stock').severity).toBe('critical')
        expect(rows.find(r => r.type === 'low_stock').severity).toBe('warning')
    })

    it('never reports one garment as both out of stock and low', () => {
        // Zero satisfies "at or below the minimum" too; two alerts saying the same
        // thing is exactly the noise that makes a centre unread.
        stock(1, 0)
        NotificationService.sweep()
        const rows = NotificationService.list({}) as any[]
        expect(rows).toHaveLength(1)
        expect(rows[0].type).toBe('out_of_stock')
    })

    it('ignores products with no minimum set', () => {
        testDb.prepare('UPDATE products SET min_stock_level = 0 WHERE id = 1').run()
        stock(1, 0)
        NotificationService.sweep()
        expect(NotificationService.unreadCount()).toBe(0)
    })

    it('names the size and colour, not just the product', () => {
        stock(1, 1)
        NotificationService.sweep()
        const [row] = NotificationService.list({}) as any[]
        expect(row.title).toContain('52 · Bleu Marine')
        expect(row.body).toContain('1 restant')
    })

    it('raises separately per store', () => {
        stock(1, 1, COSTUME)
        stock(1, 1, CASUAL)
        NotificationService.sweep()
        expect(NotificationService.unreadCount()).toBe(2)
        expect(NotificationService.unreadCount(COSTUME)).toBe(1)
    })

    it('can sweep a single store', () => {
        stock(1, 1, COSTUME)
        stock(1, 1, CASUAL)
        NotificationService.sweep(CASUAL)
        expect(NotificationService.unreadCount()).toBe(1)
    })
})

describe('operational rules', () => {
    it('escalates a stuck transfer from warning to critical at a week', () => {
        testDb.prepare(`INSERT INTO stock_transfers (id, transfer_number, from_store_id, to_store_id, status, shipped_at)
                        VALUES (1, 'TRF-1', 1, 2, 'shipped', datetime('now','-4 days'))`).run()
        NotificationService.sweep()
        expect((NotificationService.list({}) as any[])[0].severity).toBe('warning')

        testDb.prepare('DELETE FROM notifications').run()
        testDb.prepare("UPDATE stock_transfers SET shipped_at = datetime('now','-8 days')").run()
        NotificationService.sweep()
        expect((NotificationService.list({}) as any[])[0].severity).toBe('critical')
    })

    it('flags an incoming transfer to the RECEIVING store', () => {
        testDb.prepare(`INSERT INTO stock_transfers (id, transfer_number, from_store_id, to_store_id, status, shipped_at)
                        VALUES (1, 'TRF-1', 1, 2, 'shipped', datetime('now'))`).run()
        NotificationService.sweep()
        const [row] = NotificationService.list({}) as any[]
        expect(row.type).toBe('transfer_incoming')
        expect(row.store_id).toBe(CASUAL)
    })

    it('ignores a transfer already received', () => {
        testDb.prepare(`INSERT INTO stock_transfers (id, transfer_number, from_store_id, to_store_id, status, shipped_at, received_at)
                        VALUES (1, 'TRF-1', 1, 2, 'received', datetime('now','-9 days'), datetime('now'))`).run()
        NotificationService.sweep()
        expect(NotificationService.unreadCount()).toBe(0)
    })

    it('flags a till closed short, and escalates a large one', () => {
        testDb.prepare(`INSERT INTO cash_sessions (id, session_number, status, variance, store_id, closed_at, closed_by)
                        VALUES (1, 'Z-1', 'closed', -250, 1, datetime('now'), 10)`).run()
        NotificationService.sweep()
        const [row] = NotificationService.list({}) as any[]
        expect(row.type).toBe('cash_variance')
        expect(row.severity).toBe('warning')
        expect(row.title).toContain('-250')

        testDb.prepare('DELETE FROM notifications').run()
        testDb.prepare('UPDATE cash_sessions SET variance = -5000').run()
        NotificationService.sweep()
        expect((NotificationService.list({}) as any[])[0].severity).toBe('critical')
    })

    it('ignores a till that balanced to within 100 DA', () => {
        testDb.prepare(`INSERT INTO cash_sessions (id, session_number, status, variance, store_id, closed_at)
                        VALUES (1, 'Z-1', 'closed', -20, 1, datetime('now'))`).run()
        NotificationService.sweep()
        expect(NotificationService.unreadCount()).toBe(0)
    })

    it('chases an inventory count left open', () => {
        testDb.prepare(`INSERT INTO inventory_counts (id, count_number, store_id, status, started_at)
                        VALUES (1, 'CNT-1', 1, 'counting', datetime('now','-3 days'))`).run()
        NotificationService.sweep()
        expect((NotificationService.list({}) as any[])[0].type).toBe('count_open')
    })

    it('does not chase a count started today', () => {
        testDb.prepare(`INSERT INTO inventory_counts (id, count_number, store_id, status, started_at)
                        VALUES (1, 'CNT-1', 1, 'counting', datetime('now'))`).run()
        NotificationService.sweep()
        expect(NotificationService.unreadCount()).toBe(0)
    })
})

describe('the centre', () => {
    it('orders unread first, then by urgency', () => {
        stock(1, 0)   // critical
        stock(2, 2)   // warning
        NotificationService.sweep()
        const rows = NotificationService.list({}) as any[]
        expect(rows.map(r => r.severity)).toEqual(['critical', 'warning'])

        NotificationService.markRead(rows[0].id)
        const after = NotificationService.list({}) as any[]
        // Read drops below unread even though it is the more urgent one.
        expect(after[0].severity).toBe('warning')
    })

    it('shows a store its own alerts plus the global ones', () => {
        stock(1, 1, CASUAL)
        NotificationService.sweep()
        NotificationService.raise({ type: 'system', severity: 'info', title: 'Global', dedupeKey: 'g' })

        expect((NotificationService.list({ storeId: COSTUME }) as any[]).map(r => r.title)).toEqual(['Global'])
        expect(NotificationService.list({ storeId: CASUAL })).toHaveLength(2)
    })

    it('filters to unread', () => {
        stock(1, 0)
        stock(2, 2)
        NotificationService.sweep()
        const rows = NotificationService.list({}) as any[]
        NotificationService.markRead(rows[0].id)
        expect(NotificationService.list({ unreadOnly: true })).toHaveLength(1)
    })

    it('marks all read for one store only', () => {
        stock(1, 1, COSTUME)
        stock(1, 1, CASUAL)
        NotificationService.sweep()
        NotificationService.markAllRead(CASUAL)
        expect(NotificationService.unreadCount(COSTUME)).toBe(1)
        expect(NotificationService.unreadCount(CASUAL)).toBe(0)
    })

    it('is idempotent when marking an already-read row', () => {
        stock(1, 1)
        NotificationService.sweep()
        const [row] = NotificationService.list({}) as any[]
        NotificationService.markRead(row.id)
        const first = testDb.prepare('SELECT read_at FROM notifications WHERE id = ?').get(row.id) as any
        NotificationService.markRead(row.id)
        const second = testDb.prepare('SELECT read_at FROM notifications WHERE id = ?').get(row.id) as any
        expect(second.read_at).toBe(first.read_at)
    })
})
