import bcrypt from 'bcryptjs'
import type Database from 'better-sqlite3'

const ROUNDS = 10

/** A stored PIN is "hashed" if it looks like a bcrypt hash ($2a/$2b/$2y$...). */
export function isHashed(stored: string): boolean {
    return typeof stored === 'string' && /^\$2[aby]\$/.test(stored)
}

export function hashPin(pin: string): string {
    return bcrypt.hashSync(pin, ROUNDS)
}

/** Verify a raw PIN against a stored value. Falls back to plaintext compare only for
 *  not-yet-migrated rows (defensive — migratePlaintextPins should have hashed them). */
export function verifyPin(pin: string, stored: string): boolean {
    if (!stored) return false
    return isHashed(stored) ? bcrypt.compareSync(pin, stored) : pin === stored
}

interface UserRow { id: number; name: string; role: string; pin: string }

/** Returns the matching active user (without the PIN) or null. */
export function findActiveUserByPin(
    db: Database.Database,
    pin: string,
): { id: number; name: string; role: string } | null {
    const users = db.prepare('SELECT id, name, role, pin FROM users WHERE is_active = 1').all() as UserRow[]
    for (const u of users) {
        if (verifyPin(pin, u.pin)) return { id: u.id, name: u.name, role: u.role }
    }
    return null
}

export function verifyOwnerPin(db: Database.Database, pin: string): boolean {
    const owners = db.prepare("SELECT pin FROM users WHERE role = 'owner'").all() as { pin: string }[]
    return owners.some(o => verifyPin(pin, o.pin))
}

export function setOwnerPin(db: Database.Database, newPin: string): void {
    db.prepare("UPDATE users SET pin = ? WHERE role = 'owner'").run(hashPin(newPin))
}

/** True while the owner still uses the well-known default PIN (1234) — used to force a
 *  change on first run. Stateless: once the PIN is changed this returns false. */
export function ownerPinIsDefault(db: Database.Database): boolean {
    return verifyOwnerPin(db, '1234')
}

/** One-time (idempotent) migration: hash any plaintext PIN at rest. Safe to run every boot. */
export function migratePlaintextPins(db: Database.Database): void {
    try {
        const users = db.prepare('SELECT id, pin FROM users').all() as { id: number; pin: string }[]
        const update = db.prepare('UPDATE users SET pin = ? WHERE id = ?')
        const tx = db.transaction((rows: { id: number; pin: string }[]) => {
            for (const u of rows) {
                if (u.pin && !isHashed(u.pin)) update.run(hashPin(u.pin), u.id)
            }
        })
        tx(users)
    } catch (e) {
        console.error('[Auth] PIN hash migration failed:', e)
    }
}
