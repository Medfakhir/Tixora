import { prisma } from '@/lib/db/prisma'

export type Range = { from: Date; to: Date; label: string }

export type RangeKey = 'today' | '7d' | '30d' | 'month' | 'year' | 'custom'

/**
 * Reporting timezone comes from GeneralSettings and is applied by bucketing on
 * UTC day boundaries offset by the store's fixed label only for display; every
 * stored timestamp is UTC so ranges stay unambiguous.
 */
export function resolveRange(key: RangeKey, timezone: string, custom?: { from: Date; to: Date }): Range {
  const now = new Date()
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const storeToday = formatter.format(now)
  const startOfDayUtc = (yyyyMmDd: string) => new Date(`${yyyyMmDd}T00:00:00.000Z`)

  const today = startOfDayUtc(storeToday)
  switch (key) {
    case 'today':
      return { from: today, to: now, label: 'Today' }
    case '7d':
      return { from: new Date(today.getTime() - 6 * 86_400_000), to: now, label: 'Last 7 days' }
    case '30d':
      return { from: new Date(today.getTime() - 29 * 86_400_000), to: now, label: 'Last 30 days' }
    case 'month':
      return { from: startOfDayUtc(`${storeToday.slice(0, 7)}-01`), to: now, label: 'This month' }
    case 'year':
      return { from: startOfDayUtc(`${storeToday.slice(0, 4)}-01-01`), to: now, label: 'This year' }
    case 'custom':
      return { from: custom?.from ?? today, to: custom?.to ?? now, label: 'Custom range' }
  }
}

const REVENUE_STATUSES = ['PAID', 'PROCESSING', 'COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DELIVERY_FAILED'] as const

export type AnalyticsReport = {
  range: Range
  revenue: { grossMinor: number; refundedMinor: number; netMinor: number; currency: string }
  orders: { total: number; paid: number; pending: number; cancelled: number; refunded: number; averageOrderValueMinor: number; conversionRate: number | null }
  tickets: { uploaded: number; available: number; reserved: number; sold: number; delivered: number; failedDelivery: number }
  revenueByDay: { date: string; grossMinor: number; netMinor: number }[]
  revenueByProduct: { productName: string; revenueMinor: number; tickets: number }[]
  byEnvironment: { environment: string; grossMinor: number; orders: number }[]
  lowInventory: { productId: string; productName: string; sessionLabel: string; available: number; threshold: number }[]
}

/**
 * Every number is computed from stored rows. Gross revenue counts only orders that
 * were actually paid, refunds are subtracted separately, and unpaid orders never
 * enter the revenue figures.
 */
