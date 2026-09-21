import { useState, useEffect } from 'react'

/* ---------------------------------------------------------------------------
   Resolved chart colours.

   Recharts writes SVG `fill`/`stroke` attributes and cannot consume
   `var(--chart-1)`, so the ramp has to exist as literals somewhere. It now
   exists HERE, once, instead of being pasted into each dashboard — PROJECT.md's
   "change one, change the other" was a standing invitation for two charts to
   disagree about what series 3 looks like.

   The ramp itself is not a taste decision: it is validated against the light
   and dark surfaces for lightness, chroma floor, adjacent-pair CVD separation
   and contrast (see tokens.css). Assign IN ORDER — 1, then 2, then 3 — and
   never cycle: a filter that drops a series must not repaint the survivors.

   Keep in sync with tokens.css --chart-1..8.
   --------------------------------------------------------------------------- */

const RAMP_LIGHT = ['#4F46E5', '#EA580C', '#0D9488', '#CA8A04', '#0EA5E9', '#65A30D', '#7C3AED', '#DB2777']
const RAMP_DARK = ['#6366F1', '#F97316', '#14B8A6', '#EAB308', '#0EA5E9', '#84CC16', '#8B5CF6', '#EC4899']

export interface ChartTheme {
    dark: boolean
    /** Categorical ramp. Assign in order; a 9th series folds into "Autres". */
    ramp: string[]
    /** The single ink for one-dimensional charts — sizes, hours, store totals.
     *  A hue per bar there would imply an identity the data does not have. */
    ink: string
    inkSoft: string
    grid: string
    axis: string
    surface: string
    text: string
    /** Ready-made Recharts <Tooltip contentStyle>. */
    tooltip: React.CSSProperties
}

export function useChartTheme(): ChartTheme {
    const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark')

    useEffect(() => {
        const el = document.documentElement
        const obs = new MutationObserver(() => setDark(el.dataset.theme === 'dark'))
        obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
        return () => obs.disconnect()
    }, [])

    const text = dark ? '#F2F3F7' : '#14161F'
    const surface = dark ? '#171922' : '#FFFFFF'
    const grid = dark ? 'rgba(255,255,255,0.07)' : '#EDEFF5'

    return {
        dark,
        ramp: dark ? RAMP_DARK : RAMP_LIGHT,
        ink: dark ? '#7B78F0' : '#5B57E8',
        inkSoft: dark ? 'rgba(123,120,240,0.18)' : 'rgba(91,87,232,0.12)',
        grid,
        axis: dark ? '#6C7286' : '#9AA0AE',
        surface,
        text,
        tooltip: {
            background: surface,
            border: `1px solid ${grid}`,
            borderRadius: 10,
            fontSize: 12,
            color: text,
            boxShadow: dark
                ? '0 12px 34px rgba(0,0,0,0.55)'
                : '0 8px 24px rgba(20,22,31,0.07)',
        },
    }
}

/** A swatch for a colour-named category. The category IS a colour, so its own
 *  hex is the honest encoding — but white on a white card is invisible, so a
 *  near-white swatch is handed back with a visible ring instead. */
export function swatchFor(hex: string | null, fallback: string): { background: string; boxShadow?: string } {
    if (!hex) return { background: fallback }
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return { background: fallback }
    const v = parseInt(m[1], 16)
    const lum = (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255
    return lum > 0.88
        ? { background: hex, boxShadow: 'inset 0 0 0 1px rgba(20,22,31,0.28)' }
        : { background: hex }
}
