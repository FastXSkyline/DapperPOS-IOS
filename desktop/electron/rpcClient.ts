import { TerminalMode } from './terminalMode'
import { EventBus, type RetailEvent } from './eventBus'

// ---------------------------------------------------------------------------
// The client half of thin-client mode: forward an IPC call to the store server
// and subscribe to its event stream.
//
// FAILURE IS LOUD, NEVER SILENT. If the server cannot be reached, a forwarded
// call REJECTS. It must never fall back to this machine's own database: the
// client's SQLite file holds nothing but config and an empty seeded schema, so a
// fallback would answer "0 in stock" and "no such sale" with total confidence.
// A till that says "serveur injoignable" is usable; a till that quietly invents
// answers is worse than one that is switched off.
//
// This is the same stance docs/RETAIL_PLAN.md §2 takes on offline: a client that
// loses the LAN stops selling and says so. Queuing sales locally while the server
// keeps selling the same garment to another terminal is exactly the oversell the
// whole design exists to prevent.
// ---------------------------------------------------------------------------

/** Long enough for a slow query on a busy shop PC, short enough that a cashier
 *  learns the server is down rather than watching a spinner. */
const RPC_TIMEOUT_MS = 12_000

export class RpcUnavailableError extends Error {
    readonly code = 'SERVER_UNREACHABLE'

    constructor(detail: string) {
        super(`Serveur du magasin injoignable — ${detail}`)
        this.name = 'RpcUnavailableError'
    }
}

let connected = false
let lastError = ''
let sseAbort: AbortController | null = null

export const RpcClient = {
    status() {
        const cfg = TerminalMode.get()
        return {
            mode: cfg.mode,
            serverUrl: cfg.serverUrl,
            isClient: TerminalMode.isClient(),
            connected,
            lastError,
        }
    },

    /** Execute one IPC channel on the store server and return its result. */
    async forward(channel: string, args: unknown[]): Promise<unknown> {
        const { serverUrl, token } = TerminalMode.get()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)

        try {
            const res = await fetch(`${serverUrl}/rpc`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-sync-token': token },
                body: JSON.stringify({ channel, args }),
                signal: controller.signal,
            })

            if (res.status === 401) {
                connected = false
                lastError = 'jeton d’appairage refusé'
                throw new RpcUnavailableError(lastError)
            }
            if (res.status === 403) {
                // The server refused the channel itself. That is a rule, not an
                // outage, so it must not be reported as the server being down —
                // and it must carry a code, or the catch below would see an
                // untagged error, assume a transport failure, and rewrap it as
                // unreachable. That would send someone to check the network cable
                // over a policy decision.
                connected = true
                const body = await res.json().catch(() => ({})) as { error?: string }
                const err = new Error(body.error ?? `Action non autorisée à distance : ${channel}`) as Error & { code?: string }
                err.code = 'CHANNEL_NOT_REMOTABLE'
                throw err
            }
            if (!res.ok) {
                connected = false
                lastError = `HTTP ${res.status}`
                throw new RpcUnavailableError(lastError)
            }

            connected = true
            lastError = ''
            const body = await res.json() as { ok: boolean; result?: unknown; error?: string; code?: string }

            if (!body.ok) {
                // A business error from the far side. Rethrown with its code intact so
                // the renderer sees INSUFFICIENT_STOCK, not "remote call failed".
                const err = new Error(body.error ?? 'Erreur distante') as Error & { code?: string }
                err.code = body.code
                throw err
            }
            return body.result
        } catch (e) {
            if (e instanceof RpcUnavailableError) throw e
            if ((e as Error).name === 'AbortError') {
                connected = false
                lastError = 'délai dépassé'
                throw new RpcUnavailableError(lastError)
            }
            // A transport failure (DNS, refused, reset) — anything without a `code`
            // that reached us from fetch rather than from the far side's handler.
            if (!(e as { code?: string }).code) {
                connected = false
                lastError = (e as Error).message
                throw new RpcUnavailableError(lastError)
            }
            throw e
        } finally {
            clearTimeout(timer)
        }
    },

    /** Ask the server whether a user holds a permission. Used by the few channels
     *  that act locally but must still be authorised against the shop's own roles. */
    async can(userId: number, permission: string): Promise<boolean> {
        const result = await this.forward('permission-can', [{ userId, permission }])
        return result === true
    },

    async probe(): Promise<boolean> {
        const { serverUrl } = TerminalMode.get()
        if (!serverUrl) return false
        try {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 3000)
            const res = await fetch(`${serverUrl}/health`, { signal: controller.signal })
            clearTimeout(timer)
            connected = res.ok
            if (res.ok) lastError = ''
            return res.ok
        } catch (e) {
            connected = false
            lastError = (e as Error).message
            return false
        }
    },

    /**
     * Subscribe to the server's event stream and republish locally, so a client's
     * screens react to a sale rung up on another till exactly as they would to one
     * rung up here.
     *
     * Reconnects on its own with a fixed delay. No backoff: this is a LAN, the
     * server coming back is the expected case, and a growing delay would leave a
     * till stale for minutes after a two-second blip.
     */
    startEventStream(): void {
        if (!TerminalMode.isClient()) return
        this.stopEventStream()

        const { serverUrl, token } = TerminalMode.get()
        const controller = new AbortController()
        sseAbort = controller

        const run = async () => {
            try {
                const res = await fetch(`${serverUrl}/events`, {
                    headers: { 'x-sync-token': token, Accept: 'text/event-stream' },
                    signal: controller.signal,
                })
                if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`)

                connected = true
                lastError = ''
                const reader = res.body.getReader()
                const decoder = new TextDecoder()
                let buffer = ''

                for (;;) {
                    const { done, value } = await reader.read()
                    if (done) break
                    buffer += decoder.decode(value, { stream: true })

                    // SSE frames are separated by a blank line; anything after the
                    // last separator is an incomplete frame and stays in the buffer.
                    const frames = buffer.split('\n\n')
                    buffer = frames.pop() ?? ''

                    for (const frame of frames) {
                        if (!frame.startsWith('event: retail')) continue   // ready/ping
                        const line = frame.split('\n').find(l => l.startsWith('data: '))
                        if (!line) continue
                        try {
                            const event = JSON.parse(line.slice(6)) as RetailEvent
                            EventBus.publish(event.type, event.storeId, event.payload)
                        } catch {
                            // A malformed frame is not worth dropping the stream for.
                        }
                    }
                }
            } catch (e) {
                if (controller.signal.aborted) return
                connected = false
                lastError = (e as Error).message
            }

            if (!controller.signal.aborted) {
                setTimeout(run, 5000)
            }
        }

        void run()
    },

    stopEventStream(): void {
        sseAbort?.abort()
        sseAbort = null
    },
}
