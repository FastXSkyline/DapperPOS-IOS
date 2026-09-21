import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventBus, type RetailEvent, type SseSink } from '../electron/eventBus'

/** An SSE sink that records what it was sent. */
function makeSink(id: string) {
    const frames: string[] = []
    return { sink: { id, write: (c: string) => { frames.push(c) } } as SseSink, frames }
}

/** A sink whose socket has gone away. */
function makeDeadSink(id: string): SseSink {
    return { id, write: () => { throw new Error('EPIPE: socket closed') } }
}

/** Parse the JSON out of an SSE data frame. */
const parse = (frame: string): RetailEvent =>
    JSON.parse(frame.split('data: ')[1].split('\n\n')[0])

beforeEach(() => EventBus.reset())

describe('in-process listeners', () => {
    it('delivers to every listener with type, store and a timestamp', () => {
        const seen: RetailEvent[] = []
        EventBus.onEvent(e => seen.push(e))
        EventBus.onEvent(e => seen.push(e))

        EventBus.publish('sale.created', 1, { transactionId: 7 })

        expect(seen).toHaveLength(2)
        expect(seen[0]).toMatchObject({ type: 'sale.created', storeId: 1, payload: { transactionId: 7 } })
        expect(Date.parse(seen[0].at)).not.toBeNaN()
    })

    it('stops delivering after unsubscribe', () => {
        const seen: RetailEvent[] = []
        const off = EventBus.onEvent(e => seen.push(e))
        EventBus.publish('sale.created', 1)
        off()
        EventBus.publish('sale.created', 1)
        expect(seen).toHaveLength(1)
    })

    it('keeps delivering to the others when one listener throws', () => {
        // A broken window listener must not silence the rest, and must not
        // propagate into the sale that just committed.
        const seen: RetailEvent[] = []
        EventBus.onEvent(() => { throw new Error('window destroyed') })
        EventBus.onEvent(e => seen.push(e))

        expect(() => EventBus.publish('inventory.updated', 1)).not.toThrow()
        expect(seen).toHaveLength(1)
    })

    it('carries a null store for events that concern every shop', () => {
        const seen: RetailEvent[] = []
        EventBus.onEvent(e => seen.push(e))
        EventBus.publish('notification.created', null)
        expect(seen[0].storeId).toBeNull()
    })
})

describe('SSE subscribers', () => {
    it('writes a well-formed SSE frame to each client', () => {
        const a = makeSink('a')
        const b = makeSink('b')
        EventBus.addSseClient(a.sink)
        EventBus.addSseClient(b.sink)

        EventBus.publish('transfer.shipped', 2, { transferId: 3 })

        for (const c of [a, b]) {
            expect(c.frames).toHaveLength(1)
            expect(c.frames[0].startsWith('event: retail\ndata: ')).toBe(true)
            expect(c.frames[0].endsWith('\n\n')).toBe(true)
            expect(parse(c.frames[0])).toMatchObject({ type: 'transfer.shipped', storeId: 2 })
        }
    })

    it('drops a client whose socket has died, without failing the publish', () => {
        // A laptop that walked out of wifi range must not be able to break the
        // operation that just succeeded.
        const live = makeSink('live')
        EventBus.addSseClient(makeDeadSink('dead'))
        EventBus.addSseClient(live.sink)

        expect(() => EventBus.publish('sale.created', 1)).not.toThrow()
        expect(live.frames).toHaveLength(1)
        expect(EventBus.sseClientCount()).toBe(1)
    })

    it('stops writing after a client is removed', () => {
        const c = makeSink('a')
        EventBus.addSseClient(c.sink)
        EventBus.publish('sale.created', 1)
        EventBus.removeSseClient(c.sink)
        EventBus.publish('sale.created', 1)
        expect(c.frames).toHaveLength(1)
    })

    it('sends a comment frame as a heartbeat and prunes dead sockets', () => {
        const live = makeSink('live')
        EventBus.addSseClient(live.sink)
        EventBus.addSseClient(makeDeadSink('dead'))

        EventBus.heartbeat()

        expect(live.frames).toEqual([': ping\n\n'])
        expect(EventBus.sseClientCount()).toBe(1)
    })

    it('does nothing when nobody is listening', () => {
        expect(() => EventBus.publish('sale.created', 1)).not.toThrow()
        expect(EventBus.sseClientCount()).toBe(0)
    })
})

describe('payload discipline', () => {
    it('never throws on a payload that cannot be serialised', () => {
        // publish() is called after a sale has already committed, so it must not be
        // able to turn a successful sale into an error.
        const cyclic: Record<string, unknown> = {}
        cyclic.self = cyclic
        const c = makeSink('a')
        EventBus.addSseClient(c.sink)

        expect(() => EventBus.publish('sale.created', 1, cyclic)).not.toThrow()
        // The wire frame is skipped rather than sent malformed.
        expect(c.frames).toHaveLength(0)
    })

    it('still tells local windows when the wire format fails', () => {
        // Ordering matters: the till's own screens must update even if the LAN
        // broadcast cannot be encoded.
        const seen: RetailEvent[] = []
        EventBus.onEvent(e => seen.push(e))
        const cyclic: Record<string, unknown> = {}
        cyclic.self = cyclic
        EventBus.addSseClient(makeSink('a').sink)

        EventBus.publish('sale.created', 1, cyclic)
        expect(seen).toHaveLength(1)
    })
})
