import { useState } from 'react'
import { Moon, Sun, Download, Upload, AlertTriangle } from 'lucide-react'
import { useLanguage } from '../LanguageContext'
import { useTheme } from '../ThemeContext'
import { StoreSettings } from './StoreSettings'
import { PrinterSettings } from './PrinterSettings'
import { AuditLogScreen } from './AuditLogScreen'
import { CloudMirrorPanel } from './CloudMirrorPanel'
import { TerminalModePanel } from './TerminalModePanel'
import {
    CloudSyncSettings,
    SyncAddressDisplay,
    AIUsageDisplay,
    FiscalRegimeSettings,
    CompanyFiscalSettings,
    PricingRulesSettings,
} from './settingsPanels'
import './SettingsScreen.css'

/**
 * Paramètres.
 *
 * Lifted out of App.tsx, where ~600 lines of settings JSX sat inline in the
 * shell and made the navigation unreadable. The panels themselves are the same
 * components as before; what changed is that they are grouped under tabs, so
 * the sidebar can keep the fifteen entries the design calls for instead of
 * growing one row per settings page.
 *
 * The blocks that were written with inline `style={{...}}` hexes (appearance,
 * language, backup, danger zone) are rebuilt on the Elegance classes. That is
 * the whole point of having them: the old danger panel hardcoded #fef2f2 on
 * #991b1b and went invisible in dark mode.
 */

type Tab = 'general' | 'stores' | 'fiscal' | 'printing' | 'sync' | 'audit' | 'maintenance'

const TABS: { id: Tab; key: string }[] = [
    { id: 'general', key: 'last.tabGeneral' },
    { id: 'stores', key: 'last.tabStores' },
    { id: 'fiscal', key: 'last.tabFiscal' },
    { id: 'printing', key: 'last.tabPrinting' },
    { id: 'sync', key: 'last.tabSync' },
    { id: 'audit', key: 'last.tabAudit' },
    { id: 'maintenance', key: 'last.tabMaintenance' },
]

