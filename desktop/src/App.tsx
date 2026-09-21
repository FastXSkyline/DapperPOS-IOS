import { useState, useEffect, useMemo, type ReactNode } from 'react'
import {
  LayoutDashboard,
  Receipt,
  ShoppingCart,
  Package,
  Boxes,
  ArrowRightLeft,
  Users,
  Truck,
  ClipboardList,
  Banknote,
  Wallet,
  FileBarChart,
  LineChart as LineChartIcon,
  UserCog,
  Settings,
  Server,
  ChevronDown,
  Search,
} from 'lucide-react'

import { useLanguage } from './LanguageContext'
import { useTheme } from './ThemeContext'
import type { Product } from '../shared/types'

import { BrandLogo, BrandMark } from './components/BrandLogo'
import { UserSwitcher, roleKey, isElevated, type SwitchUser } from './components/UserSwitcher'
import { NotificationCenter } from './components/NotificationCenter'
import { OnboardingWizard } from './components/OnboardingWizard'
import { AIAssistant } from './components/AIAssistant'

import { Dashboard } from './components/Dashboard'
import { SalesScreen } from './components/SalesScreen'
import { POSScreen } from './components/POSScreen'
import { ProductList } from './components/ProductList'
import { ProductForm } from './components/ProductForm'
import { InventoryScreen } from './components/InventoryScreen'
import { TransfersScreen } from './components/TransfersScreen'
import { CustomersScreen } from './components/CustomersScreen'
import { SupplierManager } from './components/SupplierManager'
import { OrdersManager } from './components/OrdersManager'
import { CashSessionScreen } from './components/CashSessionScreen'
import { ExpenseManager } from './components/ExpenseManager'
import { ReportsScreen } from './components/ReportsScreen'
import { AnalyticsDashboard } from './components/AnalyticsDashboard'
import { EmployeesScreen } from './components/EmployeesScreen'
import { SettingsScreen } from './components/SettingsScreen'
import { NetworkMonitorScreen } from './components/NetworkMonitorScreen'

import './App.css'

/* ---------------------------------------------------------------------------
   Navigation.

   ONE table. It used to take three hand-maintained lists to add a screen — the
   `View` union, the AI's navigation whitelist, and the RBAC matrix — and
   missing any one of them made the screen unreachable in a way nothing caught.
   Everything below is derived from this array, so a new row is a new screen,
   full stop.

   The order and the labels are the sidebar from the approved mockup.
   --------------------------------------------------------------------------- */

const NAV = [
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard, roles: ['owner', 'manager'] },
  { id: 'sales', labelKey: 'nav.sales', icon: Receipt, roles: ['owner', 'manager', 'cashier'] },
  { id: 'pos', labelKey: 'nav.pos', icon: ShoppingCart, roles: ['owner', 'manager', 'cashier'] },
  { id: 'products', labelKey: 'nav.products', icon: Package, roles: ['owner', 'manager', 'warehouse'] },
  { id: 'inventory', labelKey: 'nav.inventory', icon: Boxes, roles: ['owner', 'manager', 'warehouse'] },
  { id: 'transfers', labelKey: 'nav.transfers', icon: ArrowRightLeft, roles: ['owner', 'manager', 'warehouse'] },
  { id: 'customers', labelKey: 'nav.customers', icon: Users, roles: ['owner', 'manager'] },
  { id: 'suppliers', labelKey: 'nav.suppliers', icon: Truck, roles: ['owner', 'manager', 'warehouse'] },
  { id: 'purchases', labelKey: 'nav.purchases', icon: ClipboardList, roles: ['owner', 'manager', 'warehouse'] },
  { id: 'cash', labelKey: 'nav.cash', icon: Banknote, roles: ['owner', 'manager', 'cashier'] },
  { id: 'expenses', labelKey: 'nav.expenses', icon: Wallet, roles: ['owner', 'manager'] },
  { id: 'reports', labelKey: 'nav.reports', icon: FileBarChart, roles: ['owner', 'manager'] },
  { id: 'insights', labelKey: 'nav.insights', icon: LineChartIcon, roles: ['owner', 'manager'] },
  { id: 'employees', labelKey: 'nav.employees', icon: UserCog, roles: ['owner'] },
  { id: 'network', labelKey: 'nav.network', icon: Server, roles: ['owner', 'manager'] },
  { id: 'settings', labelKey: 'nav.settings', icon: Settings, roles: ['owner', 'manager'] },
] as const

