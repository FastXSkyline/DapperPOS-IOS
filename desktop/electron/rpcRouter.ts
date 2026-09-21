// ---------------------------------------------------------------------------
// Thin-client routing rules (docs/RETAIL_PLAN.md §2).
//
// THE PRINCIPLE: in thin-client mode, DATA lives on the store server; DEVICES
// live on the client.
//
//   • A channel that reads or writes the shop's data is FORWARDED to the server.
//   • A channel that touches this machine's hardware, files, windows or install
//     runs LOCALLY.
//   • A channel that does both — print a document read from the database — is
//     forwarded, because the data is the hard part and the shop's printer is
//     already wired to the server PC (the phone has printed through `/print/*`
//     since long before this).
//
// THE DEFAULT MATTERS, AND THE TWO SIDES DEFAULT DIFFERENTLY.
//
//   On the CLIENT, an unlisted channel is FORWARDED. A newly added data channel
//   that nobody classified then behaves correctly. Defaulting the other way would
//   read the client's own near-empty database and show plausible nonsense, which is
//   the worst possible failure. A device channel someone forgot to list instead
//   returns the SERVER's answer — visibly wrong (the wrong machine's printers)
//   rather than quietly wrong, and that is the cheaper mistake of the two.
//
//   On the SERVER, an unlisted channel is REFUSED. `/rpc` executes whatever it is
//   handed, so it is a remote-execution surface and must be deny-by-default. The
//   allowlist is derived from the channels actually registered minus the two sets
//   below, so the two sides cannot drift apart by hand-editing one of them.
// ---------------------------------------------------------------------------

/**
 * Runs on THIS machine even in client mode: hardware, files, windows, identity.
 * Matched exactly or by prefix (`foo-*`).
 */
const LOCAL_ONLY: readonly string[] = [
    // This install, this machine
    'app-version',
    'app-check-updates',
    'terminal-device-id',
    'terminal-current-id',
    // Handled explicitly in main.ts: the row belongs on the server but the
    // resulting identity must be written into THIS box's config, so the generic
    // layer must leave it alone and let that handler do both halves.
    'terminal-register',
    'get-local-ip',
    'get-sync-token',
    // Which store THIS terminal sells for — read from its own config, so a client
    // keeps its identity even while its data comes from the server.
    'store-current',
    'store-current-id',
    'store-set-current',
    // Opens a window on this screen; takes its data as an argument, so it is
    // self-contained and correct locally.
    'receipt-preview',
    // Each machine may have its own printer attached.
    'get-printers',
    'settings-get-printer-config',
    'settings-save-printer-config',
    // Local file dialogs and disk access.
    'maintenance-export-all',
    'maintenance-export-products',
    'maintenance-import-products',
    // Provider credentials live on the machine that holds them.
    'cloud-get-config',
    'cloud-set-config',
    // The realtime bridge is wired locally; a client re-emits the server's stream.
    'rpc-status',
    // The Network monitor. The plain `network-devices` / `network-import-logs` /
    // `network-local-status` answer from THIS box, and the `network-remote-*`
    // channels do their own explicit forward to the store server — so the generic
    // layer must leave all of them alone rather than forwarding the wrapper itself.
    'network-*',
]

/**
 * NEVER executable over `/rpc`, whatever the token says.
 *
 * These either destroy data or hand out secrets, and a shared LAN secret is not a
 * strong enough boundary for either. A terminal that needs to do one of these does
 * it at the server PC, in person.
 */
const NEVER_REMOTE: readonly string[] = [
    'maintenance-reset-db',
    'maintenance-export-all',
    'maintenance-export-products',
    'maintenance-import-products',
    'db-seed',
    'cloud-get-config',
    'cloud-set-config',
    'get-sync-token',
    'auth-set-owner-pin',
]

function matches(channel: string, list: readonly string[]): boolean {
    for (const entry of list) {
        if (entry.endsWith('*')) {
            if (channel.startsWith(entry.slice(0, -1))) return true
        } else if (channel === entry) {
            return true
        }
    }
    return false
}

/** Does this channel run on the client's own machine rather than being forwarded? */
export function isLocalChannel(channel: string): boolean {
    return matches(channel, LOCAL_ONLY)
}

/** May the server execute this channel on behalf of a remote terminal? */
export function isRemotableChannel(channel: string, registered: ReadonlySet<string>): boolean {
    if (!registered.has(channel)) return false      // unknown channel: refuse
    if (matches(channel, NEVER_REMOTE)) return false
    return true
}

/** Introspection for tests and diagnostics. */
export const RoutingRules = { LOCAL_ONLY, NEVER_REMOTE }
