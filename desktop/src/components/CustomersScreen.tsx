import { useState, useEffect, useCallback, useMemo } from 'react'
import { Search, Plus, Users, Pencil, X, Phone, Mail, CreditCard } from 'lucide-react'
import type { Customer } from '../../shared/types'
import { DebtorsList } from './DebtorsList'
import { formatCurrency } from '../utils/formatters'
import { useLanguage } from '../LanguageContext'
import './CustomersScreen.css'

/* ---------------------------------------------------------------------------
   Clients.

   These are two different questions and they were sharing one screen: the
   sidebar's "Clients" opened a list of DEBTS. A shop that wanted to look up a
   customer's phone number was shown an ageing report, and a customer with
   nothing outstanding did not appear at all — so most of the shop's customers
   were invisible in the only screen named after them.

   Split, therefore:
     • Clients  — the register. Everyone, searchable, editable.
     • Créances — the money. Unpaid and partially paid sales, oldest first.

   They stay on ONE sidebar entry because they are the same people; the tab is
   the question you are asking about them.
   --------------------------------------------------------------------------- */

type Tab = 'all' | 'debts'

const EMPTY = {
    name: '', phone: '', email: '', company_name: '', tax_id: '',
    billing_address: '', credit_limit: 0,
}
type FormState = typeof EMPTY

function toForm(c: Customer): FormState {
    return {
        name: c.name ?? '',
        phone: c.phone ?? '',
        email: c.email ?? '',
        company_name: c.company_name ?? '',
        tax_id: c.tax_id ?? '',
        billing_address: c.billing_address ?? '',
        credit_limit: Number(c.credit_limit) || 0,
    }
}

