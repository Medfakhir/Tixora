import { prisma } from '@/lib/db/prisma'
import { getMuseumSettings, type MuseumSettings } from './settings'
import { addDaysKey, monthBounds, nowTime, parseDateKey, todayKey } from './dates'

export type DayStatus =
  | 'available'
  | 'past'
  | 'cutoff'
  | 'weekly_closed'
  | 'closed'
  | 'sold_out'
  | 'outside_window'

export type DayAvailability = {
  date: string
  day: number
  status: DayStatus
  available: boolean
  reason: string | null
  remaining: number | null
  capacity: number
  sold: number
}

export type MonthAvailability = {
  month: string
  year: number
  monthNumber: number
  today: string
  now: string
  cutoffTime: string
  timezone: string
  capacity: number
  days: DayAvailability[]
}

export class MuseumBookingError extends Error {
  status: number
  code: string
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'MuseumBookingError'
    this.code = code
    this.status = status
  }
}

const CAPACITY_STATUSES = ['PAID', 'PROCESSING', 'COMPLETED'] as const

type ClosureLookup = {
  closedDateKeys: Set<string>
  weeklyDays: Set<number>
  soldByDate: Map<string, number>
}

async function loadLookup(settings: MuseumSettings, first: Date, last: Date): Promise<ClosureLookup> {
  const [closed, weekly, sold] = await Promise.all([
    prisma.closedDate.findMany({ where: { date: { gte: first, lte: last } }, select: { date: true } }),
    prisma.weeklyClosure.findMany({ where: { isActive: true }, select: { dayOfWeek: true } }),
    prisma.order.groupBy({
      by: ['visitDate'],
      where: {
        kind: 'MUSEUM',
        status: { in: [...CAPACITY_STATUSES] },
        visitDate: { gte: first, lte: last },
      },
      _sum: { adultQty: true, childQty: true },
    }),
  ])

  const soldByDate = new Map<string, number>()
  for (const row of sold) {
    if (!row.visitDate) continue
    soldByDate.set(row.visitDate.toISOString().slice(0, 10), (row._sum.adultQty ?? 0) + (row._sum.childQty ?? 0))
  }

  return {
    closedDateKeys: new Set(closed.map((row) => row.date.toISOString().slice(0, 10))),
    weeklyDays: new Set(weekly.map((row) => row.dayOfWeek)),
    soldByDate,
  }
}

function statusFor(
  key: string,
  weekday: number,
  settings: MuseumSettings,
  lookup: ClosureLookup,
  today: string,
  now: string,
): DayAvailability {
  const sold = lookup.soldByDate.get(key) ?? 0
  const capacity = settings.dailyCapacity
  const remaining = capacity > 0 ? Math.max(0, capacity - sold) : null
  const base = {
    date: key,
    day: Number(key.slice(8, 10)),
    sold,
    capacity,
    remaining,
  }

  if (key < today) return { ...base, status: 'past', available: false, reason: 'reason.past' }
  if (key === today && now >= settings.cutoffTime) {
    return { ...base, status: 'cutoff', available: false, reason: 'reason.cutoff' }
  }
  if (key > addDaysKey(today, settings.bookingWindowDays)) {
    return { ...base, status: 'outside_window', available: false, reason: 'reason.outside_window' }
  }
  if (lookup.weeklyDays.has(weekday)) {
    return { ...base, status: 'weekly_closed', available: false, reason: 'reason.weekly_closed' }
  }
  if (lookup.closedDateKeys.has(key)) {
    return { ...base, status: 'closed', available: false, reason: 'reason.closed' }
  }
  if (capacity > 0 && sold >= capacity) {
    return { ...base, status: 'sold_out', available: false, reason: 'reason.sold_out' }
  }
  return { ...base, status: 'available', available: true, reason: null }
}

