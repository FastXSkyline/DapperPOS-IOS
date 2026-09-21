import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { app, protocol, net, dialog } from 'electron'
import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// Product photographs.
//
// A clothing shop sells by eye. The POS grid, the product list and the cart all
// show the garment, and `product_images` has existed in the schema since the
// beginning with nothing ever writing to it.
//
// WHERE THE FILES LIVE: userData/product-images/, NOT the repo and NOT next to
// the database file. Copied in on import rather than referenced in place — the
// owner will import from a USB stick or a phone folder that is gone tomorrow,
// and a catalogue full of dead paths is worse than no photos.
//
// HOW THE RENDERER READS THEM: a registered `dapper-img://` protocol. The
// obvious alternatives are both bad — `file://` is blocked by the renderer's
// security settings (rightly), and shipping every photo as a base64 data URI
// would push a 50-tile POS grid into tens of megabytes of IPC per keystroke.
// The handler below resolves ONLY inside the images directory, so a crafted
// path cannot walk out of it.
// ---------------------------------------------------------------------------

export const IMAGE_SCHEME = 'dapper-img'

/** Extensions we accept. Deliberately short: these are shop photos, and every
 *  format here decodes natively in Chromium with no extra dependency. */
const ALLOWED = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']

/** 8 MB. A phone photo is 2–5 MB; anything larger is a scan or a mistake, and
 *  a hundred of them would make the userData folder the biggest thing on the
 *  shop PC. */
const MAX_BYTES = 8 * 1024 * 1024

function imagesDir(): string {
    const dir = path.join(app.getPath('userData'), 'product-images')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return dir
}

/**
 * Register the protocol. Must run BEFORE app.whenReady resolves for the
 * privileges to take effect, hence the split from the handler below.
 */
export function registerImageScheme(): void {
    protocol.registerSchemesAsPrivileged([{
        scheme: IMAGE_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false },
    }])
}

/** Serve dapper-img://<file> out of the images directory, and nothing else. */
export function serveImages(): void {
    protocol.handle(IMAGE_SCHEME, (request) => {
        try {
            const url = new URL(request.url)
            // The filename may arrive in the host or the path depending on how the
            // renderer wrote the URL; take the last non-empty segment either way.
            const raw = decodeURIComponent(`${url.hostname}${url.pathname}`)
            const name = path.basename(raw)

            const dir = imagesDir()
            const file = path.join(dir, name)

            // path.basename already strips any traversal, but assert the resolved
            // path really is inside the directory: this handler is reachable from
            // any renderer string, so the check is cheap insurance rather than a
            // restatement of the line above.
            if (!path.resolve(file).startsWith(path.resolve(dir))) {
                return new Response('Forbidden', { status: 403 })
            }
            if (!fs.existsSync(file)) return new Response('Not found', { status: 404 })

            return net.fetch(`file://${file.replace(/\\/g, '/')}`)
        } catch {
            return new Response('Bad request', { status: 400 })
        }
    })
}

/** The URL a renderer puts in an <img src>. */
export const imageUrl = (fileName: string | null | undefined): string | null =>
    fileName ? `${IMAGE_SCHEME}://${encodeURIComponent(fileName)}` : null

/** Copy one chosen file into the image store and hand back its new name.
 *  Shared by products and categories: both keep a file name in a column and both
 *  need the same validation, the same random naming and the same directory. */
function storeFile(sourcePath: string): { success: true; fileName: string } | { success: false; error: string } {
    if (!fs.existsSync(sourcePath)) return { success: false, error: 'Fichier introuvable.' }
    const ext = path.extname(sourcePath).toLowerCase()
    if (!ALLOWED.includes(ext)) {
        return { success: false, error: `Format non pris en charge (${ext || 'inconnu'}).` }
    }
    if (fs.statSync(sourcePath).size > MAX_BYTES) {
        return { success: false, error: 'Image trop lourde (max 8 Mo).' }
    }
    // Random name, not the original: two suppliers both sending "1.jpg" must not
    // overwrite each other, and the original name may carry anything.
    const fileName = `${crypto.randomBytes(10).toString('hex')}${ext}`
    fs.copyFileSync(sourcePath, path.join(imagesDir(), fileName))
    return { success: true, fileName }
}

/** Best-effort unlink. A file we cannot remove is wasted disk, never a failed
 *  operation — the row that referenced it is already gone. */
function forgetFile(fileName: string | null | undefined): void {
    if (!fileName) return
    try {
        const file = path.join(imagesDir(), path.basename(fileName))
        if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch (e) {
        console.error('[images] could not delete file:', e)
    }
}

/**
 * Category artwork.
 *
 * The POS opens on a row of department tiles, and a shop picks "Costumes"
 * before it picks a garment — so the tile carries a photo for the same reason
 * the product card does. `categories.image_path` has been in the schema since
 * the beginning with nothing writing to it.
 *
 * One image per category (not a gallery like a product), so setting a new one
 * replaces the old file rather than accumulating orphans in userData.
 */
export const CategoryImageService = {
    async pickAndSet(categoryId: number) {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            title: 'Choisir une image de catégorie',
            properties: ['openFile'],
            filters: [{ name: 'Images', extensions: ALLOWED.map(e => e.slice(1)) }],
        })
        if (canceled || !filePaths.length) return { success: false as const, error: 'cancelled' }

        const stored = storeFile(filePaths[0])
        if (!stored.success) return stored

        const db = getDatabase()
        const prev = db.prepare('SELECT image_path FROM categories WHERE id = ?')
            .get(categoryId) as { image_path: string | null } | undefined
        db.prepare("UPDATE categories SET image_path = ?, updated_at = datetime('now') WHERE id = ?")
            .run(stored.fileName, categoryId)
        forgetFile(prev?.image_path)

        return { success: true as const, fileName: stored.fileName }
    },

    clear(categoryId: number) {
        const db = getDatabase()
        const prev = db.prepare('SELECT image_path FROM categories WHERE id = ?')
            .get(categoryId) as { image_path: string | null } | undefined
        db.prepare("UPDATE categories SET image_path = NULL, updated_at = datetime('now') WHERE id = ?")
            .run(categoryId)
        forgetFile(prev?.image_path)
        return { success: true as const }
    },
}

