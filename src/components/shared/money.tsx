import { formatMoney, minorUnitsFor } from '@/lib/money'

export function Money({ minor, currency, className }: { minor: number; currency: string; className?: string }) {
  return <span className={className}>{formatMoney(minor, currency)}</span>
}

/** Minor units as a decimal string, for form inputs that show a price in whole units. */
export function toMajorString(minor: number, currency: string): string {
  return (minor / 10 ** minorUnitsFor(currency)).toFixed(minorUnitsFor(currency))
}

export function toMinorUnits(major: string | number, currency: string): number {
  const exponent = minorUnitsFor(currency)
  const numeric = typeof major === 'number' ? major : Number.parseFloat(String(major).replace(/,/g, ''))
  if (!Number.isFinite(numeric)) return 0
  return Math.round(numeric * 10 ** exponent)
}
