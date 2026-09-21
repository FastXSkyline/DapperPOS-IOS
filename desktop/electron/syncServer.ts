import Fastify from 'fastify'
import cors from '@fastify/cors'
import { getDatabase } from './database'
import { ingestMobileTransactions } from './mobileIngest'
import { ReceiptService } from './receiptService'
import { InvoiceService } from './invoiceService'
import { PurchaseOrderService } from './purchaseOrderService'
import { runAssistant } from './ai/orchestrator'
import { transcribeAudio } from './voice/transcribe'
import os from 'os'
import { EventBus } from './eventBus'
import { IpcRegistry } from './ipcRegistry'
import { isRemotableChannel } from './rpcRouter'
import { NetworkService } from './networkService'
import crypto from 'node:crypto'

// bodyLimit raised to accept base64 voice clips on /ai/voice.
export const syncServer = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024 })

syncServer.register(cors, {
    origin: true // Allow all for LAN
})

// --- Pairing token: every device must present a shared secret to use the server ---
let _syncToken: string | null = null
export function getSyncToken(): string {
    if (_syncToken) return _syncToken
    const db = getDatabase()
    const row = db.prepare("SELECT value FROM config WHERE key = 'sync_token'").get() as { value: string } | undefined
    if (row?.value) {
        _syncToken = row.value
        return _syncToken
    }
    const token = crypto.randomBytes(24).toString('base64url')
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('sync_token', ?)").run(token)
    _syncToken = token
    return token
}

function tokenEquals(provided: string, expected: string): boolean {
    const a = Buffer.from(provided)
    const b = Buffer.from(expected)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// Auth hook — reject any request without the correct x-sync-token.
// /health stays open (connectivity check) and CORS preflight (OPTIONS) is allowed.
syncServer.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return
    const pathOnly = request.url.split('?')[0]
    if (pathOnly === '/health') return
    const provided = request.headers['x-sync-token']
    if (typeof provided !== 'string' || !tokenEquals(provided, getSyncToken())) {
        return reply.code(401).send({ error: 'Unauthorized: missing or invalid sync token' })
    }
})

// Device monitor — runs only for requests the auth hook above let through, so it
// records authorised callers and nothing else. Fastify skips later onRequest
// hooks once one has sent a reply, which is what keeps unauthenticated probes out
// of the device list. Fire-and-forget: `recordDevice` swallows its own errors so a
// monitoring write can never fail the sale or sync it is observing.
syncServer.addHook('onRequest', async (request) => {
    const pathOnly = request.url.split('?')[0]
    if (pathOnly === '/health') return
    const h = request.headers
    const header = (name: string) => {
        const v = h[name]
        return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : null
    }
    NetworkService.recordDevice({
        deviceId: header('x-device-id'),
        deviceName: header('x-device-name'),
        deviceType: header('x-device-type'),
        ip: request.ip,
        userAgent: header('user-agent'),
        endpoint: `${request.method} ${pathOnly}`,
    })
})

// === Get Local IP ===
export function getLocalIP() {
    const interfaces = os.networkInterfaces()
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]!) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address
            }
        }
    }
    return '127.0.0.1'
}

// === Endpoints ===

/**
 * Execute one IPC channel on behalf of a terminal in this store (thin-client mode).
 *
 * This is a remote-execution surface, so it is guarded three ways:
 *
 *   1. The `x-sync-token` hook above — a caller must already hold the shared LAN
 *      secret before this handler is ever reached.
 *   2. DENY BY DEFAULT — `isRemotableChannel` refuses anything not actually
 *      registered as a handler, so a typo or a probe gets 403, never a stack trace.
 *   3. An explicit never-remote list (database reset, catalogue import, credential
 *      reads, owner PIN). A shared secret on a shop LAN is not a strong enough
 *      boundary to destroy data or hand out keys behind.
 *
 * Errors are returned as data, with the code preserved, so the calling terminal
 * can tell INSUFFICIENT_STOCK from the server being unreachable — those two need
 * completely different things from the cashier.
 */
