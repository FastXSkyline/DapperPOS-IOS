import { useState, useEffect } from 'react'
import { useLanguage } from '../LanguageContext'
import type { Transaction } from '../../shared/types'
import { Phone, Calendar, AlertCircle, CreditCard } from 'lucide-react'
import { formatDate, formatCurrency } from '../utils/formatters'
import './DebtorsList.css'

export function DebtorsList() {
    const { t } = useLanguage()
    const [debtors, setDebtors] = useState<Transaction[]>([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        loadDebtors()
    }, [])

    const loadDebtors = async () => {
        try {
            const data = await window.electron.transaction.getDebtors()
            setDebtors(data)
        } catch (error) {
            console.error('Failed to load debtors:', error)
        } finally {
            setLoading(false)
        }
    }

    const handlePay = async (transactionId: number) => {
        if (confirm(t('debtors.markPaidConfirm'))) {
            try {
                await window.electron.transaction.settleDebt(transactionId)
                alert(t('debtors.paidSuccess'))
                await loadDebtors()
            } catch (error) {
                console.error('Failed to settle debt:', error)
                alert('Mise à jour du règlement impossible.')
            }
        }
    }

    // Partial settlement: ask for an amount + method, then post it.
    const handlePartial = async (debtor: Transaction) => {
        const remaining = (debtor.total_amount || 0) - (debtor.amount_paid || 0)
        const amountStr = prompt(`Montant à régler (reste ${remaining.toLocaleString()} DA) :`, String(remaining))
        if (!amountStr) return
        const amount = parseFloat(amountStr)
        if (isNaN(amount) || amount <= 0) return
        const method = prompt('Mode de paiement (cash, cheque, virement, ccp) :', 'cash') || 'cash'
        try {
            const res = await window.electron.ledger.settlePartial(debtor.id, amount, method)
            if (res.success) alert(`Réglé ${res.paid?.toLocaleString()} DA. Reste ${res.remaining?.toLocaleString()} DA.`)
            else alert(res.error || 'Échec du règlement.')
            await loadDebtors()
        } catch (e) { console.error(e); alert('Échec du règlement partiel.') }
    }

    const handleStatement = async (debtor: Transaction) => {
        const cid = (debtor as any).customer_id
        if (!cid) { alert('Client non enregistré (pas de relevé).'); return }
        try { await window.electron.ledger.printStatement(cid) } catch (e) { console.error(e) }
    }

    const isOverdue = (date: string) => {
        if (!date) return false
        return new Date(date) < new Date()
    }

    if (loading) return <div className="loading">{t('common.loading')}</div>

    return (
        <div className="debtors-container">
            <header className="debtors-header">
                <h1>{t('debtors.title')}</h1>
                <div className="debtors-stats">
                    <div className="stat-card">
                        <span className="stat-label">{t('debtors.totalOutstanding')}</span>
                        <span className="stat-value">
                            {formatCurrency(debtors.reduce((sum, d) => sum + (d.total_amount - d.amount_paid), 0))}
                        </span>
                    </div>
                </div>
            </header>

            <div className="debtors-grid">
                {debtors.length === 0 ? (
                    <div className="no-data">{t('debtors.noDebtors')}</div>
                ) : (
                    debtors.map((debtor) => (
                        <div key={debtor.id} className={`debtor-card ${isOverdue(debtor.debt_due_date!) ? 'overdue' : ''}`}>
                            <div className="debtor-main">
                                <div className="debtor-info">
                                    <h3>{debtor.customer_name}</h3>
                                    {debtor.customer_phone && (
                                        <div className="info-row">
                                            <Phone size={14} />
                                            <span>{debtor.customer_phone}</span>
                                        </div>
                                    )}
                                    <div className="info-row">
                                        <Calendar size={14} />
                                        <span>{t('debtors.dueDate')}: {formatDate(debtor.debt_due_date!)}</span>
                                    </div>
                                </div>
                                <div className="debtor-balance">
                                    <span className="balance-label">{t('debtors.amount')}</span>
                                    <span className="balance-value">{formatCurrency(debtor.total_amount - debtor.amount_paid)}</span>
                                </div>
                            </div>

                            <div className="debtor-footer">
                                <div className="debt-status">
                                    {isOverdue(debtor.debt_due_date!) ? (
                                        <span className="status-badge overdue">
                                            <AlertCircle size={12} />
                                            {t('debtors.overdue')}
                                        </span>
                                    ) : (
                                        <span className="status-badge pending">
                                            <Calendar size={12} />
                                            {t('debtors.pending')}
                                        </span>
                                    )}
                                </div>
                                <div className="actions">
                                    <button
                                        className="btn-pay"
                                        onClick={() => handlePay(debtor.id)}
                                        title={t('debtors.markPaid')}
                                    >
                                        <CreditCard size={14} />
                                        <span>{t('pos.pay')}</span>
                                    </button>
                                    <button
                                        className="btn-call"
                                        onClick={() => handlePartial(debtor)}
                                        title="Règlement partiel"
                                    >
                                        Versement
                                    </button>
                                    <button
                                        className="btn-call"
                                        onClick={() => handleStatement(debtor)}
                                        title="Relevé de compte"
                                    >
                                        Relevé
                                    </button>
                                    <button
                                        className="btn-call"
                                        onClick={() => window.open(`tel:${debtor.customer_phone}`)}
                                    >
                                        {t('debtors.call')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    )
}
