import { describe, expect, it } from 'vitest'
import { assertPositiveMoney, computeTotals, formatMoney, isValidCurrency, minorUnitsFor } from '@/lib/money'

describe('minor units', () => {
  it('uses two decimals for ordinary currencies', () => {
    expect(minorUnitsFor('USD')).toBe(2)
    expect(minorUnitsFor('eur')).toBe(2)
  })

  it('knows zero-decimal currencies', () => {
    expect(minorUnitsFor('JPY')).toBe(0)
    expect(minorUnitsFor('KRW')).toBe(0)
  })

  it('formats a zero-decimal amount without a fractional part', () => {
    expect(formatMoney(1500, 'JPY')).toContain('1,500')
    expect(formatMoney(1500, 'JPY')).not.toContain('.')
  })

  it('formats cents as a decimal amount', () => {
    expect(formatMoney(12345, 'USD')).toBe('$123.45')
  })
})

describe('computeTotals', () => {
  it('adds exclusive tax on top of the line total', () => {
    const totals = computeTotals({ unitPriceMinor: 3500, quantity: 2, taxRateBps: 825, taxIncluded: false })
    expect(totals.subtotalMinor).toBe(7000)
    expect(totals.taxMinor).toBe(578) // 57.75 rounded to the nearest cent
    expect(totals.totalMinor).toBe(7578)
  })

  it('extracts inclusive tax from the gross amount and keeps the total unchanged', () => {
    const totals = computeTotals({ unitPriceMinor: 3500, quantity: 2, taxRateBps: 2000, taxIncluded: true })
    expect(totals.totalMinor).toBe(7000)
    expect(totals.taxMinor).toBe(1167)
    expect(totals.subtotalMinor).toBe(5833)
    expect(totals.subtotalMinor + totals.taxMinor).toBe(totals.totalMinor)
  })

  it('never produces tax when the rate is zero', () => {
    const totals = computeTotals({ unitPriceMinor: 1999, quantity: 3, taxRateBps: 0, taxIncluded: true })
    expect(totals).toEqual({ subtotalMinor: 5997, taxMinor: 0, totalMinor: 5997 })
  })

  it('always stays in integer minor units', () => {
    for (const taxRateBps of [1, 3, 777, 1234, 9999]) {
      const totals = computeTotals({ unitPriceMinor: 999, quantity: 7, taxRateBps, taxIncluded: false })
      expect(Number.isInteger(totals.taxMinor)).toBe(true)
      expect(Number.isInteger(totals.totalMinor)).toBe(true)
    }
  })
})

describe('money guards', () => {
  it('accepts non-negative integers', () => {
    expect(() => assertPositiveMoney(0, 'USD')).not.toThrow()
    expect(() => assertPositiveMoney(1999, 'USD')).not.toThrow()
  })

  it('rejects floats and negatives', () => {
    expect(() => assertPositiveMoney(19.99, 'USD')).toThrow()
    expect(() => assertPositiveMoney(-1, 'USD')).toThrow()
  })

  it('only allows supported three-letter currency codes', () => {
    expect(isValidCurrency('USD')).toBe(true)
    expect(isValidCurrency('usd')).toBe(true)
    expect(isValidCurrency('ZZZ')).toBe(false)
    expect(isValidCurrency('US')).toBe(false)
    expect(isValidCurrency('USDT')).toBe(false)
  })
})
