import { useState, useEffect } from 'react'
import { useLanguage } from '../LanguageContext'
import { Printer, RefreshCw, CheckCircle2 } from 'lucide-react'

export function PrinterSettings() {
    const { t } = useLanguage()
    const [printers, setPrinters] = useState<any[]>([])
    const [config, setConfig] = useState({ label: '', receipt: '', order: '' })
    const [loading, setLoading] = useState(true)
    const [saved, setSaved] = useState(false)

    useEffect(() => {
        loadData()
    }, [])

    const loadData = async () => {
        setLoading(true)
        if (window.electron) {
            const list = await window.electron.getPrinters()
            const savedConfig = await window.electron.settings.getPrinterConfig()
            setPrinters(list)
            setConfig(savedConfig)
        }
        setLoading(false)
    }

    const handleSave = async () => {
        if (window.electron) {
            await window.electron.settings.savePrinterConfig(config)
            setSaved(true)
            setTimeout(() => setSaved(false), 3000)
        }
    }

    if (loading) return <div>{t('common.loading')}</div>

    return (
        <div style={{ background: 'var(--surface)', padding: '1.5rem', borderRadius: 'var(--radius-lg)', marginTop: '1.5rem', border: '1px solid var(--border-light)', boxShadow: 'var(--shadow-md)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-main)' }}>
                    <Printer size={20} />
                    {t('printers.title')}
                </h3>
                <button
                    onClick={loadData}
                    style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                >
                    <RefreshCw size={14} />
                    {t('printers.refresh')}
                </button>
            </div>

            <div style={{ display: 'grid', gap: '1.5rem' }}>
                <div className="printer-field">
                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600, fontSize: '0.9em', color: 'var(--text-muted)' }}>
                        {t('printers.a4')}
                    </label>
                    <select
                        value={config.order}
                        onChange={(e) => setConfig({ ...config, order: e.target.value })}
                        style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border-light)', background: 'var(--bg-main)', color: 'var(--text-main)' }}
                    >
                        <option value="">{t('printers.select')}</option>
                        {printers.map(p => <option key={p.name} value={p.name}>{p.name} {p.isDefault ? '(Default)' : ''}</option>)}
                    </select>
                </div>

                <div className="printer-field">
                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600, fontSize: '0.9em', color: 'var(--text-muted)' }}>
                        {t('printers.barcode')}
                    </label>
                    <select
                        value={config.label}
                        onChange={(e) => setConfig({ ...config, label: e.target.value })}
                        style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border-light)', background: 'var(--bg-main)', color: 'var(--text-main)' }}
                    >
                        <option value="">{t('printers.select')}</option>
                        {printers.map(p => <option key={p.name} value={p.name}>{p.name} {p.isDefault ? '(Default)' : ''}</option>)}
                    </select>
                </div>

                <div className="printer-field">
                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600, fontSize: '0.9em', color: 'var(--text-muted)' }}>
                        {t('printers.receipt')}
                    </label>
                    <select
                        value={config.receipt}
                        onChange={(e) => setConfig({ ...config, receipt: e.target.value })}
                        style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border-light)', background: 'var(--bg-main)', color: 'var(--text-main)' }}
                    >
                        <option value="">{t('printers.select')}</option>
                        {printers.map(p => <option key={p.name} value={p.name}>{p.name} {p.isDefault ? '(Default)' : ''}</option>)}
                    </select>
                </div>
            </div>

            <button
                onClick={handleSave}
                style={{
                    marginTop: '2rem',
                    width: '100%',
                    padding: '1rem',
                    background: 'var(--primary)',
                    color: 'white',
                    border: 'none',
                    borderRadius: '12px',
                    fontWeight: 800,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    boxShadow: '0 4px 12px var(--primary-glow)'
                }}
            >
                {saved ? <CheckCircle2 size={20} /> : null}
                {saved ? t('common.success') : t('common.save')}
            </button>
        </div>
    )
}
