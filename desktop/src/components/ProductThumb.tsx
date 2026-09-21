import { useState } from 'react'
import { Shirt } from 'lucide-react'

/* ---------------------------------------------------------------------------
   The garment, or a stand-in for it.

   A clothing shop is picked from by eye, so the POS grid, the product list and
   the cart all show a photo. Most shops will not have photographed their whole
   catalogue on day one, and a grid of grey squares makes the entire screen read
   as broken — so the FALLBACK IS DESIGNED, not empty:

     • a tinted tile with a garment glyph, and
     • the product's initials, so two placeholders side by side are still
       distinguishable at a glance.

   The tint is derived from the product id, not chosen: it is decoration that
   makes a wall of placeholders scannable, and it never carries meaning. Nothing
   anywhere reads a state off this colour.

   Files are served over the `dapper-img://` protocol registered in
   productImageService.ts — never file://, which the renderer blocks.
   --------------------------------------------------------------------------- */

const IMAGE_SCHEME = 'dapper-img'

export const productImageUrl = (fileName: string | null | undefined): string | null =>
    fileName ? `${IMAGE_SCHEME}://${encodeURIComponent(fileName)}` : null

/** Two letters, so "Chemise Oxford" and "Chemise Lin" do not both read "CH". */
function initials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean)
    if (!words.length) return '—'
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
    return (words[0][0] + words[1][0]).toUpperCase()
}

/** Eight quiet tints. Stable per product because the id picks the slot, so a
 *  product keeps the same placeholder between screens and between sessions. */
const TINTS = 8
const tintFor = (id: number) => Math.abs(id) % TINTS

export function ProductThumb({ productId, name, image, size = 36, className = '', radius }: {
    productId: number
    name: string
    /** Stored file name from product_images.image_path, if the product has one. */
    image?: string | null
    /** Rendered edge in px, or 'fill' to take the parent's box (POS tiles). */
    size?: number | 'fill'
    className?: string
    radius?: number
}) {
    const [failed, setFailed] = useState(false)
    const url = failed ? null : productImageUrl(image)

    const style: React.CSSProperties = size === 'fill'
        ? { width: '100%', height: '100%' }
        : { width: size, height: size, flexShrink: 0 }
    if (radius !== undefined) style.borderRadius = radius

    return (
        <span
            className={`pthumb pthumb--t${tintFor(productId)} ${className}`}
            style={style}
            aria-hidden="true"
        >
            {url ? (
                <img
                    src={url}
                    alt=""
                    loading="lazy"
                    // A photo whose file has been deleted under us must fall back to
                    // the placeholder, not to a broken-image icon.
                    onError={() => setFailed(true)}
                />
            ) : (
                <>
                    <Shirt className="pthumb-glyph" strokeWidth={1.5} />
                    <span className="pthumb-initials">{initials(name)}</span>
                </>
            )}
        </span>
    )
}
