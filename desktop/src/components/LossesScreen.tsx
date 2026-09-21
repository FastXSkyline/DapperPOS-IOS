import { useState, useEffect } from 'react'
import { AlertTriangle, Undo2, Plus } from 'lucide-react'
import { formatCurrency, formatDateTime } from '../utils/formatters'
import type { Product } from '../../shared/types'
import type { VariantWithStock } from '../vite-env'
import type { LossReason, StockLoss } from '../../electron/lossService'
import './LossesScreen.css'

interface Props { userId: number }

const REASONS: { value: LossReason; label: string }[] = [
    { value: 'theft', label: 'Vol' },
    { value: 'damage', label: 'Casse / abîmé' },
    { value: 'stain', label: 'Taché' },
    { value: 'lost', label: 'Égaré' },
    { value: 'expired', label: 'Périmé' },
    { value: 'other', label: 'Autre' }
]
const reasonLabel = (r: string) => REASONS.find(x => x.value === r)?.label || r

/** Pertes — shrinkage write-offs. Separate from stock corrections on purpose: a
 *  correction fixes a miscount, a loss destroys value the shop paid for. */
export function LossesScreen({ userId }: Props) {
    const [losses, setLosses] = useState<(StockLoss & { user_name?: string })[]>([])
    const [summary, setSummary] = useState<{ byReason: { reason: string; entries: number; quantity: number; cost: number }[]; totalCost: number; totalEntries: number } | null>(null)
    const [products, setProducts] = useState<Product[]>([])
    const [variants, setVariants] = useState<VariantWithStock[]>([])
    const [showForm, setShowForm] = useState(false)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    const [productId, setProductId] = useState<number | ''>('')
    const [variantId, setVariantId] = useState<number | ''>('')
    const [quantity, setQuantity] = useState('')
    const [reason, setReason] = useState<LossReason>('theft')
    const [notes, setNotes] = useState('')

    const load = async () => {
        const nextLosses = await window.electron.loss.list(100)
        setLosses(nextLosses)
        const nextSummary = await window.electron.loss.summary()
        setSummary(nextSummary)
        const nextProducts = await window.electron.product.getAll()
        setProducts(nextProducts)
    }

    useEffect(() => {
        load()
    }, [])

    // A garment's loss must name the exact size/colour, so load its variants on pick.
    const pickProduct = async (id: number | '') => {
        setProductId(id)
        setVariantId('')
        setVariants([])
        if (!id) return
        const p = products.find(x => x.id === id)
        if (p?.has_variants) setVariants(await window.electron.product.getVariants(id as number))
    }

    const submit = async () => {
        setError('')
        if (!productId) return setError('Choisissez un article.')
        if (variants.length > 0 && !variantId) return setError('Choisissez la taille / couleur.')
        if (!(Number(quantity) > 0)) return setError('Quantité invalide.')

        setBusy(true)
        try {
            const r = await window.electron.loss.record({
                productId: Number(productId),
                variantId: variantId ? Number(variantId) : null,
                quantity: Number(quantity),
                reason,
                notes: notes || undefined,
                userId
            })
            if (!r.success) return setError(r.error || 'Enregistrement impossible.')
            setProductId(''); setVariantId(''); setVariants([]); setQuantity(''); setNotes(''); setReason('theft')
            setShowForm(false)
            await load()
        } finally { setBusy(false) }
    }

    const revert = async (id: number) => {
        if (!confirm('Annuler cette perte ? La marchandise sera remise en stock.')) return
        const r = await window.electron.loss.revert(id, userId)
        if (!r.success) setError(r.error || 'Annulation impossible.')
        else load()
    }

    return (
        <div className="loss-screen">
            <header className="loss-header">
                <div>
                    <h1>Pertes</h1>
                    <p>Vol, casse, articles tachés — ce que la démarque coûte réellement.</p>
                </div>
                <button className="loss-primary" onClick={() => { setShowForm(v => !v); setError('') }}>
                    <Plus size={16} /> Enregistrer une perte
                </button>
            </header>

            {error && <div className="loss-error">{error}</div>}

            {summary && (
                <section className="loss-summary">
                    <div className="loss-tile total">
                        <span>Coût total</span>
                        <strong>{formatCurrency(summary.totalCost)}</strong>
                        <small>{summary.totalEntries} enregistrement{summary.totalEntries > 1 ? 's' : ''}</small>
                    </div>
                    {summary.byReason.map(r => (
                        <div key={r.reason} className="loss-tile">
                            <span>{reasonLabel(r.reason)}</span>
                            <strong>{formatCurrency(r.cost)}</strong>
                            <small>{r.quantity} pièce{r.quantity > 1 ? 's' : ''}</small>
                        </div>
                    ))}
                </section>
            )}

            {showForm && (
                <section className="loss-card loss-form">
                    <div className="loss-row">
                        <label>
                            <span>Article</span>
                            <select value={productId} onChange={e => pickProduct(e.target.value ? Number(e.target.value) : '')}>
                                <option value="">— Choisir —</option>
                                {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                        </label>
                        {variants.length > 0 && (
                            <label>
                                <span>Taille / couleur</span>
                                <select value={variantId} onChange={e => setVariantId(e.target.value ? Number(e.target.value) : '')}>
                                    <option value="">— Choisir —</option>
                                    {variants.map(v => (
                                        <option key={v.id} value={v.id}>
                                            {[v.size, v.color].filter(Boolean).join(' / ')} ({v.stock_quantity} en stock)
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}
                        <label>
                            <span>Quantité</span>
                            <input type="number" min="0" step="any" value={quantity} onChange={e => setQuantity(e.target.value)} />
                        </label>
                        <label>
                            <span>Motif</span>
                            <select value={reason} onChange={e => setReason(e.target.value as LossReason)}>
                                {REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </select>
                        </label>
                    </div>
                    <label className="loss-notes">
                        <span>Note (optionnel)</span>
                        <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Ex : trouvé déchiré en cabine" />
                    </label>
                    <div className="loss-actions">
                        <button className="loss-cancel" onClick={() => setShowForm(false)}>Annuler</button>
                        <button className="loss-primary" onClick={submit} disabled={busy}>Enregistrer</button>
                    </div>
                    <p className="loss-hint">La marchandise sera retirée du stock immédiatement.</p>
                </section>
            )}

            <section className="loss-card">
                <h3><AlertTriangle size={16} /> Historique</h3>
                {losses.length === 0 ? (
                    <p className="loss-hint">Aucune perte enregistrée.</p>
                ) : (
                    <table className="loss-table">
                        <thead>
                            <tr><th>Date</th><th>Article</th><th>Motif</th><th>Qté</th><th>Coût</th><th>Note</th><th /></tr>
                        </thead>
                        <tbody>
                            {losses.map(l => (
                                <tr key={l.id}>
                                    <td>{formatDateTime(l.created_at)}</td>
                                    <td>{l.product_name}</td>
                                    <td><span className={`loss-badge ${l.reason}`}>{reasonLabel(l.reason)}</span></td>
                                    <td className="num">{l.quantity}</td>
                                    <td className="num">{formatCurrency(l.total_cost)}</td>
                                    <td className="note">{l.notes || '—'}</td>
                                    <td>
                                        <button className="loss-undo" onClick={() => revert(l.id)} title="Annuler et remettre en stock">
                                            <Undo2 size={14} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    )
}
