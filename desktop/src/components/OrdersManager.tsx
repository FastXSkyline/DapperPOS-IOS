import { useState, useEffect } from 'react'
import {
    Plus,
    Search,
    Printer,
    Eye,
    Trash2,
    Truck,
    Package,
    Calendar,
    FileText,
    CheckCircle2,
    Clock
} from 'lucide-react'
import { useLanguage } from '../LanguageContext'
import { formatCurrency, formatDateTime } from '../utils/formatters'
import type { VariantWithStock } from '../vite-env'
import type { Product } from '../../shared/types'
import './OrdersManager.css'

/** A line being composed in the create-order modal. variantId is null for a plain
 *  product; a garment carries the specific size×colour so reception restocks it. */
interface POCartLine {
    productId: number
    variantId: number | null
    name: string
    sku: string | null
    unitCost: number
    quantity: number
}

interface Order {
    id: number
    po_number: string
    supplier_id: number
    supplier_name: string
    status: string
    subtotal: number
    total_amount: number
    created_at: string
}

export function OrdersManager() {
    const { t } = useLanguage()
    const [orders, setOrders] = useState<Order[]>([])
    const [loading, setLoading] = useState(true)
    const [searchTerm, setSearchTerm] = useState('')
    const [showCreateModal, setShowCreateModal] = useState(false)

    // Form State
    const [suppliers, setSuppliers] = useState<any[]>([])
    const [products, setProducts] = useState<Product[]>([])
    const [selectedSupplier, setSelectedSupplier] = useState<number | null>(null)
    const [cart, setCart] = useState<POCartLine[]>([])
    const [notes, setNotes] = useState('')
    const [productSearch, setProductSearch] = useState('')
    // Pending size/colour choice when adding a garment to the order.
    const [variantPick, setVariantPick] = useState<{ product: Product; variants: VariantWithStock[] } | null>(null)

    useEffect(() => {
        loadOrders()
        loadSuppliers()
        loadProducts()
    }, [])

    const loadOrders = async () => {
        try {
            const data = await window.electron.purchaseOrder.getAll()
            setOrders(data)
        } catch (error) {
            console.error('Failed to load orders:', error)
        } finally {
            setLoading(false)
        }
    }

    const loadSuppliers = async () => {
        const data = await window.electron.supplier.getAll()
        setSuppliers(data)
    }

    const loadProducts = async () => {
        const data = await window.electron.product.getAll()
        setProducts(data)
    }

    const handlePrint = async (orderId: number) => {
        try {
            await window.electron.purchaseOrder.print(orderId)
        } catch (error) {
            console.error('Failed to print order:', error)
        }
    }

    const handleReceive = async (orderId: number) => {
        if (!confirm(t('orders.confirmReceive'))) return

        try {
            const result = await window.electron.purchaseOrder.receive(orderId, 1) // Using 1 as dummy userId
            if (result.success) {
                loadOrders()
            } else {
                alert(result.error || 'Réception de la commande impossible.')
            }
        } catch (error) {
            console.error('Failed to receive order:', error)
            alert('Erreur lors de la réception.')
        }
    }

    // Cart lines are identified by product AND variant: ordering 10 M and 10 L of the
    // same shirt is two lines, and each must restock its own size.
    const lineKey = (productId: number, variantId: number | null) => `${productId}:${variantId ?? ''}`

    const addLine = (product: Product, variant: VariantWithStock | null) => {
        const variantId = variant?.id ?? null
        const key = lineKey(product.id, variantId)
        const existing = cart.find(item => lineKey(item.productId, item.variantId ?? null) === key)
        if (existing) {
            setCart(cart.map(item =>
                lineKey(item.productId, item.variantId ?? null) === key
                    ? { ...item, quantity: item.quantity + 1 }
                    : item
            ))
        } else {
            const label = variant ? [variant.size, variant.color].filter(Boolean).join(' / ') : ''
            setCart([...cart, {
                productId: product.id,
                variantId,
                name: label ? `${product.name} (${label})` : product.name,
                sku: variant?.sku || product.sku,
                unitCost: variant?.cost_price ?? product.cost_price ?? 0,
                quantity: 1
            }])
        }
    }

    const addToCart = async (product: Product) => {
        // A garment can't be restocked without saying which size/colour arrived.
        if (product.has_variants) {
            const variants = await window.electron.product.getVariants(product.id)
            if (variants.length) {
                setVariantPick({ product, variants })
                return
            }
        }
        addLine(product, null)
    }

    const removeFromCart = (key: string) => {
        setCart(cart.filter(item => lineKey(item.productId, item.variantId ?? null) !== key))
    }

    const updateQuantity = (key: string, qty: number) => {
        setCart(cart.map(item =>
            lineKey(item.productId, item.variantId ?? null) === key ? { ...item, quantity: Math.max(1, qty) } : item
        ))
    }

    const handleSubmitOrder = async () => {
        if (!selectedSupplier || cart.length === 0) return

        try {
            // userId is dummy for now, replace if you have session
            const result = await window.electron.purchaseOrder.create({
                userId: 1,
                supplierId: selectedSupplier,
                items: cart,
                notes
            })

            if (result.id) {
                setShowCreateModal(false)
                setCart([])
                setSelectedSupplier(null)
                setNotes('')
                loadOrders()
                // Automatic preview after creation
                handlePrint(result.id)
            }
        } catch (error) {
            console.error('Failed to create order:', error)
            alert('Création de la commande impossible.')
        }
    }

    const totalAmount = cart.reduce((sum, item) => sum + (item.unitCost * item.quantity), 0)

    const filteredOrders = orders.filter(o =>
        o.po_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
        o.supplier_name.toLowerCase().includes(searchTerm.toLowerCase())
    )

    const filteredProducts = products.filter(p =>
        p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
        (p.sku && p.sku.toLowerCase().includes(productSearch.toLowerCase()))
    )

    return (
        <div className="orders-manager">
            <div className="manager-header">
                <div className="header-info">
                    <h1>{t('orders.title')}</h1>
                    <p>{t('orders.description')}</p>
                </div>
                <div className="header-actions">
                    <div className="search-box">
                        <Search size={18} />
                        <input
                            type="text"
                            placeholder={t('common.search')}
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </div>
                    <button className="btn-add" onClick={() => setShowCreateModal(true)}>
                        <Plus size={18} />
                        <span>{t('orders.newOrder')}</span>
                    </button>
                </div>
            </div>

            <div className="orders-list-container">
                {loading ? (
                    <div className="loading-state">{t('common.loading')}</div>
                ) : filteredOrders.length === 0 ? (
                    <div className="empty-state">
                        <Package size={48} />
                        <p>{t('orders.noOrders')}</p>
                    </div>
                ) : (
                    <div className="orders-grid">
                        {filteredOrders.map(order => (
                            <div key={order.id} className="order-card">
                                <div className="card-top">
                                    <div className="order-badge">
                                        <FileText size={14} />
                                        <span>{order.po_number}</span>
                                    </div>
                                    <div className={`status-chip ${order.status}`}>
                                        {order.status === 'received' ? <CheckCircle2 size={12} /> : <Clock size={12} />}
                                        {order.status === 'received' ? t('orders.received') : t('orders.pending')}
                                    </div>
                                </div>
                                <div className="card-supplier">
                                    <Truck size={16} />
                                    <span>{order.supplier_name}</span>
                                </div>
                                <div className="card-meta">
                                    <div className="meta-item">
                                        <Calendar size={14} />
                                        <span>{formatDateTime(order.created_at)}</span>
                                    </div>
                                    <div className="meta-amount">
                                        {formatCurrency(order.total_amount)}
                                    </div>
                                </div>
                                <div className="card-actions">
                                    <button className="btn-preview" onClick={() => handlePrint(order.id)}>
                                        <Eye size={16} />
                                        <span>{t('orders.preview')}</span>
                                    </button>
                                    {order.status === 'pending' && (
                                        <button className="btn-receive" onClick={() => handleReceive(order.id)}>
                                            <CheckCircle2 size={16} />
                                            <span>{t('orders.confirm')}</span>
                                        </button>
                                    )}
                                    <button className="btn-print-mini" onClick={() => handlePrint(order.id)}>
                                        <Printer size={16} />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Create Order Modal */}
            {showCreateModal && (
                <div className="modal-overlay">
                    <div className="order-modal">
                        <div className="modal-header">
                            <h2>{t('orders.newOrder')}</h2>
                            <button className="close-btn" onClick={() => setShowCreateModal(false)}>×</button>
                        </div>

                        <div className="modal-body">
                            <div className="form-section">
                                <label>{t('orders.selectSupplier')}</label>
                                <select
                                    className="supplier-select"
                                    value={selectedSupplier || ''}
                                    onChange={(e) => setSelectedSupplier(Number(e.target.value))}
                                >
                                    <option value="">-- {t('orders.selectSupplier')} --</option>
                                    {suppliers.map(s => (
                                        <option key={s.id} value={s.id}>{s.company_name}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="split-view">
                                <div className="product-picker">
                                    <div className="picker-search">
                                        <Search size={16} />
                                        <input
                                            type="text"
                                            placeholder={t('inventory.searchPlaceholder')}
                                            value={productSearch}
                                            onChange={(e) => setProductSearch(e.target.value)}
                                        />
                                    </div>
                                    <div className="picker-results">
                                        {filteredProducts.map(p => (
                                            <div key={p.id} className="picker-item" onClick={() => addToCart(p)}>
                                                <div className="item-info">
                                                    <span className="item-name">{p.name}</span>
                                                    <span className="item-sku">{p.sku}</span>
                                                </div>
                                                <Plus size={16} />
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div className="cart-view">
                                    <h3>{t('orders.items')}</h3>
                                    <div className="cart-items">
                                        {cart.length === 0 ? (
                                            <p className="empty-cart">{t('orders.noItems')}</p>
                                        ) : (
                                            cart.map(item => {
                                                const key = lineKey(item.productId, item.variantId ?? null)
                                                return (
                                                    <div key={key} className="cart-item">
                                                        <div className="item-details">
                                                            <span className="name">{item.name}</span>
                                                            <span className="cost">{formatCurrency(item.unitCost)} / unit</span>
                                                        </div>
                                                        <div className="item-controls">
                                                            <input
                                                                type="number"
                                                                value={item.quantity}
                                                                onChange={(e) => updateQuantity(key, Number(e.target.value))}
                                                            />
                                                            <button className="btn-remove" onClick={() => removeFromCart(key)}>
                                                                <Trash2 size={14} />
                                                            </button>
                                                        </div>
                                                    </div>
                                                )
                                            })
                                        )}
                                    </div>
                                    <div className="cart-footer">
                                        <div className="cart-total">
                                            <span>{t('orders.total')}</span>
                                            <strong>{formatCurrency(totalAmount)}</strong>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="form-section">
                                <label>{t('orders.notes')}</label>
                                <textarea
                                    id="order-notes"
                                    placeholder={t('orders.notesPlaceholder')}
                                    value={notes}
                                    onChange={(e) => setNotes(e.target.value)}
                                />
                            </div>
                        </div>

                        <div className="modal-footer">
                            <button className="btn-cancel" onClick={() => setShowCreateModal(false)}>{t('common.cancel')}</button>
                            <button
                                className="btn-confirm"
                                disabled={!selectedSupplier || cart.length === 0}
                                onClick={handleSubmitOrder}
                            >
                                <FileText size={18} />
                                <span>{t('orders.createProfessional')}</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {variantPick && (
                <div className="variant-pick-overlay" onClick={() => setVariantPick(null)}>
                    <div className="variant-pick" onClick={(e) => e.stopPropagation()}>
                        <h3>{variantPick.product.name}</h3>
                        <p>Quelle taille / couleur commander ?</p>
                        <div className="variant-pick-list">
                            {/* Every combination stays selectable — being out of stock is
                                exactly the reason to reorder one. */}
                            {variantPick.variants.map(v => (
                                <button
                                    key={v.id}
                                    type="button"
                                    onClick={() => {
                                        addLine(variantPick.product, v)
                                        setVariantPick(null)
                                    }}
                                >
                                    <span>{[v.size, v.color].filter(Boolean).join(' / ') || '—'}</span>
                                    <small>{v.stock_quantity} en stock</small>
                                </button>
                            ))}
                        </div>
                        <div className="variant-pick-actions">
                            <button type="button" onClick={() => setVariantPick(null)}>{t('common.cancel')}</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
