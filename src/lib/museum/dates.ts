import type { Locale } from '@/lib/i18n/messages'

/**
 * Visit dates are calendar dates, not instants. They are stored as PostgreSQL DATE
 * and handled here as UTC-midnight values so no server timezone can shift a day.
 */
export function dateKeyFromDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate(),
  ).padStart(2, '0')}`
}

export function parseDateKey(key: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const date = new Date(`${key}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return null
  if (dateKeyFromDate(date) !== key) return null
  return date
}

export function todayKey(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(now)
}

/** Calendar day of an instant in the museum timezone, as YYYY-MM-DD. */
export function dayKeyInTimeZone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(date)
}

/** The UTC instant at which a calendar day starts in the museum timezone. */
export function startOfDayUtc(dateKey: string, timezone: string): Date {
  const guess = new Date(`${dateKey}T00:00:00.000Z`)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(guess)
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const asUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'))
  const offsetMinutes = Math.round((asUtc - guess.getTime()) / 60_000)
  return new Date(guess.getTime() - offsetMinutes * 60_000)
}

export function nowTime(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone,
  }).format(now)
}

export function addDaysKey(key: string, days: number): string {
  const date = parseDateKey(key)
  if (!date) return key
  date.setUTCDate(date.getUTCDate() + days)
  return dateKeyFromDate(date)
}

export function monthBounds(year: number, month: number): { first: Date; last: Date; firstKey: string; lastKey: string } {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const last = new Date(Date.UTC(year, month, 0))
  return { first, last, firstKey: dateKeyFromDate(first), lastKey: dateKeyFromDate(last) }
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 }
}

export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

export function parseMonthKey(value: string | null | undefined, timezone: string): { year: number; month: number } {
  if (value && /^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split('-').map(Number)
    if (month >= 1 && month <= 12) return { year, month }
  }
  const [year, month] = todayKey(timezone).split('-').map(Number)
  return { year, month }
}

const INTL_LOCALES: Record<Locale, string> = { en: 'en-GB', fr: 'fr-FR', es: 'es-ES' }

/** Formats a DATE value in UTC so 2026-11-03 never becomes 2026-11-02. */
export function formatVisitDate(date: Date | string | null | undefined, locale: Locale = 'en'): string {
  if (!date) return '—'
  const value = typeof date === 'string' ? parseDateKey(date.slice(0, 10)) : date
  if (!value) return '—'
  return new Intl.DateTimeFormat(INTL_LOCALES[locale], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value)
}

export function formatVisitDateShort(date: Date | string | null | undefined, locale: Locale = 'en'): string {
  if (!date) return '—'
  const value = typeof date === 'string' ? parseDateKey(date.slice(0, 10)) : date
  if (!value) return '—'
  return new Intl.DateTimeFormat(INTL_LOCALES[locale], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value)
}

export function monthLabel(year: number, month: number, locale: Locale = 'en'): string {
  return new Intl.DateTimeFormat(INTL_LOCALES[locale], { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  )
}