export async function getMonthAvailability(
  input: { year: number; month: number },
  settings?: MuseumSettings,
): Promise<MonthAvailability> {
  const config = settings ?? (await getMuseumSettings())
  const { first, last, firstKey } = monthBounds(input.year, input.month)
  const lookup = await loadLookup(config, first, last)
  const today = todayKey(config.timezone)
  const now = nowTime(config.timezone)

  const days: DayAvailability[] = []
  const cursor = new Date(first)
  while (cursor.getUTCMonth() === input.month - 1) {
    const key = cursor.toISOString().slice(0, 10)
    days.push(statusFor(key, cursor.getUTCDay(), config, lookup, today, now))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return {
    month: firstKey.slice(0, 7),
    year: input.year,
    monthNumber: input.month,
    today,
    now,
    cutoffTime: config.cutoffTime,
    timezone: config.timezone,
    capacity: config.dailyCapacity,
    days,
  }
}

export type PricedMuseumSelection = {
  settings: MuseumSettings
  dateKey: string
  visitDate: Date
  adultQty: number
  childQty: number
  quantity: number
  adultPriceCents: number
  childPriceCents: number
  subtotalCents: number
  totalCents: number
  currency: string
  sold: number
  remaining: number | null
}

export async function priceMuseumSelection(input: {
  date: string
  adults: number
  children: number
  settings?: MuseumSettings
}): Promise<PricedMuseumSelection> {
  const settings = input.settings ?? (await getMuseumSettings())
  const visitDate = parseDateKey(input.date)
  if (!visitDate) throw new MuseumBookingError('INVALID_DATE', 'Choose a valid visit date.', 422)

  if (!Number.isInteger(input.adults) || input.adults < 0) {
    throw new MuseumBookingError('INVALID_ADULTS', 'Adult quantity is invalid.', 422)
  }
  if (!Number.isInteger(input.children) || input.children < 0) {
    throw new MuseumBookingError('INVALID_CHILDREN', 'Child quantity is invalid.', 422)
  }
  if (input.adults > settings.maxAdultsPerOrder) {
    throw new MuseumBookingError('TOO_MANY_ADULTS', `You can book up to ${settings.maxAdultsPerOrder} adults per order.`, 422)
  }
  if (input.children > settings.maxChildrenPerOrder) {
    throw new MuseumBookingError(
      'TOO_MANY_CHILDREN',
      `You can book up to ${settings.maxChildrenPerOrder} children per order.`,
      422,
    )
  }
  const quantity = input.adults + input.children
  if (quantity < 1) {
    throw new MuseumBookingError('MIN_TICKETS', 'Select at least one adult or child ticket.', 422)
  }

  const today = todayKey(settings.timezone)
  if (input.date < today) throw new MuseumBookingError('DATE_PAST', 'That date has already passed.', 409)
  if (input.date > addDaysKey(today, settings.bookingWindowDays)) {
    throw new MuseumBookingError('OUTSIDE_WINDOW', 'That date is not open for booking yet.', 409)
  }
  if (input.date === today && nowTime(settings.timezone) >= settings.cutoffTime) {
    throw new MuseumBookingError(
      'CUTOFF',
      `Same-day online sales close at ${settings.cutoffTime} (${settings.timezone}).`,
      409,
    )
  }

  const [closed, weekly, soldRow] = await Promise.all([
    prisma.closedDate.findUnique({ where: { date: visitDate }, select: { reason: true } }),
    prisma.weeklyClosure.findUnique({ where: { dayOfWeek: visitDate.getUTCDay() } }),
    prisma.order.aggregate({
      where: {
        kind: 'MUSEUM',
        status: { in: [...CAPACITY_STATUSES] },
        visitDate,
      },
      _sum: { adultQty: true, childQty: true },
    }),
  ])
  if (weekly?.isActive) throw new MuseumBookingError('WEEKLY_CLOSED', 'The museum is closed on that day of the week.', 409)
  if (closed) throw new MuseumBookingError('DATE_CLOSED', 'The museum is closed on that date.', 409)

  const sold = (soldRow._sum.adultQty ?? 0) + (soldRow._sum.childQty ?? 0)
  if (settings.dailyCapacity > 0 && sold + quantity > settings.dailyCapacity) {
    const remaining = Math.max(0, settings.dailyCapacity - sold)
    throw new MuseumBookingError(
      'CAPACITY',
      remaining === 0
        ? 'That date is sold out.'
        : `Only ${remaining} place(s) remain on that date.`,
      409,
    )
  }

  const subtotalCents = input.adults * settings.adultPriceCents + input.children * settings.childPriceCents

  return {
    settings,
    dateKey: input.date,
    visitDate,
    adultQty: input.adults,
    childQty: input.children,
    quantity,
    adultPriceCents: settings.adultPriceCents,
    childPriceCents: settings.childPriceCents,
    subtotalCents,
    totalCents: subtotalCents,
    currency: settings.currency,
    sold,
    remaining: settings.dailyCapacity > 0 ? Math.max(0, settings.dailyCapacity - sold - quantity) : null,
  }
}

export function describeTickets(adults: number, children: number): string {
  const parts: string[] = []
  if (adults > 0) parts.push(`${adults} adult${adults === 1 ? '' : 's'}`)
  if (children > 0) parts.push(`${children} child${children === 1 ? '' : 'ren'}`)
  return parts.join(' + ') || 'No tickets'
}
