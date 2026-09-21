import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeTestDb } from './helpers/sqliteHarness'
import { runRetailMigrations } from '../electron/migrationsRetail'

let testDb: any
let userData: string

vi.mock('../electron/database', () => ({ getDatabase: () => testDb }))
// The service reaches for app.getPath('userData') and registers a protocol; the
// storage logic under test needs neither a real app nor a real window.
vi.mock('electron', () => ({
    app: { getPath: () => userData },
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
    net: { fetch: async () => new Response('') },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}))

const { ProductImageService, CategoryImageService } = await import('../electron/productImageService')

const imagesDir = () => path.join(userData, 'product-images')
const filesOnDisk = () => (fs.existsSync(imagesDir()) ? fs.readdirSync(imagesDir()) : [])

/** A throwaway source file, as if the owner picked it off a USB stick. */
function sourceFile(name = 'photo.jpg', bytes = 64): string {
    const p = path.join(userData, 'incoming', name)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, Buffer.alloc(bytes, 1))
    return p
}

beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dapper-img-'))
    testDb = makeTestDb()
    runRetailMigrations(testDb)
    testDb.prepare("INSERT INTO products (id, name, retail_price) VALUES (1, 'Costume Milano', 35000)").run()
    testDb.prepare("INSERT INTO products (id, name, retail_price) VALUES (2, 'Chemise Oxford', 4500)").run()
    testDb.prepare("INSERT INTO categories (id, name) VALUES (1, 'Costumes')").run()
})

afterEach(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('storing a photo', () => {
    it('COPIES the file rather than referencing where it came from', () => {
        const src = sourceFile()
        const res = ProductImageService.add(1, src) as any
        expect(res.success).toBe(true)

        // The owner imports from a USB stick or a phone folder that is gone
        // tomorrow; a catalogue of dead paths is worse than no photos at all.
        fs.rmSync(src)
        expect(filesOnDisk()).toHaveLength(1)
        expect(fs.existsSync(path.join(imagesDir(), res.fileName))).toBe(true)
    })

    it('renames on the way in, so two files called photo.jpg cannot collide', () => {
        const a = ProductImageService.add(1, sourceFile('photo.jpg')) as any
        const b = ProductImageService.add(2, sourceFile('photo.jpg')) as any
        expect(a.fileName).not.toBe(b.fileName)
        expect(filesOnDisk()).toHaveLength(2)
    })

    it('refuses a format the renderer cannot draw', () => {
        const res = ProductImageService.add(1, sourceFile('catalogue.pdf')) as any
        expect(res.success).toBe(false)
        expect(filesOnDisk()).toHaveLength(0)
    })

    it('refuses a file too large for a shop PC to accumulate', () => {
        const res = ProductImageService.add(1, sourceFile('huge.jpg', 9 * 1024 * 1024)) as any
        expect(res.success).toBe(false)
        expect(filesOnDisk()).toHaveLength(0)
    })

    it('refuses a source that is not there', () => {
        const res = ProductImageService.add(1, path.join(userData, 'nope.jpg')) as any
        expect(res.success).toBe(false)
    })
})

describe('which photo the till shows', () => {
    it('makes the first photo primary without being asked', () => {
        ProductImageService.add(1, sourceFile('a.jpg'))
        const rows = ProductImageService.list(1)
        // A product with photos and no primary renders a placeholder — which looks
        // exactly like a product with no photos.
        expect(rows).toHaveLength(1)
        expect(rows[0].is_primary).toBe(1)
    })

    it('keeps exactly one primary when another is promoted', () => {
        ProductImageService.add(1, sourceFile('a.jpg'))
        const second = ProductImageService.add(1, sourceFile('b.jpg')) as any
        ProductImageService.setPrimary(second.id)

        const rows = ProductImageService.list(1)
        expect(rows.filter(r => r.is_primary === 1)).toHaveLength(1)
        expect(rows.find(r => r.id === second.id)!.is_primary).toBe(1)
    })

    it('promotes the next photo when the primary is deleted', () => {
        const first = ProductImageService.add(1, sourceFile('a.jpg')) as any
        ProductImageService.add(1, sourceFile('b.jpg'))
        ProductImageService.remove(first.id)

        const rows = ProductImageService.list(1)
        expect(rows).toHaveLength(1)
        expect(rows[0].is_primary).toBe(1)
    })

    it('deletes the file from disk along with the row', () => {
        const res = ProductImageService.add(1, sourceFile()) as any
        ProductImageService.remove(res.id)
        expect(filesOnDisk()).toHaveLength(0)
    })

    it('lists the primary first', () => {
        ProductImageService.add(1, sourceFile('a.jpg'))
        const second = ProductImageService.add(1, sourceFile('b.jpg')) as any
        ProductImageService.setPrimary(second.id)
        expect(ProductImageService.list(1)[0].id).toBe(second.id)
    })
})

describe('the grid lookup', () => {
    it('answers for many products in one call', () => {
        const a = ProductImageService.add(1, sourceFile('a.jpg')) as any
        const b = ProductImageService.add(2, sourceFile('b.jpg')) as any
        const map = ProductImageService.primaryMap()
        expect(map[1]).toBe(a.fileName)
        expect(map[2]).toBe(b.fileName)
    })

    it('gives each product its PRIMARY, not whichever row came first', () => {
        ProductImageService.add(1, sourceFile('a.jpg'))
        const second = ProductImageService.add(1, sourceFile('b.jpg')) as any
        ProductImageService.setPrimary(second.id)
        expect(ProductImageService.primaryMap([1])[1]).toBe(second.fileName)
    })

    it('omits products with no photo rather than inventing a placeholder path', () => {
        ProductImageService.add(1, sourceFile())
        const map = ProductImageService.primaryMap([1, 2])
        expect(map[1]).toBeTruthy()
        expect(map[2]).toBeUndefined()
    })
})

describe('category artwork', () => {
    it('replaces the old file instead of accumulating orphans', () => {
        // One image per category, so setting a new one must not leave the old
        // file behind — userData is on a shop PC nobody ever cleans.
        testDb.prepare("UPDATE categories SET image_path = 'old.jpg' WHERE id = 1").run()
        fs.mkdirSync(imagesDir(), { recursive: true })
        fs.writeFileSync(path.join(imagesDir(), 'old.jpg'), Buffer.alloc(8))

        CategoryImageService.clear(1)

        expect(filesOnDisk()).toHaveLength(0)
        const row = testDb.prepare('SELECT image_path FROM categories WHERE id = 1').get() as any
        expect(row.image_path).toBeNull()
    })

    it('survives a missing file when clearing', () => {
        testDb.prepare("UPDATE categories SET image_path = 'ghost.jpg' WHERE id = 1").run()
        // A file we cannot unlink is wasted disk, never a failed operation.
        expect(() => CategoryImageService.clear(1)).not.toThrow()
        const row = testDb.prepare('SELECT image_path FROM categories WHERE id = 1').get() as any
        expect(row.image_path).toBeNull()
    })
})
