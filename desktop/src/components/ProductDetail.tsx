import { useState, useEffect, useCallback, useMemo } from 'react'
import { ArrowLeft, Pencil, Printer, Package, LayoutGrid, Rows3 } from 'lucide-react'
import type { Product } from '../../shared/types'
import type { VariantWithStock, StockMovementRow, StoreStock } from '../vite-env'
import { ProductThumb } from './ProductThumb'
import { ProductImagePicker } from './ImagePicker'
import { formatCurrency, formatAmount } from '../utils/formatters'
import { useLanguage } from '../LanguageContext'
import './ProductDetail.css'

/* ---------------------------------------------------------------------------
   One article — the detail screen from the approved mockup.

   Tabs: Général · Variants · Stock · Mouvements · Images.

   The Variants tab is the one that matters in a clothing shop and it has two
   shapes on purpose:

     • a LIST, when you want the SKU, the barcode and the price of a specific
       size (the mockup's default), and
     • a GRID, size down the side and colour across, when the question is "what
       am I missing" — which a list of 40 rows cannot answer at a glance.

   Nothing here writes to stock. Stock changes go through Inventaire, which
   records a movement and a reason; a silent write from a detail page is exactly
   the untraceable adjustment the ledger exists to prevent.
   --------------------------------------------------------------------------- */

type Tab = 'general' | 'variants' | 'stock' | 'movements' | 'images'

const TABS: { id: Tab; key: string }[] = [
    { id: 'general', key: 'ui2.general' },
    { id: 'variants', key: 'ui2.variants' },
    { id: 'stock', key: 'nav.inventory' },
    { id: 'movements', key: 'ui2.movements' },
    { id: 'images', key: 'ui2.images' },
]

/** A colour name mapped to something paintable, for the swatch beside a variant.
 *  Falls back to a neutral chip: inventing a hue for "Camel" would be a guess
 *  presented as fact, and the NAME is always printed next to it anyway. */
const COLOR_HEX: Record<string, string> = {
    noir: '#111111', blanc: '#FFFFFF', gris: '#9AA0AE', 'gris anthracite': '#3A3F4B',
    bleu: '#2563EB', 'bleu marine': '#1E3A5F', 'bleu ciel': '#7DD3FC', marine: '#1E3A5F',
    rouge: '#DC2626', bordeaux: '#7F1D2E', vert: '#16A34A', 'vert olive': '#5C6B3C',
    beige: '#D9C7A7', camel: '#B98B5E', marron: '#6B4423', jaune: '#EAB308',
    rose: '#F472B6', violet: '#7C3AED', orange: '#EA580C',
}
const colorHex = (name: string | null): string | null =>
    name ? (COLOR_HEX[name.trim().toLowerCase()] ?? null) : null

