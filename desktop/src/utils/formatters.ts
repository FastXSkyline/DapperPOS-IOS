export function formatDate(date: Date | string | number): string {
    const d = new Date(date)
    const day = String(d.getDate()).padStart(2, '0')
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const year = d.getFullYear()
    return `${day}/${month}/${year}`
}

export function formatDateISO(date: Date | string | number): string {
    const d = new Date(date)
    const day = String(d.getDate()).padStart(2, '0')
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const year = d.getFullYear()
    return `${year}-${month}-${day}`
}

export function formatDateTime(date: Date | string | number): string {
    const d = new Date(date)
    const day = String(d.getDate()).padStart(2, '0')
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const year = d.getFullYear()
    const hours = String(d.getHours()).padStart(2, '0')
    const minutes = String(d.getMinutes()).padStart(2, '0')
    const seconds = String(d.getSeconds()).padStart(2, '0')
    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`
}

/* ---------------------------------------------------------------------------
   Money.

   ONE formatter for the whole renderer. It used to be split between
   `toFixed(2)` and `toLocaleString()` depending on the screen, so the same sale
   read "35000.00 DZD" in one list and "35 000" in another.

   The rules, and why:

   • Thousands are grouped with a NARROW NO-BREAK SPACE (U+202F), which is the
     French convention the shop reads in and which — unlike a plain space —
     cannot wrap a price onto two lines mid-number.
   • The suffix is "DA", what the counter says and what the mockup shows, not
     the ISO code DZD. Documents that must be fiscally unambiguous say DZD;
     those are printed by the main process, not by this function.
   • Decimals appear only when the amount HAS them. Algerian retail prices are
     whole dinars, so ".00" on every row is 300 wasted glyphs on a product list
     — but silently rounding 4500.50 to "4 501 DA" would be a lie, so a
     fractional amount keeps its two decimals.
   --------------------------------------------------------------------------- */

const NNBSP = ' '

function groupDigits(n: number, decimals: number): string {
    const fixed = Math.abs(n).toFixed(decimals)
    const [whole, frac] = fixed.split('.')
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP)
    const sign = n < 0 ? '−' : ''
    return frac ? `${sign}${grouped},${frac}` : `${sign}${grouped}`
}

/** The renderer's money format: `35 000 DA`, `4 500,50 DA`, `−1 200 DA`. */
export function formatCurrency(amount: number): string {
    const n = Number(amount) || 0
    // Guard against float dust: 0.1+0.2 stored as REAL must not print as ",30".
    const hasCentimes = Math.abs(n * 100 - Math.round(n * 100)) < 0.5 && Math.round(n * 100) % 100 !== 0
    return `${groupDigits(n, hasCentimes ? 2 : 0)}${NNBSP}DA`
}

/** Money with the decimals forced on — cash counts, payment splits, anything
 *  being reconciled against a physical drawer. */
export function formatCurrencyPrecise(amount: number): string {
    return `${groupDigits(Number(amount) || 0, 2)}${NNBSP}DA`
}

/** The number alone, grouped, with no unit — for a column whose header already
 *  says DA, and for chart axis ticks. */
export function formatAmount(amount: number, decimals = 0): string {
    return groupDigits(Number(amount) || 0, decimals)
}

/** Compact axis label: 850 450 → "850K", 1 250 000 → "1,3M". Charts only —
 *  never a figure someone has to act on. */
export function formatCompact(amount: number): string {
    const n = Number(amount) || 0
    const abs = Math.abs(n)
    if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace('.', ',')}M`
    if (abs >= 1_000) return `${Math.round(n / 1_000)}K`
    return String(Math.round(n))
}
