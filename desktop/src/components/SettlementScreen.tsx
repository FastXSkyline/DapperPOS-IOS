import React, { useState, useEffect } from 'react'
import { Printer, FileText, ChevronDown, ChevronUp } from 'lucide-react'
import { useLanguage } from '../LanguageContext'
import './POSScreen.css'

export function SettlementScreen() {
    const { t } = useLanguage()
    const [orders, setOrders] = useState<any[]>([])
    const [suppliers, setSuppliers] = useState<any[]>([])
    const [selectedSupplier, setSelectedSupplier] = useState<string>('')
    const [expandedOrder, setExpandedOrder] = useState<number | null>(null)

    useEffect(() => {
        const fetchData = async () => {
            const [allOrders, allSuppliers] = await Promise.all([
                window.electron.purchaseOrder.getAll(),
                window.electron.supplier.getAll()
            ])
            setOrders(allOrders)
            setSuppliers(allSuppliers)
        }
        fetchData()
    }, [])

    const filteredOrders = orders.filter(o => {
        const matchesSupplier = !selectedSupplier || o.supplier_name === selectedSupplier
        return matchesSupplier
    })

    const handlePrintYearlySettlement = async () => {
        await window.electron.report.printYearlySettlement(selectedSupplier || undefined)
    }

    return (
        <div className="el-page">
            <div className="el-page-head">
                <div>
                    <h1 className="el-page-title">{t('settlement.title')}</h1>
                </div>
                <div className="el-page-actions">
                    <select
                        className="el-pill"
                        value={selectedSupplier}
                        onChange={(e) => setSelectedSupplier(e.target.value)}
                        aria-label={t('settlement.selectSupplier')}
                    >
                        <option value="">{t('settlement.selectSupplier')}</option>
                        {suppliers.map(s => (
                            <option key={s.id} value={s.company_name}>{s.company_name}</option>
                        ))}
                    </select>
                    <button className="el-btn el-btn--primary" onClick={handlePrintYearlySettlement}>
                        <FileText size={16} />
                        {t('settlement.yearlyReport')}
                    </button>
                </div>
            </div>

            <section className="el-card el-card--pad0">
                <table className="el-table">
                    <thead>
                        <tr>
                            <th>{t('settlement.date')}</th>
                            <th>REF</th>
                            <th>{t('settlement.supplier')}</th>
                            <th style={{ textAlign: 'right' }}>{t('settlement.amount')}</th>
                            <th style={{ textAlign: 'center' }}>{t('common.actions')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filteredOrders.length === 0 ? (
                            <tr><td colSpan={5} className="el-empty">{t('settlement.noSettlements')}</td></tr>
                        ) : (
                            filteredOrders.map(order => (
                                <React.Fragment key={order.id}>
                                    <tr className="el-ripple">
                                        <td>{new Date(order.created_at).toLocaleDateString()}</td>
                                        <td><span className="tabular" style={{ fontWeight: 700, color: 'var(--accent)' }}>{order.po_number}</span></td>
                                        <td>{order.supplier_name}</td>
                                        <td className="tabular" style={{ textAlign: 'right', fontWeight: 800 }}>{order.total_amount.toFixed(2)} DZD</td>
                                        <td style={{ textAlign: 'center' }}>
                                            <div style={{ display: 'inline-flex', gap: '10px' }}>
                                                <button
                                                    className="el-stat-more"
                                                    onClick={() => window.electron.purchaseOrder.print(order.id)}
                                                    title={t('common.print')}
                                                >
                                                    <Printer size={16} />
                                                </button>
                                                <button
                                                    className="el-stat-more"
                                                    onClick={() => setExpandedOrder(expandedOrder === order.id ? null : order.id)}
                                                >
                                                    {expandedOrder === order.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                    {expandedOrder === order.id && (
                                        <tr>
                                            <td colSpan={5} style={{ padding: '0 14px 14px' }}>
                                                <div style={{ background: 'var(--surface-2)', borderRadius: '10px', padding: '15px', border: '1px solid var(--separator)' }}>
                                                    <OrderItemsTable orderId={order.id} />
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            ))
                        )}
                    </tbody>
                </table>
            </section>
        </div>
    )
}



function OrderItemsTable({ orderId }: { orderId: number }) {
    const [items, setItems] = useState<any[]>([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        const fetchItems = async () => {
            const data = await window.electron.purchaseOrder.getById(orderId)
            setItems(data.items || [])
            setLoading(false)
        }
        fetchItems()
    }, [orderId])

    if (loading) return <div style={{ textAlign: 'center', padding: '10px' }}>Chargement...</div>

    return (
        <table style={{ width: '100%', fontSize: '13px' }}>
            <thead>
                <tr style={{ color: 'var(--text-muted)' }}>
                    <th style={{ textAlign: 'left', padding: '5px' }}>Produit</th>
                    <th style={{ textAlign: 'center', padding: '5px' }}>Quantité</th>
                    <th style={{ textAlign: 'right', padding: '5px' }}>P.U</th>
                    <th style={{ textAlign: 'right', padding: '5px' }}>Total</th>
                </tr>
            </thead>
            <tbody>
                {items.map(item => (
                    <tr key={item.id}>
                        <td style={{ padding: '5px', fontWeight: '600' }}>{item.product_name}</td>
                        <td style={{ textAlign: 'center', padding: '5px' }}>{item.quantity_ordered}</td>
                        <td style={{ textAlign: 'right', padding: '5px' }}>{item.unit_cost.toFixed(2)}</td>
                        <td style={{ textAlign: 'right', padding: '5px', fontWeight: 'bold' }}>{item.total_cost.toFixed(2)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}
