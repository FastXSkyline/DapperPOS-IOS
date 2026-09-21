import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus, Search, Truck, Pencil, Trash2, X, Phone, Mail } from 'lucide-react'
import type { Supplier } from '../../shared/types'
import { formatCurrency } from '../utils/formatters'
import { useLanguage } from '../LanguageContext'
import './SupplierManager.css'

/* ---------------------------------------------------------------------------
   Fournisseurs.

   ⚠️ THIS SCREEN USED TO CRASH. It imported `SupplierService` — a main-process
   module — straight into the renderer, which drags better-sqlite3 and
   electron/database.ts into the browser bundle. Nothing mounted it, so nobody
   found out; wiring it into the sidebar broke the build immediately, which is
   the honest version of what would have happened at runtime.

   It now goes through `window.electron.supplier.*` like every other screen.
   The same defect still exists in HeldTransactions.tsx, which is likewise
   unmounted — see PROJECT.md §6.
   --------------------------------------------------------------------------- */

const EMPTY = {
    company_name: '',
    contact_name: '',
    phone: '',
    email: '',
    address: '',
    city: '',
    tax_id: '',
    payment_terms: '',
    credit_limit: 0,
    lead_time_days: 0,
    notes: '',
}

type FormState = typeof EMPTY

function toForm(s: Supplier): FormState {
    return {
        company_name: s.company_name ?? '',
        contact_name: s.contact_name ?? '',
        phone: s.phone ?? '',
        email: s.email ?? '',
        address: s.address ?? '',
        city: s.city ?? '',
        tax_id: (s as any).tax_id ?? '',
        payment_terms: s.payment_terms ?? '',
        credit_limit: Number((s as any).credit_limit) || 0,
        lead_time_days: Number((s as any).lead_time_days) || 0,
        notes: (s as any).notes ?? '',
    }
}

