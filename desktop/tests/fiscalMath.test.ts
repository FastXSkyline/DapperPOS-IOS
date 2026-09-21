import { describe, it, expect } from 'vitest'
import { computeTimbre, computeLineTax, roundTo5 } from '../electron/fiscalMath'

describe('computeLineTax', () => {
    it('returns gross as HT and 0 tax when rate is 0 (IFU/exonéré)', () => {
        expect(computeLineTax(1000, 0, false)).toEqual({ ht: 1000, tax: 0 })
    })
    it('adds TVA on top in HT mode', () => {
        const { ht, tax } = computeLineTax(1000, 19, false)
        expect(ht).toBe(1000)
        expect(tax).toBeCloseTo(190, 6)
    })
    it('extracts TVA from a TTC price', () => {
        const { ht, tax } = computeLineTax(1190, 19, true)
        expect(ht).toBeCloseTo(1000, 6)
        expect(tax).toBeCloseTo(190, 6)
    })
    it('handles the 9% reduced rate', () => {
        const { tax } = computeLineTax(1000, 9, false)
        expect(tax).toBeCloseTo(90, 6)
    })
})

describe('computeTimbre (droit de timbre)', () => {
    it('is exempt at or below 300 DA', () => {
        expect(computeTimbre(300)).toBe(0)
        expect(computeTimbre(0)).toBe(0)
    })
    it('applies the minimum of 5 DA on small amounts', () => {
        expect(computeTimbre(400)).toBe(5)
    })
    it('is capped at 10000 DA', () => {
        expect(computeTimbre(5_000_000)).toBe(10000)
    })
    it('uses 1% up to 30k', () => {
        // 10000 → ceil(10000/100)=100 tranches × 100 × 0.01 = 100
        expect(computeTimbre(10000)).toBe(100)
    })
    it('uses 1.5% between 30k and 100k', () => {
        // 50000 → 500 tranches × 100 × 0.015 = 750
        expect(computeTimbre(50000)).toBe(750)
    })
})

describe('roundTo5 (cash rounding)', () => {
    it('rounds to the nearest 5 DA', () => {
        expect(roundTo5(102)).toBe(100)
        expect(roundTo5(103)).toBe(105)
        expect(roundTo5(107.5)).toBe(110)
        expect(roundTo5(1000)).toBe(1000)
    })
})
