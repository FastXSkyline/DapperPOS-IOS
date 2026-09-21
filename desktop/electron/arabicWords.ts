// Arabic montant-en-lettres + Eastern-Arabic numeral helpers (Phase 6.1).
// Loi 91-05 requires Arabic on commercial documents; the facture prints the
// amount in Arabic words alongside the French one.

const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة',
    'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر']
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون']
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة']
const SCALES = [
    { value: 1_000_000_000, sing: 'مليار', plur: 'مليارات' },
    { value: 1_000_000, sing: 'مليون', plur: 'ملايين' },
    { value: 1_000, sing: 'ألف', plur: 'آلاف' },
]

function threeDigitsToWords(n: number): string {
    const parts: string[] = []
    const h = Math.floor(n / 100)
    const rest = n % 100
    if (h > 0) parts.push(HUNDREDS[h])
    if (rest > 0) {
        if (rest < 20) parts.push(ONES[rest])
        else {
            const t = Math.floor(rest / 10)
            const o = rest % 10
            if (o > 0) parts.push(`${ONES[o]} و${TENS[t]}`)
            else parts.push(TENS[t])
        }
    }
    return parts.join(' و')
}

function integerToArabic(n: number): string {
    if (n === 0) return 'صفر'
    const out: string[] = []
    let remaining = n
    for (const scale of SCALES) {
        const count = Math.floor(remaining / scale.value)
        if (count > 0) {
            if (count === 1) out.push(scale.sing)
            else if (count === 2) out.push(scale.value === 1000 ? 'ألفان' : `${scale.sing}ان`)
            else if (count >= 3 && count <= 10) out.push(`${threeDigitsToWords(count)} ${scale.plur}`)
            else out.push(`${threeDigitsToWords(count)} ${scale.sing}`)
            remaining %= scale.value
        }
    }
    if (remaining > 0) out.push(threeDigitsToWords(remaining))
    return out.join(' و')
}

/** Full Algerian amount in Arabic words: dinars + centimes. */
export function montantEnLettresAR(amount: number): string {
    const neg = amount < 0
    const abs = Math.abs(amount)
    const dinars = Math.floor(abs)
    const centimes = Math.round((abs - dinars) * 100)
    let s = `${integerToArabic(dinars)} دينار جزائري`
    if (centimes > 0) s += ` و${integerToArabic(centimes)} سنتيم`
    return (neg ? 'ناقص ' : '') + s
}

const WESTERN = '0123456789'
const EASTERN = '٠١٢٣٤٥٦٧٨٩'
/** Convert Western digits to Eastern-Arabic numerals (option). */
export function toEasternArabic(input: string): string {
    return input.replace(/[0-9]/g, (d) => EASTERN[WESTERN.indexOf(d)])
}
