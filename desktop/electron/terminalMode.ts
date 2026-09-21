import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// Is this PC the store's server, or a terminal talking to it?
//
// Stored in `config`, alongside the pairing token and the device identity, so it
// survives upgrades and is readable before any window exists.
//
// DEFAULT IS SERVER. A single-PC shop — which is every shop until someone
// deliberately adds a second till — must work with no configuration at all, and
// a box that wrongly believed it was a client would refuse to sell rather than
// quietly using its own database.
// ---------------------------------------------------------------------------

export type TerminalMode = 'server' | 'client'

export interface ClientConnection {
    mode: TerminalMode
    /** e.g. http://192.168.1.20:4000 — only meaningful in client mode. */
    serverUrl: string
    /** The store server's pairing token. Must match its `sync_token`. */
    token: string
}

function read(key: string): string {
    const row = getDatabase().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? ''
}

function write(key: string, value: string): void {
    getDatabase().prepare(`
        INSERT INTO config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value)
}

export const TerminalMode = {
    get(): ClientConnection {
        const mode = read('terminal_mode') === 'client' ? 'client' : 'server'
        return {
            mode,
            serverUrl: read('server_url').replace(/\/+$/, ''),
            token: read('server_token'),
        }
    },

    /**
     * A terminal is only a client if it has somewhere to talk to. A half-configured
     * client — mode set, URL blank — would forward every call into nothing, so it is
     * treated as a server until it is actually pointed at one.
     */
    isClient(): boolean {
        const c = this.get()
        return c.mode === 'client' && !!c.serverUrl && !!c.token
    },

    set(config: Partial<ClientConnection>): void {
        const db = getDatabase()
        db.transaction(() => {
            if (config.mode) write('terminal_mode', config.mode)
            if (config.serverUrl !== undefined) write('server_url', config.serverUrl.replace(/\/+$/, ''))
            if (config.token !== undefined) write('server_token', config.token)
        })()
    },
}
