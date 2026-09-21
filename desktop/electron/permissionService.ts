import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// Granular, database-backed permissions.
//
// WHY THIS REPLACES core/permissions.ts: that file is a TypeScript object of ten
// booleans consulted by the renderer. Two problems, one of them serious.
//
//   1. The owner cannot change what a cashier may do without a rebuild.
//   2. It runs in the renderer, where it hides buttons. Hiding a button is not a
//      permission — anything that reaches an IPC handler bypasses it entirely. The
//      brief says this twice (§65, §78): never trust frontend permissions.
//
// So the catalogue lives in the database (Migration 35) and the check runs in the
// main process, where the mutation actually happens. The renderer still calls
// `can()` to hide buttons, but that is now a courtesy, not the boundary.
// ---------------------------------------------------------------------------

export interface RoleLimits {
    role: string
    max_discount_percent: number
    max_refund_amount: number | null
    can_override_stock: number
}

export class PermissionDeniedError extends Error {
    readonly code = 'PERMISSION_DENIED'
    readonly permission: string
    readonly role: string

    constructor(permission: string, role: string) {
        super(`Action non autorisée pour le rôle « ${role} » (${permission})`)
        this.name = 'PermissionDeniedError'
        this.permission = permission
        this.role = role
    }
}

function roleOf(userId: number): string | null {
    const row = getDatabase()
        .prepare('SELECT role, is_active FROM users WHERE id = ?')
        .get(userId) as { role: string; is_active: number } | undefined
    if (!row) return null
    // An account deactivated while its session is still open must lose access at the
    // next mutation, not at the next login (brief §92). Checking here rather than at
    // login is what makes that true.
    if (row.is_active === 0) return null
    return row.role
}

export const PermissionService = {
    /** Every permission code, grouped for the settings screen. */
    catalogue() {
        return getDatabase().prepare(
            'SELECT * FROM permissions ORDER BY category, code'
        ).all() as { code: string; category: string; label_fr: string; label_ar: string; is_sensitive: number }[]
    },

    /** Codes granted to a role. */
    forRole(role: string): string[] {
        return (getDatabase()
            .prepare('SELECT permission_code FROM role_permissions WHERE role = ?')
            .all(role) as any[]).map(r => r.permission_code)
    },

    /** Codes granted to a user, via their role. */
    forUser(userId: number): string[] {
        const role = roleOf(userId)
        return role ? this.forRole(role) : []
    },

    can(userId: number, permission: string): boolean {
        const role = roleOf(userId)
        if (!role) return false
        return getDatabase()
            .prepare('SELECT 1 AS ok FROM role_permissions WHERE role = ? AND permission_code = ?')
            .get(role, permission) !== undefined
    },

    /** Throwing form. Every mutating IPC handler should open with this. */
    assertCan(userId: number, permission: string): void {
        const role = roleOf(userId)
        if (!role) throw new PermissionDeniedError(permission, 'inconnu/inactif')
        if (!this.can(userId, permission)) throw new PermissionDeniedError(permission, role)
    },

    limits(role: string): RoleLimits {
        const row = getDatabase().prepare('SELECT * FROM role_limits WHERE role = ?').get(role) as RoleLimits | undefined
        // Unknown role = no privileges. Defaulting open here would make a typo in a
        // role name silently grant unlimited discounts.
        return row ?? { role, max_discount_percent: 0, max_refund_amount: 0, can_override_stock: 0 }
    },

    limitsForUser(userId: number): RoleLimits {
        const role = roleOf(userId)
        return this.limits(role ?? '__none__')
    },

    /**
     * Largest discount this user may grant, as a percentage (brief §31).
     * Returned rather than merely enforced, so the till can show the cashier their
     * ceiling before they type a number that is going to be refused.
     */
    maxDiscountPercent(userId: number): number {
        return this.limitsForUser(userId).max_discount_percent
    },

    /**
     * Enforce the discount ceiling. Fixed-amount discounts are converted to a
     * percentage of the subtotal first — otherwise "5 % max" is trivially defeated
     * by typing a large fixed amount instead, which is the whole point of the cap.
     */
    assertDiscountAllowed(userId: number, subtotal: number,
                          discountType: 'percentage' | 'fixed', value: number): void {
        this.assertCan(userId, 'sales.discount')
        const max = this.maxDiscountPercent(userId)
        const asPercent = discountType === 'percentage'
            ? value
            : (subtotal > 0 ? (value / subtotal) * 100 : (value > 0 ? Infinity : 0))

        // Tolerance for float noise on a converted fixed amount; a genuine overage is
        // always far larger than this.
        if (asPercent > max + 1e-9) {
            throw new PermissionDeniedError(
                `remise ${asPercent.toFixed(1)} % > plafond ${max} %`,
                roleOf(userId) ?? 'inconnu',
            )
        }
    },

    canOverrideStock(userId: number): boolean {
        return this.limitsForUser(userId).can_override_stock === 1
    },

    // --- Administration -----------------------------------------------------

    grant(role: string, permission: string): void {
        getDatabase()
            .prepare('INSERT OR IGNORE INTO role_permissions (role, permission_code) VALUES (?, ?)')
            .run(role, permission)
    },

    revoke(role: string, permission: string): void {
        getDatabase()
            .prepare('DELETE FROM role_permissions WHERE role = ? AND permission_code = ?')
            .run(role, permission)
    },

    /** Replace a role's whole grant set — what the settings screen saves. */
    setRolePermissions(role: string, codes: string[]): void {
        const db = getDatabase()
        db.transaction(() => {
            db.prepare('DELETE FROM role_permissions WHERE role = ?').run(role)
            const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role, permission_code) VALUES (?, ?)')
            for (const c of codes) ins.run(role, c)
        })()
    },

    setRoleLimits(role: string, limits: Partial<Omit<RoleLimits, 'role'>>): void {
        const db = getDatabase()
        db.prepare('INSERT OR IGNORE INTO role_limits (role) VALUES (?)').run(role)
        const sets: string[] = []
        const params: any[] = []
        for (const k of ['max_discount_percent', 'max_refund_amount', 'can_override_stock'] as const) {
            if (limits[k] !== undefined) { sets.push(`${k} = ?`); params.push(limits[k]) }
        }
        if (!sets.length) return
        params.push(role)
        db.prepare(`UPDATE role_limits SET ${sets.join(', ')} WHERE role = ?`).run(...params)
    },
}
