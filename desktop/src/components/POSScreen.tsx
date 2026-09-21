import { useState, useEffect, useCallback, useRef } from 'react'
import type { Product, TransactionItem, Customer, ReceiptData } from '../../shared/types'
import type { VariantWithStock } from '../vite-env'
import { PaymentModal } from './PaymentModal'
import { CustomerLookup } from './CustomerLookup'
import { ReceiptPreview } from './ReceiptPreview'
import {
    Search, User, X, Trash2, Minus, Plus, Shirt, LayoutGrid,
    PackageSearch, ShoppingBag, AlertTriangle,
} from 'lucide-react'
import { ProductThumb, productImageUrl } from './ProductThumb'
import { useLanguage } from '../LanguageContext'
import { formatDateTime, formatCurrency } from '../utils/formatters'
import './POSScreen.css'

interface POSScreenProps {
    userId: number
    /** Printed on the receipt as the vendeur. It used to be the literal string
     *  'Current User' — English, and on the paper the customer walks out with. */
    userName: string
}

export function POSScreen({ userId, userName }: POSScreenProps) {
    const { t } = useLanguage()
    // ... (State remains same)
    const [transaction, setTransaction] = useState<{ id: number; transaction_number: string } | null>(null)
    const [items, setItems] = useState<TransactionItem[]>([])
    const [products, setProducts] = useState<Product[]>([])
    const [search, setSearch] = useState('')
    const [customer, setCustomer] = useState<Customer | null>(null)
    const [showPayment, setShowPayment] = useState(false)
    const [showCustomerLookup, setShowCustomerLookup] = useState(false)
    const [showReceipt, setShowReceipt] = useState(false)
    const [lastReceiptData, setLastReceiptData] = useState<ReceiptData | null>(null)
    const [totals, setTotals] = useState<any>(null)
    const [stockWarnings, setStockWarnings] = useState<{ product_name: string; requested: number; available: number }[]>([])
    const [customerPrices, setCustomerPrices] = useState<Record<number, number>>({})
    // Pending size/colour choice for a garment on its way into the cart.
    const [variantPicker, setVariantPicker] = useState<{ product: Product; qty: number; variants: VariantWithStock[] } | null>(null)
    const searchRef = useRef<HTMLInputElement>(null)

    // --- Presentation (the mockup's till) ---
    const [categories, setCategories] = useState<{ id: number; name: string; image_path: string | null }[]>([])
    const [activeCategory, setActiveCategory] = useState<number | null>(null)
    /** productId -> primary photo file name. One IPC call for the whole grid;
     *  per-product lookups would be dozens of round-trips per keystroke. */
    const [imageMap, setImageMap] = useState<Record<number, string>>({})
    const [discountMode, setDiscountMode] = useState<'percent' | 'amount'>('percent')
    const [discountValue, setDiscountValue] = useState('')
    const [payMethod, setPayMethod] = useState<'cash' | 'card' | 'mixed'>('cash')

    useEffect(() => {
        window.electron?.category?.getAll?.()
            .then((cs: any[]) => setCategories(cs.map(c => ({
                id: c.id, name: c.name, image_path: c.image_path ?? null,
            }))))
            .catch(() => setCategories([]))
        window.electron?.product?.imageMap?.()
            .then(setImageMap)
            .catch(() => setImageMap({}))
    }, [])

    // ... (Effects remain same)

    useEffect(() => {
        const initTxn = async () => {
            try {
                if (!transaction) {
                    const txn = await window.electron.transaction.create(userId, null)
                    setTransaction(txn)
                }
            } catch (err) {
                console.error("Failed to init transaction", err)
            }
        }
        initTxn()
    }, [userId])

    useEffect(() => {
        const fetchProducts = async () => {
            const filters = {
                search: search || undefined,
                limit: 50
            }
            setProducts(await window.electron.product.getAll(filters))
        }
        fetchProducts()
    }, [search])

    const loadItems = useCallback(async () => {
        if (transaction) {
            const currentItems = await window.electron.transaction.getItems(transaction.id)
            setItems(currentItems)
            const currentTxn = await window.electron.transaction.getById(transaction.id)
            setTotals(currentTxn)
            try {
                setStockWarnings(await window.electron.transaction.checkStock(transaction.id))
            } catch {
                setStockWarnings([])
            }
        }
    }, [transaction])

    const [creditStatus, setCreditStatus] = useState<{ balance: number; limit: number; available: number; over: boolean } | null>(null)
    // Loyalty balance for the selected customer, redeemable as a discount on this sale.
    const [loyaltyPoints, setLoyaltyPoints] = useState(0)
    const [loyaltyCfg, setLoyaltyCfg] = useState<{ dinarPerPoint: number; minRedeem: number; enabled: boolean } | null>(null)
    const [loyaltyApplied, setLoyaltyApplied] = useState(0)

    // Load the selected customer's negotiated prices (grille tarifaire) + credit status.
    useEffect(() => {
        if (customer?.id && window.electron?.customer?.priceMap) {
            window.electron.customer.priceMap(customer.id).then(setCustomerPrices).catch(() => setCustomerPrices({}))
        } else {
            setCustomerPrices({})
        }
        if (customer?.id && window.electron?.loyalty) {
            window.electron.loyalty.balance(customer.id).then(setLoyaltyPoints).catch(() => setLoyaltyPoints(0))
            window.electron.loyalty.getConfig().then(setLoyaltyCfg).catch(() => setLoyaltyCfg(null))
        } else {
            setLoyaltyPoints(0)
        }
        if (customer?.id && window.electron?.ledger?.creditStatus) {
            window.electron.ledger.creditStatus(customer.id).then(setCreditStatus).catch(() => setCreditStatus(null))
        } else {
            setCreditStatus(null)
        }
    }, [customer])

    // Retail-only (Phase 4): a negotiated price for this customer, otherwise the shelf
    // price. Promotions and quantity breaks are applied server-side in addItem.
    const priceFor = (product: Product): number => {
        if (product?.id != null && customerPrices[product.id] != null) return customerPrices[product.id]
        return product.retail_price
    }

    /** Add one cart line. `variant` is the chosen size×colour, or null for a plain product. */
    const addLine = useCallback(async (product: Product, qty: number, variant: VariantWithStock | null) => {
        let currentTxn = transaction
        if (!currentTxn) {
            currentTxn = await window.electron.transaction.create(userId, null)
            setTransaction(currentTxn!)
        }

        if (!currentTxn) return // Safety check

        // Two sizes of the same shirt are different stock units, so a line is only the
        // "same line" when the variant matches too.
        const variantId = variant?.id ?? null
        const existing = items.find(i => i.product_id === product.id && (i.variant_id ?? null) === variantId)
        if (existing) {
            await window.electron.transaction.updateItemQuantity(existing.id, existing.quantity + qty)
        } else {
            const label = variant ? [variant.size, variant.color].filter(Boolean).join(' / ') : ''
            await window.electron.transaction.addItem({
                transactionId: currentTxn.id,
                productId: product.id,
                // Carries the size/colour onto the receipt and the printed document.
                productName: label ? `${product.name} (${label})` : product.name,
                quantity: qty,
                unitPrice: variant?.retail_price ?? priceFor(product),
                sku: variant?.sku ?? product.sku,
                variantId
            })
        }
        loadItems()
    }, [transaction, userId, items, loadItems, customer, customerPrices])

    const handleAddProduct = useCallback(async (product: Product, qty: number = 1) => {
        // Phase 1 uses one shared barcode per product, so a garment reaches the till
        // without a size/colour — ask for it before the line is created.
        if (product.has_variants) {
            const variants = await window.electron.product.getVariants(product.id)
            if (variants.length) {
                setVariantPicker({ product, qty, variants })
                return
            }
        }
        await addLine(product, qty, null)
    }, [addLine])

    useEffect(() => {
        loadItems()
    }, [loadItems])

    useEffect(() => {
        if (!window.electron?.ai) return
        const removeListener = window.electron.ai.onPOSAddProduct((product: Product) => {
            const qty = (product as any)?._qty
            handleAddProduct(product, typeof qty === 'number' && qty > 0 ? qty : 1)
        })
        return () => removeListener()
    }, [handleAddProduct])

    const handleBarcodeSearch = async (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && search.trim()) {
            let identifier = search.trim()
            let qty = 1

            // Regex for '2.5m' or 'Samsung 2.5m'
            const mMatch = identifier.match(/(.*?)\s*(\d*\.?\d+)m$/i)
            if (mMatch) {
                identifier = mMatch[1].trim() || '' // If empty, it means they just typed '2.5m'
                qty = parseFloat(mMatch[2])
            }

            // If identifier is empty and we have a quantity, maybe apply to the last item?
            // But let's keep it simple: if empty identifier, do nothing or searching for ""
            if (!identifier && items.length > 0) {
                // Apply to last added item
                const lastItem = items[0] // Assuming items are sorted by newest first in UI?
                handleUpdateQuantity(lastItem.id, qty)
                setSearch('')
                return
            }

            const product = await window.electron.product.getByBarcode(identifier)
            if (product) {
                // Routed through handleAddProduct so a scanned garment opens the
                // size/colour picker instead of silently adding an unspecified line.
                await handleAddProduct(product, qty)
                setSearch('')
            } else {
                // Optional: handle name search if barcode fails
            }
        }
    }

    // Global barcode listener for "Always Scannable" feel
    useEffect(() => {
        // Auto-focus on mount with slight delay to ensure DOM is ready
        const timer = setTimeout(() => {
            searchRef.current?.focus()
        }, 300)

        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            // Ignore focus steal if user is already typing in an input
            const target = e.target as HTMLElement
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                return
            }

            // Focus search box if user starts typing
            if (e.key.length === 1 || e.key === 'Enter') {
                searchRef.current?.focus()
            }
        }
        window.addEventListener('keydown', handleGlobalKeyDown)
        return () => {
            clearTimeout(timer)
            window.removeEventListener('keydown', handleGlobalKeyDown)
        }
    }, [])

    // The colisage / packaging-tier selector that used to live here is gone: it
    // came from the electrical-distributor domain, where a line could be "2.5 m of
    // cable". A boutique sells one shirt, and product.getUnits/setItemUnit remain
    // in the service layer for anything that still needs them.

    const handleUpdateQuantity = async (itemId: number, quantity: number) => {
        if (quantity <= 0) await window.electron.transaction.removeItem(itemId)
        else await window.electron.transaction.updateItemQuantity(itemId, quantity)
        loadItems()
    }

    const handleRemoveItem = async (itemId: number) => {
        await window.electron.transaction.removeItem(itemId)
        loadItems()
    }

    /** Spend the customer's points on this sale as a fixed discount.
     *  Capped so points can never exceed the amount actually due. */
    const handleRedeemLoyalty = async () => {
        if (!customer?.id || !transaction || !loyaltyCfg) return
        const due = totals?.total_amount || 0
        const maxByTotal = loyaltyCfg.dinarPerPoint > 0 ? Math.floor(due / loyaltyCfg.dinarPerPoint) : 0
        const points = Math.min(loyaltyPoints, maxByTotal)
        if (points <= 0) return

        const r = await window.electron.loyalty.redeem(customer.id, points, transaction.id)
        if (!r.success) {
            alert(r.error || 'Utilisation des points impossible.')
            return
        }
        await window.electron.transaction.applyDiscount({
            transactionId: transaction.id,
            discountType: 'fixed',
            discountValue: r.discount || 0
        })
        setLoyaltyApplied(r.discount || 0)
        setLoyaltyPoints(await window.electron.loyalty.balance(customer.id))
        loadItems()
    }

    const handleSelectCustomer = (selectedCustomer: Customer) => {
        setCustomer(selectedCustomer)
        setShowCustomerLookup(false)
    }

    const handlePaymentComplete = async (_debtDueDate?: string, customerNameOverride?: string) => {
        if (!transaction) return

        try {
            // NOTE: the sale is already completed by PaymentModal.handleComplete() before
            // onComplete() fires. Do NOT call transaction.complete() again here — doing so
            // previously decremented stock twice per sale. We only read the final state.
            const txn = await window.electron.transaction.getById(transaction.id)
            const finalItems = await window.electron.transaction.getItems(transaction.id)
            const payments = await window.electron.transaction.getPayments(transaction.id)

            if (txn) {
                const receiptData: ReceiptData = {
                    transactionNumber: txn.transaction_number,
                    date: formatDateTime(new Date()),
                    cashierName: userName,
                    customerName: customerNameOverride || customer?.name || null,
                    items: finalItems.map(i => ({
                        name: i.product_name,
                        quantity: i.quantity,
                        unitPrice: i.unit_price,
                        total: i.line_total,
                        discount: i.discount_amount,
                        taxRate: (i as any).tax_rate || 0,
                        taxAmount: (i as any).tax_amount || 0,
                        unit: (i as any).unit || '',
                        unitFactor: (i as any).unit_factor || 1
                    })),
                    subtotal: txn.subtotal,
                    discount: txn.discount_amount,
                    tax: txn.tax_amount || 0,
                    total: txn.total_amount,
                    timbre: txn.timbre || 0,
                    payments: payments.map((p: any) => ({ method: p.payment_method, amount: p.amount })),
                    change: txn.change_due,
                    // Buyer fiscal identifiers (printed on B2B invoices)
                    fiscalId: (customer as any)?.nif || (customer as any)?.tax_id || '',
                    rc: (customer as any)?.rc || '',
                    nis: (customer as any)?.nis || '',
                    ai: (customer as any)?.ai || '',
                    customerPhone: customer?.phone || ''
                }

                setLastReceiptData(receiptData)
                setShowReceipt(true)
            }
        } catch (error) {
            console.error('Failed to complete transaction:', error)
            alert('Impossible de finaliser la vente.')
        } finally {
            // Create new transaction for next sale
            const newTxn = await window.electron.transaction.create(userId, null)
            setTransaction(newTxn)
            setItems([])
            setCustomer(null)
            setTotals(null)
            setShowPayment(false)
        }
    }

    const handlePrintReceipt = async () => {
        if (lastReceiptData) {
            // @ts-ignore
            await window.electron.receipt.print(lastReceiptData)
        }
    }

    const handleVoidTransaction = async () => {
        if (!transaction) return
        if (!confirm(t('pos2.voidAsk'))) return

        const newTxn = await window.electron.transaction.create(userId, null)
        setTransaction(newTxn)
        setItems([])
    }

    const mapSymbolsToNumbers = (input: string) => {
        const mapping: { [key: string]: string } = {
            'à': '0', '@': '0', ')': '0',
            '&': '1',
            'é': '2', 'É': '2',
            '"': '3', '#': '3',
            "'": '4', '{': '4', '$': '4',
            '(': '5', '[': '5', '%': '5',
            '-': '6', '|': '6', '§': '6',
            'è': '7', 'È': '7',
            '_': '8', '\\': '8', '!': '8', '*': '8',
            'ç': '9', 'Ç': '9', '^': '9'
        };
        return input.split('').map(char => mapping[char] || char).join('');
    };

    /* ---- Presentation state -------------------------------------------------
       Everything above this point is the sale logic and is unchanged. What
       follows is the till from the approved mockup: category tiles, a photo
       grid, and a cart panel that carries the discount and the payment choice
       instead of hiding them behind a modal.
       ---------------------------------------------------------------------- */

    const cartCount = items.reduce((n, i) => n + (i.quantity || 0), 0)
    const due = totals?.total_amount || 0

    const visibleProducts = products.filter(p =>
        activeCategory === null || p.category_id === activeCategory)

    /** Push the discount into the sale. Debounced by the caller (blur / Enter)
     *  rather than per keystroke: applyDiscount recalculates every line. */
    const commitDiscount = async () => {
        if (!transaction) return
        const value = Number(String(discountValue).replace(',', '.')) || 0
        await window.electron.transaction.applyDiscount({
            transactionId: transaction.id,
            discountType: discountMode === 'percent' ? 'percentage' : 'fixed',
            discountValue: value,
        })
        loadItems()
    }

    const clearCart = async () => {
        if (!items.length) return
        if (!confirm(t('pos2.clearAsk'))) return
        for (const i of items) await window.electron.transaction.removeItem(i.id)
        loadItems()
    }

    return (
        <div className="pos-screen">
            {/* ------------------------------------------------------ catalogue -- */}
            <div className="pos-main">
                <div className="pos-topbar">
                    <label className="el-search pos-search">
                        <Search size={16} />
                        <input
                            ref={searchRef}
                            type="text"
                            placeholder={t('pos2.searchPh')}
                            value={search}
                            onChange={(e) => setSearch(mapSymbolsToNumbers(e.target.value))}
                            onKeyDown={handleBarcodeSearch}
                            autoFocus
                            aria-label={t('pos2.searchPh')}
                        />
                    </label>

                    <button
                        className={`pos-customer ${customer ? 'is-set' : ''}`}
                        onClick={() => setShowCustomerLookup(true)}
                    >
                        <User size={15} />
                        <span>{customer ? customer.name : t('pos2.clientOpt')}</span>
                        {customer && (
                            <span
                                className="pos-customer-x"
                                role="button"
                                tabIndex={0}
                                aria-label={t('pos2.removeClient')}
                                onClick={(e) => { e.stopPropagation(); setCustomer(null) }}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setCustomer(null) } }}
                            >
                                <X size={13} />
                            </span>
                        )}
                    </button>
                </div>

                {/* Category tiles. The shop picks by department first and by garment
                    second, so this is a filter you can hit at arm's length rather
                    than a dropdown. "Tous" is always first and always reachable. */}
                {categories.length > 0 && (
                    <div className="pos-cats" role="tablist" aria-label={t('pos2.categories')}>
                        <button
                            role="tab"
                            aria-selected={activeCategory === null}
                            className={`pos-cat ${activeCategory === null ? 'active' : ''}`}
                            onClick={() => setActiveCategory(null)}
                        >
                            <span className="pos-cat-tile"><LayoutGrid size={20} /></span>
                            <span className="pos-cat-name">{t('ui.all')}</span>
                        </button>
                        {categories.map(c => (
                            <button
                                key={c.id}
                                role="tab"
                                aria-selected={activeCategory === c.id}
                                className={`pos-cat ${activeCategory === c.id ? 'active' : ''}`}
                                onClick={() => setActiveCategory(activeCategory === c.id ? null : c.id)}
                            >
                                {/* The family's own picture when the shop has set one
                                    (Produits → Familles); a garment glyph until then. */}
                                <span className={`pos-cat-tile ${c.image_path ? 'has-img' : ''}`}>
                                    {c.image_path
                                        ? <img src={productImageUrl(c.image_path) || ''} alt="" />
                                        : <Shirt size={20} />}
                                </span>
                                <span className="pos-cat-name">{c.name}</span>
                            </button>
                        ))}
                    </div>
                )}

                <div className="pos-grid-wrap">
                    {visibleProducts.length === 0 ? (
                        <div className="el-empty">
                            <span className="el-empty-icon"><PackageSearch size={22} /></span>
                            <strong>{t('pos2.noProducts')}</strong>
                            <span>
                                {search
                                    ? t('pos2.noSearch')
                                    : t('pos2.otherCat')}
                            </span>
                        </div>
                    ) : (
                        <div className="pos-grid">
                            {visibleProducts.map(product => {
                                const out = (product.stock_quantity ?? 0) <= 0
                                return (
                                    <button
                                        key={product.id}
                                        className={`pos-card ${out ? 'is-out' : ''}`}
                                        onClick={() => handleAddProduct(product)}
                                        // Out of stock stays CLICKABLE: the size picker
                                        // shows which combinations are finished, and a
                                        // dead tile just makes staff ask the manager.
                                    >
                                        <span className="pos-card-img">
                                            <ProductThumb
                                                productId={product.id}
                                                name={product.name}
                                                image={imageMap[product.id]}
                                                size="fill"
                                                radius={0}
                                            />
                                            {out && <span className="pos-card-flag">{t('pos2.outOfStock')}</span>}
                                        </span>
                                        <span className="pos-card-body">
                                            <span className="pos-card-name">{product.name}</span>
                                            <span className="pos-card-price">
                                                {product.has_variants ? t('pos2.from') + ' ' : ''}
                                                {formatCurrency(priceFor(product))}
                                            </span>
                                        </span>
                                    </button>
                                )
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* ----------------------------------------------------------- cart -- */}
            <aside className="pos-cart">
                <div className="pos-cart-head">
                    <h2>{t('pos2.cart')}</h2>
                    <span className="pos-cart-count">
                        {cartCount} {t('pos2.items')}
                    </span>
                    <button
                        className="el-icon-btn"
                        onClick={clearCart}
                        disabled={!items.length}
                        aria-label={t('pos2.clearCart')}
                    >
                        <Trash2 size={16} />
                    </button>
                </div>

                <div className="pos-cart-lines">
                    {items.length === 0 ? (
                        <div className="pos-cart-empty">
                            <ShoppingBag size={26} />
                            <strong>{t('pos2.emptyCart')}</strong>
                            <span>{t('pos2.emptyHint')}</span>
                        </div>
                    ) : items.map(i => {
                        // addLine() writes the size/colour into product_name as
                        // "Costume Milano (52 / Bleu Marine)"; split it back out so
                        // the line reads like the mockup instead of one long string.
                        const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(i.product_name)
                        const name = m ? m[1] : i.product_name
                        const variant = m ? m[2].replace(' / ', ' · ') : ''
                        return (
                            <div className="pos-line" key={i.id}>
                                <ProductThumb
                                    productId={i.product_id}
                                    name={name}
                                    image={imageMap[i.product_id]}
                                    size={42}
                                />
                                <div className="pos-line-text">
                                    <span className="pos-line-name">{name}</span>
                                    {variant && <span className="pos-line-variant">{variant}</span>}
                                    <span className="pos-line-unit">
                                        {i.quantity} × {formatCurrency(i.unit_price)}
                                    </span>
                                </div>
                                <div className="pos-line-right">
                                    <span className="pos-line-total">{formatCurrency(i.line_total)}</span>
                                    <div className="pos-qty">
                                        <button
                                            onClick={() => handleUpdateQuantity(i.id, i.quantity - 1)}
                                            aria-label={t('last.removeOne')}
                                        >
                                            <Minus size={12} />
                                        </button>
                                        <span>{i.quantity}</span>
                                        <button
                                            onClick={() => handleUpdateQuantity(i.id, i.quantity + 1)}
                                            aria-label={t('last.addOne')}
                                        >
                                            <Plus size={12} />
                                        </button>
                                        <button
                                            className="pos-qty-x"
                                            onClick={() => handleRemoveItem(i.id)}
                                            aria-label={t('last.deleteLine')}
                                        >
                                            <X size={12} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )
                    })}
                </div>

                <div className="pos-cart-foot">
                    {/* Warnings sit ABOVE the total, never below the pay button: the
                        last thing under your thumb must not be the one telling you
                        the sale is a problem. */}
                    {customer && loyaltyCfg?.enabled && loyaltyPoints > 0 && (
                        <div className="pos-note is-accent">
                            <span>{loyaltyPoints} {t('pos2.points')}</span>
                            {loyaltyApplied > 0 ? (
                                <strong>−{formatCurrency(loyaltyApplied)}</strong>
                            ) : loyaltyPoints >= loyaltyCfg.minRedeem ? (
                                <button onClick={handleRedeemLoyalty} disabled={!items.length}>
                                    {t('pos2.usePoints')}
                                </button>
                            ) : (
                                <small>min. {loyaltyCfg.minRedeem}</small>
                            )}
                        </div>
                    )}

                    {creditStatus && creditStatus.limit > 0 &&
                        (creditStatus.balance + due) > creditStatus.limit && (
                        <div className="pos-note is-error" role="alert">
                            <AlertTriangle size={14} />
                            <span>
                                Crédit dépassé — solde {formatCurrency(creditStatus.balance)} +
                                cette vente dépasse la limite ({formatCurrency(creditStatus.limit)}).
                            </span>
                        </div>
                    )}

                    {stockWarnings.length > 0 && (
                        <div className="pos-note is-warn" role="alert">
                            <AlertTriangle size={14} />
                            <span>
                                Stock insuffisant — {stockWarnings.map(w =>
                                    `${w.product_name} (demandé ${w.requested}, dispo ${w.available})`).join(' · ')}
                            </span>
                        </div>
                    )}

                    <div className="pos-discount">
                        <span className="pos-discount-label">{t('pos2.discount')}</span>
                        <div className="el-segmented pos-discount-mode">
                            <button
                                className={`el-seg ${discountMode === 'percent' ? 'active' : ''}`}
                                onClick={() => setDiscountMode('percent')}
                            >%</button>
                            <button
                                className={`el-seg ${discountMode === 'amount' ? 'active' : ''}`}
                                onClick={() => setDiscountMode('amount')}
                            >{t('pos2.discountAmt')}</button>
                        </div>
                        <input
                            className="el-input pos-discount-input"
                            inputMode="decimal"
                            value={discountValue}
                            placeholder="0,00"
                            onChange={e => setDiscountValue(e.target.value)}
                            onBlur={commitDiscount}
                            onKeyDown={e => { if (e.key === 'Enter') commitDiscount() }}
                            aria-label={t('pos2.discount')}
                        />
                    </div>

                    {(totals?.discount_amount || 0) > 0 && (
                        <div className="pos-sum">
                            <span>{t('pos2.discountApplied')}</span>
                            <strong className="is-cut">−{formatCurrency(totals.discount_amount)}</strong>
                        </div>
                    )}
                    {(totals?.tax_amount || 0) > 0 && (
                        <div className="pos-sum">
                            <span>{t('pos2.vat')}</span>
                            <strong>{formatCurrency(totals.tax_amount)}</strong>
                        </div>
                    )}

                    <div className="pos-total">
                        <span>{t('ui.total')}</span>
                        <strong>{formatCurrency(due)}</strong>
                    </div>

                    {/* Payment method is chosen here and carried into the modal, so
                        the common case (cash) is one tap from the total instead of
                        one tap plus a dialog decision. */}
                    <div className="pos-methods" role="group" aria-label={t('pos2.cash')}>
                        {(['cash', 'card', 'mixed'] as const).map(m => (
                            <button
                                key={m}
                                className={`pos-method ${payMethod === m ? 'active' : ''}`}
                                onClick={() => setPayMethod(m)}
                            >
                                {m === 'cash' ? t('pos2.cash') : m === 'card' ? t('pos2.card') : t('pos2.mixed')}
                            </button>
                        ))}
                    </div>

                    <button
                        className="el-btn el-btn--primary el-btn--lg el-btn--block pos-pay"
                        onClick={() => setShowPayment(true)}
                        disabled={items.length === 0}
                    >
                        {t('pos2.checkout')} {formatCurrency(due)}
                    </button>

                    <button
                        className="el-btn el-btn--ghost el-btn--block pos-void"
                        onClick={handleVoidTransaction}
                        disabled={items.length === 0}
                    >
                        {t('pos2.voidSale')}
                    </button>
                </div>
            </aside>

            {showPayment && transaction && (
                <PaymentModal
                    transactionId={transaction.id}
                    total={due}
                    customer={customer}
                    // "Carte" on the till is CIB in the payment dialog — Algeria has
                    // no generic card rail, and PaymentModal records the real one.
                    // "Mixte" opens on cash because a split always starts with the
                    // note the customer already has in their hand.
                    initialMethod={payMethod === 'card' ? 'cib' : 'cash'}
                    onComplete={handlePaymentComplete}
                    onClose={() => setShowPayment(false)}
                />
            )}

            {showCustomerLookup && (
                <CustomerLookup
                    onSelect={handleSelectCustomer}
                    onClose={() => setShowCustomerLookup(false)}
                />
            )}

            {showReceipt && lastReceiptData && (
                <ReceiptPreview
                    data={lastReceiptData}
                    onClose={() => setShowReceipt(false)}
                    onPrint={handlePrintReceipt}
                />
            )}

            {variantPicker && (
                <VariantPicker
                    product={variantPicker.product}
                    variants={variantPicker.variants}
                    onPick={async (variant) => {
                        const pending = variantPicker
                        setVariantPicker(null)
                        await addLine(pending.product, pending.qty, variant)
                        searchRef.current?.focus()
                    }}
                    onClose={() => {
                        setVariantPicker(null)
                        searchRef.current?.focus()
                    }}
                />
            )}
        </div>
    )
}


/** Size/colour chooser shown between scanning a garment and adding it to the cart.
 *  Out-of-stock combinations stay visible but unselectable, so staff can see that the
 *  size exists and is simply finished rather than assuming it was never stocked. */
function VariantPicker({ product, variants, onPick, onClose }: {
    product: Product
    variants: VariantWithStock[]
    onPick: (variant: VariantWithStock) => void
    onClose: () => void
}) {
    const { t } = useLanguage()
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    // Group by size so the grid reads one row per size, colours across.
    const sizes: string[] = []
    for (const v of variants) if (!sizes.includes(v.size)) sizes.push(v.size)

    return (
        <div className="variant-picker-overlay" onClick={onClose}>
            <div className="variant-picker" onClick={(e) => e.stopPropagation()}>
                <h3>{product.name}</h3>
                <p className="variant-picker-hint">{t('last.pickSizeColor')}</p>

                {sizes.map(size => (
                    <div key={size} className="variant-picker-row">
                        {size && <span className="variant-picker-size">{size}</span>}
                        <div className="variant-picker-options">
                            {variants.filter(v => v.size === size).map(v => {
                                const out = v.stock_quantity <= 0
                                return (
                                    <button
                                        key={v.id}
                                        type="button"
                                        disabled={out}
                                        title={out ? t('pos2.outLabel') : `${v.stock_quantity} ${t('pos2.inStock')}`}
                                        onClick={() => onPick(v)}
                                    >
                                        <span>{v.color || size || '—'}</span>
                                        <small>{out ? t('pos2.outOfStock') : `${v.stock_quantity}`}</small>
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                ))}

                <div className="variant-picker-actions">
                    <button type="button" onClick={onClose}>{t('ui.cancelBtn')}</button>
                </div>
            </div>
        </div>
    )
}
