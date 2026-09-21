// ---------------------------------------------------------------------------
// Mobile role gating (Dapper Phase 6)
//
// Mirrors core/permissions.ts, which is the source of truth for the role names
// and what each role may do. It is duplicated rather than imported because
// mobile is a separate Expo package and Metro does not resolve across the
// package boundary — if you change the roles in core/permissions.ts, change
// them here too.
//
// The shop's two real tiers map onto the existing roles; no new role was added:
//
//   owner / manager  → everything the mobile app offers
//   cashier          → THE EMPLOYEE TIER: scan and sell, nothing else
//   warehouse        → stock lookups only (cannot process sales)
//
// 'cashier' already meant exactly "canProcessSales, nothing else" in the core
// matrix, so it is reused as the employee tier verbatim.
// ---------------------------------------------------------------------------

export type Tab =
    | 'Home' | 'POS' | 'Inventory' | 'Reports' | 'Debtors'
    | 'Expenses' | 'Orders' | 'Suppliers' | 'Settlements' | 'Settings'

/**
 * Tabs each role may open, in display order.
 *
 * The employee sees only POS. The barcode scanner lives inside that screen, so
 * "scan and sell" is exactly one tab — they scan an item, pick its size/colour
 * and take payment, and never reach reports, money, suppliers or settings.
 */
const TABS_BY_ROLE: Record<string, Tab[]> = {
    owner: ['Home', 'POS', 'Inventory', 'Reports', 'Debtors', 'Expenses', 'Orders', 'Suppliers', 'Settlements', 'Settings'],
    manager: ['Home', 'POS', 'Inventory', 'Reports', 'Debtors', 'Expenses', 'Orders', 'Suppliers', 'Settlements', 'Settings'],
    cashier: ['POS'],
    warehouse: ['Inventory'],
}

/** Tabs visible to a role. Unknown roles get the most restrictive useful set. */
export function tabsForRole(role: string | undefined | null): Tab[] {
    return TABS_BY_ROLE[(role || '').toLowerCase()] ?? ['POS']
}

export function canAccess(role: string | undefined | null, tab: Tab): boolean {
    return tabsForRole(role).includes(tab)
}

/** Where a role lands after login — its first permitted tab. */
export function landingTab(role: string | undefined | null): Tab {
    return tabsForRole(role)[0] ?? 'POS'
}

/** True when the role may take money (gates the checkout button on POS). */
export function canProcessSales(role: string | undefined | null): boolean {
    const r = (role || '').toLowerCase()
    return r === 'owner' || r === 'manager' || r === 'cashier'
}
