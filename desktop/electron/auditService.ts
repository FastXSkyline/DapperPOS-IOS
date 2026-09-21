import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// The audit trail (brief §59, §60).
//
// `activity_logs` already existed and records an action string. That answers "who
// did something" but not the question an audit log exists for: *what did this value
// used to be?* Without the before-image there is no way to tell an honest price
// correction from a cashier quietly discounting a suit for a friend.
//
// APPEND-ONLY BY API: this module exposes no update and no delete. SQLite cannot
// revoke DELETE from the process that owns the file, so this is enforced discipline
// rather than a hard guarantee — worth saying plainly instead of implying the log
// is tamper-proof when it is not. The tamper-evident version needs the log shipped
// off the machine, which is what the cPanel push-up will do (RETAIL_PLAN.md §8).
//
// NEVER let logging break the operation it is logging. Every write is wrapped: an
// audit failure must not roll back a completed sale.
// ---------------------------------------------------------------------------

export type AuditSeverity = 'info' | 'warning' | 'critical'

export interface AuditEntry {
    userId?: number | null
    action: string
    entityType?: string | null
    entityId?: number | null
    oldValue?: unknown
    newValue?: unknown
    summary?: string | null
    storeId?: number | null
    terminalId?: number | null
    severity?: AuditSeverity
    deviceInfo?: string | null
    ipAddress?: string | null
}

/** JSON, but never throws and never unbounded — a cyclic object or a 10 MB blob
 *  must not be able to take down the operation being audited. */
function serialise(value: unknown): string | null {
    if (value === undefined || value === null) return null
    try {
        const json = JSON.stringify(value)
        if (json === undefined) return null
        return json.length > 8000 ? json.slice(0, 8000) + '…(tronqué)' : json
    } catch {
        return String(value).slice(0, 500)
    }
}

/** Fields that must never reach the audit log even if a caller passes a whole row. */
const REDACTED = new Set(['pin', 'password', 'cloud_password', 'api_key', 'apiKey', 'token'])

function redact(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(redact)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = REDACTED.has(k) ? '***' : redact(v)
    }
    return out
}

export const AuditService = {
    log(entry: AuditEntry): void {
        try {
            const db = getDatabase()
            const userName = entry.userId
                ? (db.prepare('SELECT name FROM users WHERE id = ?').get(entry.userId) as any)?.name ?? null
                : null

            db.prepare(`
                INSERT INTO audit_logs
                    (user_id, user_name, action, entity_type, entity_id, old_value, new_value,
                     summary, store_id, terminal_id, device_info, ip_address, severity)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                entry.userId ?? null, userName, entry.action,
                entry.entityType ?? null, entry.entityId ?? null,
                serialise(redact(entry.oldValue)), serialise(redact(entry.newValue)),
                entry.summary ?? null, entry.storeId ?? null, entry.terminalId ?? null,
                entry.deviceInfo ?? null, entry.ipAddress ?? null,
                entry.severity ?? 'info',
            )
        } catch (e) {
            // Deliberately swallowed. A sale that completed must not be rolled back
            // because its audit row failed to write.
            console.error('[audit] failed to record entry:', entry.action, e)
        }
    },

    /**
     * Log a field-level change, recording only what actually differs.
     *
     * Diffing rather than storing both whole rows is what keeps the log readable: a
     * price change should read as `retail_price: 30000 → 32000`, not as two
     * forty-column dumps the owner has to compare by eye. It also means a save that
     * changed nothing writes nothing.
     */
    logChange(entry: Omit<AuditEntry, 'oldValue' | 'newValue'> & {
        before: Record<string, unknown> | null | undefined
        after: Record<string, unknown> | null | undefined
        fields?: string[]
    }): void {
        const before = entry.before ?? {}
        const after = entry.after ?? {}
        const keys = entry.fields ?? Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))

        const oldDiff: Record<string, unknown> = {}
        const newDiff: Record<string, unknown> = {}
        for (const k of keys) {
            // Loose comparison on purpose: SQLite hands back 1/'1' and 0/null for the
            // same stored value depending on the path, and logging those as changes
            // would bury the real ones.
            if (String(before[k] ?? '') !== String(after[k] ?? '')) {
                oldDiff[k] = before[k] ?? null
                newDiff[k] = after[k] ?? null
            }
        }
        if (Object.keys(newDiff).length === 0) return

        this.log({ ...entry, oldValue: oldDiff, newValue: newDiff })
    },

    query(filters: {
        userId?: number
        storeId?: number
        action?: string
        entityType?: string
        entityId?: number
        severity?: AuditSeverity
        from?: string
        to?: string
        search?: string
        limit?: number
        offset?: number
    } = {}) {
        const where: string[] = []
        const params: any[] = []
        if (filters.userId != null) { where.push('a.user_id = ?'); params.push(filters.userId) }
        if (filters.storeId != null) { where.push('a.store_id = ?'); params.push(filters.storeId) }
        if (filters.action) { where.push('a.action = ?'); params.push(filters.action) }
        if (filters.entityType) { where.push('a.entity_type = ?'); params.push(filters.entityType) }
        if (filters.entityId != null) { where.push('a.entity_id = ?'); params.push(filters.entityId) }
        if (filters.severity) { where.push('a.severity = ?'); params.push(filters.severity) }
        if (filters.from) { where.push('a.created_at >= ?'); params.push(filters.from) }
        if (filters.to) { where.push('a.created_at <= ?'); params.push(filters.to) }
        if (filters.search) {
            where.push('(a.action LIKE ? OR a.summary LIKE ? OR a.user_name LIKE ?)')
            const q = `%${filters.search}%`
            params.push(q, q, q)
        }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

        const total = (getDatabase()
            .prepare(`SELECT COUNT(*) AS n FROM audit_logs a ${clause}`)
            .get(...params) as any).n

        params.push(filters.limit ?? 100, filters.offset ?? 0)
        const rows = getDatabase().prepare(`
            SELECT a.*, s.name AS store_name
            FROM audit_logs a
            LEFT JOIN stores s ON s.id = a.store_id
            ${clause}
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT ? OFFSET ?
        `).all(...params)

        return { rows, total }
    },

    /** Everything that ever happened to one record — the "history" tab of an entity. */
    historyOf(entityType: string, entityId: number, limit = 100) {
        return getDatabase().prepare(`
            SELECT * FROM audit_logs
            WHERE entity_type = ? AND entity_id = ?
            ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(entityType, entityId, limit)
    },

    /** Distinct action names, for the filter dropdown. */
    actions(): string[] {
        return (getDatabase()
            .prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action')
            .all() as any[]).map(r => r.action)
    },
}