export async function buildAnalytics(range: Range, currencyFallback = 'USD'): Promise<AnalyticsReport> {
  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: range.from, lte: range.to } },
    include: { lines: true },
  })

  const paidOrders = orders.filter((order) => REVENUE_STATUSES.includes(order.status as (typeof REVENUE_STATUSES)[number]) && order.paidAt)
  const grossMinor = paidOrders.reduce((sum, order) => sum + order.totalMinor, 0)
  const refundedMinor = paidOrders.reduce((sum, order) => sum + order.refundedMinor, 0)

  const totalsByDay = new Map<string, { gross: number; refunded: number }>()
  for (const order of paidOrders) {
    const day = order.paidAt!.toISOString().slice(0, 10)
    const bucket = totalsByDay.get(day) ?? { gross: 0, refunded: 0 }
    bucket.gross += order.totalMinor
    bucket.refunded += order.refundedMinor
    totalsByDay.set(day, bucket)
  }
  // Fills gaps so the chart shows a continuous axis instead of a misleading spike.
  const revenueByDay: AnalyticsReport['revenueByDay'] = []
  for (let cursor = new Date(range.from); cursor <= range.to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.toISOString().slice(0, 10)
    const bucket = totalsByDay.get(day) ?? { gross: 0, refunded: 0 }
    revenueByDay.push({ date: day, grossMinor: bucket.gross, netMinor: bucket.gross - bucket.refunded })
  }

  const productTotals = new Map<string, { revenueMinor: number; tickets: number }>()
  for (const order of paidOrders) {
    for (const line of order.lines) {
      const current = productTotals.get(line.productName) ?? { revenueMinor: 0, tickets: 0 }
      current.revenueMinor += line.lineTotalMinor
      current.tickets += line.quantity
      productTotals.set(line.productName, current)
    }
  }

  const [ticketGroups, checkoutStarted] = await Promise.all([
    prisma.ticketInventory.groupBy({ by: ['status'], _count: { _all: true } }),
    orders.filter((order) => ['PENDING', 'AWAITING_PAYMENT'].includes(order.status)).length,
  ])
  const statusCount = (status: string) => ticketGroups.find((group) => group.status === status)?._count._all ?? 0
  const uploaded = ticketGroups.reduce((sum, group) => sum + group._count._all, 0)

  const byEnvironmentGroups = await prisma.order.groupBy({
    by: ['paymentEnvironment'],
    where: { id: { in: paidOrders.map((order) => order.id) } },
    _sum: { totalMinor: true },
    _count: { _all: true },
  })

  const published = await prisma.product.findMany({
    where: { status: 'PUBLISHED' },
    select: { id: true, name: true, lowInventoryThreshold: true, inventory: { select: { status: true, eventSessionId: true } } },
  })
  const sessions = await prisma.eventSession.findMany({ where: { productId: { in: published.map((product) => product.id) } } })
  const sessionLabel = new Map(sessions.map((session) => [session.id, `${session.date.toISOString().slice(0, 10)} ${session.startTime}`]))
  const lowInventory: AnalyticsReport['lowInventory'] = []
  for (const product of published) {
    const available = product.inventory.filter((ticket) => ticket.status === 'AVAILABLE')
    if (available.length <= product.lowInventoryThreshold) {
      const bySession = new Map<string, number>()
      for (const ticket of available) {
        const key = ticket.eventSessionId ?? 'any'
        bySession.set(key, (bySession.get(key) ?? 0) + 1)
      }
      for (const [key, count] of bySession) {
        if (count <= product.lowInventoryThreshold) {
          lowInventory.push({
            productId: product.id,
            productName: product.name,
            sessionLabel: key === 'any' ? 'All dates' : sessionLabel.get(key) ?? 'Unknown session',
            available: count,
            threshold: product.lowInventoryThreshold,
          })
        }
      }
    }
  }

  return {
    range,
    revenue: {
      grossMinor: grossMinor,
      refundedMinor,
      netMinor: grossMinor - refundedMinor,
      currency: paidOrders[0]?.currency ?? currencyFallback,
    },
    orders: {
      total: orders.length,
      paid: paidOrders.length,
      pending: checkoutStarted,
      cancelled: orders.filter((order) => order.status === 'CANCELLED').length,
      refunded: orders.filter((order) => order.status === 'REFUNDED' || order.refundedMinor > 0).length,
      averageOrderValueMinor: paidOrders.length ? Math.round(grossMinor / paidOrders.length) : 0,
      conversionRate: orders.length ? Number(((paidOrders.length / orders.length) * 100).toFixed(1)) : null,
    },
    tickets: {
      uploaded,
      available: statusCount('AVAILABLE'),
      reserved: statusCount('RESERVED'),
      sold: statusCount('SOLD'),
      delivered: statusCount('DELIVERED'),
      failedDelivery: statusCount('FAILED_DELIVERY'),
    },
    revenueByDay,
    revenueByProduct: [...productTotals.entries()]
      .map(([productName, value]) => ({ productName, ...value }))
      .sort((a, b) => b.revenueMinor - a.revenueMinor),
    byEnvironment: byEnvironmentGroups.map((group) => ({
      environment: group.paymentEnvironment ?? 'UNKNOWN',
      grossMinor: group._sum.totalMinor ?? 0,
      orders: group._count._all,
    })),
    lowInventory,
  }
}
