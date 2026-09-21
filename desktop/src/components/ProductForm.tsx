import { useState, useEffect, useCallback, useRef } from 'react'
import type { Product, Category, Supplier } from '../../shared/types'
import { useLanguage } from '../LanguageContext'
import { ProductImagePicker } from './ImagePicker'
import './ProductForm.css'

interface ProductFormProps {
    product?: Product | null
    /** Who is saving — photos are a product mutation and the main process checks
     *  `products.update` before touching the image store. */
    userId: number
    onSave: () => void
    onCancel: () => void
}

/** Composite key for a size×colour cell. JSON-encoded so ("M","Bleu ciel") and
 *  ("M Bleu","ciel") stay distinct — mirrors variantKey() in productService.ts. */
const vkey = (size: string, color: string) => JSON.stringify([size, color])

/** Chip editor for one variant axis. Enter or comma commits the typed value. */
function AxisEditor({ label, values, onChange, placeholder, presets }: {
    label: string
    values: string[]
    onChange: (v: string[]) => void
    placeholder?: string
    presets?: Record<string, string[]>
}) {
    const [draft, setDraft] = useState('')

    const add = (raw: string) => {
        const next = raw.split(',').map(s => s.trim()).filter(Boolean)
        if (!next.length) return
        onChange([...values, ...next.filter(v => !values.includes(v))])
        setDraft('')
    }

    return (
        <div className="form-group" style={{ marginBottom: 12 }}>
            <label>{label}</label>
            {values.length > 0 && (
                <div className="variant-chips">
                    {values.map(v => (
                        <span key={v} className="variant-chip">
                            {v}
                            <button type="button" onClick={() => onChange(values.filter(x => x !== v))} aria-label={`Retirer ${v}`}>×</button>
                        </span>
                    ))}
                </div>
            )}
            <input
                type="text"
                value={draft}
                placeholder={placeholder}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                        // Enter here must add a chip, never submit the product form.
                        e.preventDefault()
                        add(draft)
                    }
                }}
                onBlur={() => add(draft)}
            />
            {presets && (
                <div className="variant-presets">
                    {Object.entries(presets).map(([name, vals]) => (
                        <button
                            key={name}
                            type="button"
                            onClick={() => onChange(Array.from(new Set([...values, ...vals])))}
                        >
                            + {name}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

/** Starting points, not a fixed vocabulary — every one of these is editable and
 *  the shop can type anything. They exist because typing "Noir, Blanc, Bleu
 *  Marine, Beige, Gris" for the fortieth shirt is the reason people stop
 *  entering colours at all. */
const COLOR_PRESETS: Record<string, string[]> = {
    'Neutres': ['Noir', 'Blanc', 'Gris', 'Beige'],
    'Costume': ['Bleu Marine', 'Noir', 'Gris Anthracite', 'Bleu Ciel'],
    'Saison': ['Bordeaux', 'Vert Olive', 'Camel', 'Marron'],
}

const SIZE_PRESETS: Record<string, string[]> = {
    'S · M · L': ['S', 'M', 'L', 'XL', 'XXL'],
    'Costume': ['46', '48', '50', '52', '54', '56', '58'],
    'Pantalon': ['38', '40', '42', '44', '46', '48'],
    'Chaussure': ['39', '40', '41', '42', '43', '44', '45'],
    'Enfant': ['2A', '4A', '6A', '8A', '10A', '12A'],
}

export function ProductForm({ product, userId, onSave, onCancel }: ProductFormProps) {
    const { t } = useLanguage()
    const [categories, setCategories] = useState<Category[]>([])
    const [suppliers, setSuppliers] = useState<Supplier[]>([])
    const [taxCategories, setTaxCategories] = useState<{ id: number; name: string; rate: number }[]>([])
    const [saving, setSaving] = useState(false)
    const [errors, setErrors] = useState<Record<string, string>>({})
    const [printLabelOnCreate, setPrintLabelOnCreate] = useState(true)
    // Multi-supplier per article (Phase 4.5)
    const [prodSuppliers, setProdSuppliers] = useState<{ supplier_id: number | string; supplier_ref: string; cost_price: number | string; is_preferred: boolean }[]>([])

    // Size × colour variants (Dapper Phase 1). Both axes are optional: a garment uses
    // both, a belt sizes only, a scarf colours only. With variants on, stock is held
    // per combination and the single "current stock" field above no longer applies.
    //
    // DEFAULT ON for a new article. This is a clothing shop: a garment is only
    // sellable, stockable and scannable as a specific size×colour, so treating
    // variants as an opt-in extra had it backwards — the common case cost a
    // checkbox and the rare one (a belt, a tie clip) cost nothing. An EXISTING
    // product still shows what it actually has: the loader below turns it on
    // only when the product really carries variants, and never off for one that
    // does not.
    const [useVariants, setUseVariants] = useState(!product)

    /* -- Photos ---------------------------------------------------------------
       A photo belongs to a product row, so a brand-new article has nowhere to
       put one yet. Rather than staging files in the renderer (which leaks an
       orphan into userData every time somebody abandons the form), creating an
       article KEEPS THIS DIALOG OPEN on its photo step: the product exists, the
       picker lights up, and the footer button becomes "Terminer".
       ---------------------------------------------------------------------- */
    const [images, setImages] = useState<{ id: number; image_path: string; is_primary: number }[]>([])
    /** Set once a NEW article has been written, so the picker has an id to use. */
    const [createdId, setCreatedId] = useState<number | null>(null)
    const photoTarget = product?.id ?? createdId

    /** The id handed back by create(), read after the try block closes. */
    const newIdRef = useRef<number | null>(null)

    const loadImages = useCallback(async () => {
        if (!photoTarget) { setImages([]); return }
        try {
            setImages(await window.electron.product.images(photoTarget))
        } catch { setImages([]) }
    }, [photoTarget])

    useEffect(() => { loadImages() }, [loadImages])
    const [sizes, setSizes] = useState<string[]>([])
    const [colors, setColors] = useState<string[]>([])
    // Keyed by vkey(size, colour) so a colour containing a space can't collide.
    const [variantQty, setVariantQty] = useState<Record<string, number | string>>({})

    const [formData, setFormData] = useState({
        sku: '',
        barcode: '',
        name: '',
        category_id: null as number | null,
        supplier_id: null as number | null,
        cost_price: '' as number | string,
        retail_price: '' as number | string,
        min_stock_level: '' as number | string,
        is_active: 1,
        tax_category_id: 1,
        lead_time_days: '' as number | string,
        initial_stock: '' as number | string,
        // New inventory fields
        reference: '',
        marque: '',
        devation: '',
        designation_fournisseur: '',
        unite: 'piece',
        qtes_cmnds: '' as number | string,
        delai_livraison: '' as number | string
    })

    useEffect(() => {
        const loadDat = async () => {
            try {
                // Add safety checks if window.electron is missing (though parent likely checks)
                if (window.electron) {
                    setCategories(await window.electron.category.getAll())
                    setSuppliers(await window.electron.supplier.getAll())
                    if (window.electron.taxCategory) setTaxCategories(await window.electron.taxCategory.getAll())
                }
            } catch (e) {
                console.error("Error loading form data", e)
            }
        }
        loadDat()

        if (product) {
            setFormData({
                sku: product.sku || '',
                barcode: product.barcode || '',
                name: product.name,
                category_id: product.category_id,
                supplier_id: product.supplier_id,
                cost_price: product.cost_price,
                retail_price: product.retail_price,
                min_stock_level: product.min_stock_level,
                is_active: product.is_active,
                tax_category_id: product.tax_category_id,
                lead_time_days: product.lead_time_days,
                initial_stock: product.stock_quantity ?? 0,
                // New inventory fields
                reference: product.reference || '',
                marque: product.marque || '',
                devation: product.devation || '',
                designation_fournisseur: product.designation_fournisseur || '',
                unite: product.unite || 'piece',
                qtes_cmnds: product.qtes_cmnds ?? 0,
                delai_livraison: product.delai_livraison ?? 0
            })
            if (window.electron?.product?.getSuppliers) {
                window.electron.product.getSuppliers(product.id)
                    .then(s => setProdSuppliers(s.map((x: any) => ({ supplier_id: x.supplier_id, supplier_ref: x.supplier_ref || '', cost_price: x.cost_price ?? '', is_preferred: !!x.is_preferred }))))
                    .catch(() => {})
            }
            if (window.electron?.product?.getVariants) {
                window.electron.product.getVariants(product.id)
                    .then(rows => {
                        // An existing simple article stays simple; only the new-product
                        // path defaults to sizes and colours.
                        if (!rows.length) { setUseVariants(false); return }
                        // Rebuild the two axes from the stored combinations. Rows arrive in
                        // sort_order, so first-seen order preserves S < M < L < XL.
                        const sizeList: string[] = []
                        const colorList: string[] = []
                        const qty: Record<string, number | string> = {}
                        for (const r of rows) {
                            if (r.size && !sizeList.includes(r.size)) sizeList.push(r.size)
                            if (r.color && !colorList.includes(r.color)) colorList.push(r.color)
                            qty[vkey(r.size, r.color)] = r.stock_quantity
                        }
                        setSizes(sizeList)
                        setColors(colorList)
                        setVariantQty(qty)
                        setUseVariants(true)
                    })
                    .catch(() => {})
            }
        }
    }, [product])

    /* The "Colisage (conditionnements)" editor that used to live alongside this
       is gone. It came from the electrical-distributor domain — "Carton = 12,
       Palette = 480" — and a boutique sells one shirt. Its only reader was the
       POS cart's unit selector, which was already removed, so the section had
       become a form that wrote data nothing read.

       It only STOPS writing: product.getUnits/setUnits and any rows an existing
       article already carries are untouched, so restoring the feature is a UI
       job, not a data recovery job. */
    const saveSuppliers = async (productId: number) => {
        if (window.electron?.product?.setSuppliers) {
            const cleanS = prodSuppliers
                .filter(s => Number(s.supplier_id) > 0)
                .map(s => ({ supplier_id: Number(s.supplier_id), supplier_ref: s.supplier_ref || null, cost_price: Number(s.cost_price) || 0, is_preferred: s.is_preferred }))
            await window.electron.product.setSuppliers(productId, cleanS)
        }
    }

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        const { name, value, type } = e.target

        // Custom handling for quantity/stock fields to support 'm' suffix and decimals
        // Keep as string to allow typing "50.5m" or "0.5" without immediate conversion
        if (name === 'initial_stock' || name === 'min_stock_level' || name === 'reorder_point') {
            // Allow: digits, dots, commas, 'm', and spaces
            const allowedChars = /^[\d.,m\s]*$/i
            if (allowedChars.test(value) || value === '') {
                setFormData(prev => ({
                    ...prev,
                    [name]: value // Keep as string for typing
                }))
            }
        } else {
            setFormData(prev => ({
                ...prev,
                [name]: type === 'number' ? (value === '' ? '' : parseFloat(value)) : value
            }))
        }
        setErrors(prev => ({ ...prev, [name]: '' }))
    }


    const validate = () => {
        const newErrors: Record<string, string> = {}
        if (!formData.name.trim()) newErrors.name = 'Le nom de l’article est obligatoire.'
        if (Number(formData.retail_price) <= 0) newErrors.retail_price = 'Le prix de vente doit être supérieur à 0.'
        setErrors(newErrors)
        return Object.keys(newErrors).length === 0
    }

    // Helper to parse stock values like "50.5m", "100,5", etc.
    const parseStockValue = (val: string | number): number => {
        if (typeof val === 'number') return val
        if (!val || val === '') return 0
        // Remove 'm', spaces, and convert comma to dot
        const cleaned = String(val).toLowerCase().replace(/[m\s]/g, '').replace(',', '.')
        const num = parseFloat(cleaned)
        return isNaN(num) ? 0 : num
    }

    /** Every sellable combination implied by the two axes. One axis empty = single-axis
     *  product (belt = sizes only, scarf = colours only); both empty = no variants. */
    const variantCells = (): { size: string; color: string; sort_order: number }[] => {
        if (!useVariants || (!sizes.length && !colors.length)) return []
        const rows = sizes.length ? sizes : ['']
        const cols = colors.length ? colors : ['']
        const out: { size: string; color: string; sort_order: number }[] = []
        rows.forEach((s, si) => cols.forEach((c, ci) => {
            // Size is the primary axis so the grid reads S < M < L < XL.
            out.push({ size: s, color: c, sort_order: si * 1000 + ci })
        }))
        return out
    }

    const saveVariants = async (productId: number) => {
        if (!window.electron?.product?.setVariants) return
        const cells = variantCells()
        // An empty list deactivates every existing combination — that's how turning the
        // toggle off (or clearing both axes) is expressed. Rows are never hard-deleted.
        await window.electron.product.setVariants(productId, cells.map(c => ({
            size: c.size,
            color: c.color,
            sort_order: c.sort_order,
            quantity: parseStockValue(variantQty[vkey(c.size, c.color)] ?? 0)
        })))
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!validate()) return

        setSaving(true)
        setErrors({})
        try {
            if (product) {
                await window.electron.product.update(product.id, formData)
                // With variants on, stock is per size×colour — writing the single field here
                // would land on the product's base row, which is not sellable at the till.
                if (!useVariants && formData.initial_stock !== undefined && formData.initial_stock !== null) {
                    await window.electron.product.updateStock(product.id, parseStockValue(formData.initial_stock))
                }
                await saveSuppliers(product.id)
                await saveVariants(product.id)
            } else {
                // Create new product
                // Make sure we parse the stock before creating
                const dataToSave = {
                    ...formData,
                    initial_stock: useVariants ? 0 : parseStockValue(formData.initial_stock),
                    min_stock_level: parseStockValue(formData.min_stock_level)
                }
                const created: any = await window.electron.product.create(dataToSave as any)
                const newId = Number(created?.lastInsertRowid)
                newIdRef.current = newId || null
                if (newId) {
                    await saveSuppliers(newId)
                    await saveVariants(newId)
                }

                // Print barcode label if option is checked and barcode exists
                if (printLabelOnCreate && formData.barcode) {
                    try {
                        // Pass false explicitly for preview when creating
                        await window.electron.label.print({
                            name: formData.name,
                            barcode: formData.barcode,
                            price: Number(formData.retail_price)
                        }, {
                            width: 39,
                            height: 19,
                            showPrice: true,
                            showName: true,
                            showBarcode: true
                        }, false)
                    } catch (labelError) {
                        console.error('Failed to print label:', labelError)
                    }
                }
            }
            // A NEW article stays on screen so its photos can be attached now —
            // the row exists, so the picker has an id to hang them on. An edit
            // closes as before.
            if (!product) {
                setCreatedId(newIdRef.current)
                setSaving(false)
                return
            }
            onSave()
        } catch (error: any) {
            console.error('Failed to save product:', error)

            // Handle duplicate SKU or Barcode error
            if (error.message?.includes('UNIQUE constraint failed')) {
                if (error.message.includes('products.sku')) {
                    setErrors({ sku: 'Ce SKU est déjà utilisé par un autre article.' })
                } else if (error.message.includes('products.barcode')) {
                    setErrors({ barcode: 'Ce code-barres est déjà utilisé par un autre article.' })
                } else {
                    alert('Un article avec ce SKU ou ce code-barres existe déjà.')
                }
            } else {
                alert('Enregistrement de l’article impossible.')
            }
        } finally {
            setSaving(false)
        }
    }

    const profitMargin = Number(formData.retail_price) > 0
        ? ((Number(formData.retail_price) - Number(formData.cost_price)) / Number(formData.retail_price) * 100).toFixed(1)
        : '0'

    return (
        <div className="product-form-overlay">
            <div className="product-form">
                <div className="form-header">
                    <h2>{product ? t('inventory.editProduct') : t('inventory.newProduct')}</h2>
                    <button className="btn-close" onClick={onCancel}>×</button>
                </div>

                <form onSubmit={handleSubmit}>
                    {createdId && (
                        <div className="pf-created" role="status">
                            <strong>« {formData.name} » {t('pform.saved')}</strong>
                            <span>{t('pform.savedHint')}</span>
                        </div>
                    )}
                    <div className="form-grid">
                        <div className="form-section">
                            <h3>{t('inventory.basicInfo')}</h3>

                            <div className="form-row">
                                <div className="form-group">
                                    <label>{t('inventory.name')} *</label>
                                    <input
                                        type="text"
                                        name="name"
                                        value={formData.name}
                                        onChange={handleChange}
                                        className={errors.name ? 'error' : ''}
                                    />
                                    {errors.name && <span className="error-text">{errors.name}</span>}
                                </div>
                            </div>

                            <div className="form-row two-col">
                                <div className="form-group">
                                    <label>{t('inventory.sku')}</label>
                                    <input
                                        type="text"
                                        name="sku"
                                        value={formData.sku}
                                        onChange={handleChange}
                                        className={errors.sku ? 'error' : ''}
                                    />
                                    {errors.sku && <span className="error-text">{errors.sku}</span>}
                                </div>
                                <div className="form-group">
                                    <label>{t('inventory.barcode')}</label>
                                    <input
                                        type="text"
                                        name="barcode"
                                        value={formData.barcode}
                                        onChange={handleChange}
                                        className={errors.barcode ? 'error' : ''}
                                    />
                                    {errors.barcode && <span className="error-text">{errors.barcode}</span>}
                                </div>
                            </div>


                            <div className="form-row two-col">
                                <div className="form-group">
                                    <label>{t('inventory.category')}</label>
                                    <select name="category_id" value={formData.category_id || ''} onChange={handleChange}>
                                        <option value="">{t('inventory.noCategory')}</option>
                                        {categories.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label>{t('inventory.suppliers')}</label>
                                    <select name="supplier_id" value={formData.supplier_id || ''} onChange={handleChange}>
                                        <option value="">-- {t('inventory.suppliers')} --</option>
                                        {suppliers.map(sup => <option key={sup.id} value={sup.id}>{sup.company_name}</option>)}
                                    </select>
                                </div>
                            </div>
                        </div>

                        <div className="form-section">
                            <h3>{t('inventory.pricing')}</h3>

                            <div className="form-row two-col">
                                <div className="form-group">
                                    <label>{t('inventory.cost')}</label>
                                    <input type="number" name="cost_price" value={formData.cost_price} onChange={handleChange} step="0.01" min="0" />
                                </div>
                                <div className="form-group">
                                    <label>{t('inventory.retail')} *</label>
                                    <input type="number" name="retail_price" value={formData.retail_price} onChange={handleChange} step="0.01" min="0" className={errors.retail_price ? 'error' : ''} />
                                    {errors.retail_price && <span className="error-text">{errors.retail_price}</span>}
                                </div>
                            </div>

                            {/* Prix Gros / Demi-Gros removed in Phase 4 — Dapper is a retail
                                shop with a single shelf price. The columns remain in the
                                schema but are no longer read (see docs/DAPPER_PLAN.md §3.1). */}

                            <div className="form-row two-col">
                                <div className="form-group">
                                    <label>TVA</label>
                                    <select name="tax_category_id" value={formData.tax_category_id} onChange={handleChange}>
                                        {taxCategories.length === 0 && <option value={1}>Standard (19%)</option>}
                                        {taxCategories.map(tc => (
                                            <option key={tc.id} value={tc.id}>{tc.name} ({tc.rate}%)</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div className="profit-margin">
                                {t('inventory.margin')} : <strong>{profitMargin} %</strong>
                            </div>
                        </div>

                        <div className="form-section">
                            <h3>{t('inventory.stockSettings')}</h3>

                            <div className="form-row two-col">
                                <div className="form-group">
                                    <label>{t('inventory.alertLevel')}</label>
                                    <input type="text" name="min_stock_level" value={formData.min_stock_level} onChange={handleChange} placeholder="0" />
                                </div>
                                <div className="form-group">
                                    <label>{product ? t('inventory.currentStock') : t('inventory.initialStock')}</label>
                                    <input
                                        type="text"
                                        name="initial_stock"
                                        value={useVariants ? '' : formData.initial_stock}
                                        onChange={handleChange}
                                        disabled={useVariants}
                                        placeholder={useVariants ? 'Par taille/couleur' : '0'}
                                    />
                                </div>
                            </div>

                            <div className="form-row checkboxes">
                                {!product && (
                                    <label className="checkbox-label" style={{ marginLeft: 'auto', color: 'var(--accent)', fontWeight: 600 }}>
                                        <input type="checkbox" checked={printLabelOnCreate} onChange={(e) => setPrintLabelOnCreate(e.target.checked)} />
                                        🖨️ {t('inventory.printLabel')}
                                    </label>
                                )}
                            </div>
                        </div>

                        {/* Tailles et couleurs — one row per sellable size×colour
                            combination. This is the DEFAULT shape of an article here:
                            a garment is only sellable, stockable and scannable as a
                            specific size and colour, so the grid leads and the
                            "article simple" escape hatch trails. */}
                        <div className="form-section form-section--wide">
                            <h3 style={{ margin: '0 0 4px' }}>{t('pform.sizesColors')}</h3>
                            <p style={{ fontSize: '0.8em', color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
                                {t('pform.sizesHint')}
                                son propre code-barres. Le stock se saisit dans la grille
                                ci-dessous, pas dans « stock initial ».
                            </p>

                            {useVariants && (
                                <>
                                    <AxisEditor
                                        label={t('pform.sizes')}
                                        values={sizes}
                                        onChange={setSizes}
                                        placeholder={t('pform.sizePh')}
                                        presets={SIZE_PRESETS}
                                    />
                                    <AxisEditor
                                        label={t('pform.colors')}
                                        values={colors}
                                        onChange={setColors}
                                        placeholder={t('pform.colorPh')}
                                        presets={COLOR_PRESETS}
                                    />

                                    {variantCells().length === 0 ? (
                                        <p style={{ opacity: 0.7, fontSize: 13 }}>
                                            {t('pform.addAxis')}
                                        </p>
                                    ) : (
                                        <div>
                                            <table className="variant-grid">
                                                <thead>
                                                    <tr>
                                                        <th />
                                                        {(colors.length ? colors : ['—']).map(c => <th key={c}>{c}</th>)}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {(sizes.length ? sizes : ['—']).map(s => (
                                                        <tr key={s}>
                                                            <th scope="row">{s}</th>
                                                            {(colors.length ? colors : ['']).map(c => {
                                                                const key = vkey(sizes.length ? s : '', c)
                                                                return (
                                                                    <td key={c || '_'}>
                                                                        <input
                                                                            type="text"
                                                                            inputMode="numeric"
                                                                            aria-label={`Stock ${s} ${c}`.trim()}
                                                                            value={variantQty[key] ?? ''}
                                                                            onChange={(e) => setVariantQty(prev => ({ ...prev, [key]: e.target.value }))}
                                                                            placeholder="0"
                                                                        />
                                                                    </td>
                                                                )
                                                            })}
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                            <p style={{ opacity: 0.7, fontSize: 12, marginTop: 6 }}>
                                                {t('ui.total')} : {variantCells().reduce((sum, c) => sum + parseStockValue(variantQty[vkey(c.size, c.color)] ?? 0), 0)} pièces
                                            </p>
                                        </div>
                                    )}
                                </>
                            )}

                            <label className="checkbox-label" style={{ marginTop: 14 }}>
                                <input
                                    type="checkbox"
                                    checked={!useVariants}
                                    onChange={(e) => setUseVariants(!e.target.checked)}
                                />
                                {t('pform.simpleItem')}
                                <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, marginLeft: 6 }}>
                                    {t('pform.simpleEg')}
                                </span>
                            </label>
                        </div>

                        {/* Photos. A clothing shop is picked from by eye: this image is
                            what the till tile, the product list and the cart line all
                            show. */}
                        <div className="form-section form-section--wide">
                            <h3 style={{ margin: '0 0 4px' }}>{t('ui.photos')}</h3>
                            <p style={{ fontSize: '0.8em', color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
                                {t('pform.photoHint')}
                                produits et dans le panier.
                            </p>
                            <ProductImagePicker
                                productId={photoTarget}
                                userId={userId}
                                images={images}
                                onChange={loadImages}
                            />
                        </div>

                        {/* Advanced Inventory Fields Section */}
                        <div className="form-section">
                            <h3>{t('pform.advanced')}</h3>

                            <div className="form-row two-col">
                                <div className="form-group">
                                    <label>Reference</label>
                                    <input
                                        type="text"
                                        name="reference"
                                        value={formData.reference}
                                        onChange={handleChange}
                                        placeholder="REF-001"
                                    />
                                </div>
                                <div className="form-group">
                                    <label>Marque</label>
                                    <input
                                        type="text"
                                        name="marque"
                                        value={formData.marque}
                                        onChange={handleChange}
                                        placeholder={t('last.brandPh')}
                                    />
                                </div>
                            </div>

                            <div className="form-row two-col">
                                <div className="form-group">
                                    <label>{t('last.variation')}</label>
                                    <input
                                        type="text"
                                        name="devation"
                                        value={formData.devation}
                                        onChange={handleChange}
                                        placeholder={t('last.variation')}
                                    />
                                </div>
                                <div className="form-group">
                                    <label>{t('last.supplierRef')}</label>
                                    <input
                                        type="text"
                                        name="designation_fournisseur"
                                        value={formData.designation_fournisseur}
                                        onChange={handleChange}
                                        placeholder={t('last.supplierRef')}
                                    />
                                </div>
                            </div>

                            <div className="form-row three-col">
                                <div className="form-group">
                                    <label>{t('last.unit')}</label>
                                    <select name="unite" value={formData.unite} onChange={handleChange}>
                                        <option value="piece">{t('last.piece')}</option>
                                        <option value="paire">Paire</option>
                                        <option value="lot">Lot</option>
                                        <option value="boite">{t('last.box')}</option>
                                        <option value="carton">Carton</option>
                                        <option value="paquet">Paquet</option>
                                        {/* Kept for goods genuinely sold by length (tissu, ruban) —
                                            this is what drives the cut-to-length entry at payment. */}
                                        <option value="metre">{t('last.metre')}</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label>{t('last.orderQty')}</label>
                                    <input
                                        type="number"
                                        name="qtes_cmnds"
                                        value={formData.qtes_cmnds}
                                        onChange={handleChange}
                                        min="0"
                                        placeholder="0"
                                    />
                                </div>
                                <div className="form-group">
                                    <label>{t('last.leadDays')}</label>
                                    <input
                                        type="number"
                                        name="delai_livraison"
                                        value={formData.delai_livraison}
                                        onChange={handleChange}
                                        min="0"
                                        placeholder="7"
                                    />
                                </div>
                            </div>
                        </div>
                        <div className="form-section form-section--wide">
                                <h3>{t('last.multiSupplier')}</h3>
                            <p style={{ fontSize: '0.8em', color: 'var(--text-muted)', margin: '0 0 8px' }}>
                                {t('last.multiSupplierHint')}
                            </p>
                            {prodSuppliers.map((s, idx) => (
                                <div key={idx} className="pf-supplier-row">
                                    <select
                                        value={s.supplier_id}
                                        onChange={e => setProdSuppliers(prodSuppliers.map((x, i) => i === idx ? { ...x, supplier_id: e.target.value } : x))}
                                    >
                                        <option value="">{t('last.pickSupplier')}</option>
                                        {suppliers.map(sup => <option key={sup.id} value={sup.id}>{sup.company_name}</option>)}
                                    </select>
                                    <input
                                        placeholder={t('last.supRefPh')}
                                        value={s.supplier_ref}
                                        onChange={e => setProdSuppliers(prodSuppliers.map((x, i) => i === idx ? { ...x, supplier_ref: e.target.value } : x))}
                                    />
                                    <input
                                        type="number" min="0" step="any"
                                        placeholder={t('last.costPh')}
                                        value={s.cost_price}
                                        className="pf-sup-cost"
                                        onChange={e => setProdSuppliers(prodSuppliers.map((x, i) => i === idx ? { ...x, cost_price: e.target.value } : x))}
                                    />
                                    <label className="checkbox-label pf-sup-pref">
                                        <input
                                            type="checkbox"
                                            checked={s.is_preferred}
                                            onChange={e => setProdSuppliers(prodSuppliers.map((x, i) => ({ ...x, is_preferred: i === idx ? e.target.checked : false })))}
                                        /> {t('last.preferred')}
                                    </label>
                                    <button type="button" className="btn-secondary" onClick={() => setProdSuppliers(prodSuppliers.filter((_, i) => i !== idx))}>✕</button>
                                </div>
                            ))}
                            <button type="button" className="btn-secondary" onClick={() => setProdSuppliers([...prodSuppliers, { supplier_id: '', supplier_ref: '', cost_price: '', is_preferred: false }])}>
                                + {t('last.addSupplier')}
                            </button>
                        </div>
                    </div>


                    <div className="form-actions">
                        <button type="button" className="btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>

                        <div className="pf-label-tools">
                            <button
                                type="button"
                                className="btn-secondary"
                                disabled={!formData.barcode}
                                title={!formData.barcode ? "Saisissez d’abord un code-barres" : "Aperçu de l’étiquette"}
                                onClick={() => window.electron.label.print({
                                    name: formData.name || 'Nouvel article',
                                    barcode: formData.barcode,
                                    price: Number(formData.retail_price) || 0
                                }, {
                                    width: 39,
                                    height: 19,
                                    showPrice: true,
                                    showName: true,
                                    showBarcode: true
                                }, true)}
                            >
                                🔍 {t('inventory.previewLabel')}
                            </button>
                            <button
                                type="button"
                                className="btn-secondary"
                                disabled={!formData.barcode}
                                title={!formData.barcode ? "Saisissez d’abord un code-barres" : "Imprimer l’étiquette"}
                                onClick={() => window.electron.label.print({
                                    name: formData.name || 'Nouvel article',
                                    barcode: formData.barcode,
                                    price: Number(formData.retail_price) || 0
                                }, {
                                    width: 39,
                                    height: 19,
                                    showPrice: true,
                                    showName: true,
                                    showBarcode: true
                                }, false)}
                            >
                                🖨️ {t('inventory.printLabel')}
                            </button>
                        </div>

                        {createdId ? (
                            <button type="button" className="btn-primary" onClick={onSave}>
                                {t('ui.finish')}
                            </button>
                        ) : (
                            <button type="submit" className="btn-primary" disabled={saving}>
                                {saving ? t('common.loading') : (product ? t('inventory.updateProduct') : t('inventory.createProduct'))}
                            </button>
                        )}
                    </div>
                </form>
            </div>
        </div>
    )
}
