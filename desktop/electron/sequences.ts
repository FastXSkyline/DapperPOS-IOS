import { getDatabase } from './database'

/**
 * Allocate the next GAPLESS sequential number for a document type, scoped to the year.
 * Atomic (wrapped in a DB transaction) so concurrent calls never collide or skip.
 * Format: PREFIX-YYYY-000001. Algerian fiscal documents (facture, avoir) require a
 * continuous, non-resettable series — see docs/ALGERIA_REQUIREMENTS.md.
 */
export function nextDocNumber(docType: string, prefix: string, year = new Date().getFullYear()): string {
    const db = getDatabase()
    const n = db.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO doc_sequences (doc_type, year, last_number) VALUES (?, ?, 0)').run(docType, year)
        db.prepare('UPDATE doc_sequences SET last_number = last_number + 1 WHERE doc_type = ? AND year = ?').run(docType, year)
        const row = db.prepare('SELECT last_number FROM doc_sequences WHERE doc_type = ? AND year = ?').get(docType, year) as { last_number: number }
        return row.last_number
    })()
    return `${prefix}-${year}-${String(n).padStart(6, '0')}`
}
