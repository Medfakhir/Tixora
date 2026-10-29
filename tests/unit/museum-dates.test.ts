import { describe, expect, it } from 'vitest'
import {
  addDaysKey,
  dateKeyFromDate,
  dayKeyInTimeZone,
  formatVisitDate,
  formatVisitDateShort,
  monthBounds,
  monthLabel,
  parseDateKey,
  shiftMonth,
  startOfDayUtc,
  todayKey,
} from '@/lib/museum/dates'
import { describeTickets } from '@/lib/museum/availability'

describe('museum date keys', () => {
  it('round-trips valid calendar dates', () => {
    const date = parseDateKey('2026-10-29')
    expect(date).not.toBeNull()
    expect(dateKeyFromDate(date!)).toBe('2026-10-29')
  })

  it('rejects impossible dates instead of rolling them over', () => {
    expect(parseDateKey('2026-02-29')).toBeNull()
    expect(parseDateKey('2026-13-01')).toBeNull()
    expect(parseDateKey('29/10/2026')).toBeNull()
    expect(parseDateKey('')).toBeNull()
  })

  it('accepts a leap day', () => {
    expect(parseDateKey('2024-02-29')).not.toBeNull()
  })

  it('adds days across month and year boundaries', () => {
    expect(addDaysKey('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysKey('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDaysKey('2024-03-01', -1)).toBe('2024-02-29')
    expect(addDaysKey('2026-10-29', 0)).toBe('2026-10-29')
  })

  it('returns month bounds including leap years', () => {
    expect(monthBounds(2026, 2)).toMatchObject({ firstKey: '2026-02-01', lastKey: '2026-02-28' })
    expect(monthBounds(2024, 2)).toMatchObject({ firstKey: '2024-02-01', lastKey: '2024-02-29' })
    expect(monthBounds(2026, 12)).toMatchObject({ firstKey: '2026-12-01', lastKey: '2026-12-31' })
  })

  it('shifts months across year boundaries', () => {
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 })
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 })
    expect(shiftMonth(2026, 6, 0)).toEqual({ year: 2026, month: 6 })
  })
})

describe('museum timezone helpers', () => {
  // 23:30 UTC is already the next calendar day in Tokyo (UTC+9).
  const lateUtc = new Date('2026-10-29T23:30:00.000Z')

  it('derives the business day in the museum timezone', () => {
    expect(todayKey('Asia/Tokyo', lateUtc)).toBe('2026-10-30')
    expect(todayKey('UTC', lateUtc)).toBe('2026-10-29')
    expect(dayKeyInTimeZone(lateUtc, 'Asia/Tokyo')).toBe('2026-10-30')
  })

  it('finds the UTC instant where a local day starts', () => {
    expect(startOfDayUtc('2026-01-15', 'Europe/Paris').toISOString()).toBe('2026-01-14T23:00:00.000Z')
    expect(startOfDayUtc('2026-07-15', 'Europe/Paris').toISOString()).toBe('2026-07-14T22:00:00.000Z')
  })

  it('formats DATE values without shifting the day', () => {
    expect(formatVisitDate('2026-11-03', 'en')).toContain('3 November 2026')
    expect(formatVisitDateShort('2026-11-03', 'en')).toContain('3 Nov 2026')
    expect(formatVisitDate(null, 'en')).toBe('—')
    expect(formatVisitDateShort('not-a-date', 'en')).toBe('—')
    expect(monthLabel(2026, 11, 'en')).toBe('November 2026')
  })
})

describe('museum ticket descriptions', () => {
  it('pluralises adults and children', () => {
    expect(describeTickets(1, 0)).toBe('1 adult')
    expect(describeTickets(2, 1)).toBe('2 adults + 1 child')
    expect(describeTickets(0, 3)).toBe('3 children')
    expect(describeTickets(0, 0)).toBe('No tickets')
  })
})
