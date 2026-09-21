import { getDatabase } from './database'
import { TerminalMode } from './terminalMode'

// ---------------------------------------------------------------------------
// The Network monitor's read/write surface.
//
// Two questions this answers for the shop owner:
//
//   1. WHICH DEVICES are on the shop wifi talking to this PC's LAN server, and
//      what did each one last do? (`connected_devices`, written by the sync
//      server on every authenticated request.)
//
//   2. WHO IMPORTED / SYNCED DATA, and from where? (the append-only
//      `audit_logs`, filtered to the import/ingest/sync actions, plus the
//      transactions that arrived from a phone via the mobile ingest.)
//
// Everything here is read-only except `recordDevice`, which is a monitor write:
// it must never be able to break the request it is observing, so it swallows its
// own errors. A sale that completed must not fail because we could not note the
// phone's IP.
// ---------------------------------------------------------------------------

/** A device is "online" if it has been seen within this window. The mobile app
 *  syncs on a timer and on every sale, so five minutes of silence means the
 *  phone left the wifi or the app was closed — not a live connection. */
const ONLINE_WINDOW_SECONDS = 5 * 60

export interface ConnectedDevice {
    device_key: string
    device_id: string | null
    device_name: string | null
    device_type: string | null
    ip_address: string | null
    user_agent: string | null
    last_endpoint: string | null
    request_count: number
    first_seen_at: string | null
    last_seen_at: string | null
}

export interface DeviceView extends ConnectedDevice {
    /** Derived: last_seen_at within the online window. */
    online: boolean
    /** A short human label so the UI never shows a bare IP or a null. */
    label: string
}

