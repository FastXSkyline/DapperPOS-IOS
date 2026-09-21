import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus, Pencil, X, UserCog, Wallet, CheckCircle2, AlertTriangle } from 'lucide-react'
import type { EmployeeRow, EmployeeInput, PayslipRow, PayrollTotals } from '../vite-env'
import { formatCurrency } from '../utils/formatters'
import { useLanguage } from '../LanguageContext'
import './EmployeesScreen.css'

/* ---------------------------------------------------------------------------
   Employés.

   Two jobs, deliberately in one screen:

     1. The REGISTER — who works here, in which shop, on what contract, for how
        much. A shop needs this whether or not it runs payroll in the app.

     2. The PAYROLL, and the thing that was missing until now: the wage bill
        reaching the books. Computing payslips into their own table meant the
        expenses did not know salaries existed, so every figure that subtracted
        expenses was wrong by the largest cost the business has. The button that
        fixes that is "Comptabiliser".

   What gets posted is the EMPLOYER COST (gross + employer CNAS), not net pay —
   the withheld CNAS and IRG still leave the shop's account, just addressed to
   the state. Posting net would understate the wage bill by about a third, and
   the screen says so rather than leaving it to be discovered.
   --------------------------------------------------------------------------- */

type Tab = 'staff' | 'payroll'

const CONTRACTS = [
    { id: 'cdi', key: 'emp.cdi' },
    { id: 'cdd', key: 'emp.cdd' },
    { id: 'essai', key: 'emp.trial' },
    { id: 'saisonnier', key: 'emp.seasonal' },
]

const EMPTY: EmployeeInput = {
    name: '', position: '', base_salary: 0, allowances: 0, phone: '', email: '',
    address: '', national_id: '', ncc: '', hire_date: '', contract_type: 'cdi',
    store_id: null, user_id: null, notes: '', is_btp: false,
}

