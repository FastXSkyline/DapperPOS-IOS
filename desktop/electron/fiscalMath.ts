// Pure fiscal/money math — NO electron/db imports, so it is unit-testable in
// isolation (Phase 6.6). The transaction service re-exports these so existing
// importers keep working.

/** Droit de timbre (stamp duty) on a cash-settled TTC amount.
 *  Graduated: 1% ≤30k, 1.5% ≤100k, 2% above, per 100-DA tranche, min 5, cap 10000,
 *  exempt ≤300. (Research-based brackets — pending accountant sign-off, 3.12.) */
export function computeTimbre(amountTTC: number): number {
    if (!amountTTC || amountTTC <= 300) return 0
    const rate = amountTTC <= 30000 ? 0.01 : amountTTC <= 100000 ? 0.015 : 0.02
    const tranches = Math.ceil(amountTTC / 100)
    let timbre = tranches * 100 * rate
    timbre = Math.max(5, Math.min(10000, timbre))
    return Math.round(timbre * 100) / 100
}

/** Split a gross line amount into HT base + TVA, honoring the HT/TTC pricing mode. */
export function computeLineTax(gross: number, rate: number, ttc: boolean): { ht: number; tax: number } {
    if (!rate) return { ht: gross, tax: 0 }
    if (ttc) {
        const ht = gross / (1 + rate / 100)
        return { ht, tax: gross - ht }
    }
    return { ht: gross, tax: (gross * rate) / 100 }
}

/** Round to the nearest 5 DA (cash rounding — 1 & 2 DA coins are scarce). Phase 6.10. */
export function roundTo5(amount: number): number {
    return Math.round(amount / 5) * 5
}