export function SupplierManager() {
    const { t } = useLanguage()
    const [suppliers, setSuppliers] = useState<Supplier[]>([])
    const [search, setSearch] = useState('')
    const [editing, setEditing] = useState<Supplier | null>(null)
    const [creating, setCreating] = useState(false)
    const [loading, setLoading] = useState(true)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            setSuppliers(await window.electron.supplier.getAll())
        } catch (e) {
            console.error('[Fournisseurs] load failed:', e)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase()
        if (!q) return suppliers
        return suppliers.filter(s =>
            s.company_name?.toLowerCase().includes(q) ||
            (s.contact_name || '').toLowerCase().includes(q) ||
            (s.phone || '').toLowerCase().includes(q) ||
            (s.city || '').toLowerCase().includes(q))
    }, [suppliers, search])

    const save = async (f: FormState) => {
        const payload = {
            company_name: f.company_name.trim(),
            contact_name: f.contact_name || null,
            phone: f.phone || null,
            email: f.email || null,
            address: f.address || null,
            city: f.city || null,
            country: null,
            tax_id: f.tax_id || null,
            website: null,
            payment_terms: f.payment_terms || null,
            credit_limit: Number(f.credit_limit) || 0,
            lead_time_days: Number(f.lead_time_days) || 0,
            rating: 0,
            notes: f.notes || null,
            is_active: 1,
        }
        if (editing) await window.electron.supplier.update(editing.id, payload)
        else await window.electron.supplier.create(payload)
        setEditing(null)
        setCreating(false)
        load()
    }

    const remove = async (s: Supplier) => {
        if (!confirm(`${t('sup.deleteAsk')} ${s.company_name} ?`)) return
        await window.electron.supplier.delete(s.id)
        load()
    }

    return (
        <div className="el-page">
            <div className="el-page-head">
                <div>
                    <h1 className="el-page-title">{t('nav.suppliers')}</h1>
                    <p className="el-page-sub">{t('sup.subtitle')}</p>
                </div>
                <div className="el-page-actions">
                    <label className="el-search sup-search">
                        <Search size={15} />
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder={t('sup.searchPh')}
                            aria-label={t('sup.searchPh')}
                        />
                    </label>
                    <button className="el-btn el-btn--primary" onClick={() => { setCreating(true); setEditing(null) }}>
                        <Plus size={15} /> {t('sup.newSupplier')}
                    </button>
                </div>
            </div>

            <div className="el-card el-card--pad0">
                <div className="el-table-wrap">
                    <table className="el-table">
                        <thead>
                            <tr>
                                <th>{t('ui2.supplier')}</th>
                                <th>{t('ui2.contact')}</th>
                                <th>{t('ui.phone')}</th>
                                <th>{t('ui2.city')}</th>
                                <th>{t('sup.terms')}</th>
                                <th className="num">{t('ui2.creditCap')}</th>
                                <th className="num">{t('sup.leadTime')}</th>
                                <th aria-label={t('ui.actionsCol')} />
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map(s => (
                                <tr key={s.id}>
                                    <td>
                                        <span className="el-cell-product">
                                            <span className="el-thumb"><Truck size={16} /></span>
                                            <span>{s.company_name}</span>
                                        </span>
                                    </td>
                                    <td className="muted">{s.contact_name || '—'}</td>
                                    <td className="muted">{s.phone || '—'}</td>
                                    <td className="muted">{s.city || '—'}</td>
                                    <td className="muted">{s.payment_terms || '—'}</td>
                                    <td className="num">
                                        {(s as any).credit_limit ? formatCurrency((s as any).credit_limit) : '—'}
                                    </td>
                                    <td className="num muted">
                                        {(s as any).lead_time_days ? `${(s as any).lead_time_days} j` : '—'}
                                    </td>
                                    <td className="num sup-actions">
                                        <button
                                            className="el-icon-btn"
                                            onClick={() => { setEditing(s); setCreating(false) }}
                                            aria-label={`Modifier ${s.company_name}`}
                                        >
                                            <Pencil size={15} />
                                        </button>
                                        <button
                                            className="el-icon-btn"
                                            onClick={() => remove(s)}
                                            aria-label={`Supprimer ${s.company_name}`}
                                        >
                                            <Trash2 size={15} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    {!loading && filtered.length === 0 && (
                        <div className="el-empty">
                            <span className="el-empty-icon"><Truck size={22} /></span>
                            <strong>{search ? t('ui.noResult') : t('sup.noSuppliers')}</strong>
                            <span>
                                {search
                                    ? t('sup.noMatchHint')
                                    : t('sup.noSuppliersHint')}
                            </span>
                        </div>
                    )}
                    {loading && <div className="el-empty">{t('ui.loading')}</div>}
                </div>

                {filtered.length > 0 && (
                    <div className="el-table-foot">
                        {filtered.length} {t('sup.suppliersN')}
                    </div>
                )}
            </div>

            {(creating || editing) && (
                <SupplierForm
                    initial={editing ? toForm(editing) : EMPTY}
                    title={editing ? `${t('ui.edit')} ${editing.company_name}` : t('sup.newSupplier')}
                    onSave={save}
                    onCancel={() => { setCreating(false); setEditing(null) }}
                />
            )}
        </div>
    )
}

function SupplierForm({ initial, title, onSave, onCancel }: {
    initial: FormState
    title: string
    onSave: (f: FormState) => void
    onCancel: () => void
}) {
    const { t } = useLanguage()
    const [f, setF] = useState<FormState>(initial)
    const set = (k: keyof FormState, v: string | number) => setF(prev => ({ ...prev, [k]: v }))

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onCancel])

    return (
        <div className="el-modal-overlay" onClick={onCancel}>
            <form
                className="el-modal el-modal--wide"
                onClick={e => e.stopPropagation()}
                onSubmit={e => { e.preventDefault(); if (f.company_name.trim()) onSave(f) }}
            >
                <div className="el-modal-head">
                    <h2>{title}</h2>
                    <button type="button" className="el-icon-btn el-modal-x" onClick={onCancel} aria-label={t('ui.close')}>
                        <X size={18} />
                    </button>
                </div>

                <div className="el-modal-body">
                    <div className="sup-form-grid">
                        <label className="el-field sup-span2">
                            <span className="el-label">{t('sup.legalName')}</span>
                            <input className="el-input" value={f.company_name} required autoFocus
                                onChange={e => set('company_name', e.target.value)} />
                        </label>
                        <label className="el-field">
                            <span className="el-label">{t('sup.contactName')}</span>
                            <input className="el-input" value={f.contact_name}
                                onChange={e => set('contact_name', e.target.value)} />
                        </label>
                        <label className="el-field">
                            <span className="el-label"><Phone size={11} /> {t('ui.phone')}</span>
                            <input className="el-input" value={f.phone}
                                onChange={e => set('phone', e.target.value)} />
                        </label>
                        <label className="el-field">
                            <span className="el-label"><Mail size={11} /> {t('ui.email')}</span>
                            <input className="el-input" type="email" value={f.email}
                                onChange={e => set('email', e.target.value)} />
                        </label>
                        <label className="el-field">
                            <span className="el-label">{t('ui2.taxId')}</span>
                            <input className="el-input" value={f.tax_id}
                                onChange={e => set('tax_id', e.target.value)} />
                        </label>
                        <label className="el-field sup-span2">
                            <span className="el-label">{t('ui.address')}</span>
                            <input className="el-input" value={f.address}
                                onChange={e => set('address', e.target.value)} />
                        </label>
                        <label className="el-field">
                            <span className="el-label">{t('ui2.city')}</span>
                            <input className="el-input" value={f.city}
                                onChange={e => set('city', e.target.value)} />
                        </label>
                        <label className="el-field">
                            <span className="el-label">{t('sup.paymentTerms')}</span>
                            <input className="el-input" value={f.payment_terms} placeholder={t('last.termsPh')}
                                onChange={e => set('payment_terms', e.target.value)} />
                        </label>
                        <label className="el-field">
                            <span className="el-label">{t('ui2.creditLimit')}</span>
                            <input className="el-input tabular" type="number" min="0" value={f.credit_limit}
                                onChange={e => set('credit_limit', Number(e.target.value))} />
                        </label>
                        <label className="el-field">
                            <span className="el-label">{t('sup.leadTimeDays')}</span>
                            <input className="el-input tabular" type="number" min="0" value={f.lead_time_days}
                                onChange={e => set('lead_time_days', Number(e.target.value))} />
                        </label>
                        <label className="el-field sup-span2">
                            <span className="el-label">{t('ui.notes')}</span>
                            <textarea className="el-textarea" value={f.notes}
                                onChange={e => set('notes', e.target.value)} />
                        </label>
                    </div>
                </div>

                <div className="el-modal-foot">
                    <button type="button" className="el-btn el-btn--secondary" onClick={onCancel}>{t('ui.cancelBtn')}</button>
                    <span className="el-spacer" />
                    <button type="submit" className="el-btn el-btn--primary" disabled={!f.company_name.trim()}>
                        {t('ui.saveBtn')}
                    </button>
                </div>
            </form>
        </div>
    )
}
