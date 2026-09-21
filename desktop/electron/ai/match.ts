/** Fuzzy entity matching for noisy Darija/French voice transcripts. */

export function normalizeForSearch(s: string): string {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Best fuzzy match of `target` against `list` by name, using substring + bigram Dice. */
export function findBestMatch<T>(
    target: string,
    list: T[],
    getName: (item: T) => string,
    threshold = 0.35,
): T | null {
    const t = normalizeForSearch(target)
    if (!t) return null

    let best: { item: T; score: number } | null = null

    for (const item of list) {
        const n = normalizeForSearch(getName(item))

        // 1. Direct or partial match is highest priority
        if (n && (n.includes(t) || t.includes(n))) {
            const score = 0.8 + (Math.min(n.length, t.length) / Math.max(n.length, t.length)) * 0.2
            if (!best || score > best.score) best = { item, score }
            continue
        }

        // 2. Bigram Dice coefficient for phonetic/typo similarity
        const getBigrams = (str: string) => {
            const bigrams = new Set<string>()
            for (let i = 0; i < str.length - 1; i++) bigrams.add(str.substring(i, i + 2))
            return bigrams
        }
        const b1 = getBigrams(t)
        const b2 = getBigrams(n)
        let intersect = 0
        for (const b of b1) if (b2.has(b)) intersect++
        const dice = (b1.size + b2.size) === 0 ? 0 : (2 * intersect) / (b1.size + b2.size)
        if (!best || dice > best.score) best = { item, score: dice }
    }

    return best && best.score >= threshold ? best.item : null
}
