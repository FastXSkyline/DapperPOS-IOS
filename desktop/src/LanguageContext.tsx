import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { fr } from './locales/fr'
import { ar } from './locales/ar'

/* ---------------------------------------------------------------------------
   Language.

   FRENCH AND ARABIC ONLY. English is gone — it was the DEFAULT, which is why a
   shop in Algeria opened on "New Product / Basic Information / Cost" next to
   screens written in French. A third language nobody had asked for was doing
   nothing but guaranteeing a mixed interface.

   TWO RULES THIS FILE ENFORCES:

   1. The choice PERSISTS. It used to live in `useState` alone, so every launch
      silently reset the app to English regardless of what Settings said. It is
      now written to the config table and read back on boot.

   2. A missing key is LOUD IN DEV AND SILENT IN PRODUCTION. Returning the raw
      key path ("inventory.sku") put a developer string in front of a shopkeeper.
      French is the fallback instead — always a real sentence, and the console
      warning still tells us the Arabic string is missing.
   --------------------------------------------------------------------------- */

export type Language = 'fr' | 'ar'

const translations = { fr, ar }

/** Written to the config table, so the terminal reopens in the same language. */
const CONFIG_KEY = 'ui_language'

const isLanguage = (v: unknown): v is Language => v === 'fr' || v === 'ar'

interface LanguageContextType {
    language: Language
    setLanguage: (lang: Language) => void
    t: (key: string) => string
    dir: 'ltr' | 'rtl'
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

function lookup(lang: Language, path: string): string | undefined {
    let current: any = translations[lang]
    for (const key of path.split('.')) {
        if (current == null || current[key] === undefined) return undefined
        current = current[key]
    }
    return typeof current === 'string' ? current : undefined
}

export function LanguageProvider({ children }: { children: ReactNode }) {
    const [language, setLanguageState] = useState<Language>('fr')

    // Read the stored choice once. Optional-chained: an older preload without the
    // config bridge must fall back to French, not crash the shell.
    useEffect(() => {
        window.electron?.config?.get?.(CONFIG_KEY)
            .then(v => { if (isLanguage(v)) setLanguageState(v) })
            .catch(() => { })
    }, [])

    const setLanguage = (lang: Language) => {
        if (!isLanguage(lang)) return
        setLanguageState(lang)
        window.electron?.config?.set?.(CONFIG_KEY, lang).catch(() => { })
    }

    const dir: 'ltr' | 'rtl' = language === 'ar' ? 'rtl' : 'ltr'

    // On <html>, so the tokens' :lang(ar) Arabic face and every [dir="rtl"] rule
    // apply to portals and dialogs too — not just to what sits inside the div.
    useEffect(() => {
        document.documentElement.lang = language
        document.documentElement.dir = dir
    }, [language, dir])

    const t = (path: string): string => {
        const hit = lookup(language, path)
        if (hit !== undefined) return hit
        // Arabic gap: show the French sentence rather than a dotted key path.
        const fallback = lookup('fr', path)
        if (import.meta.env.DEV) {
            console.warn(`[i18n] missing "${path}" for "${language}"`)
        }
        return fallback ?? path
    }

    return (
        <LanguageContext.Provider value={{ language, setLanguage, t, dir }}>
            <div dir={dir} style={{ height: '100%', direction: dir }}>
                {children}
            </div>
        </LanguageContext.Provider>
    )
}

export function useLanguage() {
    const context = useContext(LanguageContext)
    if (context === undefined) {
        throw new Error('useLanguage must be used within a LanguageProvider')
    }
    return context
}
