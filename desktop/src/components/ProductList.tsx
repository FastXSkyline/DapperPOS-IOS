import { useState, useEffect, useCallback, useRef } from 'react'
import {
    Search, Plus, Package, Pencil, Trash2, Printer, MoreHorizontal,
    ChevronLeft, ChevronRight, FolderTree, X,
} from 'lucide-react'
import type { Product, Category } from '../../shared/types'
import { ProductThumb } from './ProductThumb'
import { CategoryManager } from './CategoryManager'
import { ProductDetail } from './ProductDetail'
import { formatCurrency, formatAmount } from '../utils/formatters'
import { useLanguage } from '../LanguageContext'
import './ProductList.css'

/* ---------------------------------------------------------------------------
   Produits — the catalogue screen from the approved mockup.

   A photo, a name, a family, a price, a total stock, a status. Nothing else on
   the row, because the row's job is to let you FIND the article; everything you
   might want to know about it lives one click deeper in ProductDetail, which is
   where the mockup puts the Général / Variants / Stock / Mouvements / Images
   tabs.

   The old screen carried three unrelated things behind tabs — products, a
   low-stock list, and a supplier CRUD. The low-stock list is now Inventaire's
   job (and does it better, with one state per line instead of three
   overlapping ones); suppliers have their own sidebar entry. What is left is
   one list that does one thing.
   --------------------------------------------------------------------------- */

interface ProductListProps {
    onEdit: (product: Product) => void
    onAdd: () => void
    userId: number
    refreshKey?: number
    onInventoryChange?: () => void
}

type StatusFilter = 'all' | 'active' | 'inactive'

const PAGE_SIZE = 20