/** Current month as YYYY-MM — the period a payroll run defaults to. */
function thisPeriod(): string {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function EmployeesScreen({ userId }: { userId: number }) {
    const { t } = useLanguage()
    const [tab, setTab] = useState<Tab>('staff')
    const [rows, setRows] = useState<EmployeeRow[]>([])
    const [showInactive, setShowInactive] = useState(false)
    const [stores, setStores] = useState<{ id: number; name: string }[]>([])
    const [users, setUsers] = useState<{ id: number; name: string; role: string }[]>([])
    const [editing, setEditing] = useState<EmployeeRow | null>(null)
    const [creating, setCreating] = useState(false)
    const [error, setError] = useState('')

    // Payroll
    const [period, setPeriod] = useState(thisPeriod())
    const [slips, setSlips] = useState<PayslipRow[]>([])
    const [totals, setTotals] = useState<PayrollTotals | null>(null)
    const [posting, setPosting] = useState<{ posted: boolean; count: number; total: number } | null>(null)
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState('')

    const load = useCallback(async () => {
        try {
            setRows(await window.electron.payroll.employees(showInactive))
        } catch (e) {
            console.error('[Employés] load failed:', e)
        }
    }, [showInactive])

    useEffect(() => { load() }, [load])

    useEffect(() => {
        window.electron?.store?.list?.().then(setStores).catch(() => {})
        window.electron?.user?.getAll?.().then(setUsers).catch(() => {})
    }, [])

    const loadPayroll = useCallback(async () => {
        try {
            const [ps, st] = await Promise.all([
                window.electron.payroll.payslips(period),
                window.electron.payroll.postingStatus(period),
            ])
            setSlips(ps)
            setPosting(st)
            setTotals(ps.length ? ps.reduce((t, s) => ({
                gross: t.gross + (s.gross || 0),
                cnasEmployee: t.cnasEmployee + (s.cnas_employee || 0),
                cnasEmployer: t.cnasEmployer + (s.cnas_employer || 0),
                cacobatph: t.cacobatph + (s.cacobatph || 0),
                irg: t.irg + (s.irg || 0),
                net: t.net + (s.net || 0),
                employerCost: t.employerCost + (s.employer_cost || 0),
            }), { gross: 0, cnasEmployee: 0, cnasEmployer: 0, cacobatph: 0, irg: 0, net: 0, employerCost: 0 }) : null)
        } catch (e) {
            console.error('[Paie] load failed:', e)
        }
    }, [period])

    useEffect(() => { if (tab === 'payroll') loadPayroll() }, [tab, loadPayroll])

    const active = rows.filter(r => r.is_active !== 0)
    const monthlyBase = useMemo(
        () => active.reduce((n, r) => n + (Number(r.base_salary) || 0) + (Number(r.allowances) || 0), 0),
        [active],
    )

    const save = async (data: EmployeeInput) => {
        setError('')
        const res = editing
            ? await window.electron.payroll.updateEmployee(editing.id, data, userId)
            : await window.electron.payroll.createEmployee(data, userId)
        if (!res.ok) { setError(res.message); return }
        if (res.data && 'error' in res.data && res.data.error) { setError(res.data.error); return }
        setEditing(null)
        setCreating(false)
        load()
    }

    const deactivate = async (row: EmployeeRow) => {
        if (!confirm(`${t('last.deactivateAsk')} ${row.name} ? ${t('last.deactivateNote')}`)) return
        const res = await window.electron.payroll.deleteEmployee(row.id, userId)
        if (!res.ok) { setError(res.message); return }
        load()
    }

    const runPayroll = async () => {
        setBusy(true); setNotice(''); setError('')
        try {
            const res = await window.electron.payroll.run(period, userId)
            if (!res.ok) { setError(res.message); return }
            setNotice(`${res.data.slips.length} ${t('last.slipsComputed')} ${period}.`)
            await loadPayroll()
        } finally { setBusy(false) }
    }

    const postToBooks = async () => {
        setBusy(true); setNotice(''); setError('')
        try {
            const res = await window.electron.payroll.postToExpenses(period, userId)
            if (!res.ok) { setError(res.message); return }
            if (!res.data.success) { setError(res.data.error || t('last.postImpossible')); return }
            setNotice(`${t('last.postedFor')} ${period} — ${formatCurrency(res.data.total ?? 0)} / ${res.data.posted} ${t('last.onLines')}`)
            await loadPayroll()
        } finally { setBusy(false) }
    }

    return (
        <div className="el-page emp">
            <div className="el-page-head">
                <div>
                    <h1 className="el-page-title">{t('nav.employees')}</h1>
                    <p className="el-page-sub">
                        {t('emp.subtitle')}
                    </p>
                </div>
                <div className="el-page-actions">
                    {tab === 'staff' && (
                        <button className="el-btn el-btn--primary" onClick={() => { setCreating(true); setEditing(null) }}>
                            <Plus size={15} /> {t('emp.newEmployee')}
                        </button>
                    )}
                </div>
            </div>

            <div className="el-tabs">
                <button className={`el-tab ${tab === 'staff' ? 'active' : ''}`} onClick={() => setTab('staff')}>
                    {t('emp.tabStaff')}
                </button>
                <button className={`el-tab ${tab === 'payroll' ? 'active' : ''}`} onClick={() => setTab('payroll')}>
                    {t('emp.tabPayroll')}
                </button>
            </div>

            {error && (
                <div className="emp-banner is-error" role="alert">
                    <AlertTriangle size={16} /> {error}
                </div>
            )}
            {notice && (
                <div className="emp-banner is-ok" role="status">
                    <CheckCircle2 size={16} /> {notice}
                </div>
            )}

            {tab === 'staff' && (
                <>
                    <div className="el-grid el-grid--stats">
                        <div className="el-stat">
                            <span className="el-stat-label">{t('emp.headcount')}</span>
                            <span className="el-stat-value">{active.length}</span>
                            <span className="el-stat-foot"><span className="el-stat-note">{t('emp.activeStaff')}</span></span>
                        </div>
                        <div className="el-stat">
                            <span className="el-stat-label">{t('emp.grossMonth')}</span>
                            <span className="el-stat-value">{formatCurrency(monthlyBase)}</span>
                            <span className="el-stat-foot">
                                <span className="el-stat-note">{t('emp.baseAllow')}</span>
                            </span>
                        </div>
                        <div className="el-stat">
                            <span className="el-stat-label">{t('emp.estCost')}</span>
                            {/* +25.5 % CNAS employeur. Estimated, and labelled as such:
                                the real figure comes from a payroll run. */}
                            <span className="el-stat-value">{formatCurrency(monthlyBase * 1.255)}</span>
                            <span className="el-stat-foot">
                                <span className="el-stat-note">{t('emp.withCnas')}</span>
                            </span>
                        </div>
                    </div>

                    <div className="emp-toolbar">
                        <label className="el-checkbox">
                            <input
                                type="checkbox"
                                checked={showInactive}
                                onChange={e => setShowInactive(e.target.checked)}
                            />
                            {t('emp.showInactive')}
                        </label>
                    </div>

                    <div className="el-card el-card--pad0">
                        <div className="el-table-wrap">
                            <table className="el-table">
                                <thead>
                                    <tr>
                                        <th>{t('emp.employee')}</th>
                                        <th>{t('emp.position')}</th>
                                        <th>{t('ui.store')}</th>
                                        <th>{t('emp.contract')}</th>
                                        <th>{t('emp.hired')}</th>
                                        <th>{t('emp.tillAccount')}</th>
                                        <th className="num">{t('emp.baseSalary')}</th>
                                        <th className="num">{t('emp.allowances')}</th>
                                        <th aria-label={t('ui.actionsCol')} />
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map(r => (
                                        <tr key={r.id} className={r.is_active === 0 ? 'is-off' : ''}>
                                            <td>
                                                <span className="emp-person">
                                                    <span className="emp-avatar">{r.name.charAt(0).toUpperCase()}</span>
                                                    <span>
                                                        <strong>{r.name}</strong>
                                                        {r.phone && <small>{r.phone}</small>}
                                                    </span>
                                                </span>
                                            </td>
                                            <td className="muted">{r.position || '—'}</td>
                                            <td className="muted">{r.store_name || t('ui.all')}</td>
                                            <td>
                                                <span className="el-chip el-chip--neutral">
                                                    {t(CONTRACTS.find(c => c.id === r.contract_type)?.key ?? 'emp.cdi')}
                                                </span>
                                            </td>
                                            <td className="muted">{r.hire_date || '—'}</td>
                                            <td className="muted">{r.user_name || '—'}</td>
                                            <td className="num strong">{formatCurrency(Number(r.base_salary) || 0)}</td>
                                            <td className="num muted">
                                                {Number(r.allowances) ? formatCurrency(Number(r.allowances)) : '—'}
                                            </td>
                                            <td className="num emp-actions">
                                                <button
                                                    className="el-icon-btn"
                                                    onClick={() => { setEditing(r); setCreating(false) }}
                                                    aria-label={`Modifier ${r.name}`}
                                                >
                                                    <Pencil size={15} />
                                                </button>
                                                {r.is_active !== 0 && (
                                                    <button
                                                        className="el-icon-btn"
                                                        onClick={() => deactivate(r)}
                                                        aria-label={`Désactiver ${r.name}`}
                                                    >
                                                        <X size={15} />
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {rows.length === 0 && (
                                <div className="el-empty">
                                    <span className="el-empty-icon"><UserCog size={22} /></span>
                                    <strong>{t('emp.noEmployees')}</strong>
                                    <span>{t('emp.noEmployeesHint')}</span>
                                </div>
                            )}
                        </div>
                        {rows.length > 0 && (
                            <div className="el-table-foot">
                                {active.length} {t('emp.activeStaff')}
                            </div>
                        )}
                    </div>
                </>
            )}

            {tab === 'payroll' && (
                <>
                    <div className="emp-toolbar">
                        <label className="el-field emp-period">
                            <span className="el-label">{t('emp.period')}</span>
                            <input
                                className="el-input"
                                type="month"
                                value={period}
                                onChange={e => setPeriod(e.target.value)}
                            />
                        </label>
                        <button className="el-btn el-btn--secondary" onClick={runPayroll} disabled={busy || !active.length}>
                            <Wallet size={15} /> {t('emp.runPayroll')}
                        </button>
                        <button
                            className="el-btn el-btn--primary"
                            onClick={postToBooks}
                            disabled={busy || slips.length === 0}
                            title={t('emp.postTip')}
                        >
                            {posting?.posted ? t('emp.repost') : t('emp.post')}
                        </button>
                        {posting?.posted && (
                            <span className="el-chip el-chip--ok">
                                <CheckCircle2 size={13} /> {formatCurrency(posting.total)} {t('emp.inCharges')}
                            </span>
                        )}
                    </div>

                    {totals && (
                        <div className="el-grid el-grid--stats">
                            <div className="el-stat">
                                <span className="el-stat-label">{t('emp.gross')}</span>
                                <span className="el-stat-value">{formatCurrency(totals.gross)}</span>
                                <span className="el-stat-foot"><span className="el-stat-note">{t('emp.grossParts')}</span></span>
                            </div>
                            <div className="el-stat">
                                <span className="el-stat-label">{t('emp.netPay')}</span>
                                <span className="el-stat-value">{formatCurrency(totals.net)}</span>
                                <span className="el-stat-foot"><span className="el-stat-note">{t('emp.paidToStaff')}</span></span>
                            </div>
                            <div className="el-stat">
                                <span className="el-stat-label">{t('emp.cnasIrg')}</span>
                                <span className="el-stat-value">
                                    {formatCurrency(totals.cnasEmployee + totals.cnasEmployer + totals.irg + totals.cacobatph)}
                                </span>
                                <span className="el-stat-foot"><span className="el-stat-note">{t('emp.withheld')}</span></span>
                            </div>
                            <div className="el-stat emp-stat-strong">
                                <span className="el-stat-label">{t('emp.employerCost')}</span>
                                <span className="el-stat-value">{formatCurrency(totals.employerCost)}</span>
                                <span className="el-stat-foot">
                                    <span className="el-stat-note">{t('emp.leavesTill')}</span>
                                </span>
                            </div>
                        </div>
                    )}

                    <div className="el-card el-card--pad0">
                        <div className="el-card-head el-card-head--ruled">
                            <h2 className="el-card-title">{t('emp.payslips')} — {period}</h2>
                        </div>
                        <div className="el-table-wrap">
                            <table className="el-table">
                                <thead>
                                    <tr>
                                        <th>{t('emp.employee')}</th>
                                        <th>{t('ui.store')}</th>
                                        <th className="num">{t('emp.gross')}</th>
                                        <th className="num">{t('emp.cnasEmp')}</th>
                                        <th className="num">{t('emp.irg')}</th>
                                        <th className="num">{t('emp.net')}</th>
                                        <th className="num">{t('emp.cnasEr')}</th>
                                        <th className="num">{t('emp.employerCost')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {slips.map(s => (
                                        <tr key={`${s.employee_id}-${s.period}`}>
                                            <td className="strong">{s.employee_name}</td>
                                            <td className="muted">{s.store_name || '—'}</td>
                                            <td className="num">{formatCurrency(s.gross)}</td>
                                            <td className="num muted">−{formatCurrency(s.cnas_employee || 0)}</td>
                                            <td className="num muted">−{formatCurrency(s.irg)}</td>
                                            <td className="num strong">{formatCurrency(s.net)}</td>
                                            <td className="num muted">{formatCurrency(s.cnas_employer || 0)}</td>
                                            <td className="num strong">{formatCurrency(s.employer_cost || 0)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {slips.length === 0 && (
                                <div className="el-empty">
                                    <span className="el-empty-icon"><Wallet size={22} /></span>
                                    <strong>{t('emp.noSlips')} {period}</strong>
                                    <span>{t('emp.clickRun')}</span>
                                </div>
                            )}
                        </div>
                    </div>

                    <p className="el-hint emp-note">
                        {t('emp.ratesNote')} — <strong>{t('emp.confirmAccountant')}</strong>. {t('emp.postNote')}
                        ceux couramment appliqués — <strong>à confirmer avec votre comptable</strong>,
                        ils changent à chaque loi de finances. « Comptabiliser » écrit le coût
                        employeur dans les Dépenses, catégorie <em>salaires</em>, daté de la
                        période : relancer le calcul puis recomptabiliser met la charge à jour
                        au lieu de la doubler.
                    </p>
                </>
            )}

            {(creating || editing) && (
                <EmployeeForm
                    initial={editing ?? EMPTY}
                    stores={stores}
                    users={users}
                    onCancel={() => { setCreating(false); setEditing(null); setError('') }}
                    onSave={save}
                />
            )}
        </div>
    )
}

/* ------------------------------------------------------------------------- */

function EmployeeForm({ initial, stores, users, onSave, onCancel }: {
    initial: EmployeeInput
    stores: { id: number; name: string }[]
    users: { id: number; name: string; role: string }[]
    onSave: (e: EmployeeInput) => void
    onCancel: () => void
}) {
    const { t } = useLanguage()
    const [f, setF] = useState<EmployeeInput>({ ...EMPTY, ...initial })
    const set = <K extends keyof EmployeeInput>(k: K, v: EmployeeInput[K]) =>
        setF(prev => ({ ...prev, [k]: v }))

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onCancel])

    const gross = (Number(f.base_salary) || 0) + (Number(f.allowances) || 0)

    return (
        <div className="el-modal-overlay" onClick={onCancel}>
            <form
                className="el-modal el-modal--wide"
                onClick={e => e.stopPropagation()}
                onSubmit={e => { e.preventDefault(); onSave(f) }}
            >
                <div className="el-modal-head">
                    <h2>{initial.name ? `Modifier ${initial.name}` : 'Nouvel employé'}</h2>
                    <button type="button" className="el-icon-btn el-modal-x" onClick={onCancel} aria-label={t('ui.close')}>
                        <X size={18} />
                    </button>
                </div>

                <div className="el-modal-body emp-form">
                    <section>
                        <h3 className="emp-form-section">{t('emp.identity')}</h3>
                        <div className="emp-form-grid">
                            <label className="el-field">
                                <span className="el-label">{t('emp.fullName')}</span>
                                <input className="el-input" value={f.name} required autoFocus
                                    onChange={e => set('name', e.target.value)} />
                            </label>
                            <label className="el-field">
                                <span className="el-label">{t('emp.position')}</span>
                                <input className="el-input" value={f.position ?? ''} placeholder={t('emp.positionPh')}
                                    onChange={e => set('position', e.target.value)} />
                            </label>
                            <label className="el-field">
                                <span className="el-label">{t('ui.phone')}</span>
                                <input className="el-input" value={f.phone ?? ''} placeholder={t('last.phonePh')}
                                    onChange={e => set('phone', e.target.value)} />
                            </label>
                            <label className="el-field">
                                <span className="el-label">{t('ui.email')}</span>
                                <input className="el-input" type="email" value={f.email ?? ''}
                                    onChange={e => set('email', e.target.value)} />
                            </label>
                            <label className="el-field emp-span2">
                                <span className="el-label">{t('ui.address')}</span>
                                <input className="el-input" value={f.address ?? ''}
                                    onChange={e => set('address', e.target.value)} />
                            </label>
                            <label className="el-field">
                                <span className="el-label">{t('emp.nationalId')}</span>
                                <input className="el-input" value={f.national_id ?? ''}
                                    onChange={e => set('national_id', e.target.value)} />
                            </label>
                            <label className="el-field">
                                <span className="el-label">{t('emp.ncc')}</span>
                                <input className="el-input" value={f.ncc ?? ''}
                                    onChange={e => set('ncc', e.target.value)} />
                            </label>
                        </div>
                    </section>

                    <section>
                        <h3 className="emp-form-section">{t('emp.contractAssign')}</h3>
                        <div className="emp-form-grid">
                            <label className="el-field">
                                <span className="el-label">{t('emp.contractType')}</span>
                                <select className="el-select" value={f.contract_type ?? 'cdi'}
                                    onChange={e => set('contract_type', e.target.value)}>
                                    {CONTRACTS.map(c => <option key={c.id} value={c.id}>{t(c.key)}</option>)}
                                </select>
                            </label>
                            <label className="el-field">
                                <span className="el-label">{t('emp.hireDate')}</span>
                                <input className="el-input" type="date" value={f.hire_date ?? ''}
                                    onChange={e => set('hire_date', e.target.value)} />
                            </label>
                            <label className="el-field">
                                <span className="el-label">{t('ui.store')}</span>
                                <select className="el-select" value={f.store_id ?? ''}
                                    onChange={e => set('store_id', e.target.value ? Number(e.target.value) : null)}>
                                    <option value="">{t('ui.allStores')}</option>
                                    {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                                {/* Salaries are a store-scoped cost like any other, or the two
                                    shops cannot be compared honestly. */}
                                <span className="el-hint">{t('emp.storeNote')}</span>
                            </label>
                            <label className="el-field">
                                <span className="el-label">{t('emp.tillAccount')}</span>
                                <select className="el-select" value={f.user_id ?? ''}
                                    onChange={e => set('user_id', e.target.value ? Number(e.target.value) : null)}>
                                    <option value="">{t('ui2.none')}</option>
                                    {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                                </select>
                                <span className="el-hint">{t('emp.tillNote')}</span>
                            </label>
                        </div>
                    </section>

                    <section>
                        <h3 className="emp-form-section">{t('emp.pay')}</h3>
                        <div className="emp-form-grid">
                            <label className="el-field">
                                <span className="el-label">{t('emp.baseMonthly')}</span>
                                <input className="el-input tabular" type="number" min="0" step="100"
                                    value={f.base_salary ?? 0}
                                    onChange={e => set('base_salary', Number(e.target.value))} />
                            </label>
                            <label className="el-field">
                                <span className="el-label">{t('emp.allowMonthly')}</span>
                                <input className="el-input tabular" type="number" min="0" step="100"
                                    value={f.allowances ?? 0}
                                    onChange={e => set('allowances', Number(e.target.value))} />
                                <span className="el-hint">{t('emp.allowNote')}</span>
                            </label>
                        </div>

                        <div className="emp-preview">
                            <div>
                                <span>{t('emp.grossMonthly')}</span>
                                <strong>{formatCurrency(gross)}</strong>
                            </div>
                            <div>
                                <span>{t('emp.estNet')}</span>
                                <strong>{formatCurrency(gross * 0.91)}</strong>
                            </div>
                            <div className="emp-preview-strong">
                                <span>{t('emp.costToShop')}</span>
                                <strong>{formatCurrency(gross * 1.255)}</strong>
                            </div>
                        </div>
                        <p className="el-hint">
                            {t('emp.estNote')}
                            exact (CNAS + barème IRG) se fait dans l&apos;onglet Paie.
                        </p>
                    </section>

                    <label className="el-field">
                        <span className="el-label">{t('ui.notes')}</span>
                        <textarea className="el-textarea" value={f.notes ?? ''}
                            onChange={e => set('notes', e.target.value)} />
                    </label>
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
