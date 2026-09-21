import { useState, useEffect } from 'react'
import { TransactionService, type HeldTransaction } from '../../electron/transactionService'
import './HeldTransactions.css'

interface HeldTransactionsProps {
    userId: number
    onRetrieve: (items: any[], customerId?: number) => void
    onClose: () => void
}

export function HeldTransactions({ onRetrieve, onClose }: HeldTransactionsProps) {
    const [holds, setHolds] = useState<HeldTransaction[]>([])

    useEffect(() => {
        setHolds(TransactionService.getHeldTransactions())
    }, [])

    const handleRetrieve = (hold: HeldTransaction) => {
        const items = JSON.parse(hold.items_json)
        TransactionService.retrieveHeldTransaction(hold.id)
        onRetrieve(items, hold.customer_id || undefined)
    }

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleString()
    }

    return (
        <div className="held-overlay">
            <div className="held-modal">
                <div className="held-header">
                    <h2>Held Transactions</h2>
                    <button className="btn-close" onClick={onClose}>×</button>
                </div>

                <div className="held-list">
                    {holds.length === 0 ? (
                        <div className="no-holds">No held transactions</div>
                    ) : (
                        holds.map(hold => (
                            <div key={hold.id} className="held-item" onClick={() => handleRetrieve(hold)}>
                                <div className="held-info">
                                    <div className="held-name">{hold.hold_name || `Hold #${hold.id}`}</div>
                                    <div className="held-date">{formatDate(hold.created_at)}</div>
                                </div>
                                <div className="held-total">{hold.subtotal.toFixed(2)} DZD</div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}
