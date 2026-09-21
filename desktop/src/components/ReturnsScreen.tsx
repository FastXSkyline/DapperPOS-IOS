import { useState, useEffect, useMemo } from 'react'
import {
    Search, RotateCcw, ArrowLeftRight, AlertTriangle, PackageCheck,
    PackageX, Receipt, X, Plus, Trash2,
} from 'lucide-react'
import { formatCurrency, formatDateTime } from '../utils/formatters'
import type { Product } from '../../shared/types'
import type { SaleReturnRow, VariantWithStock } from '../vite-env'
import './ReturnsScreen.css'

interface Props {
    userId: number
    /** Store physically receiving the goods. May differ from the selling store. */
    storeId: number | null
}

/** One line of the original sale, with how much of it can still come back. */
interface SaleLine {
    id: number
    product_id: number
    variant_id: number | null
    product_name: string
    size: string | null
    color: string | null
    quantity: number
    unit_price: number
    returned_quantity: number
    returnable_quantity: number
}

interface FoundSale {
    transaction: {
        id: number
        transaction_number: string
        created_at: string
        total_amount: number
        status: string
        return_status: string
        customer_name: string | null
        store_name: string | null
        user_name: string | null
    }
    items: SaleLine[]
    previousReturns: { id: number; return_number: string; kind: string; created_at: string; balance: number }[]
}

const REASONS = [
    'Taille incorrecte',
    'Couleur non conforme',
    'Défaut / article abîmé',
    'Changement d’avis',
    'Article non conforme à la commande',
    'Autre',
]

const variantLabel = (l: { size: string | null; color: string | null }) =>
    [l.size, l.color].filter(Boolean).join(' · ') || '—'

/** A line of the replacement cart, held in the renderer until the exchange is
 *  submitted. Nothing is written to the database until then. */
interface ReplacementLine {
    key: string
    productId: number
    variantId: number | null
    productName: string
    size: string | null
    color: string | null
    unitPrice: number
    quantity: number
    available: number
}

/**
 * Retours & échanges.
 *
 * The flow deliberately starts from the ORIGINAL SALE and never from a product:
 * a return that does not reference the sale it reverses is exactly the fraud the
 * anti-fraud rules exist to prevent, and it is also the only lawful shape for an
 * avoir. So the cashier must find the ticket first; there is no way through this
 * screen to refund something that was never sold.
 */