export const NetworkService = {
    /**
     * Note that a device just hit the server. Called from the sync server's
     * request hook, AFTER the pairing token has been accepted, so this only ever
     * records authorised callers.
     *
     * Keyed on the device's own id when it sends one, else on IP+agent. The
     * upsert keeps one row per physical device and bumps its counters, rather
     * than appending a log line per request (that would grow without bound on a
     * busy till).
     */
    recordDevice(info: {
        deviceId?: string | null
        deviceName?: string | null
        deviceType?: string | null
        ip?: string | null
        userAgent?: string | null
        endpoint?: string | null
    }): void {
        try {
            const db = getDatabase()
            const id = (info.deviceId ?? '').trim()
            const ip = (info.ip ?? '').trim()
            const ua = (info.userAgent ?? '').trim()
            // A device that identifies itself is keyed on that id (stable across
            // wifi reconnects and IP changes). One that does not is keyed on the
            // IP+agent pair — the best guess available, and enough to show it.
            const key = id || (ip ? `${ip}|${ua}` : '')
            if (!key) return

            const name = (info.deviceName ?? '').trim() || null
            const type = (info.deviceType ?? '').trim() || null
            const endpoint = (info.endpoint ?? '').trim() || null

            db.prepare(`
                INSERT INTO connected_devices
                    (device_key, device_id, device_name, device_type, ip_address,
                     user_agent, last_endpoint, request_count, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
                ON CONFLICT(device_key) DO UPDATE SET
                    device_id     = COALESCE(excluded.device_id, device_id),
                    device_name   = COALESCE(excluded.device_name, device_name),
                    device_type   = COALESCE(excluded.device_type, device_type),
                    ip_address    = COALESCE(excluded.ip_address, ip_address),
                    user_agent    = COALESCE(excluded.user_agent, user_agent),
                    last_endpoint = COALESCE(excluded.last_endpoint, last_endpoint),
                    request_count = request_count + 1,
                    last_seen_at  = datetime('now')
            `).run(
                key,
                id || null,
                name,
                type,
                ip || null,
                ua || null,
                endpoint,
            )
        } catch (e) {
            // Never let monitoring break the operation it monitors.
            console.error('[network] recordDevice failed:', e)
        }
    },

    /** Devices seen most-recent-first, each flagged online/offline. */
    devices(): DeviceView[] {
        const rows = getDatabase().prepare(`
            SELECT * FROM connected_devices
            ORDER BY last_seen_at DESC, device_key ASC
            LIMIT 200
        `).all() as ConnectedDevice[]

        return rows.map(r => ({
            ...r,
            online: withinWindow(r.last_seen_at, ONLINE_WINDOW_SECONDS),
            label: r.device_name?.trim()
                || r.device_id?.trim()
                || r.ip_address?.trim()
                || 'Appareil inconnu',
        }))
    },

    onlineCount(): number {
        return (getDatabase().prepare(`
            SELECT COUNT(*) AS n FROM connected_devices
            WHERE last_seen_at >= datetime('now', ?)
        `).get(`-${ONLINE_WINDOW_SECONDS} seconds`) as { n: number }).n
    },

    /**
     * Drop devices not seen for a while, so the table does not accumulate every
     * phone that ever joined the wifi. Called opportunistically; harmless to skip.
     */
    prune(days = 14): void {
        try {
            getDatabase()
                .prepare("DELETE FROM connected_devices WHERE last_seen_at < datetime('now', ?)")
                .run(`-${days} days`)
        } catch { /* the table simply is not there yet */ }
    },

    /**
     * Who imported or synced data, newest first.
     *
     * Two sources, because the two paths write differently:
     *   • audit_logs — desktop imports, catalogue pushes, mobile-ingest batches,
     *     terminal registrations. Filtered to the import/ingest/sync actions so
     *     the list is about DATA MOVEMENT, not every price edit.
     *   • transactions with a non-desktop source_device — each sale a phone rang
     *     up and pushed over the LAN. Grouped, because a shift produces hundreds.
     */
    importLogs(limit = 200): ImportLogRow[] {
        const db = getDatabase()
        const rows = db.prepare(`
            SELECT a.id, a.created_at, a.user_name, a.action, a.summary,
                   a.device_info, a.ip_address, a.entity_type, a.entity_id,
                   a.severity, s.name AS store_name
            FROM audit_logs a
            LEFT JOIN stores s ON s.id = a.store_id
            WHERE a.action LIKE '%import%'
               OR a.action LIKE '%ingest%'
               OR a.action LIKE '%sync%'
               OR a.action LIKE '%push%'
               OR a.action LIKE 'terminal.%'
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT ?
        `).all(limit) as ImportLogRow[]

        return rows.map(r => ({ ...r, kind: classify(r.action) }))
    },

    /** Sales that arrived FROM a device rather than this desktop's own till. */
    deviceIngest(limit = 100): DeviceIngestRow[] {
        return getDatabase().prepare(`
            SELECT source_device,
                   COUNT(*) AS sales,
                   MIN(created_at) AS first_at,
                   MAX(created_at) AS last_at,
                   SUM(total_amount) AS revenue
            FROM transactions
            WHERE source_device IS NOT NULL AND source_device != 'desktop' AND source_device != ''
            GROUP BY source_device
            ORDER BY last_at DESC
            LIMIT ?
        `).all(limit) as DeviceIngestRow[]
    },

    /** Facts about this machine's own server, for the panel header. */
    localStatus(): {
        mode: 'server' | 'client'
        isClient: boolean
        devicesOnline: number
        devicesTotal: number
    } {
        const db = getDatabase()
        const total = (db.prepare('SELECT COUNT(*) AS n FROM connected_devices').get() as { n: number }).n
        return {
            mode: TerminalMode.get().mode,
            isClient: TerminalMode.isClient(),
            devicesOnline: this.onlineCount(),
            devicesTotal: total,
        }
    },
}

export interface ImportLogRow {
    id: number
    created_at: string
    user_name: string | null
    action: string
    summary: string | null
    device_info: string | null
    ip_address: string | null
    entity_type: string | null
    entity_id: number | null
    severity: string
    store_name: string | null
    kind: 'import' | 'sync' | 'device' | 'other'
}

export interface DeviceIngestRow {
    source_device: string
    sales: number
    first_at: string
    last_at: string
    revenue: number | null
}

function classify(action: string): ImportLogRow['kind'] {
    if (action.includes('import')) return 'import'
    if (action.includes('ingest') || action.includes('sync') || action.includes('push')) return 'sync'
    if (action.startsWith('terminal.')) return 'device'
    return 'other'
}

/** True when `sqliteNow` (a `datetime('now')` string) is within `seconds`.
 *  Compared in SQL-adjacent JS on the ISO-ish `YYYY-MM-DD HH:MM:SS` format the
 *  database writes; parsing it as UTC keeps it independent of the PC's timezone. */
function withinWindow(sqliteNow: string | null, seconds: number): boolean {
    if (!sqliteNow) return false
    const t = Date.parse(sqliteNow.replace(' ', 'T') + 'Z')
    if (Number.isNaN(t)) return false
    return Date.now() - t <= seconds * 1000
}