syncServer.post('/rpc', async (request: any, reply) => {
    const { channel, args } = (request.body ?? {}) as { channel?: string; args?: unknown[] }

    if (typeof channel !== 'string') {
        return reply.code(400).send({ ok: false, error: 'channel manquant' })
    }
    if (!isRemotableChannel(channel, IpcRegistry.channels())) {
        console.warn(`[rpc] refused channel: ${channel}`)
        return reply.code(403).send({ ok: false, error: `Action non disponible a distance : ${channel}` })
    }

    const handler = IpcRegistry.get(channel)!
    try {
        // The first parameter of an ipcMain handler is the IpcMainInvokeEvent, which
        // no handler in this codebase reads. Passing null keeps the signature honest
        // rather than fabricating a fake event object.
        const result = await handler(null, ...(Array.isArray(args) ? args : []))
        return reply.send({ ok: true, result: result ?? null })
    } catch (e: any) {
        console.error(`[rpc] ${channel} failed:`, e)
        return reply.send({ ok: false, error: e?.message ?? 'Erreur', code: e?.code })
    }
})

/**
 * Live event stream for the other terminals in this store (brief §61).
 *
 * SSE rather than a WebSocket: the traffic is one-way (server tells clients
 * something changed), it rides plain HTTP so it inherits the pairing-token hook
 * above unchanged, and it reconnects on its own. A WebSocket would buy
 * bidirectionality nobody needs and a second auth path to get wrong.
 *
 * NOTE ON AUTH: the token is required in the `x-sync-token` header like every
 * other route, which means a browser `EventSource` cannot connect — it cannot set
 * headers. That is deliberate: the clients here are Electron and React Native,
 * both of which can stream with fetch, and the alternative (accepting the token in
 * the query string) would write the shared secret into every access log.
 */