type View = (typeof NAV)[number]['id']

const VIEW_IDS = NAV.map(n => n.id) as readonly string[]

/** Sections for the expanded rail's group labels (the reference's group
 *  headers). Keys into the existing nav translations; a screen not listed
 *  under a section simply belongs to the previous one. */
const NAV_SECTIONS: { afterView: View | null; labelKey: string }[] = [
  { afterView: null, labelKey: 'nav.dashboard' },
  { afterView: 'pos', labelKey: 'nav.inventory' },
  { afterView: 'suppliers', labelKey: 'nav.sales' },
  { afterView: 'insights', labelKey: 'nav.settings' },
]

/** Screens a role may open. Derived, so it cannot drift from the sidebar. */
function canAccess(role: string, view: View): boolean {
  const entry = NAV.find(n => n.id === view)
  return !!entry && (entry.roles as readonly string[]).includes((role || '').toLowerCase())
}

/** The first screen this role is actually allowed to see. A cashier has no
 *  Dashboard, so landing them on one would show an empty shell. */
function landingView(role: string): View {
  return (NAV.find(n => (n.roles as readonly string[]).includes((role || '').toLowerCase()))?.id ?? 'pos') as View
}

/* ------------------------------------------------------------------------- */

function AppContent() {
  const { t, setLanguage } = useLanguage()
  const { toggleTheme } = useTheme()

  const [user, setUser] = useState<SwitchUser | null>(null)
  const [currentView, setCurrentView] = useState<View>('dashboard')
  // `collapsed` is the ICON RAIL state — now the DEFAULT look (the reference's
  // slim left edge). `expanded` is the widened rail with labels.
  const [collapsed, setCollapsed] = useState(true)
  const [showSwitcher, setShowSwitcher] = useState(false)

  const [editingProduct, setEditingProduct] = useState<Product | null | undefined>(undefined)
  const [showProductForm, setShowProductForm] = useState(false)
  const [inventoryRefreshKey, setInventoryRefreshKey] = useState(0)
  const [lowStockCount, setLowStockCount] = useState(0)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)

  const [stores, setStores] = useState<{ id: number; name: string; code: string }[]>([])
  const [storeId, setStoreId] = useState<number | null>(null)

  /* -- Boot identity --------------------------------------------------------
     The launch keypad is gone: it was a wall in front of a machine that sits
     behind the counter of a shop the staff already work in, and it made a
     shift change a four-digit ceremony. What replaced it is NOT "no boundary".

     The app opens as the LEAST privileged person available, because the thing
     worth protecting is not the till — it is the margins, the payroll and the
     audit trail. Stepping up to responsable/propriétaire still costs that
     person's PIN (UserSwitcher). A shop whose only user is the owner has
     nothing to step down to, so it opens as the owner.
     ------------------------------------------------------------------------ */
  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      try {
        const rows: any[] = (await window.electron?.user?.getAll?.()) ?? []
        const active = rows.filter(r => r.is_active !== 0)
        const remembered = Number(await window.electron?.config?.get?.('active_user_id')) || null

        const pick =
          active.find(u => u.id === remembered && !isElevated(u.role)) ??
          active.find(u => (u.role || '').toLowerCase() === 'cashier') ??
          active.find(u => !isElevated(u.role)) ??
          active[0]

        if (!cancelled && pick) {
          const who = { id: pick.id, name: pick.name, role: pick.role }
          setUser(who)
          setCurrentView(landingView(who.role))
        }
      } catch (e) {
        console.error('Boot identity failed', e)
      }
    }
    boot()
    return () => { cancelled = true }
  }, [])

  const refreshLowStockCount = async () => {
    if (!window.electron?.product?.getCount) return
    try {
      setLowStockCount(await window.electron.product.getCount({ lowStock: true }))
    } catch (err) {
      console.error('Failed to fetch low stock count:', err)
    }
  }

  useEffect(() => {
    if (!user) return
    refreshLowStockCount()
    window.electron?.config?.get('onboarded').then(v => setNeedsOnboarding(v !== '1')).catch(() => {})
    window.electron?.receipt?.getConfig?.().then((c: any) => {
      document.title = (c?.companyName || '').trim() || 'Dapper'
    }).catch(() => {})
    // Optional-chained: an older preload without the store bridge must degrade to
    // "no store shown", not crash the shell on boot.
    window.electron?.store?.list?.().then(setStores).catch(() => {})
    window.electron?.store?.currentId?.().then(setStoreId).catch(() => {})
  }, [user, inventoryRefreshKey, needsOnboarding])

  // AI copilot → UI. The whitelist is the nav table, so a capability that can
  // navigate can reach every screen that exists and nothing that does not.
  useEffect(() => {
    if (!window.electron?.ai) return
    const offView = window.electron.ai.onViewChange((view: string) => {
      if (VIEW_IDS.includes(view)) setCurrentView(view as View)
    })
    const offTheme = window.electron.ai.onSettingsToggleTheme(() => toggleTheme())
    // The copilot may switch language, but only to one the app actually has —
    // an unrecognised code used to be cast straight through and would blank
    // every translated string.
    const offLang = window.electron.ai.onSettingsChangeLang((lang: string) => {
      if (lang === 'fr' || lang === 'ar') setLanguage(lang)
    })
    return () => { offView?.(); offTheme?.(); offLang?.() }
  }, [toggleTheme, setLanguage])

  const triggerInventoryRefresh = () => {
    setInventoryRefreshKey(prev => prev + 1)
    refreshLowStockCount()
  }

  const visibleNav = useMemo(
    () => NAV.filter(n => user && canAccess(user.role, n.id)),
    [user],
  )

  const switchUser = (next: SwitchUser) => {
    setUser(next)
    setShowSwitcher(false)
    // Remember only day-to-day accounts. Persisting an owner would hand the next
    // launch a privileged session with no PIN, which is the one thing removing
    // the keypad must not do.
    if (!isElevated(next.role)) {
      window.electron?.config?.set?.('active_user_id', String(next.id)).catch(() => {})
    }
    if (!canAccess(next.role, currentView)) setCurrentView(landingView(next.role))
  }

  const handleProductAdd = () => { setEditingProduct(null); setShowProductForm(true) }
  const handleProductEdit = (product: Product) => { setEditingProduct(product); setShowProductForm(true) }
  const handleProductSave = () => {
    setShowProductForm(false)
    setEditingProduct(undefined)
    triggerInventoryRefresh()
  }

  if (!user) {
    return (
      <div className="app-boot">
        <BrandLogo height={26} />
        <span>{t('nav.opening')}</span>
      </div>
    )
  }

  const activeStore = stores.find(s => s.id === storeId)

  return (
    <div className="app-container">
      {needsOnboarding && <OnboardingWizard onDone={() => setNeedsOnboarding(false)} />}

      {/* The reference's icon rail. `collapsed` = rail (default); the brand
          glyph expands it to the labelled rail. */}
      <nav className={`sidebar ${collapsed ? '' : 'is-expanded'}`}>
        <div className="sidebar-header">
          <button
            className="sidebar-brand"
            onClick={() => setCollapsed(c => !c)}
            title="Dapper"
          >
            <span className="sidebar-brand-glyph"><BrandMark size={19} /></span>
            <span className="sidebar-brand-text">
              <BrandLogo height={13} className="wordmark" />
              <small>{t('nav.retailSystem')}</small>
            </span>
          </button>
        </div>

        <div className="nav-items">
          {visibleNav.flatMap(item => {
            const Icon = item.icon
            const badge = item.id === 'products' && lowStockCount > 0 ? lowStockCount : null
            const nodes: ReactNode[] = [
              <button
                key={item.id}
                className={`nav-item ${currentView === item.id ? 'active' : ''}`}
                onClick={() => setCurrentView(item.id)}
                data-label={t(item.labelKey)}
                title={collapsed ? t(item.labelKey) : undefined}
              >
                <span className="icon"><Icon size={17} /></span>
                <span>{t(item.labelKey)}</span>
                {badge !== null && <span className="nav-badge">{badge}</span>}
              </button>,
            ]
            // Group label AFTER its last screen, only in the expanded rail.
            const next = NAV_SECTIONS.find(s => s.afterView === item.id)
            if (next) {
              nodes.push(
                <div key={`sec-${next.labelKey}`} className="nav-section">{t(next.labelKey)}</div>,
              )
            }
            return nodes
          })}
        </div>

        <div className="sidebar-footer">
          {/* Identity AND shop, behind one control. Both are facts about this
              terminal that stay wrong silently, so they are shown together and
              changed together — see UserSwitcher. */}
          <button className="user-card" onClick={() => setShowSwitcher(true)}>
            <span className="user-avatar"><BrandMark size={18} letter={user.name} /></span>
            <span className="user-card-text">
              <span className="user-card-name">{user.name}</span>
              <span className="user-card-role">
                {t(roleKey(user.role))}{activeStore ? ` · ${activeStore.name}` : ''}
              </span>
            </span>
            <ChevronDown size={15} />
          </button>
        </div>
      </nav>

      <main className={`main-content ${currentView === 'pos' ? 'is-fixed' : ''}`}>
        <div className="app-topbar">
          <h2 className="app-topbar-title">
            {(() => { const e = NAV.find(n => n.id === currentView); return e ? t(e.labelKey) : '' })()}
          </h2>
          {activeStore && <span className="el-chip el-chip--accent">{activeStore.name}</span>}
          <div className="app-topbar-right">
            {/* The reference's quiet search field. Focus funnels into the POS
                search on sale screens (the only place search makes sense). */}
            <button
              className="topbar-search"
              onClick={() => setCurrentView('pos')}
              title={t('nav.pos')}
            >
              <Search size={14} />
              <span>{t('nav.pos')}…</span>
            </button>
            <NotificationCenter
              storeId={storeId}
              onNavigate={(entityType) => {
                const target: Record<string, View> = {
                  product: 'inventory',
                  stock_transfer: 'transfers',
                  cash_session: 'cash',
                  inventory_count: 'inventory',
                }
                if (entityType && target[entityType]) setCurrentView(target[entityType])
              }}
            />
            <button
              className="topbar-avatar"
              onClick={() => setShowSwitcher(true)}
              title={user.name}
            >
              <BrandMark size={18} letter={user.name} />
            </button>
          </div>
        </div>

        {currentView === 'dashboard' && (
          <Dashboard storeId={storeId} stores={stores} onNavigate={setCurrentView} />
        )}

        {currentView === 'sales' && <SalesScreen userId={user.id} storeId={storeId} />}

        {currentView === 'pos' && <POSScreen userId={user.id} userName={user.name} />}

        {currentView === 'products' && (
          <>
            <ProductList
              userId={user.id}
              onAdd={handleProductAdd}
              onEdit={handleProductEdit}
              refreshKey={inventoryRefreshKey}
              onInventoryChange={triggerInventoryRefresh}
            />
            {showProductForm && (
              <ProductForm
                product={editingProduct}
                userId={user.id}
                onSave={handleProductSave}
                onCancel={() => setShowProductForm(false)}
              />
            )}
          </>
        )}

        {currentView === 'inventory' && <InventoryScreen userId={user.id} storeId={storeId} />}

        {currentView === 'transfers' && <TransfersScreen userId={user.id} storeId={storeId} />}

        {currentView === 'customers' && <CustomersScreen />}

        {currentView === 'suppliers' && <SupplierManager />}

        {currentView === 'purchases' && <OrdersManager />}

        {currentView === 'cash' && <CashSessionScreen userId={user.id} />}

        {currentView === 'expenses' && <ExpenseManager />}

        {currentView === 'reports' && (
          <ReportsScreen userId={user.id} storeId={storeId} canManageTargets={user.role === 'owner'} />
        )}

        {currentView === 'insights' && <AnalyticsDashboard />}

        {currentView === 'employees' && <EmployeesScreen userId={user.id} />}

        {currentView === 'network' && <NetworkMonitorScreen />}

        {currentView === 'settings' && (
          <SettingsScreen
            userId={user.id}
            onStoresChanged={() => {
              window.electron?.store?.list?.().then(setStores).catch(() => {})
              window.electron?.store?.currentId?.().then(setStoreId).catch(() => {})
            }}
            onInventoryChange={triggerInventoryRefresh}
          />
        )}
      </main>

      {showSwitcher && (
        <UserSwitcher
          currentUser={user}
          stores={stores}
          storeId={storeId}
          onSwitchUser={switchUser}
          onSwitchStore={(id) => { setStoreId(id); setShowSwitcher(false) }}
          onClose={() => setShowSwitcher(false)}
        />
      )}

      <AIAssistant />
    </div>
  )
}

function App() {
  return <AppContent />
}

export default App
