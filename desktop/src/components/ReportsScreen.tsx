import { useState } from 'react'
import { BarChart3, Landmark, FileStack } from 'lucide-react'
import { RetailReports } from './RetailReports'
import { AccountingScreen } from './AccountingScreen'
import { DocumentsScreen } from './DocumentsScreen'

/**
 * Rapports.
 *
 * A container. RetailReports is the mockup's report page; the accounting ledger
 * and the document register sit beside it as tabs so the sidebar keeps the
 * fifteen entries the design calls for instead of growing a row each.
 *
 * The sub-tabs are the design system's segmented control floating on a glass
 * strip — the same widget `.el-seg` renders inside cards, lifted to page level
 * so the three sections read as one screen with a mode switch, not three
 * unrelated pages behind tiny text links.
 */
type Tab = 'retail' | 'accounting' | 'documents'

const TABS: { id: Tab; label: string; Icon: typeof BarChart3 }[] = [
    { id: 'retail', label: 'Rapports', Icon: BarChart3 },
    { id: 'accounting', label: 'Comptabilité', Icon: Landmark },
    { id: 'documents', label: 'Documents', Icon: FileStack },
]

export function ReportsScreen({ userId, storeId, canManageTargets }: {
    userId: number
    storeId: number | null
    canManageTargets: boolean
}) {
    const [tab, setTab] = useState<Tab>('retail')

    return (
        <div className="reports-shell">
            <div className="reports-tabsbar">
                <div className="el-segmented reports-seg" role="tablist">
                    {TABS.map(({ id, label, Icon }) => (
                        <button
                            key={id}
                            role="tab"
                            aria-selected={tab === id}
                            className={`el-seg ${tab === id ? 'active' : ''}`}
                            onClick={() => setTab(id)}
                        >
                            <Icon size={15} />
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            {tab === 'retail' && (
                <RetailReports storeId={storeId} userId={userId} canManageTargets={canManageTargets} />
            )}
            {tab === 'accounting' && <AccountingScreen userId={userId} />}
            {tab === 'documents' && <DocumentsScreen userId={userId} />}
        </div>
    )
}
