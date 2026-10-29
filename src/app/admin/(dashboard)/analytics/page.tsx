import Link from 'next/link'
import { buildAnalytics, resolveRange, type RangeKey } from '@/lib/analytics/report'
import { getGeneral } from '@/lib/settings/service'
import { prisma } from '@/lib/db/prisma'
import { PageHeader, StatCard } from '@/components/admin/page-primitives'
import { AnalyticsCharts } from '@/components/admin/analytics-charts'
import { Money } from '@/components/shared/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatDate } from '@/lib/format'

export const metadata = { title: 'Analytics' }

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'month', label: 'This month' },
  { key: 'year', label: 'This year' },
]

const RANGE_KEYS: RangeKey[] = ['today', '7d', '30d', 'month', 'year', 'custom']

function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

function parseBoundary(value: string, endOfDay: boolean): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const general = await getGeneral()
  const requested = readParam(params.range)
  const key: RangeKey = RANGE_KEYS.includes(requested as RangeKey) ? (requested as RangeKey) : '30d'

  const fromValue = readParam(params.from)
  const toValue = readParam(params.to)
  const from = parseBoundary(fromValue, false)
  const to = parseBoundary(toValue, true)
  const custom = from && to && from <= to ? { from, to } : undefined
  const effectiveKey: RangeKey = key === 'custom' && !custom ? '30d' : key

  const range = resolveRange(effectiveKey, general.timezone, custom)
  const [report, statusGroups] = await Promise.all([
    buildAnalytics(range, general.defaultCurrency),
    prisma.order.groupBy({
      by: ['status'],
      where: { createdAt: { gte: range.from, lte: range.to } },
      _count: { _all: true },
    }),
  ])

  const orderStatus = statusGroups
    .map((group) => ({ status: group.status, count: group._count._all }))
    .sort((a, b) => b.count - a.count)
  const ticketsByStatus = [
    { status: 'AVAILABLE', count: report.tickets.available },
    { status: 'RESERVED', count: report.tickets.reserved },
    { status: 'SOLD', count: report.tickets.sold },
    { status: 'DELIVERED', count: report.tickets.delivered },
    { status: 'FAILED_DELIVERY', count: report.tickets.failedDelivery },
  ]
  const { currency } = report.revenue

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Analytics"
        description={`${report.range.label}: ${formatDate(range.from)} to ${formatDate(range.to)}.`}
      />

      <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border bg-card p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {RANGE_OPTIONS.map((option) => (
            <Button
              key={option.key}
              size="sm"
              variant={effectiveKey === option.key ? 'default' : 'outline'}
              render={<Link href={`/admin/analytics?range=${option.key}`} />}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <form action="/admin/analytics" method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="range" value="custom" />
          <div className="grid gap-1">
            <Label htmlFor="from" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input id="from" name="from" type="date" defaultValue={fromValue} className="w-36" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="to" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input id="to" name="to" type="date" defaultValue={toValue} className="w-36" />
          </div>
          <Button type="submit" size="sm" variant={effectiveKey === 'custom' ? 'default' : 'outline'}>
            Apply custom range
          </Button>
        </form>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Gross revenue" value={<Money minor={report.revenue.grossMinor} currency={currency} />} hint={report.range.label} />
        <StatCard
          label="Net revenue"
          value={<Money minor={report.revenue.netMinor} currency={currency} />}
          hint={
            <>
              After <Money minor={report.revenue.refundedMinor} currency={currency} /> in refunds
            </>
          }
          tone="positive"
        />
        <StatCard
          label="Paid orders"
          value={report.orders.paid}
          hint={`${report.orders.total} created · ${report.orders.cancelled} cancelled`}
        />
        <StatCard
          label="Average order value"
          value={<Money minor={report.orders.averageOrderValueMinor} currency={currency} />}
          hint={report.orders.conversionRate === null ? 'No orders in range' : `${report.orders.conversionRate}% conversion`}
        />
      </div>

      <AnalyticsCharts
        revenueByDay={report.orders.paid > 0 ? report.revenueByDay : []}
        revenueByProduct={report.revenueByProduct.slice(0, 10)}
        byEnvironment={report.byEnvironment}
        orderStatus={orderStatus}
        ticketsByStatus={ticketsByStatus}
        currency={currency}
      />
    </div>
  )
}
