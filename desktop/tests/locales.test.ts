import { describe, it, expect } from 'vitest'
import { fr } from '../src/locales/fr'
import { ar } from '../src/locales/ar'

/* ---------------------------------------------------------------------------
   The two locales must stay key-for-key identical.

   This is not tidiness. `t()` falls back to the FRENCH string for a missing
   Arabic key, which is the right behaviour at runtime — a real sentence beats a
   dotted key path in front of a shopkeeper — but it is also silent. Without
   this test, an Arabic gap ships as a French sentence sitting in the middle of
   an Arabic screen and nobody finds out until the shop does.

   Two Arabic keys were already wrong when this was written: `common.action`
   (a typo for `actions`) and a missing `common.print`.
   --------------------------------------------------------------------------- */

type Dict = Record<string, unknown>

/** Depth-first, because one section (reports.dateControls) nests a level. */
function walk(d: Dict, prefix = ''): [string, string][] {
    const out: [string, string][] = []
    for (const [k, v] of Object.entries(d)) {
        const path = prefix ? `${prefix}.${k}` : k
        if (v && typeof v === 'object') out.push(...walk(v as Dict, path))
        else out.push([path, v as string])
    }
    return out
}

const flatten = (d: Dict) => new Set(walk(d).map(([k]) => k))

const frKeys = flatten(fr as unknown as Dict)
const arKeys = flatten(ar as unknown as Dict)

describe('locale parity', () => {
    it('has no French key missing from Arabic', () => {
        expect([...frKeys].filter(k => !arKeys.has(k))).toEqual([])
    })

    it('has no Arabic key missing from French', () => {
        expect([...arKeys].filter(k => !frKeys.has(k))).toEqual([])
    })

    it('carries a real string for every key in both languages', () => {
        const empty: string[] = []
        for (const d of [fr, ar] as unknown as Dict[]) {
            for (const [path, v] of walk(d)) {
                if (typeof v !== 'string' || !v.trim()) empty.push(path)
            }
        }
        expect(empty).toEqual([])
    })
})

describe('no English left in the interface', () => {
    // Words that would only appear if an English string slipped back in. French
    // and Arabic share none of them.
    const ENGLISH = /\b(the|and|with|your|please|failed|loading|save|cancel|search|settings|product|customer|supplier|barcode|new|edit|delete|report|amount|quantity|stock min|current|user)\b/i

    it('leaves no English word in the French locale', () => {
        const hits = walk(fr as unknown as Dict)
            .filter(([, v]) => ENGLISH.test(v))
            .map(([k, v]) => `${k} = ${v}`)
        expect(hits).toEqual([])
    })

    it('leaves no Latin-script sentence in the Arabic locale', () => {
        // Brand names and units are fine (Dapper, DA, CNAS, IRG, SKU, JPG…);
        // a whole Latin SENTENCE is not.
        const hits = walk(ar as unknown as Dict)
            .filter(([, v]) => ((v.match(/[A-Za-zÀ-ÿ]{3,}/g) ?? []).length >= 3) && !/[؀-ۿ]/.test(v))
            .map(([k, v]) => `${k} = ${v}`)
        expect(hits).toEqual([])
    })
})

describe('the language contract', () => {
    it('offers exactly French and Arabic', async () => {
        // English was the DEFAULT once, which is why an Algerian shop opened on
        // "New Product". Deleting the file is the only thing that keeps it gone.
        const mod = await import('../src/locales/fr')
        expect(Object.keys(mod)).toContain('fr')
        await expect(import('../src/locales/en' as string)).rejects.toThrow()
    })
})

describe('every t() call resolves', () => {
    // The bug this catches: a screen asked for `inv.inStock` while the key lived
    // under `ui2`. Nothing failed — t() returned the literal string
    // "inv.inStock", and a column header in the Inventaire screen read as a
    // dotted key path. Only a human looking at the screen would ever notice.
    it('references no key that is missing from the locales', async () => {
        const fs = await import('node:fs')
        const path = await import('node:path')

        const root = path.resolve(__dirname, '../src')
        const files: string[] = []
        const walkDir = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name)
                if (e.isDirectory()) walkDir(full)
                else if (/\.tsx?$/.test(e.name) && !full.includes('locales')) files.push(full)
            }
        }
        walkDir(root)

        const bad: string[] = []
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8')
            // Literal t('a.b') calls only — a computed key cannot be checked here.
            for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)'\s*\)/g)) {
                if (!frKeys.has(m[1])) bad.push(`${path.basename(f)}: ${m[1]}`)
            }
        }
        expect(bad).toEqual([])
    })
})