export function CustomersScreen() {
    const { t } = useLanguage()
    const [tab, setTab] = useState<Tab>('all')
    const [customers, setCustomers] = useState<Customer[]>([])
    const [search, setSearch] = useState('')
    const [editing, setEditing] = useState<Customer | null>(null)
    const [creating, setCreating] = useState(false)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')

    const load = useCallback(async () => {
        setLoading(true)
        try {
            setCustomers(await window.electron.customer.getAll())
        } catch (e) {
            console.error('[Clients] load failed:', e)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase()
        if (!q) return customers
        return customers.filter(c =>
            c.name?.toLowerCase().includes(q) ||
            (c.phone || '').toLowerCase().includes(q) ||
            (c.company_name || '').toLowerCase().includes(q) ||
            (c.email || '').toLowerCase().includes(q))
    }, [customers, search])

    const totals = useMemo(() => ({
        count: customers.length,
        owing: customers.filter(c => (c.current_balance || 0) > 0).length,
        balance: customers.reduce((n, c) => n + (Number(c.current_balance) || 0), 0),
    }), [customers])

    const save = async (f: FormState) => {
        setError('')
        const payload = {
            name: f.name.trim(),
            phone: f.phone || null,
            email: f.email || null,
            company_name: f.company_name || null,
            tax_id: f.tax_id || null,
            billing_address: f.billing_address || null,
            credit_limit: Number(f.credit_limit) || 0,
        }
        try {
            if (editing) await window.electron.customer.update(editing.id, payload)
            else await window.electron.customer.create(payload)
            setEditing(null)
            setCreating(false)
            load()
        } catch (e: any) {
            setError(e?.message || t('cat.saveFailed'))
        }
    }

    return (
        <div className="el-page cs">
            <div className="el-page-head">
                <div>
                    <h1 className="el-page-title">{t('nav.customers')}</h1>
                    <p className="el-page-sub">{t('cust.subtitle')}</p>
                </div>
                <div className="el-page-actions">
                    {tab === 'all' && (
                        <button className="el-btn el-btn--primary" onClick={() => { setCreating(true); setEditing(null) }}>
                            <Plus size={15} /> {t('cust.newClient')}
                        </button>
                    )}
                </div>
            </div>

            <div className="el-tabs">
                <button className={`el-tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
                    {t('cust.tabAll')}
                </button>
                <button className={`el-tab ${tab === 'debts' ? 'active' : ''}`} onClick={() => setTab('debts')}>
                    {t('cust.tabDebts')}
                    {totals.owing > 0 && <span className="cs-tab-count">{totals.owing}</span>}
                </button>
            </div>

            {tab === 'debts' ? (
                <DebtorsList />
            ) : (
                <>
                    <div className="el-grid el-grid--stats">
                        <div className="el-stat">
                            <span className="el-stat-label">{t('cust.tabAll')}</span>
                            <span className="el-stat-value">{totals.count}</span>
                            <span className="el-stat-foot"><span className="el-stat-note">{t('cust.inFile')}</span></span>
                        </div>
                        <div className="el-stat">
                            <span className="el-stat-label">{t('cust.withDebt')}</span>
                            <span className="el-stat-value">{totals.owing}</span>
                            <span className="el-stat-foot"><span className="el-stat-note">{t('cust.unpaid')}</span></span>
                        </div>
                        <div className={`el-stat ${totals.balance > 0 ? 'cs-stat-owed' : ''}`}>
                            <span className="el-stat-label">{t('cust.totalOwed')}</span>
                            <span className="el-stat-value">{formatCurrency(totals.balance)}</span>
                            <span className="el-stat-foot"><span className="el-stat-note">{t('cust.allClients')}</span></span>
                        </div>
                    </div>

                    <label className="el-search cs-search">
                        <Search size={15} />
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder={t('cust.searchPh')}
                            aria-label={t('cust.searchPh')}
                        />
                    </label>

                    <div className="el-card el-card--pad0">
                        <div className="el-table-wrap">
                            <table className="el-table">
                                <thead>
                                    <tr>
                                        <th>{t('ui2.client')}</th>
                                        <th>{t('ui.phone')}</th>
                                        <th>{t('ui.company')}</th>
                                        <th className="num">{t('ui2.creditCap')}</th>
                                        <th className="num">{t('ui2.balance')}</th>
                                        <th aria-label={t('ui.actionsCol')} />
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map(c => {
                                        const owed = Number(c.current_balance) || 0
                                        const over = c.credit_limit > 0 && owed > c.credit_limit
                                        return (
                                            <tr key={c.id}>
                                                <td>
                                                    <span className="cs-person">
                                                        <span className="cs-avatar">{c.name.charAt(0).toUpperCase()}</span>
                                                        <span>
                                                            <strong>{c.name}</strong>
                                                            {c.email && <small>{c.email}</small>}
                                                        </span>
                                                    </span>
                                                </td>
                                                <td className="muted">{c.phone || '—'}</td>
                                                <td className="muted">{c.company_name || '—'}</td>
                                                <td className="num muted">
                                                    {c.credit_limit ? formatCurrency(c.credit_limit) : '—'}
                                                </td>
                                                <td className={`num strong ${owed > 0 ? 'cs-owed' : ''}`}>
                                                    {owed > 0 ? formatCurrency(owed) : '—'}
                                                    {/* Over the agreed limit is the one thing on this row
                                                        that needs acting on, so it is named, not just tinted. */}
                                                    {over && <span className="el-chip el-chip--bad cs-over">{t('cust.over')}</span>}
                                                </td>
                                                <td className="num">
                                                    <button
                                                        className="el-icon-btn"
                                                        onClick={() => { setEditing(c); setCreating(false) }}
                                                        aria-label={`Modifier ${c.name}`}
                                                    >
                                                        <Pencil size={15} />
                                                    </button>
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>

                            {!loading && filtered.length === 0 && (
                                <div className="el-empty">
                                    <span className="el-empty-icon"><Users size={22} /></span>
                                    <strong>{search ? t('ui.noResult') : t('cust.noClients')}</strong>
                                    <span>
                                        {search
                                            ? t('cust.noMatchHint')
                                            : t('cust.noClientsHint')}
                                    </span>
                                </div>
                            )}
                            {loading && <div className="el-empty">{t('ui.loading')}</div>}
                        </div>

                        {filtered.length > 0 && (
                            <div className="el-table-foot">
                                {filtered.length} {t('cust.clientsN')}
                            </div>
                        )}
                    </div>
                </>
            )}

            {(creating || editing) && (
                <CustomerForm
                    initial={editing ? toForm(editing) : EMPTY}
                    title={editing ? `${t('ui.edit')} ${editing.name}` : t('cust.newClient')}
                    error={error}
                    onSave={save}
                    onCancel={() => { setCreating(false); setEditing(null); setError('') }}
                />
            )}
        </div>
    )
}

function CustomerForm({ initial, title, error, onSave, onCancel }: {
    initial: FormState
    title: string
    error: string
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
                className="el-modal"
                onClick={e => e.stopPropagation()}
                onSubmit={e => { e.preventDefault(); if (f.name.trim()) onSave(f) }}
            >
                <div className="el-modal-head">
                    <h2>{title}</h2>
                    <button type="button" className="el-icon-btn el-modal-x" onClick={onCancel} aria-label={t('ui.close')}>
                        <X size={18} />
                    </button>
                </div>

                <div className="el-modal-body">
                    <div className="cs-form-grid">
                        <label className="el-field cs-span2">
                            <span className="el-label">{t('ui2.nameReq')}</span>
                            <input className="el-input" value={f.name} required autoFocus
                                onChange={e => set('name', e.target.value)} />
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
                            <span className="el-label">{t('ui.company')}</span>
                            <input className="el-input" value={f.company_name}
                                onChange={e => set('company_name', e.target.value)} />
                        </label>
                        <label className="el-field">
                            <span className="el-label">{t('ui2.taxId')}</span>
                            <input className="el-input" value={f.tax_id}
                                onChange={e => set('tax_id', e.target.value)} />
                            {/* Required on a B2B facture for the buyer to deduct the TVA. */}
                            <span className="el-hint">{t('cust.b2bNote')}</span>
                        </label>
                        <label className="el-field cs-span2">
                            <span className="el-label">{t('ui.address')}</span>
                            <input className="el-input" value={f.billing_address}
                                onChange={e => set('billing_address', e.target.value)} />
                        </label>
                        <label className="el-field">
                            <span className="el-label"><CreditCard size={11} /> {t('ui2.creditLimit')}</span>
                            <input className="el-input tabular" type="number" min="0" value={f.credit_limit}
                                onChange={e => set('credit_limit', Number(e.target.value))} />
                            <span className="el-hint">{t('cust.noCredit')}</span>
                        </label>
                    </div>
                    {error && <span className="el-error-text">{error}</span>}
                </div>

                <div className="el-modal-foot">
                    <button type="button" className="el-btn el-btn--secondary" onClick={onCancel}>{t('ui.cancelBtn')}</button>
                    <span className="el-spacer" />
                    <button type="submit" className="el-btn el-btn--primary" disabled={!f.name.trim()}>
                        {t('ui.saveBtn')}
                    </button>
                </div>
            </form>
        </div>
    )
}