export const ProductImageService = {
    /** Every photo for a product, primary first. */
    list(productId: number) {
        return getDatabase().prepare(`
            SELECT id, product_id, image_path, is_primary, sort_order
            FROM product_images
            WHERE product_id = ?
            ORDER BY is_primary DESC, sort_order, id
        `).all(productId) as {
            id: number; product_id: number; image_path: string
            is_primary: number; sort_order: number
        }[]
    },

    /**
     * Primary photo filename for many products in ONE query.
     *
     * The POS grid and the product list each render dozens of rows; asking per
     * product would be dozens of IPC round-trips on every keystroke of the
     * search box.
     */
    primaryMap(productIds?: number[]): Record<number, string> {
        const db = getDatabase()
        let rows: { product_id: number; image_path: string }[]
        if (productIds?.length) {
            const marks = productIds.map(() => '?').join(',')
            rows = db.prepare(`
                SELECT product_id, image_path FROM product_images
                WHERE product_id IN (${marks})
                ORDER BY is_primary DESC, sort_order, id
            `).all(...productIds) as any[]
        } else {
            rows = db.prepare(`
                SELECT product_id, image_path FROM product_images
                ORDER BY is_primary DESC, sort_order, id
            `).all() as any[]
        }
        // First row per product wins — the ORDER BY already put the primary there.
        const out: Record<number, string> = {}
        for (const r of rows) if (!(r.product_id in out)) out[r.product_id] = r.image_path
        return out
    },

    /** Copy a file into the store and attach it to a product. */
    add(productId: number, sourcePath: string, makePrimary = false) {
        if (!productId) return { success: false as const, error: 'Produit manquant.' }
        if (!fs.existsSync(sourcePath)) return { success: false as const, error: 'Fichier introuvable.' }

        const stored = storeFile(sourcePath)
        if (!stored.success) return { success: false as const, error: stored.error }
        const fileName = stored.fileName

        const db = getDatabase()
        const run = db.transaction(() => {
            const existing = db.prepare('SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?')
                .get(productId) as { n: number }
            // The first photo is the primary one whether or not the caller asked:
            // a product with photos and no primary shows a placeholder, which
            // looks exactly like a product with no photos at all.
            const primary = makePrimary || existing.n === 0
            if (primary) {
                db.prepare('UPDATE product_images SET is_primary = 0 WHERE product_id = ?').run(productId)
            }
            const res = db.prepare(`
                INSERT INTO product_images (product_id, image_path, is_primary, sort_order)
                VALUES (?, ?, ?, ?)
            `).run(productId, fileName, primary ? 1 : 0, existing.n)
            return res.lastInsertRowid as number
        })

        return { success: true as const, id: run(), fileName }
    },

    setPrimary(imageId: number) {
        const db = getDatabase()
        const row = db.prepare('SELECT product_id FROM product_images WHERE id = ?')
            .get(imageId) as { product_id: number } | undefined
        if (!row) return { success: false as const, error: 'Image introuvable.' }
        const run = db.transaction(() => {
            db.prepare('UPDATE product_images SET is_primary = 0 WHERE product_id = ?').run(row.product_id)
            db.prepare('UPDATE product_images SET is_primary = 1 WHERE id = ?').run(imageId)
        })
        run()
        return { success: true as const }
    },

    remove(imageId: number) {
        const db = getDatabase()
        const row = db.prepare('SELECT product_id, image_path, is_primary FROM product_images WHERE id = ?')
            .get(imageId) as { product_id: number; image_path: string; is_primary: number } | undefined
        if (!row) return { success: false as const, error: 'Image introuvable.' }

        const run = db.transaction(() => {
            db.prepare('DELETE FROM product_images WHERE id = ?').run(imageId)
            // Promote the next one, so removing the primary never leaves a product
            // with photos and none of them shown.
            if (row.is_primary) {
                const next = db.prepare(`
                    SELECT id FROM product_images WHERE product_id = ? ORDER BY sort_order, id LIMIT 1
                `).get(row.product_id) as { id: number } | undefined
                if (next) db.prepare('UPDATE product_images SET is_primary = 1 WHERE id = ?').run(next.id)
            }
        })
        run()

        forgetFile(row.image_path)
        return { success: true as const }
    },

    /** Native picker, then add. Returns `cancelled` rather than an error so the
     *  renderer does not show an alert when the user simply closed the dialog. */
    async pickAndAdd(productId: number) {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            title: 'Choisir une photo',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Images', extensions: ALLOWED.map(e => e.slice(1)) }],
        })
        if (canceled || !filePaths.length) return { success: false as const, error: 'cancelled' }

        const added: number[] = []
        for (const p of filePaths) {
            const res = this.add(productId, p)
            if (!res.success) return res
            added.push(res.id)
        }
        return { success: true as const, added: added.length }
    },
}
