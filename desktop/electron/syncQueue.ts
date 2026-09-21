import { getDatabase } from './database'

export interface SyncQueueItem {
    id: number
    operation: 'insert' | 'update' | 'delete'
    table_name: string
    record_id: number
    payload: string
    synced: number
    created_at: string
    synced_at: string | null
}

// Sync Queue Service for Desktop
export const SyncQueueService = {
    // Add operation to sync queue
    add(operation: 'insert' | 'update' | 'delete', tableName: string, recordId: number, payload: object) {
        const db = getDatabase()
        const stmt = db.prepare(
            'INSERT INTO sync_queue (operation, table_name, record_id, payload) VALUES (?, ?, ?, ?)'
        )
        return stmt.run(operation, tableName, recordId, JSON.stringify(payload))
    },

    // Get all pending (unsynced) items
    getPending(): SyncQueueItem[] {
        const db = getDatabase()
        const stmt = db.prepare('SELECT * FROM sync_queue WHERE synced = 0 ORDER BY created_at ASC')
        return stmt.all() as SyncQueueItem[]
    },

    // Mark items as synced
    markSynced(ids: number[]) {
        if (ids.length === 0) return
        const db = getDatabase()
        const placeholders = ids.map(() => '?').join(',')
        const stmt = db.prepare(
            `UPDATE sync_queue SET synced = 1, synced_at = datetime('now') WHERE id IN (${placeholders})`
        )
        return stmt.run(...ids)
    },

    // Remove synced items older than X days
    cleanup(daysOld: number = 7) {
        const db = getDatabase()
        const stmt = db.prepare(
            `DELETE FROM sync_queue WHERE synced = 1 AND synced_at < datetime('now', '-${daysOld} days')`
        )
        return stmt.run()
    },

    // Get count of pending items
    getPendingCount(): number {
        const db = getDatabase()
        const stmt = db.prepare('SELECT COUNT(*) as count FROM sync_queue WHERE synced = 0')
        const result = stmt.get() as { count: number }
        return result.count
    },
}

// Background sync processor
export async function processSyncQueue(
    syncFunction: (items: SyncQueueItem[]) => Promise<number[]>
): Promise<{ synced: number; failed: number }> {
    const pending = SyncQueueService.getPending()

    if (pending.length === 0) {
        return { synced: 0, failed: 0 }
    }

    try {
        // Call the provided sync function which should return IDs of successfully synced items
        const syncedIds = await syncFunction(pending)

        if (syncedIds.length > 0) {
            SyncQueueService.markSynced(syncedIds)
        }

        return {
            synced: syncedIds.length,
            failed: pending.length - syncedIds.length,
        }
    } catch (error) {
        console.error('Sync failed:', error)
        return { synced: 0, failed: pending.length }
    }
}
