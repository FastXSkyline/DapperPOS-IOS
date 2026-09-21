import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// TerminalMode reads config out of the database; stub it so these tests are about
// the transport and nothing else.
vi.mock('../electron/terminalMode', () => ({
    TerminalMode: {
        get: () => ({ mode: 'client', serverUrl: 'http://192.168.1.20:4000', token: 'secret' }),
        isClient: () => true,
        set: () => {},
    },
}))
vi.mock('../electron/eventBus', () => ({ EventBus: { publish: () => {} } }))

const { RpcClient, RpcUnavailableError } = await import('../electron/rpcClient')

const originalFetch = globalThis.fetch

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>) {
    globalThis.fetch = ((url: string, init?: RequestInit) =>
        impl(url, init) as Promise<Response>) as typeof fetch
}

const jsonResponse = (status: number, body: unknown): Partial<Response> => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
})

beforeEach(() => { globalThis.fetch = originalFetch })
afterEach(() => { globalThis.fetch = originalFetch })

describe('forwarding a call', () => {
    it('posts the channel and args with the pairing token', async () => {
        let seen: { url: string; init?: RequestInit } | null = null
        stubFetch(async (url, init) => {
            seen = { url, init }
            return jsonResponse(200, { ok: true, result: { id: 7 } })
        })

        const result = await RpcClient.forward('transaction-create', [1, null])

        expect(result).toEqual({ id: 7 })
        expect(seen!.url).toBe('http://192.168.1.20:4000/rpc')
        expect((seen!.init!.headers as Record<string, string>)['x-sync-token']).toBe('secret')
        expect(JSON.parse(seen!.init!.body as string))
            .toEqual({ channel: 'transaction-create', args: [1, null] })
    })

    it('marks the connection healthy on success', async () => {
        stubFetch(async () => jsonResponse(200, { ok: true, result: null }))
        await RpcClient.forward('product-get-all', [])
        expect(RpcClient.status().connected).toBe(true)
        expect(RpcClient.status().lastError).toBe('')
    })
})

describe('a business error is not an outage', () => {
    // The distinction the cashier acts on: "the shop is short of this shirt" means
    // change the cart; "the server is down" means stop selling and find the manager.
    it('rethrows the far side’s error with its code intact', async () => {
        stubFetch(async () => jsonResponse(200, {
            ok: false, error: 'Stock insuffisant pour Costume Milano', code: 'INSUFFICIENT_STOCK',
        }))

        await expect(RpcClient.forward('transaction-complete', [{}]))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK', message: /Stock insuffisant/ })
    })

    it('does not report the server as down when it answered a business error', async () => {
        stubFetch(async () => jsonResponse(200, { ok: false, error: 'refusé', code: 'PERMISSION_DENIED' }))
        await expect(RpcClient.forward('inventory-adjust', [{}])).rejects.toThrow()
        expect(RpcClient.status().connected).toBe(true)
    })

    it('treats a refused channel as a rule, not an outage', async () => {
        // 403 means the server declined to run this channel remotely. Reporting it
        // as unreachable would send someone to check the network cable.
        stubFetch(async () => jsonResponse(403, { ok: false, error: 'Action non disponible a distance' }))

        await expect(RpcClient.forward('maintenance-reset-db', []))
            .rejects.toThrow(/non disponible/)
        expect(RpcClient.status().connected).toBe(true)
    })
})

describe('an outage is loud, and never answered locally', () => {
    it('reports a refused connection as SERVER_UNREACHABLE', async () => {
        stubFetch(async () => { throw new Error('connect ECONNREFUSED 192.168.1.20:4000') })

        await expect(RpcClient.forward('product-get-all', []))
            .rejects.toBeInstanceOf(RpcUnavailableError)
        const status = RpcClient.status()
        expect(status.connected).toBe(false)
        expect(status.lastError).toContain('ECONNREFUSED')
    })

    it('reports a bad token as unreachable rather than silently degrading', async () => {
        stubFetch(async () => jsonResponse(401, { error: 'Unauthorized' }))
        await expect(RpcClient.forward('product-get-all', []))
            .rejects.toThrow(/jeton/)
        expect(RpcClient.status().connected).toBe(false)
    })

    it('reports a 500 as unreachable', async () => {
        stubFetch(async () => jsonResponse(500, {}))
        await expect(RpcClient.forward('product-get-all', []))
            .rejects.toBeInstanceOf(RpcUnavailableError)
    })

    it('reports an abort as a timeout', async () => {
        stubFetch(async () => {
            const e = new Error('The operation was aborted')
            e.name = 'AbortError'
            throw e
        })
        await expect(RpcClient.forward('analytics-summary', [{}]))
            .rejects.toThrow(/délai dépassé/)
    })

    it('never returns a value when the server cannot be reached', async () => {
        // The property that matters most: a client's own database holds nothing but
        // config and an empty schema, so ANY local answer would be confident nonsense.
        stubFetch(async () => { throw new Error('network down') })
        await expect(RpcClient.forward('inventory-stock', [{}])).rejects.toThrow()
    })
})

describe('health probe', () => {
    it('marks connected when /health answers', async () => {
        stubFetch(async () => ({ ok: true, status: 200 }))
        expect(await RpcClient.probe()).toBe(true)
        expect(RpcClient.status().connected).toBe(true)
    })

    it('marks disconnected and records why when it does not', async () => {
        stubFetch(async () => { throw new Error('EHOSTUNREACH') })
        expect(await RpcClient.probe()).toBe(false)
        expect(RpcClient.status().lastError).toContain('EHOSTUNREACH')
    })
})
