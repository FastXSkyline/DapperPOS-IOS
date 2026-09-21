import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from './helpers/sqliteHarness'
import { runRetailMigrations } from '../electron/migrationsRetail'

let testDb: any
vi.mock('../electron/database', () => ({ getDatabase: () => testDb }))
// receiptService reaches for `electron` (BrowserWindow, app) at import time for
// its print path; the generators under test do not touch it.
vi.mock('electron', () => ({
    app: { getPath: () => '.' },
    BrowserWindow: class {},
}))

const { ReceiptService } = await import('../electron/receiptService')

/* ---------------------------------------------------------------------------
   A discounted line has to show what the ticket said AND what was paid.

   The signal is `transaction_items.base_unit_price` — the pre-promotion,
   pre-quantity-break price frozen by TransactionService.addItem. It is only a
   discount when it is strictly higher than `unit_price`; on an ordinary line
   the two are equal, and printing an identical struck-through price on every
   receipt would be noise that trains the customer to ignore it.
   --------------------------------------------------------------------------- */

function seedSale(lines: { name: string; qty: number; paid: number; base: number }[]) {
    testDb.prepare("INSERT OR IGNORE INTO users (id, name, pin, role) VALUES (1, 'Sara', 'x', 'cashier')").run()
    testDb.prepare(`
        INSERT INTO transactions (id, transaction_number, user_id, status, subtotal, discount_amount, tax_amount, total_amount, change_due, created_at)
        VALUES (1, 'TX-1', 1, 'completed', 0, 0, 0, 0, 0, datetime('now'))
    `).run()
    const total = lines.reduce((n, l) => n + l.paid * l.qty, 0)
    testDb.prepare('UPDATE transactions SET subtotal = ?, total_amount = ? WHERE id = 1').run(total, total)

    lines.forEach((l, idx) => {
        testDb.prepare('INSERT OR IGNORE INTO products (id, name, retail_price) VALUES (?, ?, ?)')
            .run(idx + 1, l.name, l.base)
        testDb.prepare(`
            INSERT INTO transaction_items
                (transaction_id, product_id, product_name, quantity, unit_price, base_unit_price, line_total, tax_rate, tax_amount, unit_factor)
            VALUES (1, ?, ?, ?, ?, ?, ?, 0, 0, 1)
        `).run(idx + 1, l.name, l.qty, l.paid, l.base, l.paid * l.qty)
    })
}

beforeEach(() => {
    testDb = makeTestDb()
    runRetailMigrations(testDb)
    testDb.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('receipt_config', ?)")
        .run(JSON.stringify({ companyName: 'Dapper', paperWidth: 80, showLogo: true, showTaxBreakdown: true }))
})

describe('the discounted line on a receipt', () => {
    it('carries the original price when a promotion cut it', async () => {
        seedSale([{ name: 'Costume Milano', qty: 1, paid: 28000, base: 35000 }])
        const data = await ReceiptService.generateReceiptDataFromTransaction(1)
        expect(data.items[0].originalUnitPrice).toBe(35000)
        expect(data.items[0].unitPrice).toBe(28000)
    })

    it('carries nothing when the line sold at the ticket price', async () => {
        seedSale([{ name: 'Chemise Oxford', qty: 2, paid: 4500, base: 4500 }])
        const data = await ReceiptService.generateReceiptDataFromTransaction(1)
        // Undefined, not "equal to unitPrice" — the templates branch on presence.
        expect(data.items[0].originalUnitPrice).toBeUndefined()
    })

    it('never treats a price RISE as a discount', async () => {
        // Defensive: a negotiated price above the shelf price must not print as
        // a promotion. base < paid is not a saving.
        seedSale([{ name: 'Veste Slim', qty: 1, paid: 9800, base: 9000 }])
        const data = await ReceiptService.generateReceiptDataFromTransaction(1)
        expect(data.items[0].originalUnitPrice).toBeUndefined()
    })

    it('strikes the original through in the printed HTML and names the saving', async () => {
        seedSale([{ name: 'Costume Milano', qty: 2, paid: 28000, base: 35000 }])
        const data = await ReceiptService.generateReceiptDataFromTransaction(1)
        const html = ReceiptService.generateReceiptHTML(data)

        expect(html).toContain('class="was"')
        expect(html).toContain('35000.00')
        expect(html).toContain('28000.00')
        // 2 × (35000 − 28000)
        expect(html).toContain('14000.00')
        expect(html).toContain('PROMO')
    })

    it('leaves an undiscounted receipt free of promo furniture', async () => {
        seedSale([{ name: 'Chemise Oxford', qty: 1, paid: 4500, base: 4500 }])
        const html = ReceiptService.generateReceiptHTML(
            await ReceiptService.generateReceiptDataFromTransaction(1))
        expect(html).not.toContain('class="was"')
        expect(html).not.toContain('PROMO')
    })

    it('spells the saving out on the plain-text receipt, which cannot strike through', async () => {
        seedSale([{ name: 'Costume Milano', qty: 1, paid: 28000, base: 35000 }])
        const text = ReceiptService.generateReceiptText(
            await ReceiptService.generateReceiptDataFromTransaction(1))
        expect(text).toContain('Prix normal 35000.00')
        expect(text).toContain('PROMO -7000.00')
    })
})

describe('the wordmark', () => {
    it('goes on the printed receipt', async () => {
        seedSale([{ name: 'Chemise Oxford', qty: 1, paid: 4500, base: 4500 }])
        const html = ReceiptService.generateReceiptHTML(
            await ReceiptService.generateReceiptDataFromTransaction(1))
        // Embedded as a data: URI so a packaged build cannot lose the file path —
        // a broken <img> on a receipt is invisible until a customer holds the paper.
        expect(html).toContain('data:image/svg+xml;base64,')
        expect(html).toContain('alt="DAPPER"')
    })

    it('has a transparent background, so it sits on the paper rather than in a box', async () => {
        const { brandLogoDataUri } = await import('../electron/util/brandLogo')
        const svg = Buffer.from(brandLogoDataUri().split(',')[1], 'base64').toString('utf8')
        expect(svg).toContain('DAPPER')
        expect(svg).not.toMatch(/<rect/)
        expect(svg).not.toContain('background')
    })

    it('goes on the plain-text receipt too, as spaced capitals', async () => {
        seedSale([{ name: 'Chemise Oxford', qty: 1, paid: 4500, base: 4500 }])
        const text = ReceiptService.generateReceiptText(
            await ReceiptService.generateReceiptDataFromTransaction(1))
        expect(text).toContain('D A P P E R')
    })

    it('is suppressed when the shop turns the logo off', async () => {
        testDb.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('receipt_config', ?)")
            .run(JSON.stringify({ companyName: 'Dapper', paperWidth: 80, showLogo: false }))
        seedSale([{ name: 'Chemise Oxford', qty: 1, paid: 4500, base: 4500 }])
        const html = ReceiptService.generateReceiptHTML(
            await ReceiptService.generateReceiptDataFromTransaction(1))
        expect(html).not.toContain('alt="DAPPER"')
    })
})
