import { useState, useEffect } from 'react'
import { Plus, Trash2, ChevronRight, FolderTree, Pencil, Check, X } from 'lucide-react'
import type { Category } from '../../shared/types'
import { CategoryImagePicker } from './ImagePicker'
import { useLanguage } from '../LanguageContext'
import './CategoryManager.css'

interface CategoryManagerProps {
    /** Photos are a catalogue mutation; the main process checks `products.update`. */
    userId: number
    /** Called after any change so the parent screen can refresh its category filter. */
    onChanged?: () => void
    onClose?: () => void
}

/**
 * Familles d'articles.
 *
 * Everything goes through window.electron.category.* — this component used to
 * import the main-process CategoryService directly, which cannot work in the
 * renderer (no better-sqlite3 there), so nothing was ever saved.
 *
 * Each family now carries an IMAGE. That is not decoration: the till opens on a
 * row of department tiles and the shop picks "Costumes" before it picks a
 * garment, so the tile needs a picture for the same reason the product card
 * does. `categories.image_path` has been in the schema from the beginning with
 * nothing writing to it.
 */
export function CategoryManager({ userId, onChanged, onClose }: CategoryManagerProps) {
    const { t } = useLanguage()
    const [categories, setCategories] = useState<Category[]>([])
    const [flatCategories, setFlatCategories] = useState<Category[]>([])
    const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
    const [newCategoryName, setNewCategoryName] = useState('')
    const [newCategoryParent, setNewCategoryParent] = useState<number | null>(null)
    const [showAddForm, setShowAddForm] = useState(false)
    const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    const loadCategories = async () => {
        const tree = await window.electron.category.getTree()
        setCategories(tree)
        setFlatCategories(await window.electron.category.getAll())
        const allIds = new Set<number>()
        const collectIds = (cats: Category[]) => {
            cats.forEach(c => {
                allIds.add(c.id)
                if (c.children) collectIds(c.children)
            })
        }
        collectIds(tree)
        setExpandedIds(allIds)
    }

    useEffect(() => { loadCategories() }, [])

    const refresh = async () => {
        await loadCategories()
        onChanged?.()
    }

    const toggleExpand = (id: number) => {
        setExpandedIds(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const handleAdd = async () => {
        const name = newCategoryName.trim()
        if (!name) return setError(t('cat.nameRequired'))
        if (flatCategories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
            return setError(`« ${name} » ${t('cat.exists')}`)
        }

        setBusy(true)
        setError('')
        try {
            await window.electron.category.create({
                name,
                parent_id: newCategoryParent,
                icon: null,
                image_path: null,
                sort_order: 0,
                is_active: 1,
            })
            setNewCategoryName('')
            setNewCategoryParent(null)
            setShowAddForm(false)
            await refresh()
        } catch {
            setError(t('cat.saveFailed'))
        } finally {
            setBusy(false)
        }
    }

    const handleRename = async () => {
        if (!renaming?.name.trim()) return
        await window.electron.category.update(renaming.id, { name: renaming.name.trim() })
        setRenaming(null)
        await refresh()
    }

    const handleDelete = async (id: number) => {
        // Soft delete (is_active = 0): products keep pointing at the category, so
        // history and existing articles are never orphaned.
        if (!confirm(t('cat.hideAsk'))) return
        await window.electron.category.delete(id)
        await refresh()
    }

    const renderCategory = (category: Category, level = 0) => {
        const hasChildren = !!category.children?.length
        const open = expandedIds.has(category.id)
        const isRenaming = renaming?.id === category.id

        return (
            <div key={category.id} className="cat-item" style={{ marginInlineStart: level * 22 }}>
                <div className="cat-row">
                    {hasChildren ? (
                        <button
                            className="cat-expand"
                            onClick={() => toggleExpand(category.id)}
                            aria-label={open ? 'Replier' : 'Déplier'}
                        >
                            <ChevronRight size={14} className={open ? 'is-open' : ''} />
                        </button>
                    ) : (
                        <span className="cat-expand-space" />
                    )}

                    {/* The tile picture, editable in place — the family list IS the
                        place you look after noticing an empty tile at the till. */}
                    <CategoryImagePicker
                        categoryId={category.id}
                        userId={userId}
                        image={category.image_path ?? null}
                        onChange={refresh}
                    />

                    {isRenaming ? (
                        <>
                            <input
                                className="el-input cat-rename"
                                value={renaming.name}
                                autoFocus
                                onChange={e => setRenaming({ id: category.id, name: e.target.value })}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') handleRename()
                                    if (e.key === 'Escape') setRenaming(null)
                                }}
                            />
                            <button className="el-icon-btn" onClick={handleRename} aria-label={t('cat.validate')}>
                                <Check size={15} />
                            </button>
                            <button className="el-icon-btn" onClick={() => setRenaming(null)} aria-label={t('ui.cancelBtn')}>
                                <X size={15} />
                            </button>
                        </>
                    ) : (
                        <>
                            <span className="cat-name">{category.name}</span>
                            <div className="cat-actions">
                                <button
                                    className="el-icon-btn"
                                    onClick={() => setRenaming({ id: category.id, name: category.name })}
                                    title={t('cat.rename')}
                                    aria-label={`Renommer ${category.name}`}
                                >
                                    <Pencil size={14} />
                                </button>
                                <button
                                    className="el-icon-btn"
                                    onClick={() => { setNewCategoryParent(category.id); setShowAddForm(true); setError('') }}
                                    title={t('cat.subFamily')}
                                    aria-label={`Sous-famille de ${category.name}`}
                                >
                                    <Plus size={15} />
                                </button>
                                <button
                                    className="el-icon-btn cat-danger"
                                    onClick={() => handleDelete(category.id)}
                                    title={t('cat.hide')}
                                    aria-label={`Masquer ${category.name}`}
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        </>
                    )}
                </div>

                {open && hasChildren && (
                    <div className="cat-children">
                        {category.children!.map(child => renderCategory(child, level + 1))}
                    </div>
                )}
            </div>
        )
    }

    return (
        <div className="cat-manager">
            <div className="el-card-head">
                <h2 className="el-card-title">{t('cat.title')}</h2>
                <div className="el-card-actions">
                    <button
                        className="el-btn el-btn--primary"
                        onClick={() => { setNewCategoryParent(null); setShowAddForm(true); setError('') }}
                    >
                        <Plus size={15} /> {t('cat.newFamily')}
                    </button>
                    {onClose && (
                        <button className="el-btn el-btn--secondary" onClick={onClose}>{t('ui.close')}</button>
                    )}
                </div>
            </div>

            <p className="el-hint cat-intro">
                {t('cat.intro')}
                image à chacune : c&apos;est ce que le vendeur touche avant de choisir
                l&apos;article.
            </p>

            {error && <div className="emp-banner is-error" role="alert">{error}</div>}

            {showAddForm && (
                <div className="cat-add">
                    <input
                        className="el-input"
                        type="text"
                        placeholder={t('cat.namePh')}
                        value={newCategoryName}
                        onChange={e => { setNewCategoryName(e.target.value); setError('') }}
                        onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
                        autoFocus
                    />
                    <select
                        className="el-select cat-add-parent"
                        value={newCategoryParent || ''}
                        onChange={e => setNewCategoryParent(e.target.value ? Number(e.target.value) : null)}
                    >
                        <option value="">{t('cat.root')}</option>
                        {flatCategories.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
                    </select>
                    <button
                        className="el-btn el-btn--primary"
                        onClick={handleAdd}
                        disabled={busy || !newCategoryName.trim()}
                    >
                        {busy ? '…' : t('ui.add')}
                    </button>
                    <button
                        className="el-btn el-btn--secondary"
                        onClick={() => { setShowAddForm(false); setError('') }}
                    >
                        {t('ui.cancelBtn')}
                    </button>
                    {/* The image comes after the row exists — there is nothing to hang
                        a file on until then, and staging one would leak an orphan
                        whenever somebody abandons this form. */}
                    <span className="el-hint cat-add-hint">
                        {t('cat.imageAfter')}
                    </span>
                </div>
            )}

            <div className="cat-tree">
                {categories.length === 0 ? (
                    <div className="el-empty">
                        <span className="el-empty-icon"><FolderTree size={22} /></span>
                        <strong>{t('cat.noFamilies')}</strong>
                        <span>{t('cat.noFamiliesHint')}</span>
                    </div>
                ) : (
                    categories.map(cat => renderCategory(cat))
                )}
            </div>
        </div>
    )
}
