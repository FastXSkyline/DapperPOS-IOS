import { useState, useEffect, useRef } from 'react'
import type { Customer, TransactionItem } from '../../shared/types'
import './PaymentModal.css'
import { Ruler, AlertTriangle } from 'lucide-react'

interface PaymentModalProps {
    transactionId: number
    total: number
    customer: Customer | null
    /** What the cashier already chose on the till before opening this dialog.
     *  Carrying it through is the point of the choice being on the cart at all —
     *  otherwise the segmented control is decoration and the method is picked
     *  twice. */
    initialMethod?: string
    onComplete: (debtDueDate?: string, customerNameOverride?: string) => void
    onClose: () => void
}

export function PaymentModal({ transactionId, total, customer, initialMethod, onComplete, onClose }: PaymentModalProps) {
    const [selectedMethod, setSelectedMethod] = useState(initialMethod || 'cash')
    const [amountTendered, setAmountTendered] = useState(total.toString())
    const [payments, setPayments] = useState<{ method: string; amount: number }[]>([])
    const [referenceNumber, setReferenceNumber] = useState('')
    const [debtDueDate, setDebtDueDate] = useState<string>('')
    const [newCustomerName, setNewCustomerName] = useState('')
    const [newCustomerPhone, setNewCustomerPhone] = useState('')
    const [customerNameOverride, setCustomerNameOverride] = useState('')
    const [items, setItems] = useState<TransactionItem[]>([])
    const [currentTotal, setCurrentTotal] = useState(total)
    const [currentTax, setCurrentTax] = useState(0)
    const [amlThreshold, setAmlThreshold] = useState(0)
    const [cashRounding, setCashRounding] = useState(false)
    const [localQtys, setLocalQtys] = useState<Record<number, string>>({})
    // A refused sale has to stop the flow visibly. `submitting` also blocks the
    // double-click that used to complete the same sale twice.
    const [submitting, setSubmitting] = useState(false)
    const [failure, setFailure] = useState<{ code: string; message: string } | null>(null)
    // A ref, not state: it must be readable synchronously inside handleComplete,
    // and changing it must never trigger a re-render mid-submit.
    const paymentsRecorded = useRef(false)

    useEffect(() => {
        const loadItems = async () => {
            const data = await window.electron.transaction.getItems(transactionId)
            setItems(data)
            const initialQtys: Record<number, string> = {}
            data.forEach(item => {
                initialQtys[item.id] = item.quantity.toString()
            })
            setLocalQtys(initialQtys)
            const txn = await window.electron.transaction.getById(transactionId)
            if (txn) {
                setCurrentTotal(txn.total_amount)
                setCurrentTax(txn.tax_amount || 0)
            }
        }
        loadItems()
        window.electron?.config?.get('aml_cash_threshold').then(v => setAmlThreshold(Number(v) || 0)).catch(() => {})
        window.electron?.config?.get('cash_rounding_5').then(v => setCashRounding(v === '1')).catch(() => {})
    }, [transactionId])

    const amlWarn = selectedMethod === 'cash' && amlThreshold > 0 && currentTotal >= amlThreshold

    // Cut-to-length entry, for goods actually sold by the metre (fabric, ribbon).
    // Phase 4: was hardcoded to product names containing "cable"/"tube" — an artefact
    // of the electrical-supplies origin. Keyed off the line's unit instead, so it
    // never appears for ready-to-wear and still works if metre goods are stocked.
    const portionItems = items.filter(item => item.unit === 'metre')

    const handleQuantityChange = async (itemId: number, rawVal: string) => {
        // Allow typing dots and commas
        const normalizedVal = rawVal.replace(',', '.')
        setLocalQtys(prev => ({ ...prev, [itemId]: normalizedVal }))

        const num = parseFloat(normalizedVal)
        if (!isNaN(num)) {
            await window.electron.transaction.updateItemQuantity(itemId, num)
            const updatedItems = await window.electron.transaction.getItems(transactionId)
            setItems(updatedItems)

            // Refresh total from transaction
            const txn = await window.electron.transaction.getById(transactionId)
            if (txn) {
                setCurrentTotal(txn.total_amount)
                setCurrentTax(txn.tax_amount || 0)
                setAmountTendered(txn.total_amount.toString())
            }
        }
    }

    const paidAmount = payments.reduce((sum: number, p: { amount: number }) => sum + p.amount, 0)
    const remaining = currentTotal - paidAmount
    const effectiveAmount = selectedMethod === 'cash' ? (parseFloat(amountTendered) || 0) : remaining
    const changeDue = selectedMethod === 'cash' ? Math.max(0, effectiveAmount - remaining) : 0

    const isCreditSale = (remaining - effectiveAmount) > 0.01 // Use small epsilon for float comparison
    const isFullCredit = Math.abs(remaining - currentTotal) < 0.01 && effectiveAmount === 0 && payments.length === 0

    const handleAddPayment = () => {
        if (effectiveAmount <= 0) return

        setPayments([...payments, { method: selectedMethod, amount: Math.min(effectiveAmount, remaining) }])
        setAmountTendered('')
        setReferenceNumber('')
    }

    const handleRemovePayment = (index: number) => {
        setPayments(payments.filter((_, i: number) => i !== index))
    }

    const handleComplete = async () => {
        let finalCustomerId = customer?.id

        // If it's a credit sale and we have new customer info, create them
        if ((isCreditSale || isFullCredit) && !hasValidCustomer && newCustomerName) {
            const result = await window.electron.customer.create({
                name: newCustomerName,
                phone: newCustomerPhone,
                customer_type: 'retail'
            })
            finalCustomerId = result.lastInsertRowid as number

            await window.electron.transaction.setCustomer(transactionId, finalCustomerId ?? null).catch(e => console.error('Link customer failed:', e))
        }

        // Payments are written ONCE per transaction, even across retries.
        //
        // Completion can now be refused (insufficient stock), which makes a second
        // attempt possible for the first time. Without this flag the retry would
        // insert the same payments again, and the sale would report as paid twice —
        // a money bug created by making the stock path safe.
        if (!paymentsRecorded.current) {
            for (const p of payments) {
                await window.electron.transaction.addPayment({ transactionId, method: p.method, amount: p.amount })
            }

            // Add any remaining current amount
            const finalBalance = currentTotal - paidAmount
            if (finalBalance > 0 && effectiveAmount > 0) {
                const amountToPay = selectedMethod === 'cash' ? Math.min(effectiveAmount, finalBalance) : finalBalance
                await window.electron.transaction.addPayment({
                    transactionId,
                    method: selectedMethod,
                    amount: amountToPay,
                    referenceNumber: referenceNumber || undefined
                })
            }
            paymentsRecorded.current = true
        }

        const result = await window.electron.transaction.complete({
            transactionId,
            debtDueDate,
            customerNameOverride: customerNameOverride || undefined
        })

        // The sale is only done if the main process says so. Calling onComplete() on a
        // refusal would print a receipt for goods that never left stock.
        if (!result.ok) {
            setFailure({ code: result.code, message: result.message })
            return
        }

        onComplete(debtDueDate || undefined, customerNameOverride || undefined)
    }

    // Payments are already recorded against the transaction by the time completion is
    // attempted, so a refusal leaves the sale PENDING with its payments intact — the
    // cashier fixes the cart and retries rather than starting over.
    const submit = async () => {
        if (submitting) return
        setSubmitting(true)
        setFailure(null)
        try {
            await handleComplete()
        } catch (e) {
            console.error('[PaymentModal] completion failed:', e)
            setFailure({ code: 'UNEXPECTED_ERROR', message: 'Le paiement n’a pas pu être finalisé. Réessayez.' })
        } finally {
            setSubmitting(false)
        }
    }

    const quickAmounts = [10, 20, 50, 100, 200, 500, 1000, 2000]

    // Validation
    const needsCustomer = isCreditSale || isFullCredit
    const hasValidCustomer = customer && customer.id !== 1 // Not "Walk-in"
    const hasNewCustomerInfo = newCustomerName.length >= 3
    const hasDueDate = !needsCustomer || debtDueDate !== ''

    const canComplete = (paidAmount >= total || (effectiveAmount >= remaining && selectedMethod === 'cash') || (selectedMethod !== 'cash' && remaining <= 0)) || (needsCustomer && (hasValidCustomer || hasNewCustomerInfo) && hasDueDate)

    return (
        <div className="payment-modal-overlay">
            <div className="payment-modal">
                <div className="payment-header">
                    <h2>Paiement</h2>
                    <button className="btn-close" onClick={onClose}>×</button>
                </div>

                <div className="payment-content-scroll">
                    <div className="payment-grid">
                        <div className="payment-left-side">
                            {portionItems.length > 0 && (
                                <div className="portion-measurements">
                                    <div className="section-title">
                                        <Ruler size={16} />
                                        <span>Articles vendus au mètre</span>
                                    </div>
                                    <div className="portion-grid">
                                        {portionItems.map(item => (
                                            <div key={item.id} className="portion-item">
                                                <div className="portion-info">
                                                    <span className="name">{item.product_name}</span>
                                                    <span className="price">{item.unit_price.toFixed(2)} DZD/m</span>
                                                </div>
                                                <div className="portion-input-wrapper">
                                                    <input
                                                        type="text"
                                                        className="portion-qty-input"
                                                        value={localQtys[item.id] || ''}
                                                        onChange={(e) => handleQuantityChange(item.id, e.target.value)}
                                                        placeholder="0.00"
                                                    />
                                                    <span className="unit">m</span>
                                                </div>
                                                <div className="portion-line-total">
                                                    {(item.unit_price * (parseFloat(localQtys[item.id]) || 0)).toFixed(2)} DZD
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="payment-summary-card">
                                <div className="summary-row">
                                    <span>Total à Payer</span>
                                    <span className="total-due">{currentTotal.toFixed(2)} DZD</span>
                                </div>
                                {currentTax > 0 && (
                                    <div className="summary-row">
                                        <span>dont TVA</span>
                                        <span>{currentTax.toFixed(2)} DZD</span>
                                    </div>
                                )}
                                {paidAmount > 0 && (
                                    <div className="summary-row paid">
                                        <span>Déjà Payé</span>
                                        <span>-{paidAmount.toFixed(2)} DZD</span>
                                    </div>
                                )}
                                <div className="summary-row remaining">
                                    <span>Reste à Payer</span>
                                    <span>{Math.max(0, remaining).toFixed(2)} DZD</span>
                                </div>
                            </div>

                            <div className="custom-name-section">
                                <label>Nom du Client (Optionnel)</label>
                                <input
                                    type="text"
                                    value={customerNameOverride}
                                    onChange={(e) => setCustomerNameOverride(e.target.value)}
                                    placeholder="Ex: Ahmed Ben"
                                />
                            </div>
                        </div>

                        <div className="payment-right-side">
                            <div className="payment-main-inputs">
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
                                    {([['cash', 'Espèces'], ['cheque', 'Chèque'], ['virement', 'Virement'], ['ccp', 'CCP'], ['cib', 'CIB'], ['edahabia', 'Edahabia']] as const).map(([val, label]) => (
                                        <button
                                            key={val}
                                            type="button"
                                            onClick={() => setSelectedMethod(val)}
                                            style={{
                                                padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--border-light)', cursor: 'pointer',
                                                background: selectedMethod === val ? 'var(--accent)' : 'var(--surface)',
                                                color: selectedMethod === val ? 'var(--text-on-accent)' : 'var(--text-main)', fontWeight: 600, fontSize: '0.85rem'
                                            }}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>

                                {amlWarn && (
                                    <div role="alert" style={{ background: 'color-mix(in srgb, var(--warning) 16%, transparent)', border: '1px solid var(--warning)', borderRadius: '8px', padding: '8px 10px', marginBottom: '10px', fontSize: '0.82rem', color: 'var(--text-main)' }}>
                                        ⚠️ Montant élevé en espèces ({currentTotal.toLocaleString()} DZD). Un paiement scriptural (chèque/virement) est recommandé/requis (Décret 15-153).
                                    </div>
                                )}

                                {selectedMethod !== 'cash' && (
                                    <div className="payment-amount">
                                        <label>Référence / N° {selectedMethod}</label>
                                        <div className="amount-input-container">
                                            <input
                                                type="text"
                                                value={referenceNumber}
                                                onChange={(e) => setReferenceNumber(e.target.value)}
                                                placeholder="N° chèque / virement / bordereau"
                                            />
                                        </div>
                                    </div>
                                )}

                                {selectedMethod === 'cash' && (
                                    <div className="payment-amount">
                                        <label>Montant Reçu (Espèces)</label>
                                        <div className="amount-input-container">
                                            <input
                                                type="text" // Changed to text to allow comma/dot typing
                                                value={amountTendered}
                                                onChange={(e) => setAmountTendered(e.target.value.replace(',', '.'))}
                                                placeholder="0.00"
                                                autoFocus
                                            />
                                            <span className="currency">DZD</span>
                                        </div>
                                    </div>
                                )}

                                {changeDue > 0 && (
                                    <div className="change-due-banner">
                                        <span>Monnaie à rendre:</span>
                                        <strong>{changeDue.toFixed(2)} DZD</strong>
                                    </div>
                                )}

                                <div className="quick-amounts-grid">
                                    {quickAmounts.map(amount => (
                                        <button key={amount} onClick={() => setAmountTendered(amount.toString())}>
                                            {amount}
                                        </button>
                                    ))}
                                    {cashRounding && (
                                        <button title="Arrondi à 5 DA" onClick={() => setAmountTendered(String(Math.round(remaining / 5) * 5))}>
                                            ⌁ 5 DA
                                        </button>
                                    )}
                                </div>

                                {payments.length > 0 && (
                                    <div className="added-payments-list">
                                        {payments.map((p, i) => (
                                            <div key={i} className="compact-added-payment">
                                                <span>{p.method}: {p.amount.toFixed(2)} DZD</span>
                                                <button onClick={() => handleRemovePayment(i)}>×</button>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {needsCustomer && (
                                    <div className={`customer-credit-config ${hasValidCustomer ? 'valid' : 'active'}`}>
                                        {!hasValidCustomer ? (
                                            <div className="credit-customer-warning">
                                                <span className="icon">💳</span>
                                                <div className="msg">
                                                    <strong>Vente à Crédit</strong>
                                                    <p>Veuillez identifier le client</p>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="credit-customer-info">
                                                <span>Client: <strong>{customer?.name}</strong></span>
                                            </div>
                                        )}

                                        {!hasValidCustomer && (
                                            <div className="new-customer-compact">
                                                <input
                                                    type="text"
                                                    value={newCustomerName}
                                                    onChange={(e) => setNewCustomerName(e.target.value)}
                                                    placeholder="Nom du nouveau client..."
                                                />
                                                <input
                                                    type="tel"
                                                    value={newCustomerPhone}
                                                    onChange={(e) => setNewCustomerPhone(e.target.value)}
                                                    placeholder="Téléphone (Optionnel)"
                                                />
                                            </div>
                                        )}

                                        <div className="due-date-compact">
                                            <label>Date limite de paiement:</label>
                                            <input
                                                type="date"
                                                value={debtDueDate}
                                                onChange={(e) => setDebtDueDate(e.target.value)}
                                                min={new Date().toISOString().split('T')[0]}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {failure && (
                    <div className="payment-failure" role="alert">
                        <AlertTriangle size={18} />
                        <div>
                            <strong>
                                {failure.code === 'INSUFFICIENT_STOCK'
                                    ? 'Stock insuffisant — vente non enregistrée'
                                    : 'La vente n’a pas été enregistrée'}
                            </strong>
                            <p>{failure.message}</p>
                            {failure.code === 'INSUFFICIENT_STOCK' && (
                                <p className="payment-failure-hint">
                                    Un autre poste a peut-être vendu le dernier article. Retirez-le du
                                    panier ou ajustez la quantité, puis réessayez. Les paiements déjà
                                    saisis sont conservés.
                                </p>
                            )}
                        </div>
                    </div>
                )}

                <div className="payment-actions">
                    {remaining > effectiveAmount && effectiveAmount > 0 && selectedMethod === 'cash' && (
                        <button className="btn-add-payment" onClick={handleAddPayment}>
                            Ajouter un Paiement Partiel
                        </button>
                    )}
                    <button
                        className={`btn-complete ${needsCustomer && !hasValidCustomer ? 'disabled' : ''}`}
                        onClick={submit}
                        disabled={!canComplete || submitting}
                    >
                        {submitting
                            ? 'Enregistrement…'
                            : `${isCreditSale || isFullCredit ? 'Terminer Vente à Crédit' : 'Terminer la Vente'} (${Math.min(remaining, effectiveAmount || remaining).toFixed(2)} DZD)`}
                    </button>
                </div>
            </div>
        </div>
    )
}
