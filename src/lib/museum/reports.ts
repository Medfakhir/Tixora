import { prisma } from '@/lib/db/prisma'
import { getMuseumSettings } from './settings'
import {
  addDaysKey,
  dateKeyFromDate,
  dayKeyInTimeZone,
  monthBounds,
  todayKey,
} from './dates'

/** Statuses that represent money actually collected. Unpaid checkouts never count. */
export const MUSEUM_REVENUE_STATUSES = [
  'PAID',
  'PROCESSING',
  'COMPLETED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'DELIVERY_FAILED',
] as const

/** Bookings that still entitle the holder to entry. Full refunds do not. */
export const MUSEUM_ADMISSION_STATUSES = ['PAID', 'PROCESSING', 'COMPLETED', 'PARTIALLY_REFUNDED'] as const

export type MuseumPeriodTotals = {
  revenueMinor: number
  refundedMinor: number
  orders: number
  adults: number
  children: number
  tickets: number
}

export type MuseumReport = {
  currency: string
  timezone: string
  today: MuseumPeriodTotals
  week: MuseumPeriodTotals
  month: MuseumPeriodTotals
  allTime: MuseumPeriodTotals
  checkedInToday: number
  expectedToday: number
  revenueByDay: { date: string; grossMinor: number; netMinor: number }[]
  upcoming: { date: string; orders: number; tickets: number; checkedIn: number }[]
  recentOrders: {
    id: string
    publicId: string
    reference: string
    customerName: string
    customerEmail: string
    visitDate: Date | null
    adultQty: number
    childQty: number
    totalMinor: number
    currency: string
    status: string
    checkedInAt: Date | null
    createdAt: Date
  }[]
}

function emptyTotals(): MuseumPeriodTotals {
  return { revenueMinor: 0, refundedMinor: 0, orders: 0, adults: 0, children: 0, tickets: 0 }
}

function addOrder(totals: MuseumPeriodTotals, order: {
  totalMinor: number
  refundedMinor: number
  adultQty: number
  childQty: number
}) {
  totals.orders += 1
  totals.adults += order.adultQty
  totals.children += order.childQty
  totals.tickets += order.adultQty + order.childQty
  totals.revenueMinor += order.totalMinor
  totals.refundedMinor += order.refundedMinor
}

function revenueTotal(totals: MuseumPeriodTotals): MuseumPeriodTotals {
  return { ...totals, revenueMinor: Math.max(0, totals.revenueMinor - totals.refundedMinor) }
}

/**
 * The dashboard reads paid museum orders once and buckets them in the museum
 * timezone. That keeps "today" honest for a business whose day starts in
 * Africa/Casablanca rather than UTC, and avoids one aggregate query per card.
 */
export async function buildMuseumReport(): Promise<MuseumReport> {
  const settings = await getMuseumSettings()
  const timezone = settings.timezone
  const today = todayKey(timezone)

  const paidWhere = {
    kind: 'MUSEUM' as const,
    paidAt: { not: null },
    status: { in: [...MUSEUM_REVENUE_STATUSES] },
  }

  const [orders, upcomingRows, recent] = await Promise.all([
    prisma.order.findMany({
      where: paidWhere,
      select: {
        paidAt: true,
        totalMinor: true,
        refundedMinor: true,
        adultQty: true,
        childQty: true,
      },
      take: 50_000,
    }),
    prisma.order.groupBy({
      by: ['visitDate'],
      where: {
        kind: 'MUSEUM',
        status: { in: [...MUSEUM_ADMISSION_STATUSES] },
        visitDate: { gte: parseKey(today), lte: parseKey(addDaysKey(today, 14)) },
      },
      _sum: { adultQty: true, childQty: true },
      _count: { _all: true },
    }),
    prisma.order.findMany({
      where: { kind: 'MUSEUM' },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        id: true,
        publicId: true,
        reference: true,
        customerName: true,
        customerEmail: true,
        visitDate: true,
        adultQty: true,
        childQty: true,
        totalMinor: true,
        currency: true,
        status: true,
        checkedInAt: true,
        createdAt: true,
      },
    }),
  ])

  const todayTotals = emptyTotals()
  const weekTotals = emptyTotals()
  const monthTotals = emptyTotals()
  const allTimeTotals = emptyTotals()
  const byDay = new Map<string, { gross: number; refunded: number }>()

  const nowKey = todayKey(timezone)
  const monthPrefix = nowKey.slice(0, 7)
  const weekday = new Date(`${nowKey}T00:00:00.000Z`).getUTCDay()
  const weekStart = addDaysKey(nowKey, -((weekday + 6) % 7))

  for (const order of orders) {
    if (!order.paidAt) continue
    const key = dayKeyInTimeZone(order.paidAt, timezone)
    addOrder(allTimeTotals, order)
    if (key === nowKey) addOrder(todayTotals, order)
    if (key >= weekStart && key <= nowKey) addOrder(weekTotals, order)
    if (key.startsWith(monthPrefix)) addOrder(monthTotals, order)

    const bucket = byDay.get(key) ?? { gross: 0, refunded: 0 }
    bucket.gross += order.totalMinor
    bucket.refunded += order.refundedMinor
    byDay.set(key, bucket)
  }

  // Only the last 30 days are charted; all-time totals still cover every paid order.
  const revenueByDay: MuseumReport['revenueByDay'] = []
  for (let cursor = addDaysKey(nowKey, -29); cursor <= nowKey; cursor = addDaysKey(cursor, 1)) {
    const bucket = byDay.get(cursor) ?? { gross: 0, refunded: 0 }
    revenueByDay.push({
      date: cursor,
      grossMinor: bucket.gross,
      netMinor: Math.max(0, bucket.gross - bucket.refunded),
    })
  }

  const [checkedInToday, expectedToday] = await Promise.all([
    prisma.order.count({
      where: {
        kind: 'MUSEUM',
        status: { in: [...MUSEUM_ADMISSION_STATUSES] },
        visitDate: parseKey(today),
        checkedInAt: { not: null },
      },
    }),
    prisma.order.count({
      where: {
        kind: 'MUSEUM',
        status: { in: [...MUSEUM_ADMISSION_STATUSES] },
        visitDate: parseKey(today),
      },
    }),
  ])

  const upcoming = upcomingRows
    .filter((row) => row.visitDate)
    .map((row) => {
      const date = dateKeyFromDate(row.visitDate!)
      return {
        date,
        orders: row._count._all,
        tickets: (row._sum.adultQty ?? 0) + (row._sum.childQty ?? 0),
        checkedIn: 0,
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))

  // One extra query keeps the upcoming list accurate without a per-day N+1.
  if (upcoming.length > 0) {
    const checkins = await prisma.order.groupBy({
      by: ['visitDate'],
      where: {
        kind: 'MUSEUM',
        status: { in: [...MUSEUM_ADMISSION_STATUSES] },
        checkedInAt: { not: null },
        visitDate: { in: upcoming.map((row) => parseKey(row.date)) },
      },
      _count: { _all: true },
    })
    const byDate = new Map(checkins.map((row) => [row.visitDate ? dateKeyFromDate(row.visitDate) : '', row._count._all]))
    for (const row of upcoming) row.checkedIn = byDate.get(row.date) ?? 0
  }

  return {
    currency: settings.currency,
    timezone,
    today: revenueTotal(todayTotals),
    week: revenueTotal(weekTotals),
    month: revenueTotal(monthTotals),
    allTime: revenueTotal(allTimeTotals),
    checkedInToday,
    expectedToday,
    revenueByDay,
    upcoming,
    recentOrders: recent,
  }
}

function parseKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`)
}

export type SalesCalendarDay = {
  date: string
  day: number
  weekday: number
  orders: number
  adults: number
  children: number
  tickets: number
  revenueMinor: number
  checkedIn: number
  closed: boolean
  weeklyClosed: boolean
  reason: string
  capacity: number
  remaining: number | null
}

export type SalesCalendar = {
  year: number
  month: number
  monthKey: string
  currency: string
  timezone: string
  today: string
  capacity: number
  days: SalesCalendarDay[]
  totals: { revenueMinor: number; orders: number; tickets: number; adults: number; children: number }
}

/** Calendar of actual sales by visit date, including closures and daily capacity. */
export async function buildSalesCalendar(year: number, month: number): Promise<SalesCalendar> {
  const settings = await getMuseumSettings()
  const { first, last, firstKey } = monthBounds(year, month)
  const timezone = settings.timezone
  const today = todayKey(timezone)

  const [orders, closedDates, weekly] = await Promise.all([
    prisma.order.findMany({
      where: {
        kind: 'MUSEUM',
        status: { in: [...MUSEUM_REVENUE_STATUSES] },
        visitDate: { gte: first, lte: last },
      },
      select: {
        visitDate: true,
        totalMinor: true,
        refundedMinor: true,
        adultQty: true,
        childQty: true,
        checkedInAt: true,
      },
      take: 20_000,
    }),
    prisma.closedDate.findMany({ where: { date: { gte: first, lte: last } } }),
    prisma.weeklyClosure.findMany({ where: { isActive: true } }),
  ])

  const closedMap = new Map(closedDates.map((row) => [dateKeyFromDate(row.date), row.reason]))
  const weeklyDays = new Set(weekly.map((row) => row.dayOfWeek))

  const byDate = new Map<string, SalesCalendarDay>()
  const totals = { revenueMinor: 0, orders: 0, tickets: 0, adults: 0, children: 0 }

  const cursor = new Date(first)
  while (cursor.getUTCMonth() === month - 1) {
    const key = dateKeyFromDate(cursor)
    byDate.set(key, {
      date: key,
      day: cursor.getUTCDate(),
      weekday: cursor.getUTCDay(),
      orders: 0,
      adults: 0,
      children: 0,
      tickets: 0,
      revenueMinor: 0,
      checkedIn: 0,
      closed: closedMap.has(key),
      weeklyClosed: weeklyDays.has(cursor.getUTCDay()),
      reason: closedMap.get(key) ?? '',
      capacity: settings.dailyCapacity,
      remaining: settings.dailyCapacity > 0 ? settings.dailyCapacity : null,
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  for (const order of orders) {
    if (!order.visitDate) continue
    const key = dateKeyFromDate(order.visitDate)
    const day = byDate.get(key)
    if (!day) continue
    day.orders += 1
    day.adults += order.adultQty
    day.children += order.childQty
    day.tickets += order.adultQty + order.childQty
    day.revenueMinor += order.totalMinor - order.refundedMinor
    if (order.checkedInAt) day.checkedIn += 1

    totals.orders += 1
    totals.adults += order.adultQty
    totals.children += order.childQty
    totals.tickets += order.adultQty + order.childQty
    totals.revenueMinor += order.totalMinor - order.refundedMinor
  }

  for (const day of byDate.values()) {
    day.revenueMinor = Math.max(0, day.revenueMinor)
    if (day.capacity > 0) day.remaining = Math.max(0, day.capacity - day.tickets)
  }

  return {
    year,
    month,
    monthKey: firstKey.slice(0, 7),
    currency: settings.currency,
    timezone,
    today,
    capacity: settings.dailyCapacity,
    days: [...byDate.values()],
    totals,
  }
}
