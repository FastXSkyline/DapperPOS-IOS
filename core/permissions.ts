// User roles and their permissions
export type UserRole = 'owner' | 'manager' | 'cashier' | 'warehouse'

export interface User {
    id: number
    name: string
    role: UserRole
}

export interface Permission {
    canViewDashboard: boolean
    canManageProducts: boolean
    canManageInventory: boolean
    canManageUsers: boolean
    canProcessSales: boolean
    canIssueRefunds: boolean
    canApplyDiscounts: boolean
    canViewReports: boolean
    canExportData: boolean
    canModifySettings: boolean
}

// Role-based permissions matrix
export const PERMISSIONS: Record<UserRole, Permission> = {
    owner: {
        canViewDashboard: true,
        canManageProducts: true,
        canManageInventory: true,
        canManageUsers: true,
        canProcessSales: true,
        canIssueRefunds: true,
        canApplyDiscounts: true,
        canViewReports: true,
        canExportData: true,
        canModifySettings: true,
    },
    manager: {
        canViewDashboard: true,
        canManageProducts: true,
        canManageInventory: true,
        canManageUsers: false,
        canProcessSales: true,
        canIssueRefunds: true,
        canApplyDiscounts: true,
        canViewReports: true,
        canExportData: true,
        canModifySettings: false,
    },
    cashier: {
        canViewDashboard: false,
        canManageProducts: false,
        canManageInventory: false,
        canManageUsers: false,
        canProcessSales: true,
        canIssueRefunds: false,
        canApplyDiscounts: false,
        canViewReports: false,
        canExportData: false,
        canModifySettings: false,
    },
    warehouse: {
        canViewDashboard: false,
        canManageProducts: false,
        canManageInventory: true,
        canManageUsers: false,
        canProcessSales: false,
        canIssueRefunds: false,
        canApplyDiscounts: false,
        canViewReports: false,
        canExportData: false,
        canModifySettings: false,
    },
}

// Helper to check if user has permission
export function hasPermission(user: User, permission: keyof Permission): boolean {
    return PERMISSIONS[user.role][permission]
}

// Higher-order component pattern for permission checks
export function requirePermission(user: User | null, permission: keyof Permission): boolean {
    if (!user) return false
    return hasPermission(user, permission)
}