export function ProductDetail({ productId, userId, onBack, onEdit, onChanged }: {
    productId: number
    userId: number
    onBack: () => void
    onEdit: (p: Product) => void
    onChanged: () => void
}) {
    const { t } = useLanguage()
    const [tab, setTab] = useState<Tab>('general')
    const [product, setProduct] = useState<Product | null>(null)
    const [variants, setVariants] = useState<VariantWithStock[]>([])
    const [images, setImages] = useState<{ id: number; image_path: string; is_primary: number }[]>([])
    const [stores, setStores] = useState<StoreStock[]>([])
    const [movements, setMovements] = useState<StockMovementRow[]>([])
    const [variantView, setVariantView] = useState<'list' | 'grid'>('list')
    const [loading, setLoading] = useState(true)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const [p, v, img, st, mv] = await Promise.all([
                window.electron.product.getById(productId),
                window.electron.product.getVariants(productId).catch(() => []),
                window.electron.product.images(productId).catch(() => []),
                window.electron.inventory.acrossStores(productId, null).catch(() => []),
                window.electron.inventory.movements(null, productId, undefined, 60).catch(() => []),
            ])
            setProduct(p)
            setVariants(v)
            setImages(img)
            setStores(st)
            setMovements(mv)
        } catch (e) {
            console.error('[Produit] load failed:', e)
        } finally {
            setLoading(false)
        }
    }, [productId])

    useEffect(() => { load() }, [load])

    const primary = images.find(i => i.is_primary === 1) ?? images[0]

    const totalStock = useMemo(
        () => (variants.length
            ? variants.reduce((n, v) => n + (v.stock_quantity || 0), 0)
            : (product?.stock_quantity ?? 0)),
        [variants, product],
    )

    const stockValue = useMemo(
        () => totalStock * (product?.cost_price ?? 0),
        [totalStock, product],
    )

    // Axes in the order the shop entered them (sort_order), never alphabetical:
    // S < M < L < XL is the whole point.
    const sizes = useMemo(() => {
        const out: string[] = []
        for (const v of variants) if (v.size && !out.includes(v.size)) out.push(v.size)
        return out
    }, [variants])
    const colors = useMemo(() => {
        const out: string[] = []
        for (const v of variants) if (v.color && !out.includes(v.color)) out.push(v.color)
        return out
    }, [variants])

    const cell = (size: string, color: string) =>
        variants.find(v => (v.size || '') === size && (v.color || '') === color)

    const printLabel = async () => {
        if (!product?.barcode) { alert(t('prod.noBarcode')); return }
        await window.electron.label.print(
            { name: product.name, barcode: product.barcode, price: product.retail_price },
            { width: 39, height: 19, showPrice: true, showName: true, showBarcode: true },
            false,
        )
    }

    if (loading && !product) {
        return <div className="el-page"><div className="el-empty">{t('ui.loading')}</div></div>
    }
    if (!product) {
        return (
            <div className="el-page">
                <button className="el-btn el-btn--ghost pd-back" onClick={onBack}>
                    <ArrowLeft size={16} /> {t('nav.products')}
                </button>
                <div className="el-empty">
                    <span className="el-empty-icon"><Package size={22} /></span>
                    <strong>{t('pdet.notFound')}</strong>
                </div>
            </div>
        )
    }

    return (
        <div className="el-page pd">
            <div className="pd-head">
                <button className="el-icon-btn" onClick={onBack} aria-label={t('pdet.backToList')}>
                    <ArrowLeft size={18} />
                </button>
                <ProductThumb
                    productId={product.id}
                    name={product.name}
                    image={primary?.image_path}
                    size={44}
                />
                <div className="pd-title">
                    <h1>{product.name}</h1>
                    <span>
                        {product.category_name || t('inventory.noCategory')}
                        {product.sku ? ` · ${product.sku}` : ''}
                    </span>
                </div>
                <div className="el-page-actions">
                    <button className="el-btn el-btn--secondary" onClick={printLabel}>
                        <Printer size={15} /> {t('pdet.label')}
                    </button>
                    <button className="el-btn el-btn--primary" onClick={() => onEdit(product)}>
                        <Pencil size={15} /> {t('ui.edit')}
                    </button>
                </div>
            </div>

            <div className="el-tabs">
                {TABS.map(x => (
                    <button
                        key={x.id}
                        className={`el-tab ${tab === x.id ? 'active' : ''}`}
                        onClick={() => setTab(x.id)}
                    >
                        {t(x.key)}
                        {x.id === 'variants' && variants.length > 0 && (
                            <span className="pd-tab-count">{variants.length}</span>
                        )}
                    </button>
                ))}
            </div>

            {/* -------------------------------------------------------- Général -- */}
            {tab === 'general' && (
                <>
                    <div className="el-grid el-grid--stats">
                        <div className="el-stat">
                            <span className="el-stat-label">{t('pdet.salePrice')}</span>
                            <span className="el-stat-value">{formatCurrency(product.retail_price)}</span>
                            <span className="el-stat-foot"><span className="el-stat-note">{t('pdet.shelfPrice')}</span></span>
                        </div>
                        <div className="el-stat">
                            <span className="el-stat-label">{t('pdet.costPrice')}</span>
                            <span className="el-stat-value">{formatCurrency(product.cost_price)}</span>
                            <span className="el-stat-foot">
                                <span className="el-stat-note">
                                    {t('pdet.margin')} {product.retail_price > 0
                                        ? Math.round(((product.retail_price - product.cost_price) / product.retail_price) * 100)
                                        : 0} %
                                </span>
                            </span>
                        </div>
                        <div className="el-stat">
                            <span className="el-stat-label">{t('ui2.stockTotal')}</span>
                            <span className="el-stat-value">{formatAmount(totalStock)}</span>
                            <span className="el-stat-foot">
                                <span className="el-stat-note">
                                    {variants.length ? `${t('pdet.onVariants')} ${variants.length} ${t('pdet.variantsN')}` : t('inv.simpleItem')}
                                </span>
                            </span>
                        </div>
                        <div className="el-stat">
                            <span className="el-stat-label">{t('ui2.stockValue')}</span>
                            <span className="el-stat-value">{formatCurrency(stockValue)}</span>
                            <span className="el-stat-foot"><span className="el-stat-note">{t('inv.atCost')}</span></span>
                        </div>
                    </div>

                    <div className="el-split">
                        <section className="el-card">
                            <div className="el-card-head"><h2 className="el-card-title">{t('pdet.sheet')}</h2></div>
                            <dl className="pd-facts">
                                <div><dt>{t('ui2.reference')}</dt><dd>{product.reference || '—'}</dd></div>
                                <div><dt>{t('ui2.sku')}</dt><dd className="mono">{product.sku || '—'}</dd></div>
                                <div><dt>{t('ui2.barcode')}</dt><dd className="mono">{product.barcode || '—'}</dd></div>
                                <div><dt>{t('ui2.brand')}</dt><dd>{product.marque || '—'}</dd></div>
                                <div><dt>{t('ui.category')}</dt><dd>{product.category_name || '—'}</dd></div>
                                <div><dt>{t('ui2.supplier')}</dt><dd>{product.supplier_name || '—'}</dd></div>
                                <div><dt>{t('inventory.alertLevel')}</dt><dd>{product.min_stock_level || '—'}</dd></div>
                                <div>
                                    <dt>{t('ui.status')}</dt>
                                    <dd>
                                        <span className={`el-chip ${product.is_active === 1 ? 'el-chip--ok' : 'el-chip--neutral'}`}>
                                            {product.is_active === 1 ? t('ui.active') : t('ui.inactive')}
                                        </span>
                                    </dd>
                                </div>
                            </dl>
                        </section>

                        <section className="el-card">
                            <div className="el-card-head"><h2 className="el-card-title">{t('pdet.mainPhoto')}</h2></div>
                            <div className="pd-hero">
                                <ProductThumb
                                    productId={product.id}
                                    name={product.name}
                                    image={primary?.image_path}
                                    size="fill"
                                />
                            </div>
                            <button
                                className="el-btn el-btn--secondary el-btn--block pd-hero-btn"
                                onClick={() => setTab('images')}
                            >
                                {images.length ? `${t('pdet.managePhotos')} (${images.length})` : t('pdet.addPhoto')}
                            </button>
                        </section>
                    </div>
                </>
            )}

            {/* ------------------------------------------------------- Variants -- */}
            {tab === 'variants' && (
                <section className="el-card el-card--pad0">
                    <div className="el-card-head el-card-head--ruled">
                        <h2 className="el-card-title">{t('ui2.variants')} ({variants.length})</h2>
                        <div className="el-card-actions">
                            {/* Two views of one truth: the list answers "what is this
                                size's barcode", the grid answers "what am I missing". */}
                            <div className="el-segmented">
                                <button
                                    className={`el-seg ${variantView === 'list' ? 'active' : ''}`}
                                    onClick={() => setVariantView('list')}
                                    title={t('pdet.listView')}
                                    aria-label={t('pdet.listView')}
                                >
                                    <Rows3 size={14} />
                                </button>
                                <button
                                    className={`el-seg ${variantView === 'grid' ? 'active' : ''}`}
                                    onClick={() => setVariantView('grid')}
                                    title={t('pdet.gridView')}
                                    aria-label={t('pdet.gridView')}
                                >
                                    <LayoutGrid size={14} />
                                </button>
                            </div>
                        </div>
                    </div>

                    {variants.length === 0 ? (
                        <div className="el-empty">
                            <span className="el-empty-icon"><Package size={22} /></span>
                            <strong>{t('inv.simpleItem')}</strong>
                            <span>{t('pdet.noVariants')}</span>
                        </div>
                    ) : variantView === 'list' ? (
                        <div className="el-table-wrap">
                            <table className="el-table">
                                <thead>
                                    <tr>
                                        <th>{t('ui2.size')}</th>
                                        <th>{t('ui2.color')}</th>
                                        <th>{t('ui2.sku')}</th>
                                        <th>{t('ui2.barcode')}</th>
                                        <th className="num">{t('ui2.price')}</th>
                                        <th className="num">{t('nav.inventory')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {variants.map(v => (
                                        <tr key={v.id}>
                                            <td className="strong">{v.size || '—'}</td>
                                            <td>
                                                <span className="pd-color">
                                                    <i
                                                        className="el-swatch"
                                                        style={{ background: colorHex(v.color) ?? 'var(--bg-deep)' }}
                                                    />
                                                    {v.color || '—'}
                                                </span>
                                            </td>
                                            <td className="muted mono">{v.sku || '—'}</td>
                                            <td className="muted mono">{v.barcode || '—'}</td>
                                            <td className="num">
                                                {formatCurrency(v.retail_price ?? product.retail_price)}
                                            </td>
                                            <td className={`num strong ${v.stock_quantity <= 0 ? 'pl-zero' : ''}`}>
                                                {formatAmount(v.stock_quantity)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className="pd-matrix-wrap">
                            <table className="pd-matrix">
                                <thead>
                                    <tr>
                                        <th />
                                        {(colors.length ? colors : ['']).map(c => (
                                            <th key={c || '_'}>
                                                <span className="pd-color">
                                                    <i
                                                        className="el-swatch"
                                                        style={{ background: colorHex(c) ?? 'var(--bg-deep)' }}
                                                    />
                                                    {c || '—'}
                                                </span>
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {(sizes.length ? sizes : ['']).map(s => (
                                        <tr key={s || '_'}>
                                            <th scope="row">{s || '—'}</th>
                                            {(colors.length ? colors : ['']).map(c => {
                                                const v = cell(s, c)
                                                if (!v) return <td key={c || '_'} className="is-absent">—</td>
                                                const q = v.stock_quantity
                                                return (
                                                    <td
                                                        key={c || '_'}
                                                        className={q <= 0 ? 'is-out' : q <= 2 ? 'is-low' : 'is-ok'}
                                                        title={`${s} ${c} — ${q} en stock`}
                                                    >
                                                        {formatAmount(q)}
                                                    </td>
                                                )
                                            })}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <p className="el-hint pd-matrix-key">
                                {t('pdet.matrixKey')}
                                au catalogue ; un 0 veut dire qu&apos;elle existe et qu&apos;elle
                                est épuisée. Ce n&apos;est pas la même décision.
                            </p>
                        </div>
                    )}
                </section>
            )}

            {/* ---------------------------------------------------------- Stock -- */}
            {tab === 'stock' && (
                <section className="el-card el-card--pad0">
                    <div className="el-card-head el-card-head--ruled">
                        <h2 className="el-card-title">{t('pdet.stockByStore')}</h2>
                    </div>
                    <div className="el-table-wrap">
                        <table className="el-table">
                            <thead>
                                <tr>
                                    <th>{t('ui.store')}</th>
                                    <th className="num">{t('ui.quantity')}</th>
                                    <th className="num">{t('ui.value')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {stores.map(s => (
                                    <tr key={s.store_id}>
                                        <td className="strong">{s.store_name}</td>
                                        <td className={`num strong ${s.quantity <= 0 ? 'pl-zero' : ''}`}>
                                            {formatAmount(s.quantity)}
                                        </td>
                                        <td className="num">{formatCurrency(s.quantity * product.cost_price)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {stores.length === 0 && (
                            <div className="el-empty">{t('pdet.noStockItem')}</div>
                        )}
                    </div>
                    <div className="el-table-foot">
                        {/* Stock is never edited from here — see the file header. */}
                        {t('pdet.adjustNote')}
                    </div>
                </section>
            )}

            {/* ----------------------------------------------------- Mouvements -- */}
            {tab === 'movements' && (
                <section className="el-card el-card--pad0">
                    <div className="el-card-head el-card-head--ruled">
                        <h2 className="el-card-title">{t('ui2.movements')}</h2>
                    </div>
                    <div className="el-table-wrap">
                        <table className="el-table">
                            <thead>
                                <tr>
                                    <th>{t('ui.date')}</th>
                                    <th>{t('ui2.type')}</th>
                                    <th>{t('pdet.variant')}</th>
                                    <th>{t('ui.store')}</th>
                                    <th className="num">{t('ui.quantity')}</th>
                                    <th>{t('ui.reason')}</th>
                                    <th>{t('ui2.by')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {movements.map(m => (
                                    <tr key={m.id}>
                                        <td className="muted">{(m.created_at || '').slice(0, 16).replace('T', ' ')}</td>
                                        <td>
                                            <span className={`el-chip ${m.quantity < 0 ? 'el-chip--bad' : 'el-chip--ok'}`}>
                                                {m.movement_type}
                                            </span>
                                        </td>
                                        <td className="muted">
                                            {[m.size, m.color].filter(Boolean).join(' · ') || '—'}
                                        </td>
                                        <td className="muted">{m.store_name || '—'}</td>
                                        <td className={`num strong ${m.quantity < 0 ? 'pl-zero' : ''}`}>
                                            {m.quantity > 0 ? '+' : ''}{formatAmount(m.quantity)}
                                        </td>
                                        <td className="muted">{m.reason || '—'}</td>
                                        <td className="muted">{m.user_name || '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {movements.length === 0 && (
                            <div className="el-empty">{t('pdet.noMovesItem')}</div>
                        )}
                    </div>
                </section>
            )}

            {/* --------------------------------------------------------- Images -- */}
            {tab === 'images' && (
                <section className="el-card">
                    <div className="el-card-head">
                        <h2 className="el-card-title">{t('ui.photos')}</h2>
                    </div>
                    <ProductImagePicker
                        productId={product.id}
                        userId={userId}
                        images={images}
                        onChange={() => { load(); onChanged() }}
                    />
                </section>
            )}
        </div>
    )
}
