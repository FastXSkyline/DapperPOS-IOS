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

// Sync Queue Service for Mobile
export const SyncQueueService = {
    // Add operation to sync queue
    async add(operation: 'insert' | 'update' | 'delete', tableName: string, recordId: number, payload: object) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        return db.runAsync(
            'INSERT INTO sync_queue (operation, table_name, record_id, payload) VALUES (?, ?, ?, ?)',
            [operation, tableName, recordId, JSON.stringify(payload)]
        )
    },

    // Get all pending (unsynced) items
    async getPending(): Promise<SyncQueueItem[]> {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        return db.getAllAsync(
            'SELECT * FROM sync_queue WHERE synced = 0 ORDER BY created_at ASC'
        ) as Promise<SyncQueueItem[]>
    },

    // Mark items as synced
    async markSynced(ids: number[]) {
        if (ids.length === 0) return
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        const placeholders = ids.map(() => '?').join(',')
        return db.runAsync(
            `UPDATE sync_queue SET synced = 1, synced_at = datetime('now') WHERE id IN (${placeholders})`,
            ids
        )
    },

    // Remove synced items older than X days
    async cleanup(daysOld: number = 7) {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        return db.runAsync(
            `DELETE FROM sync_queue WHERE synced = 1 AND synced_at < datetime('now', '-${daysOld} days')`,
            []
        )
    },

    // Get count of pending items
    async getPendingCount(): Promise<number> {
        const db = getDatabase()
        if (!db) throw new Error('Database not initialized')

        const result = await db.getFirstAsync('SELECT COUNT(*) as count FROM sync_queue WHERE synced = 0') as { count: number } | null
        return result?.count ?? 0
    },
}

// Background sync processor
export async function processSyncQueue(
    syncFunction: (items: SyncQueueItem[]) => Promise<number[]>
): Promise<{ synced: number; failed: number }> {
    const pending = await SyncQueueService.getPending()

    if (pending.length === 0) {
        return { synced: 0, failed: 0 }
    }

    try {
        // Call the provided sync function which should return IDs of successfully synced items
        const syncedIds = await syncFunction(pending)

        if (syncedIds.length > 0) {
            await SyncQueueService.markSynced(syncedIds)
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