export function ReturnsScreen({ userId, storeId }: Props) {
    const [query, setQuery] = useState('')
    const [sale, setSale] = useState<FoundSale | null>(null)
    const [searching, setSearching] = useState(false)
    const [notFound, setNotFound] = useState(false)

    // line id -> quantity being returned
    const [picked, setPicked] = useState<Record<number, number>>({})
    const [condition, setCondition] = useState<Record<number, 'resellable' | 'damaged'>>({})
    const [reason, setReason] = useState(REASONS[0])
    const [refundMethod, setRefundMethod] = useState('cash')
    const [notes, setNotes] = useState('')

    const [history, setHistory] = useState<SaleReturnRow[]>([])
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [done, setDone] = useState<{ number: string; balance: number; kind: string; replacementNumber?: string } | null>(null)

    // --- exchange: the replacement cart ---
    const [mode, setMode] = useState<'refund' | 'exchange'>('refund')
    const [productQuery, setProductQuery] = useState('')
    const [productHits, setProductHits] = useState<Product[]>([])
    const [pickedProduct, setPickedProduct] = useState<Product | null>(null)
    const [pickedVariants, setPickedVariants] = useState<VariantWithStock[]>([])
    const [replacementCart, setReplacementCart] = useState<ReplacementLine[]>([])
    const [topUpMethod, setTopUpMethod] = useState('cash')

    const loadHistory = async () => {
        setHistory(await window.electron.salesReturn.list({ limit: 50 }))
    }

    useEffect(() => { loadHistory() }, [])

    const search = async () => {
        const term = query.trim()
        if (!term) return
        setSearching(true)
        setError('')
        setNotFound(false)
        setSale(null)
        setPicked({})
        setCondition({})
        setReplacementCart([])
        setPickedProduct(null)
        setDone(null)
        try {
            const found = await window.electron.salesReturn.findSale(term)
            if (!found) setNotFound(true)
            else setSale(found as FoundSale)
        } finally {
            setSearching(false)
        }
    }

    const setQty = (line: SaleLine, raw: string) => {
        const n = Math.max(0, Math.min(line.returnable_quantity, Number(raw) || 0))
        setPicked(prev => {
            const next = { ...prev }
            if (n <= 0) delete next[line.id]
            else next[line.id] = n
            return next
        })
    }

    const lines = useMemo(
        () => Object.entries(picked).map(([id, qty]) => ({ id: Number(id), qty })),
        [picked],
    )

    // Value is computed from the ORIGINAL line price, mirroring what the service
    // does — the cashier must see the same number the shop is going to pay out.
    const returnedValue = useMemo(() => {
        if (!sale) return 0
        return lines.reduce((sum, l) => {
            const line = sale.items.find(i => i.id === l.id)
            return sum + (line ? line.unit_price * l.qty : 0)
        }, 0)
    }, [lines, sale])

    // Debounced-ish product lookup for the replacement cart. Kept deliberately
    // small: this is a picker, not a second till — the sale itself is still built
    // by the service through TransactionService.
    useEffect(() => {
        if (mode !== 'exchange') return
        const term = productQuery.trim()
        if (term.length < 2) { setProductHits([]); return }
        let cancelled = false
        const t = setTimeout(async () => {
            const hits = await window.electron.product.getAll({ search: term, limit: 8 })
            if (!cancelled) setProductHits(hits)
        }, 180)
        return () => { cancelled = true; clearTimeout(t) }
    }, [productQuery, mode])

    const choose = async (p: Product) => {
        setPickedProduct(p)
        setPickedVariants(p.has_variants ? await window.electron.product.getVariants(p.id) : [])
    }

    const addReplacement = (variant: VariantWithStock | null) => {
        if (!pickedProduct) return
        const price = variant?.retail_price ?? pickedProduct.retail_price ?? 0
        const key = `${pickedProduct.id}:${variant?.id ?? 0}`
        setReplacementCart(prev => {
            const existing = prev.find(l => l.key === key)
            if (existing) {
                return prev.map(l => l.key === key ? { ...l, quantity: l.quantity + 1 } : l)
            }
            return [...prev, {
                key,
                productId: pickedProduct.id,
                variantId: variant?.id ?? null,
                productName: pickedProduct.name,
                size: variant?.size ?? null,
                color: variant?.color ?? null,
                unitPrice: price,
                quantity: 1,
                available: variant?.stock_quantity ?? pickedProduct.stock_quantity ?? 0,
            }]
        })
        setPickedProduct(null)
        setPickedVariants([])
        setProductQuery('')
        setProductHits([])
    }

    const replacementTotal = useMemo(
        () => replacementCart.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
        [replacementCart])

    // Mirrors what the service computes, so the cashier sees the figure they are
    // about to act on before they commit. The service recomputes it regardless —
    // this is display, never the source of truth.
    const exchangeBalance = returnedValue - replacementTotal

    const submitExchange = async () => {
        if (!sale || !lines.length || !replacementCart.length) return
        setBusy(true)
        setError('')
        try {
            const result = await window.electron.salesReturn.exchangeWithNewSale({
                originalTransactionId: sale.transaction.id,
                storeId: storeId ?? undefined,
                userId,
                reason,
                notes: notes || null,
                topUpMethod,
                lines: lines.map(l => ({
                    originalItemId: l.id,
                    quantity: l.qty,
                    condition: condition[l.id] ?? 'resellable',
                    reason,
                })),
                replacement: replacementCart.map(l => ({
                    productId: l.productId,
                    variantId: l.variantId,
                    productName: l.productName,
                    quantity: l.quantity,
                    unitPrice: l.unitPrice,
                })),
            })

            if (!result.ok) {
                setError(result.message)
                return
            }

            setDone({
                number: result.data.returnNumber,
                balance: result.data.balance,
                kind: 'exchange',
                replacementNumber: result.data.replacementNumber,
            })
            setPicked({})
            setCondition({})
            setReplacementCart([])
            const refreshed = await window.electron.salesReturn.getSale(sale.transaction.id)
            setSale(refreshed as FoundSale)
            await loadHistory()
        } catch (e) {
            console.error('[Returns] exchange failed:', e)
            setError('L’échange n’a pas pu être enregistré. Réessayez.')
        } finally {
            setBusy(false)
        }
    }

    const submitRefund = async () => {
        if (!sale || !lines.length) return
        setBusy(true)
        setError('')
        try {
            const result = await window.electron.salesReturn.refund({
                originalTransactionId: sale.transaction.id,
                storeId: storeId ?? undefined,
                userId,
                refundMethod,
                reason,
                notes: notes || null,
                lines: lines.map(l => ({
                    originalItemId: l.id,
                    quantity: l.qty,
                    condition: condition[l.id] ?? 'resellable',
                    reason,
                })),
            })

            if (!result.ok) {
                setError(result.message)
                return
            }

            setDone({ number: result.data.returnNumber, balance: result.data.balance, kind: 'refund' })
            setPicked({})
            setCondition({})
            // Re-read the sale so the returnable quantities reflect what just happened.
            const refreshed = await window.electron.salesReturn.getSale(sale.transaction.id)
            setSale(refreshed as FoundSale)
            await loadHistory()
        } catch (e) {
            console.error('[Returns] refund failed:', e)
            setError('Le retour n’a pas pu être enregistré. Réessayez.')
        } finally {
            setBusy(false)
        }
    }

    const totalPicked = lines.reduce((n, l) => n + l.qty, 0)

    return (
        <div className="returns-screen">
            <header className="returns-header">
                <div>
                    <h1>Retours &amp; échanges</h1>
                    <p>
                        Un retour référence toujours la vente d’origine et rembourse le prix
                        réellement payé — jamais le prix du jour.
                    </p>
                </div>
            </header>

            <section className="returns-search">
                <div className="returns-search-field">
                    <Search size={17} />
                    <input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') search() }}
                        placeholder="Numéro de ticket ou de facture (ex. BL-2026-000042)"
                        autoFocus
                    />
                </div>
                <button className="returns-primary" onClick={search} disabled={searching || !query.trim()}>
                    {searching ? 'Recherche…' : 'Rechercher la vente'}
                </button>
            </section>

            {notFound && (
                <div className="returns-empty">
                    <Receipt size={30} />
                    <h3>Aucune vente ne porte ce numéro</h3>
                    <p>
                        Vérifiez le numéro sur le ticket du client. Sans la vente d’origine, aucun
                        remboursement n’est possible.
                    </p>
                </div>
            )}

            {done && (
                <div className="returns-success" role="status">
                    <PackageCheck size={18} />
                    <div>
                        <strong>
                            {done.number} enregistré
                            {done.replacementNumber && ` — nouvelle vente ${done.replacementNumber}`}
                        </strong>
                        <p>
                            {done.balance > 0
                                ? `À rembourser au client : ${formatCurrency(done.balance)}`
                                : done.balance < 0
                                    ? `Le client doit encore : ${formatCurrency(Math.abs(done.balance))}`
                                    : 'Échange équilibré — rien à régler.'}
                        </p>
                    </div>
                    <button className="returns-dismiss" onClick={() => setDone(null)} aria-label="Fermer">
                        <X size={16} />
                    </button>
                </div>
            )}

            {sale && (
                <section className="returns-sale">
                    <div className="returns-sale-head">
                        <div>
                            <h2>{sale.transaction.transaction_number}</h2>
                            <div className="returns-meta">
                                <span>{formatDateTime(sale.transaction.created_at)}</span>
                                <span>{sale.transaction.customer_name || 'Client de passage'}</span>
                                {sale.transaction.store_name && <span>{sale.transaction.store_name}</span>}
                                {sale.transaction.user_name && <span>Vendu par {sale.transaction.user_name}</span>}
                            </div>
                        </div>
                        <div className="returns-sale-total">
                            <span>Total de la vente</span>
                            <strong>{formatCurrency(sale.transaction.total_amount)}</strong>
                        </div>
                    </div>

                    <div className="returns-mode" role="tablist">
                        <button
                            role="tab"
                            aria-selected={mode === 'refund'}
                            className={mode === 'refund' ? 'active' : ''}
                            onClick={() => setMode('refund')}
                        >
                            <RotateCcw size={15} /> Remboursement
                        </button>
                        <button
                            role="tab"
                            aria-selected={mode === 'exchange'}
                            className={mode === 'exchange' ? 'active' : ''}
                            onClick={() => setMode('exchange')}
                        >
                            <ArrowLeftRight size={15} /> Échange
                        </button>
                    </div>

                    {sale.transaction.return_status === 'full' && (
                        <div className="returns-note">
                            <AlertTriangle size={15} />
                            Cette vente a déjà été intégralement retournée.
                        </div>
                    )}

                    <table className="returns-table">
                        <thead>
                            <tr>
                                <th>Article</th>
                                <th>Taille · Couleur</th>
                                <th className="num">Vendu</th>
                                <th className="num">Déjà retourné</th>
                                <th className="num">Prix payé</th>
                                <th className="num">À retourner</th>
                                <th>État</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sale.items.map(line => {
                                const exhausted = line.returnable_quantity <= 0
                                return (
                                    <tr key={line.id} className={exhausted ? 'exhausted' : ''}>
                                        <td>{line.product_name}</td>
                                        <td className="muted">{variantLabel(line)}</td>
                                        <td className="num">{line.quantity}</td>
                                        <td className="num muted">{line.returned_quantity || 0}</td>
                                        {/* The price the customer actually paid, frozen on the line. */}
                                        <td className="num">{formatCurrency(line.unit_price)}</td>
                                        <td className="num">
                                            <input
                                                className="returns-qty"
                                                type="number"
                                                min={0}
                                                max={line.returnable_quantity}
                                                step={1}
                                                value={picked[line.id] ?? ''}
                                                placeholder="0"
                                                disabled={exhausted}
                                                onChange={e => setQty(line, e.target.value)}
                                            />
                                        </td>
                                        <td>
                                            <select
                                                className="returns-condition"
                                                value={condition[line.id] ?? 'resellable'}
                                                disabled={exhausted || !picked[line.id]}
                                                onChange={e => setCondition(prev => ({
                                                    ...prev,
                                                    [line.id]: e.target.value as 'resellable' | 'damaged',
                                                }))}
                                            >
                                                <option value="resellable">Revendable</option>
                                                <option value="damaged">Abîmé</option>
                                            </select>
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>

                    <div className="returns-form">
                        <label>
                            <span>Motif</span>
                            <select value={reason} onChange={e => setReason(e.target.value)}>
                                {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                            </select>
                        </label>
                        <label hidden={mode === 'exchange'}>
                            <span>Mode de remboursement</span>
                            <select value={refundMethod} onChange={e => setRefundMethod(e.target.value)}>
                                <option value="cash">Espèces</option>
                                <option value="card">Carte</option>
                                <option value="bank_transfer">Virement</option>
                                <option value="store_credit">Avoir magasin</option>
                            </select>
                        </label>
                        <label className="grow">
                            <span>Note (facultatif)</span>
                            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Précision…" />
                        </label>
                    </div>

                    {/* Damaged goods are credited to the customer but booked to shrinkage
                        rather than returned to sellable stock — worth saying before the
                        cashier commits, because it is not reversible from this screen. */}
                    {lines.some(l => condition[l.id] === 'damaged') && (
                        <div className="returns-note">
                            <PackageX size={15} />
                            Les articles marqués « abîmé » sont remboursés mais enregistrés en perte,
                            pas remis en stock vendable.
                        </div>
                    )}

                    {error && (
                        <div className="returns-error" role="alert">
                            <AlertTriangle size={16} />
                            <span>{error}</span>
                        </div>
                    )}

                    {mode === 'exchange' && (
                        <div className="returns-exchange">
                            <h3>Articles de remplacement</h3>

                            <div className="returns-picker">
                                <div className="returns-search-field">
                                    <Search size={16} />
                                    <input
                                        value={productQuery}
                                        onChange={e => setProductQuery(e.target.value)}
                                        placeholder="Chercher un article à donner en échange…"
                                    />
                                </div>

                                {productHits.length > 0 && !pickedProduct && (
                                    <ul className="returns-hits">
                                        {productHits.map(p => (
                                            <li key={p.id}>
                                                <button onClick={() => choose(p)}>
                                                    <span>{p.name}</span>
                                                    <span className="muted">{formatCurrency(p.retail_price ?? 0)}</span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}

                                {/* A garment is only sellable as a size×colour, so a product with
                                    variants cannot be added until one is chosen. */}
                                {pickedProduct && (
                                    <div className="returns-variants">
                                        <div className="returns-variants-head">
                                            <strong>{pickedProduct.name}</strong>
                                            <button className="returns-dismiss" onClick={() => { setPickedProduct(null); setPickedVariants([]) }} aria-label="Annuler">
                                                <X size={15} />
                                            </button>
                                        </div>
                                        {pickedVariants.length === 0 ? (
                                            <button className="returns-secondary" onClick={() => addReplacement(null)}>
                                                <Plus size={15} /> Ajouter ({formatCurrency(pickedProduct.retail_price ?? 0)})
                                            </button>
                                        ) : (
                                            <div className="returns-variant-grid">
                                                {pickedVariants.map(v => (
                                                    <button
                                                        key={v.id}
                                                        className="returns-variant"
                                                        disabled={v.stock_quantity <= 0}
                                                        onClick={() => addReplacement(v)}
                                                        title={v.stock_quantity <= 0 ? 'Rupture de stock' : undefined}
                                                    >
                                                        <span>{variantLabel(v)}</span>
                                                        <span className={v.stock_quantity <= 0 ? 'out' : 'muted'}>
                                                            {v.stock_quantity <= 0 ? 'Rupture' : `${v.stock_quantity} en stock`}
                                                        </span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {replacementCart.length === 0 ? (
                                <p className="returns-cart-empty">
                                    Aucun article de remplacement. L’échange sera refusé tant que ce panier est vide.
                                </p>
                            ) : (
                                <table className="returns-table">
                                    <thead>
                                        <tr>
                                            <th>Article</th><th>Taille · Couleur</th>
                                            <th className="num">Prix</th><th className="num">Qté</th>
                                            <th className="num">Total</th><th />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {replacementCart.map(l => (
                                            <tr key={l.key}>
                                                <td>{l.productName}</td>
                                                <td className="muted">{variantLabel(l)}</td>
                                                <td className="num">{formatCurrency(l.unitPrice)}</td>
                                                <td className="num">
                                                    <input
                                                        className="returns-qty"
                                                        type="number"
                                                        min={1}
                                                        value={l.quantity}
                                                        onChange={e => {
                                                            const q = Math.max(1, Number(e.target.value) || 1)
                                                            setReplacementCart(prev => prev.map(x => x.key === l.key ? { ...x, quantity: q } : x))
                                                        }}
                                                    />
                                                </td>
                                                <td className="num">{formatCurrency(l.unitPrice * l.quantity)}</td>
                                                <td className="num">
                                                    <button
                                                        className="returns-dismiss"
                                                        aria-label="Retirer"
                                                        onClick={() => setReplacementCart(prev => prev.filter(x => x.key !== l.key))}
                                                    >
                                                        <Trash2 size={15} />
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}

                            {/* The one number the cashier acts on. Shown before committing
                                because it decides whether they take money or hand it back. */}
                            <div className="returns-balance">
                                <div>
                                    <span>Repris</span>
                                    <strong>{formatCurrency(returnedValue)}</strong>
                                </div>
                                <div>
                                    <span>Remplacement</span>
                                    <strong>{formatCurrency(replacementTotal)}</strong>
                                </div>
                                <div className={exchangeBalance > 0 ? 'pay-out' : exchangeBalance < 0 ? 'take-in' : ''}>
                                    <span>
                                        {exchangeBalance > 0 ? 'À rembourser au client'
                                            : exchangeBalance < 0 ? 'À encaisser'
                                                : 'Solde'}
                                    </span>
                                    <strong>{formatCurrency(Math.abs(exchangeBalance))}</strong>
                                </div>
                                {exchangeBalance < 0 && (
                                    <label className="returns-topup">
                                        <span>Règlement de la différence</span>
                                        <select value={topUpMethod} onChange={e => setTopUpMethod(e.target.value)}>
                                            <option value="cash">Espèces</option>
                                            <option value="card">Carte</option>
                                            <option value="bank_transfer">Virement</option>
                                        </select>
                                    </label>
                                )}
                            </div>
                        </div>
                    )}

                    <footer className="returns-actions">
                        <div className="returns-summary">
                            <span>{totalPicked} article{totalPicked > 1 ? 's' : ''} repris</span>
                            <strong>{formatCurrency(returnedValue)}</strong>
                        </div>
                        <div className="returns-buttons">
                            {mode === 'exchange' ? (
                                <button
                                    className="returns-primary"
                                    onClick={submitExchange}
                                    disabled={busy || !totalPicked || !replacementCart.length}
                                >
                                    <ArrowLeftRight size={16} />
                                    {busy ? 'Enregistrement…' : 'Valider l’échange'}
                                </button>
                            ) : (
                                <button
                                    className="returns-primary"
                                    onClick={submitRefund}
                                    disabled={busy || !totalPicked}
                                >
                                    <RotateCcw size={16} />
                                    {busy ? 'Enregistrement…' : 'Valider le remboursement'}
                                </button>
                            )}
                        </div>
                    </footer>
                </section>
            )}

            <section className="returns-history">
                <h2>Derniers retours</h2>
                {history.length === 0 ? (
                    <p className="returns-history-empty">Aucun retour enregistré pour l’instant.</p>
                ) : (
                    <table className="returns-table">
                        <thead>
                            <tr>
                                <th>N°</th>
                                <th>Type</th>
                                <th>Vente d’origine</th>
                                <th>Client</th>
                                <th>Magasin</th>
                                <th className="num">Articles</th>
                                <th className="num">Solde</th>
                                <th>Date</th>
                            </tr>
                        </thead>
                        <tbody>
                            {history.map(r => (
                                <tr key={r.id}>
                                    <td className="mono">{r.return_number}</td>
                                    <td>
                                        <span className={`returns-badge ${r.kind}`}>
                                            {r.kind === 'exchange' ? 'Échange' : 'Remboursement'}
                                        </span>
                                    </td>
                                    <td className="mono muted">{r.original_number || '—'}</td>
                                    <td>{r.customer_name || 'Client de passage'}</td>
                                    <td className="muted">{r.store_name || '—'}</td>
                                    <td className="num">{r.item_count ?? 0}</td>
                                    <td className="num">{formatCurrency(r.balance)}</td>
                                    <td className="muted">{formatDateTime(r.created_at)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    )
}
