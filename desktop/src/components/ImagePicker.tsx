import { useState, useCallback } from 'react'
import { ImagePlus, Star, Trash2, Loader2 } from 'lucide-react'
import { productImageUrl } from './ProductThumb'
import { useLanguage } from '../LanguageContext'
import './ImagePicker.css'

/* ---------------------------------------------------------------------------
   Adding photographs.

   Two shapes, one component, because they are the same job with a different
   cardinality and letting them drift would mean two sets of error handling for
   one native dialog:

     • a PRODUCT has a gallery — several photos, one of them primary (the one
       the POS tile and the cart line show);
     • a CATEGORY has exactly one — the department tile at the top of the till.

   Both go through the main process: the renderer never touches the filesystem,
   the file is COPIED into userData (an owner importing from a USB stick that is
   gone tomorrow must not end up with a catalogue of dead paths), and it comes
   back over the `dapper-img://` protocol.

   "cancelled" is not an error. Closing the OS picker is the most common thing
   that happens to a file dialog, and showing an alert for it would train the
   user to dismiss alerts.
   --------------------------------------------------------------------------- */

interface ProductImage {
    id: number
    image_path: string
    is_primary: number
}

/** A product's gallery. */
export function ProductImagePicker({ productId, userId, images, onChange, compact = false }: {
    /** null while the product is being CREATED — photos attach after the first save. */
    productId: number | null
    userId: number
    images: ProductImage[]
    onChange: () => void
    compact?: boolean
}) {
    const { t } = useLanguage()
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const add = useCallback(async () => {
        if (!productId) return
        setBusy(true); setError('')
        try {
            const res = await window.electron.product.pickImage(productId, userId)
            if (!res.ok) { setError(res.message); return }
            if (!res.data.success && res.data.error && res.data.error !== 'cancelled') {
                setError(res.data.error); return
            }
            onChange()
        } finally { setBusy(false) }
    }, [productId, userId, onChange])

    const makePrimary = async (imageId: number) => {
        const res = await window.electron.product.setPrimaryImage(imageId, userId)
        if (!res.ok) { setError(res.message); return }
        onChange()
    }

    const remove = async (imageId: number) => {
        const res = await window.electron.product.removeImage(imageId, userId)
        if (!res.ok) { setError(res.message); return }
        onChange()
    }

    if (!productId) {
        return (
            <div className="imgpick">
                <p className="el-hint">
                    {t('img.saveFirst')}
                    elles se rattachent à sa fiche.
                </p>
            </div>
        )
    }

    return (
        <div className={`imgpick ${compact ? 'is-compact' : ''}`}>
            <div className="imgpick-grid">
                {images.map(img => (
                    <div key={img.id} className={`imgpick-cell ${img.is_primary ? 'is-primary' : ''}`}>
                        <img src={productImageUrl(img.image_path) || ''} alt="" />
                        {/* The primary photo is the one the till shows, so which one it
                            is has to be visible without hovering. */}
                        {img.is_primary === 1 && (
                            <span className="imgpick-badge"><Star size={11} fill="currentColor" /> {t('img.primary')}</span>
                        )}
                        <div className="imgpick-actions">
                            {img.is_primary !== 1 && (
                                <button
                                    type="button"
                                    onClick={() => makePrimary(img.id)}
                                    title={t('img.makePrimary')}
                                    aria-label={t('img.makePrimary')}
                                >
                                    <Star size={14} />
                                </button>
                            )}
                            <button
                                type="button"
                                className="is-danger"
                                onClick={() => remove(img.id)}
                                title={t('ui.remove')}
                                aria-label={t('img.deletePhoto')}
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                    </div>
                ))}

                <button type="button" className="imgpick-add" onClick={add} disabled={busy}>
                    {busy ? <Loader2 size={20} className="imgpick-spin" /> : <ImagePlus size={20} />}
                    <span>{images.length ? t('img.add') : t('img.addPhoto')}</span>
                </button>
            </div>

            {error && <span className="el-error-text">{error}</span>}
            <p className="el-hint">
                {t('img.limits')}
                apparaît sur la caisse et dans le panier.
            </p>
        </div>
    )
}

/** A category's single tile image. */
export function CategoryImagePicker({ categoryId, userId, image, onChange }: {
    categoryId: number
    userId: number
    image: string | null
    onChange: () => void
}) {
    const { t } = useLanguage()
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const pick = async () => {
        setBusy(true); setError('')
        try {
            const res = await window.electron.category.pickImage(categoryId, userId)
            if (!res.ok) { setError(res.message); return }
            if (!res.data.success && res.data.error && res.data.error !== 'cancelled') {
                setError(res.data.error); return
            }
            onChange()
        } finally { setBusy(false) }
    }

    const clear = async () => {
        const res = await window.electron.category.clearImage(categoryId, userId)
        if (!res.ok) { setError(res.message); return }
        onChange()
    }

    const url = productImageUrl(image)

    return (
        <div className="imgpick-one">
            <button
                type="button"
                className={`imgpick-one-tile ${url ? 'has-img' : ''}`}
                onClick={pick}
                disabled={busy}
                title={url ? t('img.changeImage') : t('img.addImage')}
                aria-label={url ? t('img.changeImage') : t('img.addImage')}
            >
                {url
                    ? <img src={url} alt="" />
                    : (busy ? <Loader2 size={18} className="imgpick-spin" /> : <ImagePlus size={18} />)}
            </button>
            {url && (
                <button type="button" className="el-btn el-btn--ghost imgpick-one-clear" onClick={clear}>
                    {t('img.removeImage')}
                </button>
            )}
            {error && <span className="el-error-text">{error}</span>}
        </div>
    )
}
