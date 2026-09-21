import { useState, useEffect } from 'react'
import { Tag, Trash2, Plus } from 'lucide-react'
import { formatCurrency } from '../utils/formatters'
import type { Product, Category } from '../../shared/types'
import './PromotionsManager.css'

interface Rule {
    id: number
    name: string
    rule_type: string
    product_id: number | null
    category_id: number | null
    min_quantity: number
    discount_type: 'percentage' | 'fixed' | 'price_override'
    discount_value: number
    start_date: string | null
    end_date: string | null
    is_active: number
}

/** Promotions screen — a thin editor over the pricing_rules engine that the POS
 *  already consults on every line (applyBulkPrice). Creating a rule here makes it
 *  live at the till immediately; no separate wiring. */
export function PromotionsManager() {
    const [rules, setRules] = useState<Rule[]>([])
    const [products, setProducts] = useState<Product[]>([])
    const [categories, setCategories] = useState<Category[]>([])
    const [showForm, setShowForm] = useState(false)
    const [error, setError] = useState('')

    const [form, setForm] = useState({
        name: '',
        target: 'product' as 'product' | 'category',
        product_id: '' as number | '',
        category_id: '' as number | '',
        discount_type: 'percentage' as Rule['discount_type'],
        discount_value: '' as number | '',
        min_quantity: '1' as number | string,
        start_date: '',
        end_date: ''
    })

    const load = async () => {
        const nextRules = await window.electron.pricing.listRules()
        setRules(nextRules)
        const nextProducts = await window.electron.product.getAll()
        setProducts(nextProducts)
        const nextCategories = await window.electron.category.getAll()
        setCategories(nextCategories)
    }

    useEffect(() => {
        load()
    }, [])

    const reset = () => setForm({
        name: '', target: 'product', product_id: '', category_id: '',
        discount_type: 'percentage', discount_value: '', min_quantity: '1', start_date: '', end_date: ''
    })

    const submit = async () => {
        setError('')
        if (!form.name.trim()) return setError('Donnez un nom à la promotion.')
        if (form.discount_value === '' || Number(form.discount_value) <= 0) return setError('Valeur de remise invalide.')
        if (form.target === 'product' && !form.product_id) return setError('Choisissez un article.')
        if (form.target === 'category' && !form.category_id) return setError('Choisissez une famille.')
        if (form.discount_type === 'percentage' && Number(form.discount_value) > 100) return setError('Une remise ne peut pas dépasser 100 %.')
        if (form.start_date && form.end_date && form.end_date < form.start_date) return setError('La date de fin précède la date de début.')

        await window.electron.pricing.createRule({
            name: form.name.trim(),
            rule_type: 'promotional',
            product_id: form.target === 'product' ? Number(form.product_id) : null,
            category_id: form.target === 'category' ? Number(form.category_id) : null,
            min_quantity: Number(form.min_quantity) || 1,
            discount_type: form.discount_type,
            discount_value: Number(form.discount_value),
            start_date: form.start_date || null,
            end_date: form.end_date || null
        })
        reset()
        setShowForm(false)
        load()
    }

    const remove = async (r: Rule) => {
        if (!confirm(`Supprimer la promotion « ${r.name} » ?`)) return
        await window.electron.pricing.deleteRule(r.id)
        load()
    }

    const toggle = async (r: Rule) => {
        await window.electron.pricing.setActive(r.id, !r.is_active)
        load()
    }

    const targetLabel = (r: Rule) => {
        if (r.product_id) return products.find(p => p.id === r.product_id)?.name || `Article #${r.product_id}`
        if (r.category_id) return `Famille : ${categories.find(c => c.id === r.category_id)?.name || r.category_id}`
        return 'Tous les articles'
    }

    const discountLabel = (r: Rule) => {
        if (r.discount_type === 'percentage') return `−${r.discount_value} %`
        if (r.discount_type === 'fixed') return `−${formatCurrency(r.discount_value)}`
        return `Prix fixe ${formatCurrency(r.discount_value)}`
    }

    const windowLabel = (r: Rule) => {
        if (!r.start_date && !r.end_date) return 'Permanente'
        return `${r.start_date || '…'} → ${r.end_date || '…'}`
    }

    const promos = rules.filter(r => r.rule_type === 'promotional')
    const others = rules.filter(r => r.rule_type !== 'promotional')

    return (
        <div className="promo-screen">
            <header className="promo-header">
                <div>
                    <h1>Promotions</h1>
                    <p>Les remises s'appliquent automatiquement en caisse.</p>
                </div>
                <button className="promo-primary" onClick={() => { reset(); setShowForm(v => !v); setError('') }}>
                    <Plus size={16} /> Nouvelle promotion
                </button>
            </header>

            {error && <div className="promo-error">{error}</div>}

            {showForm && (
                <section className="promo-card promo-form">
                    <div className="promo-row">
                        <label>
                            <span>Nom</span>
                            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ex : Soldes d'été" />
                        </label>
                        <label>
                            <span>S'applique à</span>
                            <select value={form.target} onChange={e => setForm(f => ({ ...f, target: e.target.value as 'product' | 'category' }))}>
                                <option value="product">Un article</option>
                                <option value="category">Une famille</option>
                            </select>
                        </label>
                        <label>
                            <span>{form.target === 'product' ? 'Article' : 'Famille'}</span>
                            {form.target === 'product' ? (
                                <select value={form.product_id} onChange={e => setForm(f => ({ ...f, product_id: Number(e.target.value) }))}>
                                    <option value="">— Choisir —</option>
                                    {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                </select>
                            ) : (
                                <select value={form.category_id} onChange={e => setForm(f => ({ ...f, category_id: Number(e.target.value) }))}>
                                    <option value="">— Choisir —</option>
                                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                </select>
                            )}
                        </label>
                    </div>

                    <div className="promo-row">
                        <label>
                            <span>Type de remise</span>
                            <select value={form.discount_type} onChange={e => setForm(f => ({ ...f, discount_type: e.target.value as Rule['discount_type'] }))}>
                                <option value="percentage">Pourcentage (%)</option>
                                <option value="fixed">Montant fixe (DZD)</option>
                                <option value="price_override">Prix imposé (DZD)</option>
                            </select>
                        </label>
                        <label>
                            <span>Valeur</span>
                            <input type="number" min="0" value={form.discount_value}
                                onChange={e => setForm(f => ({ ...f, discount_value: e.target.value === '' ? '' : Number(e.target.value) }))} />
                        </label>
                        <label>
                            <span>Quantité minimum</span>
                            <input type="number" min="1" value={form.min_quantity}
                                onChange={e => setForm(f => ({ ...f, min_quantity: e.target.value }))} />
                        </label>
                    </div>

                    <div className="promo-row">
                        <label>
                            <span>Début (optionnel)</span>
                            <input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} />
                        </label>
                        <label>
                            <span>Fin (optionnel)</span>
                            <input type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} />
                        </label>
                    </div>

                    <div className="promo-actions">
                        <button className="promo-cancel" onClick={() => setShowForm(false)}>Annuler</button>
                        <button className="promo-primary" onClick={submit}>Créer</button>
                    </div>
                </section>
            )}

            <section className="promo-card">
                <h3><Tag size={16} /> Promotions ({promos.length})</h3>
                {promos.length === 0 ? (
                    <p className="promo-hint">Aucune promotion. Créez-en une pour l'appliquer automatiquement en caisse.</p>
                ) : (
                    <table className="promo-table">
                        <thead>
                            <tr><th>Nom</th><th>Cible</th><th>Remise</th><th>Qté min</th><th>Période</th><th>État</th><th /></tr>
                        </thead>
                        <tbody>
                            {promos.map(r => (
                                <tr key={r.id} className={r.is_active ? '' : 'inactive'}>
                                    <td>{r.name}</td>
                                    <td>{targetLabel(r)}</td>
                                    <td className="num">{discountLabel(r)}</td>
                                    <td className="num">{r.min_quantity}</td>
                                    <td>{windowLabel(r)}</td>
                                    <td>
                                        <button className="promo-toggle" onClick={() => toggle(r)}>
                                            {r.is_active ? 'Active' : 'Inactive'}
                                        </button>
                                    </td>
                                    <td>
                                        <button className="promo-del" onClick={() => remove(r)} aria-label="Supprimer">
                                            <Trash2 size={14} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>

            {others.length > 0 && (
                <section className="promo-card">
                    <h3>Autres règles de prix ({others.length})</h3>
                    <p className="promo-hint">Remises quantité et paliers, gérées ailleurs — affichées ici pour information.</p>
                    <table className="promo-table">
                        <tbody>
                            {others.map(r => (
                                <tr key={r.id} className={r.is_active ? '' : 'inactive'}>
                                    <td>{r.name}</td>
                                    <td>{r.rule_type}</td>
                                    <td>{targetLabel(r)}</td>
                                    <td className="num">{discountLabel(r)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}
        </div>
    )
}