syncServer.get('/events', async (request, reply) => {
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    })

    const sink = {
        id: crypto.randomUUID(),
        write: (chunk: string) => reply.raw.write(chunk),
    }
    EventBus.addSseClient(sink)

    // Tell the client it is connected, so it can distinguish "attached and quiet"
    // from "never attached" — the difference between a calm shop and a broken link.
    sink.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`)

    request.raw.on('close', () => EventBus.removeSseClient(sink))
    request.raw.on('error', () => EventBus.removeSseClient(sink))

    // Never resolves: the handler owns the socket for the life of the connection.
    return reply
})

// 1. Health Check
syncServer.get('/health', async () => {
    return { status: 'ok', device: 'Desktop POS' }
})

// 2. Delta Sync: Get Products changed since TIMESTAMP
syncServer.get('/sync/products', async (request: any, reply) => {
    const { since } = request.query
    const db = getDatabase()

    // If 'since' is provided, return only changed.
    // stock_inventory is joined through a GROUPED subquery: a product with variants
    // has one row per size/colour, so joining it directly would emit that product
    // once per variant and mobile would show duplicates with partial stock.
    let sql = `
        SELECT p.*,
               c.name as category_name,
               s.company_name as supplier_name,
               COALESCE(si.quantity, 0) as stock_quantity,
               EXISTS(SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1) AS has_variants
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN suppliers s ON p.supplier_id = s.id
        LEFT JOIN (
            SELECT product_id, SUM(quantity) AS quantity
            FROM stock_inventory GROUP BY product_id
        ) si ON si.product_id = p.id
    `

    const params: any[] = []

    if (since) {
        sql += ` WHERE p.updated_at > ?`
        params.push(since)
    }

    try {
        const products = db.prepare(sql).all(...params)
        // Variants ride along with the products so the till can ask for a size/colour
        // offline. Always the full active set — they are few, and a delta on the
        // parent product's updated_at would miss a variant edited on its own.
        const variants = db.prepare(`
            SELECT pv.id, pv.product_id, pv.size, pv.color, pv.sku, pv.barcode,
                   pv.retail_price, pv.sort_order,
                   COALESCE(si.quantity, 0) AS stock_quantity
            FROM product_variants pv
            LEFT JOIN (
                SELECT variant_id, SUM(quantity) AS quantity
                FROM stock_inventory WHERE variant_id IS NOT NULL GROUP BY variant_id
            ) si ON si.variant_id = pv.id
            WHERE pv.is_active = 1
            ORDER BY pv.product_id, pv.sort_order, pv.size, pv.color
        `).all()
        const regimeRow = db.prepare("SELECT value FROM config WHERE key = 'regime'").get() as { value: string } | undefined
        const pricesRow = db.prepare("SELECT value FROM config WHERE key = 'prices_include_tax'").get() as { value: string } | undefined
        const receiptRow = db.prepare("SELECT value FROM config WHERE key = 'receipt_config'").get() as { value: string } | undefined
        let companyName = ''
        try { companyName = (receiptRow ? JSON.parse(receiptRow.value)?.companyName : '') || '' } catch { /* ignore */ }
        return {
            products,
            variants,
            timestamp: new Date().toISOString(),
            regime: regimeRow?.value || 'reel',
            pricesIncludeTax: pricesRow?.value === '1',
            companyName, // white-label: mobile shows the shop's own name
        }
    } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Database error' })
    }
})

// 2.5. Get all suppliers for mobile sync
syncServer.get('/sync/suppliers', async (request: any, reply) => {
    const db = getDatabase()
    try {
        const suppliers = db.prepare(`
            SELECT id, company_name, contact_name, phone, email, address, city, country, tax_id, is_active
            FROM suppliers
            WHERE is_active = 1
            ORDER BY company_name
        `).all()
        return { suppliers }
    } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Database error' })
    }
})

// 3. Receive Transactions from Mobile
syncServer.post('/sync/transactions', async (request: any, reply) => {
    const { transactions } = request.body

    if (!transactions || !Array.isArray(transactions)) {
        return reply.code(400).send({ error: 'Invalid payload' })
    }

    // Shared with the Firestore relay — see electron/mobileIngest.ts. A phone sale
    // must be recomputed identically whichever transport delivered it.
    const { ingested, ...results } = ingestMobileTransactions(transactions)
    void ingested
    return results
})

// 4. Remote Print: Print receipt from Mobile
syncServer.post('/print/receipt/:id', async (request: any, reply) => {
    const { id } = request.params
    console.log(`[SyncServer] Received print request for transaction identifier: ${id}`)

    try {
        let transactionId = Number(id)
        const db = getDatabase()

        // If ID is NaN or likely a transaction string (e.g. "TX-..."), try lookup
        if (isNaN(transactionId)) {
            const tx = db.prepare('SELECT id FROM transactions WHERE transaction_number = ?').get(id) as { id: number }
            if (tx) transactionId = tx.id
        }

        const data = await ReceiptService.generateReceiptDataFromTransaction(transactionId)
        if (!data) {
            return reply.code(404).send({ error: 'Transaction not found' })
        }

        const result = await ReceiptService.print(data)
        if (result.success) {
            return { success: true }
        } else {
            return reply.code(500).send({ error: result.error })
        }
    } catch (e: any) {
        console.error('[SyncServer] Print error:', e)
        return reply.code(500).send({ error: e.message })
    }
})

// 5. Remote Print Purchase Order
syncServer.post('/print/order/:id', async (request: any, reply) => {
    const { id } = request.params
    console.log(`[SyncServer] Received print order request for: ${id}`)

    try {
        let orderId = Number(id)
        const db = getDatabase()

        // If ID is NaN, try lookup by PO number
        if (isNaN(orderId)) {
            const po = db.prepare('SELECT id FROM purchase_orders WHERE po_number = ?').get(id) as { id: number }
            if (po) orderId = po.id
        }

        if (!orderId) {
            return reply.code(404).send({ error: 'Order not found' })
        }

        const result = await PurchaseOrderService.printPO(orderId)

        if ((result as any).success) {
            return { success: true }
        } else {
            return reply.code(500).send({ error: (result as any).error })
        }
    } catch (e: any) {
        console.error('[SyncServer] Print order error:', e)
        return reply.code(500).send({ error: e.message })
    }
})

// 6. Raw Print Receipt (Full Data)
syncServer.post('/print/raw/receipt', async (request: any, reply) => {
    console.log('[SyncServer] Received RAW receipt print request')
    try {
        const receiptData = request.body
        if (!receiptData || !receiptData.items) {
            console.error('[SyncServer] Invalid receipt data received')
            return reply.code(400).send({ error: 'Invalid receipt data' })
        }

        console.log(`[SyncServer] Printing receipt: ${receiptData.transactionNumber} (${receiptData.items.length} items)`)
        const result = await ReceiptService.print(receiptData)

        if (result.success) {
            console.log('[SyncServer] Raw receipt print success')
            return { success: true }
        } else {
            console.error('[SyncServer] Raw receipt print failed:', result.error)
            return reply.code(500).send({ error: result.error })
        }
    } catch (e: any) {
        console.error('[SyncServer] Raw receipt print error:', e)
        return reply.code(500).send({ error: e.message })
    }
})

// 7. Raw Print Purchase Order (Full Data)
syncServer.post('/print/raw/order', async (request: any, reply) => {
    console.log('[SyncServer] Received RAW PO print request')
    try {
        const poData = request.body
        if (!poData || !poData.items) {
            console.error('[SyncServer] Invalid PO data received')
            return reply.code(400).send({ error: 'Invalid PO data' })
        }

        console.log(`[SyncServer] Printing PO: ${poData.po_number} (${poData.items.length} items)`)
        const result = await PurchaseOrderService.printPOFromData(poData)

        if ((result as any).success) {
            console.log('[SyncServer] Raw PO print success')
            return { success: true }
        } else {
            console.error('[SyncServer] Raw PO print failed:', (result as any).error)
            return reply.code(500).send({ error: (result as any).error })
        }
    } catch (e: any) {
        console.error('[SyncServer] Raw PO print error:', e)
        return reply.code(500).send({ error: e.message })
    }
})

// 8. Raw Print Invoice (Full Data, A4)
syncServer.post('/print/raw/invoice', async (request: any, reply) => {
    console.log('[SyncServer] Received RAW invoice print request')
    try {
        const receiptData = request.body
        if (!receiptData || !receiptData.items) {
            console.error('[SyncServer] Invalid invoice data received')
            return reply.code(400).send({ error: 'Invalid invoice data' })
        }

        console.log(`[SyncServer] Printing invoice: ${receiptData.transactionNumber}`)
        const result = await InvoiceService.print(receiptData)

        if ((result as any).success) {
            console.log('[SyncServer] Raw invoice print success')
            return { success: true }
        } else {
            console.error('[SyncServer] Raw invoice print failed:', (result as any).error)
            return reply.code(500).send({ error: (result as any).error })
        }
    } catch (e: any) {
        console.error('[SyncServer] Raw invoice print error:', e)
        return reply.code(500).send({ error: e.message })
    }
})

// 9. AI copilot proxy (text) — mobile sends a command, the desktop "brain" runs it.
syncServer.post('/ai', async (request: any, reply) => {
    const { text } = request.body || {}
    if (!text || typeof text !== 'string') {
        return reply.code(400).send({ error: 'Missing text' })
    }
    const result = await runAssistant(text, { userId: 1 })
    return { text, reply: result.reply, events: result.events, success: result.success, error: result.error }
})

// 10. AI copilot proxy (voice) — mobile sends base64 audio; desktop transcribes + runs it.
// Keeps the OpenAI key server-side only (never shipped in the mobile bundle).
syncServer.post('/ai/voice', async (request: any, reply) => {
    const { audioBase64, filename } = request.body || {}
    if (!audioBase64 || typeof audioBase64 !== 'string') {
        return reply.code(400).send({ error: 'Missing audio' })
    }
    const text = await transcribeAudio(Buffer.from(audioBase64, 'base64'), typeof filename === 'string' ? filename : undefined)
    if (!text) return reply.code(422).send({ error: 'Could not transcribe audio' })
    const result = await runAssistant(text, { userId: 1 })
    return { text, reply: result.reply, events: result.events, success: result.success, error: result.error }
})

export async function startSyncServer(port = 4000) {
    try {
        await syncServer.listen({ port, host: '0.0.0.0' })
        const ip = getLocalIP()
        getSyncToken() // ensure a pairing token exists at boot
        console.log(`Sync Server running at http://${ip}:${port} (pairing token required)`)
        return { port, ip }
    } catch (err) {
        syncServer.log.error(err)
        // process.exit(1) // Don't crash main app
        return null
    }
}
