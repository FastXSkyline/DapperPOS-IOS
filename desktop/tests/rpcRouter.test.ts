import { describe, it, expect } from 'vitest'
import { isLocalChannel, isRemotableChannel, RoutingRules } from '../electron/rpcRouter'

/** Stand-in for the channels main.ts actually registers. */
const registered = new Set([
    'transaction-complete', 'product-get-all', 'inventory-stock', 'return-create-refund',
    'transfer-ship', 'count-apply', 'analytics-summary', 'permission-can',
    'receipt-print', 'invoice-pdf', 'get-printers', 'receipt-preview',
    'app-version', 'terminal-device-id', 'terminal-register', 'terminal-create-remote',
    'store-current-id', 'store-set-current', 'store-list',
    'maintenance-reset-db', 'maintenance-export-all', 'db-seed',
    'cloud-set-config', 'cloud-get-config', 'get-sync-token', 'auth-set-owner-pin',
])

describe('client routing — data goes to the server', () => {
    it('forwards every channel that reads or writes shop data', () => {
        for (const channel of [
            'transaction-complete', 'product-get-all', 'inventory-stock',
            'return-create-refund', 'transfer-ship', 'count-apply',
            'analytics-summary', 'permission-can', 'store-list',
        ]) {
            expect(isLocalChannel(channel), `${channel} must be forwarded`).toBe(false)
        }
    })

    it('forwards an unknown channel rather than answering it locally', () => {
        // The client default. A new data channel nobody classified must reach the
        // server; answering it from the client's near-empty database would show
        // plausible nonsense, which is the worst failure available.
        expect(isLocalChannel('some-feature-added-next-year')).toBe(false)
    })

    it('forwards printing, because the shop printer is on the server PC', () => {
        expect(isLocalChannel('receipt-print')).toBe(false)
        expect(isLocalChannel('invoice-pdf')).toBe(false)
    })
})

describe('client routing — devices stay on this machine', () => {
    it('keeps this install’s own identity local', () => {
        for (const channel of ['app-version', 'app-check-updates', 'terminal-device-id']) {
            expect(isLocalChannel(channel), `${channel} must stay local`).toBe(true)
        }
    })

    it('keeps which-store-am-I local, so a client knows itself', () => {
        // Read from this box's own config: a client must keep its identity even
        // though all its data comes from the server.
        expect(isLocalChannel('store-current-id')).toBe(true)
        expect(isLocalChannel('store-set-current')).toBe(true)
        // ...but the LIST of stores is shop data.
        expect(isLocalChannel('store-list')).toBe(false)
    })

    it('keeps terminal registration local so it can do both halves itself', () => {
        // The generic layer must not forward it: the row belongs on the server, the
        // resulting identity belongs in this box's config, and only the explicit
        // handler in main.ts does both.
        expect(isLocalChannel('terminal-register')).toBe(true)
    })

    it('keeps this machine’s printer configuration local', () => {
        expect(isLocalChannel('get-printers')).toBe(true)
        expect(isLocalChannel('settings-save-printer-config')).toBe(true)
    })

    it('keeps a preview window on the screen the cashier is looking at', () => {
        expect(isLocalChannel('receipt-preview')).toBe(true)
    })
})

describe('server allowlist — deny by default', () => {
    it('executes ordinary data channels for a paired terminal', () => {
        for (const channel of ['transaction-complete', 'product-get-all', 'transfer-ship']) {
            expect(isRemotableChannel(channel, registered), channel).toBe(true)
        }
    })

    it('refuses a channel that is not registered at all', () => {
        // A typo or a probe gets a flat refusal, never a stack trace.
        expect(isRemotableChannel('rm -rf', registered)).toBe(false)
        expect(isRemotableChannel('transaction-complete-x', registered)).toBe(false)
        expect(isRemotableChannel('', registered)).toBe(false)
    })

    it('refuses everything destructive, even with a valid token', () => {
        // A shared LAN secret is not a strong enough boundary to destroy data
        // behind. These are done at the server PC, in person.
        for (const channel of ['maintenance-reset-db', 'maintenance-import-products', 'db-seed']) {
            expect(isRemotableChannel(channel, registered), channel).toBe(false)
        }
    })

    it('refuses everything that hands out a secret', () => {
        for (const channel of ['cloud-get-config', 'cloud-set-config', 'get-sync-token', 'auth-set-owner-pin']) {
            expect(isRemotableChannel(channel, registered), channel).toBe(false)
        }
    })

    it('allows the server half of terminal registration', () => {
        expect(isRemotableChannel('terminal-create-remote', registered)).toBe(true)
    })

    it('refuses a never-remote channel even if it is somehow registered twice', () => {
        expect(isRemotableChannel('maintenance-export-all', new Set(['maintenance-export-all']))).toBe(false)
    })
})

describe('the two lists agree', () => {
    it('never lets a destructive channel be reachable from a client at all', () => {
        // Belt and braces: anything on the never-remote list must also not be
        // silently forwarded, or a client would call it and get a 403 it cannot
        // explain to the user.
        for (const channel of RoutingRules.NEVER_REMOTE) {
            const local = isLocalChannel(channel)
            const remotable = isRemotableChannel(channel, registered)
            expect(remotable, `${channel} must never be remotable`).toBe(false)
            // Either it runs locally, or it is a server-PC-only action. `db-seed`
            // and `maintenance-reset-db` are the latter: forwarded, then refused.
            if (!local) {
                expect(['db-seed', 'maintenance-reset-db', 'auth-set-owner-pin']).toContain(channel)
            }
        }
    })

    it('matches a prefix entry only on its prefix', () => {
        // The matcher supports `foo-*`; nothing currently uses it, so this pins the
        // behaviour before something does.
        expect(isLocalChannel('app-version')).toBe(true)
        expect(isLocalChannel('app-versionx')).toBe(false)
    })
})