export function ProductList({ onEdit, onAdd, userId, refreshKey, onInventoryChange }: ProductListProps) {
    const { t } = useLanguage()
    const [products, setProducts] = useState<Product[]>([])
    const [categories, setCategories] = useState<Category[]>([])
    const [imageMap, setImageMap] = useState<Record<number, string>>({})
    const [search, setSearch] = useState('')
    const [status, setStatus] = useState<StatusFilter>('all')
    const [categoryFilter, setCategoryFilter] = useState<number | null>(null)
    const [page, setPage] = useState(0)
    const [totalCount, setTotalCount] = useState(0)
    const [loading, setLoading] = useState(true)
    const [showCategories, setShowCategories] = useState(false)
    const [detailId, setDetailId] = useState<number | null>(null)
    /** Which row's menu is open, and where to paint it. The coordinates are
     *  viewport-relative: the menu is `position: fixed`, because any ancestor
     *  that scrolls would otherwise clip it. */
    const [menu, setMenu] = useState<{ id: number; top: number; right: number } | null>(null)
    const searchRef = useRef<HTMLInputElement>(null)

    const loadProducts = useCallback(async () => {
        setLoading(true)
        try {
            const filters = {
                search: search || undefined,
                categoryId: categoryFilter || undefined,
                limit: PAGE_SIZE,
                offset: page * PAGE_SIZE,
            }
            const [data, count] = await Promise.all([
                window.electron.product.getAll(filters),
                window.electron.product.getCount(filters),
            ])
            setProducts(data)
            setTotalCount(count)
        } catch (error) {
            console.error('[Produits] load failed:', error)
        } finally {
            setLoading(false)
        }
    }, [search, categoryFilter, page])

    const loadCategories = useCallback(async () => {
        try { setCategories(await window.electron.category.getAll()) } catch { /* ignore */ }
    }, [])

    useEffect(() => { loadCategories() }, [loadCategories])
    useEffect(() => { loadProducts() }, [loadProducts, refreshKey])

    // One call for the whole page's photos rather than one per row.
    useEffect(() => {
        window.electron?.product?.imageMap?.().then(setImageMap).catch(() => setImageMap({}))
    }, [products, refreshKey])

    useEffect(() => {
        const timer = setTimeout(() => searchRef.current?.focus(), 250)
        return () => clearTimeout(timer)
    }, [])

    // A filter change must reset paging, or filtering from page 3 shows nothing.
    useEffect(() => { setPage(0) }, [search, categoryFilter, status])

    useEffect(() => {
        const close = () => setMenu(null)
        window.addEventListener('click', close)
        // Scrolling or resizing would leave a fixed menu stranded away from its
        // row, so it closes rather than chasing the button.
        window.addEventListener('scroll', close, true)
        window.addEventListener('resize', close)
        return () => {
            window.removeEventListener('click', close)
            window.removeEventListener('scroll', close, true)
            window.removeEventListener('resize', close)
        }
    }, [])

    /** Open the row menu under (or above) the button that was pressed. */
    const openMenu = (e: React.MouseEvent, id: number) => {
        e.stopPropagation()
        if (menu?.id === id) { setMenu(null); return }
        const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const MENU_H = 132
        // Open upward when there is not room below, so the last rows of a full
        // page do not need scrolling to reach Modifier.
        const flip = b.bottom + MENU_H > window.innerHeight - 8
        setMenu({
            id,
            top: flip ? b.top - MENU_H - 4 : b.bottom + 4,
            right: window.innerWidth - b.right,
        })
    }

    const handleDelete = async (product: Product) => {
        if (!confirm(`${t('prod.deleteAsk')} « ${product.name} » ?`)) return
        await window.electron.product.delete(product.id)
        await loadProducts()
        onInventoryChange?.()
    }

    const printLabel = async (product: Product) => {
        if (!product.barcode) { alert(t('prod.noBarcode')); return }
        await window.electron.label.print(
            { name: product.name, barcode: product.barcode, price: product.retail_price },
            { width: 39, height: 19, showPrice: true, showName: true, showBarcode: true },
            false,
        )
    }

    // `is_active` is not a server-side filter on product.getAll, so the status
    // segment narrows the page that came back. It is labelled as a filter on the
    // page, not on the catalogue, by the count in the footer.
    const visible = products.filter(p =>
        status === 'all' ? true : status === 'active' ? p.is_active === 1 : p.is_active !== 1)

    const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

    if (detailId !== null) {
        return (
            <ProductDetail
                productId={detailId}
                userId={userId}
                onBack={() => { setDetailId(null); loadProducts() }}
                onEdit={onEdit}
                onChanged={() => { loadProducts(); onInventoryChange?.() }}
            />
        )
    }

    return (
        <div className="el-page">
            <div className="el-page-head">
                <div>
                    <h1 className="el-page-title">{t('nav.products')}</h1>
                    <p className="el-page-sub">{t('prod.subtitle')}</p>
                </div>
                <div className="el-page-actions">
                    <button className="el-btn el-btn--secondary" onClick={() => setShowCategories(true)}>
                        <FolderTree size={15} /> {t('ui.families')}
                    </button>
                    <button className="el-btn el-btn--primary" onClick={onAdd}>
                        <Plus size={15} /> {t('prod.newProduct')}
                    </button>
                </div>
            </div>

            <div className="pl-toolbar">
                <label className="el-search pl-search">
                    <Search size={15} />
                    <input
                        ref={searchRef}
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder={t('prod.searchPh')}
                        aria-label={t('prod.searchPh')}
                    />
                </label>

                <div className="el-segmented">
                    {([['all', t('ui.all')], ['active', t('ui.active')], ['inactive', t('ui.inactive')]] as const).map(([id, label]) => (
                        <button
                            key={id}
                            className={`el-seg ${status === id ? 'active' : ''}`}
                            onClick={() => setStatus(id)}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                <select
                    className="el-pill pl-cat"
                    value={categoryFilter ?? 'all'}
                    onChange={e => setCategoryFilter(e.target.value === 'all' ? null : Number(e.target.value))}
                    aria-label={t('ui.category')}
                >
                    <option value="all">{t('prod.allFamilies')}</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
            </div>

            <div className="el-card el-card--pad0">
                <div className="el-table-wrap">
                    <table className="el-table">
                        <thead>
                            <tr>
                                <th>{t('ui2.product')}</th>
                                <th>{t('ui.category')}</th>
                                <th className="num">{t('ui2.price')}</th>
                                <th className="num">{t('ui2.stockTotal')}</th>
                                <th>{t('ui.status')}</th>
                                <th aria-label={t('ui.actionsCol')} />
                            </tr>
                        </thead>
                        <tbody>
                            {visible.map(product => {
                                const stock = product.stock_quantity ?? 0
                                const low = product.min_stock_level > 0 && stock <= product.min_stock_level
                                return (
                                    <tr
                                        key={product.id}
                                        className="is-clickable"
                                        onClick={() => setDetailId(product.id)}
                                    >
                                        <td>
                                            <span className="el-cell-product">
                                                <ProductThumb
                                                    productId={product.id}
                                                    name={product.name}
                                                    image={imageMap[product.id]}
                                                    size={36}
                                                />
                                                <span>{product.name}</span>
                                            </span>
                                        </td>
                                        <td className="muted">{product.category_name || '—'}</td>
                                        <td className="num">{formatCurrency(product.retail_price)}</td>
                                        <td className={`num strong ${stock <= 0 ? 'pl-zero' : low ? 'pl-low' : ''}`}>
                                            {formatAmount(stock)}
                                        </td>
                                        <td>
                                            <span className={`el-chip ${product.is_active === 1 ? 'el-chip--ok' : 'el-chip--neutral'}`}>
                                                {product.is_active === 1 ? t('ui.active') : t('ui.inactive')}
                                            </span>
                                        </td>
                                        <td className="num pl-actions" onClick={e => e.stopPropagation()}>
                                            <button
                                                className="el-icon-btn"
                                                onClick={e => openMenu(e, product.id)}
                                                aria-haspopup="menu"
                                                aria-expanded={menu?.id === product.id}
                                                aria-label={`Actions pour ${product.name}`}
                                            >
                                                <MoreHorizontal size={16} />
                                            </button>
                                            {menu?.id === product.id && (
                                                <div
                                                    className="pl-menu"
                                                    role="menu"
                                                    style={{ top: menu.top, right: menu.right }}
                                                    onClick={e => e.stopPropagation()}
                                                >
                                                    <button role="menuitem" onClick={() => { setMenu(null); onEdit(product) }}>
                                                        <Pencil size={14} /> {t('ui.edit')}
                                                    </button>
                                                    <button role="menuitem" onClick={() => { setMenu(null); printLabel(product) }}>
                                                        <Printer size={14} /> {t('prod.printLabel')}
                                                    </button>
                                                    <button
                                                        role="menuitem"
                                                        className="is-danger"
                                                        onClick={() => { setMenu(null); handleDelete(product) }}
                                                    >
                                                        <Trash2 size={14} /> {t('ui.remove')}
                                                    </button>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>

                    {!loading && visible.length === 0 && (
                        <div className="el-empty">
                            <span className="el-empty-icon"><Package size={22} /></span>
                            <strong>{search || categoryFilter ? t('ui.noResult') : t('prod.noProduct')}</strong>
                            <span>
                                {search || categoryFilter
                                    ? t('prod.noMatchHint')
                                    : t('prod.noProductHint')}
                            </span>
                        </div>
                    )}
                    {loading && <div className="el-empty">{t('ui.loading')}</div>}
                </div>

                {totalCount > 0 && (
                    <div className="el-table-foot">
                        {t('prod.totalN')} {totalCount}
                        <span className="el-page-actions pl-pager">
                            <button
                                className="el-icon-btn el-icon-btn--bordered"
                                disabled={page === 0}
                                onClick={() => setPage(p => Math.max(0, p - 1))}
                                aria-label={t('prod.prevPage')}
                            >
                                <ChevronLeft size={15} />
                            </button>
                            <span className="pl-page-num">{page + 1} / {pageCount}</span>
                            <button
                                className="el-icon-btn el-icon-btn--bordered"
                                disabled={page + 1 >= pageCount}
                                onClick={() => setPage(p => p + 1)}
                                aria-label={t('prod.nextPage')}
                            >
                                <ChevronRight size={15} />
                            </button>
                        </span>
                    </div>
                )}
            </div>

            {showCategories && (
                <div className="el-modal-overlay" onClick={() => setShowCategories(false)}>
                    <div
                        className="el-modal el-modal--wide pl-cat-modal"
                        onClick={e => e.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                    >
                        <div className="el-modal-head">
                            <h2>{t('cat.title')}</h2>
                            <button
                                className="el-icon-btn el-modal-x"
                                onClick={() => setShowCategories(false)}
                                aria-label={t('ui.close')}
                            >
                                <X size={18} />
                            </button>
                        </div>
                        <div className="el-modal-body">
                            <CategoryManager
                                userId={userId}
                                onChanged={() => { loadCategories(); loadProducts() }}
                            />
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
