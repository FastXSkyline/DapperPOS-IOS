// ---------------------------------------------------------------------------
// Retail event bus (brief §61).
//
// One publisher, two transports:
//
//   • Electron windows on THIS machine, over IPC — so the Stock screen reacts to
//     a sale made on the POS screen without anyone pressing refresh.
//   • Other terminals in the same store, over Server-Sent Events on the LAN
//     server — the transport a thin client will consume.
//
// THE ONE RULE THAT MATTERS: publish AFTER the database transaction commits,
// never inside it. An event emitted mid-transaction announces something that may
// still roll back, and every subscriber would then be showing stock that was
// never actually sold. That is why publishing lives in the IPC handlers in
// main.ts — after the service call has returned — and not inside the services,
// where "have we committed yet?" is not knowable locally.
//
// The bus is deliberately dumb: no retries, no ordering guarantees, no replay.
// An event is a HINT that something changed, never the change itself. A client
// that misses one re-reads and is correct again; a client that treats the payload
// as authoritative would drift the moment a packet is dropped. Payloads therefore
// carry identifiers, not values to be trusted.
//
// SCOPE, STATED PLAINLY: cross-machine delivery works only for a client that
// reads the SAME database — i.e. a thin client pointed at this store's server.
// That mode is not built yet, so today the SSE stream is live and correct but has
// no desktop consumer. See docs/RETAIL_PLAN.md §2.
// ---------------------------------------------------------------------------

export type RetailEventType =
    | 'inventory.updated'
    | 'sale.created'
    | 'sale.returned'
    | 'transfer.created'
    | 'transfer.shipped'
    | 'transfer.received'
    | 'cash_session.updated'
    | 'notification.created'
    | 'count.applied'

export interface RetailEvent {
    type: RetailEventType
    /** Null for events that concern every store (settings, catalogue). */
    storeId: number | null
    /** ISO timestamp, set by the bus so every subscriber agrees on ordering. */
    at: string
    /** Identifiers only — see the header on why payloads are not authoritative. */
    payload?: Record<string, unknown>
}

type Listener = (event: RetailEvent) => void

/** An SSE subscriber. Kept structural rather than typed to Fastify's Reply so the
 *  bus does not have to import the web framework. */
export interface SseSink {
    write(chunk: string): void
    id: string
}

const windowListeners = new Set<Listener>()
const sseClients = new Set<SseSink>()

export const EventBus = {
    /** Subscribe an in-process listener (the Electron window broadcaster). */
    onEvent(listener: Listener): () => void {
        windowListeners.add(listener)
        return () => windowListeners.delete(listener)
    },

    addSseClient(sink: SseSink): void {
        sseClients.add(sink)
    },

    removeSseClient(sink: SseSink): void {
        sseClients.delete(sink)
    },

    sseClientCount(): number {
        return sseClients.size
    },

    /**
     * Announce a change. Call only after the work has committed.
     *
     * Never throws: a subscriber that has gone away — a closed window, a laptop
     * that walked out of wifi range — must not be able to fail the operation that
     * just succeeded.
     */
    publish(type: RetailEventType, storeId: number | null, payload?: Record<string, unknown>): void {
        const event: RetailEvent = { type, storeId, at: new Date().toISOString(), payload }

        for (const listener of windowListeners) {
            try {
                listener(event)
            } catch (e) {
                console.error('[eventBus] window listener failed:', e)
            }
        }

        if (sseClients.size === 0) return

        // Serialising can fail on a payload that is not plain data. Local windows
        // have already been told by this point, so the right answer is to skip the
        // wire and carry on — the alternative would let a malformed payload throw
        // out of a handler whose sale has already committed.
        let frame: string
        try {
            frame = `event: retail\ndata: ${JSON.stringify(event)}\n\n`
        } catch (e) {
            console.error('[eventBus] payload is not serialisable, not broadcast:', type, e)
            return
        }

        for (const client of sseClients) {
            try {
                client.write(frame)
            } catch {
                // A dead socket: drop it rather than retrying into a void.
                sseClients.delete(client)
            }
        }
    },

    /** Keeps idle SSE connections from being reaped by the OS or a proxy. A comment
     *  frame is valid SSE and is ignored by every client. */
    heartbeat(): void {
        for (const client of sseClients) {
            try {
                client.write(': ping\n\n')
            } catch {
                sseClients.delete(client)
            }
        }
    },

    /** Test seam — drops every subscriber. */
    reset(): void {
        windowListeners.clear()
        sseClients.clear()
    },
}
