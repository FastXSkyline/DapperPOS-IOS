import { useState, useEffect } from 'react'
import { Trash2, Wallet } from 'lucide-react'
import { useLanguage } from '../LanguageContext'
import './ExpenseManager.css'

interface Expense {
    id: number
    name: string
    amount: number
    created_at: string
}

interface ExpenseTotals {
    total7D: number
    total1M: number
    total6M: number
    total1Y: number
}

export function ExpenseManager() {
    const [expenses, setExpenses] = useState<Expense[]>([])
    const [totals, setTotals] = useState<ExpenseTotals>({ total7D: 0, total1M: 0, total6M: 0, total1Y: 0 })
    const [name, setName] = useState('')
    const [amount, setAmount] = useState('')
    const [loading, setLoading] = useState(false)
    const { t } = useLanguage()

    const loadData = async () => {
        try {
            const [expenseList, expenseTotals] = await Promise.all([
                window.electron.expense.list(),
                window.electron.expense.totals()
            ])
            setExpenses(expenseList)
            setTotals(expenseTotals)
        } catch (error) {
            console.error('Failed to load expenses:', error)
        }
    }

    useEffect(() => {
        loadData()
    }, [])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!name.trim() || !amount) return

        setLoading(true)
        try {
            await window.electron.expense.create({
                name: name.trim(),
                amount: parseFloat(amount)
            })
            setName('')
            setAmount('')
            await loadData()
        } catch (error) {
            console.error('Failed to add expense:', error)
        } finally {
            setLoading(false)
        }
    }

    const handleDelete = async (id: number) => {
        if (!confirm(t('expenses.confirmDelete'))) return
        try {
            await window.electron.expense.delete(id)
            await loadData()
        } catch (error) {
            console.error('Failed to delete expense:', error)
        }
    }

    const formatCurrency = (val: number) => val.toLocaleString('fr-DZ', { minimumFractionDigits: 2 }) + ' DZD'

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr)
        return date.toLocaleDateString('fr-FR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        })
    }

    return (
        <div className="expense-manager">
            <h1><Wallet size={28} style={{ marginRight: 12, verticalAlign: 'middle' }} />{t('sidebar.expenses')}</h1>

            {/* Stats Cards */}
            <div className="expense-stats">
                <div className="stat-card">
                    <div className="stat-label">{t('expenses.stats7d')}</div>
                    <div className="stat-value">{formatCurrency(totals.total7D)}</div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">{t('expenses.stats1m')}</div>
                    <div className="stat-value">{formatCurrency(totals.total1M)}</div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">{t('expenses.stats6m')}</div>
                    <div className="stat-value">{formatCurrency(totals.total6M)}</div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">{t('expenses.stats1y')}</div>
                    <div className="stat-value">{formatCurrency(totals.total1Y)}</div>
                </div>
            </div>

            {/* Add Expense Form */}
            <div className="expense-form-section">
                <h2>{t('expenses.add')}</h2>
                <form className="expense-form" onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label>{t('expenses.name')}</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={t('expenses.placeholderName')}
                            required
                        />
                    </div>
                    <div className="form-group">
                        <label>{t('expenses.amount')} (DZD)</label>
                        <input
                            type="number"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            placeholder="0.00"
                            min="0"
                            step="0.01"
                            required
                        />
                    </div>
                    <button type="submit" disabled={loading}>
                        {loading ? t('expenses.adding') : t('common.save')}
                    </button>
                </form>
            </div>

            {/* Expense History */}
            <div className="expense-history">
                <h2>{t('expenses.history')}</h2>
                {expenses.length === 0 ? (
                    <div className="empty-state">{t('expenses.noExpenses')}</div>
                ) : (
                    <table className="expense-table">
                        <thead>
                            <tr>
                                <th>{t('expenses.name')}</th>
                                <th>{t('expenses.amount')}</th>
                                <th>{t('expenses.date')}</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {expenses.map((expense: Expense) => (
                                <tr key={expense.id}>
                                    <td>{expense.name}</td>
                                    <td className="amount">{formatCurrency(expense.amount)}</td>
                                    <td className="date">{formatDate(expense.created_at)}</td>
                                    <td>
                                        <button
                                            className="delete-btn"
                                            onClick={() => handleDelete(expense.id)}
                                            title={t('common.delete')}
                                        >
                                            <Trash2 size={18} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    )
}
