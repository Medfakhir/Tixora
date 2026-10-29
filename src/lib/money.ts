/**
 * Money is stored and moved as integer minor units (cents, pence, ...) never as
 * floats. Currency is always carried alongside the amount and no conversion is
 * ever performed implicitly.
 */

const MINOR_UNIT_ZERO: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  IDF: 0,
}

export function minorUnitsFor(currency: string): number {
  return MINOR_UNIT_ZERO[currency.toUpperCase()] ?? 2
}

export function formatMoney(minor: number, currency: string): string {
  const exponent = minorUnitsFor(currency)
  const amount = minor / 10 ** exponent
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toFixed(exponent)} ${currency.toUpperCase()}`
  }
}

/**
 * Tax is derived from the stored rate and the `taxIncluded` flag; it is never
 * assumed. When tax is included the line total is treated as gross and tax is
 * extracted, otherwise tax is added on top.
 */
export function computeTotals({
  unitPriceMinor,
  quantity,
  taxRateBps,
  taxIncluded,
}: {
  unitPriceMinor: number
  quantity: number
  taxRateBps: number
  taxIncluded: boolean
}): { subtotalMinor: number; taxMinor: number; totalMinor: number } {
  const lineTotal = unitPriceMinor * quantity
  if (taxRateBps <= 0) {
    return { subtotalMinor: lineTotal, taxMinor: 0, totalMinor: lineTotal }
  }
  if (taxIncluded) {
    // gross = net * (1 + rate); integer rounding keeps the total equal to lineTotal.
    const taxMinor = Math.round(lineTotal - lineTotal / (1 + taxRateBps / 10_000))
    return { subtotalMinor: lineTotal - taxMinor, taxMinor, totalMinor: lineTotal }
  }
  const taxMinor = Math.round((lineTotal * taxRateBps) / 10_000)
  return { subtotalMinor: lineTotal, taxMinor, totalMinor: lineTotal + taxMinor }
}

export function assertPositiveMoney(minor: number, currency: string): void {
  if (!Number.isInteger(minor) || minor < 0) {
    throw new Error(`Invalid money amount for ${currency}: ${minor}`)
  }
}

export const SUPPORTED_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK',
  'PLN', 'CZK', 'HUF', 'RON', 'BRL', 'MXN', 'TRY', 'ILS', 'SAR', 'AED',
  'SGD', 'HKD', 'NZD', 'INR', 'ZAR', 'KES', 'NGN', 'GHS',
] as const

export function isValidCurrency(code: string): boolean {
  const upper = code.toUpperCase()
  return /^[A-Z]{3}$/.test(upper) && (SUPPORTED_CURRENCIES as readonly string[]).includes(upper)
}
