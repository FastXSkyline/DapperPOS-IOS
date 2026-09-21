/**
 * Light normalization of Latin "Arabizi" Darija tokens to Arabic script before TTS,
 * using WHOLE-WORD matching only.
 *
 * The previous version did global single-letter and digit replaces (e.g. /f/ -> 'في',
 * /li/ -> 'لي', 3 -> 'ع'). Those corrupted ordinary words ("facture" -> "في acture",
 * "client", "livraison") and — now that replies come back as Arabic text with real
 * numbers — would also mangle amounts (every "3" -> "ع"). We only map known whole words.
 */
const WORD_MAP: Record<string, string> = {
    smahli: 'سماحلي',
    mafhamtch: 'ما فهمتش',
    mli7: 'مليح',
    '3awdli': 'عاودلي',
    ghir: 'غير',
    bla3qal: 'بالعقل',
    safi: 'صايي',
    zidt: 'زدت',
    zeddt: 'زدت',
    werri: 'وري',
    nwerrilek: 'نوريلك',
    ga3: 'كاع',
    produits: 'برودوي',
    tfeddel: 'تفضل',
    rapport: 'رابور',
    lyoum: 'لليوم',
    ntabba3: 'نطبع',
    dork: 'درك',
    expense: 'مصاريف',
    ta3: 'تاع',
}

export function normalizeDarija(text: string): string {
    let out = (text || '')
    for (const [latin, arabic] of Object.entries(WORD_MAP)) {
        out = out.replace(new RegExp(`\\b${latin}\\b`, 'gi'), arabic)
    }
    return out.replace(/\s+/g, ' ').trim()
}