export function SettingsScreen({ userId, onStoresChanged, onInventoryChange }: {
    userId: number
    onStoresChanged: () => void
    onInventoryChange: () => void
}) {
    const { t, language, setLanguage } = useLanguage()
    const { theme, toggleTheme } = useTheme()
    const [tab, setTab] = useState<Tab>('general')
    const [showReset, setShowReset] = useState(false)
    const [resetText, setResetText] = useState('')

    const verifyWord = t('settings.resetVerifyWord')

    const handleReset = async () => {
        if (resetText !== verifyWord) return
        const result = await window.electron.maintenance.resetDatabase()
        if (result.success) {
            setShowReset(false)
            setResetText('')
            alert(t('common.success'))
        } else {
            alert(t('common.error') + ': ' + result.error)
        }
    }

    return (
        <div className="el-page settings-screen">
            <div className="el-page-head">
                <div>
                    <h1 className="el-page-title">{t('settings.title')}</h1>
                    <p className="el-page-sub">{t('last.settingsSub')}</p>
                </div>
            </div>

            <div className="el-tabs">
                {TABS.map(x => (
                    <button
                        key={x.id}
                        className={`el-tab ${tab === x.id ? 'active' : ''}`}
                        onClick={() => setTab(x.id)}
                    >
                        {t(x.key)}
                    </button>
                ))}
            </div>

            {tab === 'general' && (
                <div className="settings-stack">
                    <div className="el-card">
                        <div className="el-card-head">
                            <h2 className="el-card-title">{t('settings.appearance')}</h2>
                            <div className="el-card-actions">
                                <button className="el-btn el-btn--secondary" onClick={toggleTheme}>
                                    {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
                                    {theme === 'light' ? t('settings.switchDark') : t('settings.switchLight')}
                                </button>
                            </div>
                        </div>
                        <p className="el-hint">
                            {t('set.themeNote')}
                        </p>
                    </div>

                    <div className="el-card">
                        <div className="el-card-head">
                            <h2 className="el-card-title">{t('settings.selectLanguage')}</h2>
                        </div>
                        <div className="el-segmented">
                            <button className={`el-seg ${language === 'fr' ? 'active' : ''}`} onClick={() => setLanguage('fr')}>Français</button>
                            <button className={`el-seg ${language === 'ar' ? 'active' : ''}`} onClick={() => setLanguage('ar')}>العربية</button>
                        </div>
                        <p className="el-hint" style={{ marginTop: 10 }}>
                            {t('set.langNote')}
                        </p>
                    </div>

                    <PricingRulesSettings />
                </div>
            )}

            {tab === 'stores' && (
                <div className="settings-stack">
                    <StoreSettings userId={userId} onStoreChanged={onStoresChanged} />
                    <TerminalModePanel userId={userId} />
                </div>
            )}

            {tab === 'fiscal' && (
                <div className="settings-stack">
                    <FiscalRegimeSettings />
                    <CompanyFiscalSettings />
                </div>
            )}

            {tab === 'printing' && (
                <div className="settings-stack">
                    <PrinterSettings />
                </div>
            )}

            {tab === 'sync' && (
                <div className="settings-stack">
                    <div className="el-card">
                        <div className="el-card-head">
                            <h2 className="el-card-title">{t('settings.mobileSync')}</h2>
                        </div>
                        <p className="el-hint" style={{ marginBottom: 12 }}>{t('settings.mobileSyncDesc')}</p>
                        <SyncAddressDisplay />
                        <CloudSyncSettings />
                        <AIUsageDisplay />
                    </div>
                    <CloudMirrorPanel userId={userId} />
                </div>
            )}

            {tab === 'audit' && <AuditLogScreen userId={userId} />}

            {tab === 'maintenance' && (
                <div className="settings-stack">
                    <div className="el-card">
                        <div className="el-card-head">
                            <h2 className="el-card-title">{t('last.backupRestore')}</h2>
                        </div>
                        <p className="el-hint" style={{ marginBottom: 14 }}>
                            {t('set.backupNote')}
                        </p>
                        <div className="settings-actions">
                            <button
                                className="el-btn el-btn--secondary"
                                onClick={async () => {
                                    const result = await window.electron.maintenance.exportAllData()
                                    if (result.success) alert('Sauvegarde créée : ' + result.path)
                                    else if (result.error !== 'cancelled') alert('Échec de l’export : ' + result.error)
                                }}
                            >
                                <Download size={15} /> {t('set.exportAll')}
                            </button>
                            <button
                                className="el-btn el-btn--secondary"
                                onClick={async () => {
                                    if (!confirm('Importer de nouveaux produits et fournisseurs ?')) return
                                    const result = await window.electron.maintenance.importProducts(userId)
                                    if (result.success) {
                                        alert(`${result.products} produits et ${result.suppliers} fournisseurs importés.`)
                                        onInventoryChange()
                                    } else if (result.error !== 'cancelled') {
                                        alert('Échec de l’import : ' + result.error)
                                    }
                                }}
                            >
                                <Upload size={15} /> {t('set.importMaster')}
                            </button>
                        </div>
                    </div>

                    <div className="el-card settings-danger">
                        <div className="el-card-head">
                            <span className="settings-danger-icon"><AlertTriangle size={17} /></span>
                            <h2 className="el-card-title">{t('settings.dangerZone')}</h2>
                        </div>
                        <p className="el-hint" style={{ marginBottom: 14 }}>{t('settings.deleteAllDataDesc')}</p>
                        <button className="el-btn el-btn--danger" onClick={() => setShowReset(true)}>
                            {t('settings.deleteAllData')}
                        </button>
                    </div>
                </div>
            )}

            {showReset && (
                <div className="el-modal-overlay" onClick={() => { setShowReset(false); setResetText('') }}>
                    <div
                        className="el-modal"
                        style={{ width: 'min(420px, 100%)' }}
                        onClick={e => e.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                    >
                        <div className="el-modal-head">
                            <span className="settings-danger-icon"><AlertTriangle size={17} /></span>
                            <h2>{t('settings.deleteAllData')}</h2>
                        </div>
                        <div className="el-modal-body">
                            <p style={{ margin: '0 0 12px', fontSize: 'var(--fs-callout)', color: 'var(--text-main)', lineHeight: 1.55 }}>
                                {t('settings.deleteAllDataDesc')}
                            </p>
                            <p className="el-hint" style={{ marginBottom: 8 }}>{t('settings.resetConfirmPlaceholder')}</p>
                            <input
                                className="el-input"
                                style={{ textAlign: 'center', fontWeight: 700, letterSpacing: '0.08em' }}
                                value={resetText}
                                onChange={e => setResetText(e.target.value)}
                                placeholder={verifyWord}
                                autoFocus
                            />
                        </div>
                        <div className="el-modal-foot">
                            <button className="el-btn el-btn--secondary" onClick={() => { setShowReset(false); setResetText('') }}>
                                {t('common.cancel')}
                            </button>
                            <span className="el-spacer" />
                            <button className="el-btn el-btn--danger" disabled={resetText !== verifyWord} onClick={handleReset}>
                                {t('common.confirm')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
