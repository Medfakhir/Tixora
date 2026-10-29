import Link from 'next/link'
import { ArrowRight, CalendarDays, QrCode, Settings2, TrendingUp, Users } from 'lucide-react'
import { buildMuseumReport } from '@/lib/museum/reports'
import { formatVisitDateShort } from '@/lib/museum/dates'
import { formatDateTime } from '@/lib/format'
import { getMuseumSettings } from '@/lib/museum/settings'
import { PageHeader, SectionCard, StatCard, EmptyState } from '@/components/admin/page-primitives'
import { RevenueTrendChart } from '@/components/admin/analytics-charts'
import { Money } from '@/components/shared/money'
import { buttonVariants } from '@/components/ui/button'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { OrderStatusBadge } from '@/components/shared/status-badges'

export const metadata = { title: 'Overview' }
export const dynamic = 'force-dynamic'

export default async function AdminOverviewPage() {
  const [report, settings] = await Promise.all([buildMuseumReport(), getMuseumSettings()])
  const upcoming = report.upcoming

  const periodHint = (orders: number, tickets: number) => `${orders} order${orders === 1 ? '' : 's'} · ${tickets} ticket${tickets === 1 ? '' : 's'}`

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Museum overview"
        description={`Live sales for ${settings.museumName}. All figures come from paid bookings and are shown in ${settings.currency}.`}
        actions={
          <>
            <Button size="sm" render={<Link href="/admin/check-in" />}>
              <QrCode data-icon="inline-start" /> Check in
            </Button>
            <Button size="sm" variant="outline" render={<Link href="/admin/sales-calendar" />}>
              <CalendarDays data-icon="inline-start" /> Sales calendar
            </Button>
            <Button size="sm" variant="outline" render={<Link href="/admin/settings/museum" />}>
              <Settings2 data-icon="inline-start" /> Settings
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Revenue today"
          value={<Money minor={report.today.revenueMinor} currency={report.currency} />}
          hint={periodHint(report.today.orders, report.today.tickets)}
          tone="positive"
        />
        <StatCard
          label="This week"
          value={<Money minor={report.week.revenueMinor} currency={report.currency} />}
          hint={periodHint(report.week.orders, report.week.tickets)}
        />
        <StatCard
          label="This month"
          value={<Money minor={report.month.revenueMinor} currency={report.currency} />}
          hint={periodHint(report.month.orders, report.month.tickets)}
        />
        <StatCard
          label="All time"
          value={<Money minor={report.allTime.revenueMinor} currency={report.currency} />}
          hint={periodHint(report.allTime.orders, report.allTime.tickets)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Paid orders" value={report.allTime.orders.toLocaleString()} hint="Museum bookings only" />
        <StatCard
          label="Tickets sold"
          value={report.allTime.tickets.toLocaleString()}
          hint={`${report.allTime.adults.toLocaleString()} adult · ${report.allTime.children.toLocaleString()} child`}
        />
        <StatCard
          label="Checked in today"
          value={`${report.checkedInToday} / ${report.expectedToday}`}
          hint={report.expectedToday > 0 ? 'Visitors expected today' : 'No visits expected today'}
          tone={report.expectedToday > 0 && report.checkedInToday < report.expectedToday ? 'warning' : 'default'}
        />
        <StatCard
          label="Capacity"
          value={settings.dailyCapacity > 0 ? settings.dailyCapacity.toLocaleString() : 'Unlimited'}
          hint={`Same-day cutoff ${settings.cutoffTime} · ${settings.timezone}`}
        />
      </div>

      <SectionCard
        title="Revenue · last 30 days"
        description="Net of refunds, grouped by payment day in the museum timezone."
      >
        <RevenueTrendChart data={report.revenueByDay} currency={report.currency} />
      </SectionCard>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <SectionCard
          title="Upcoming visits"
          description="Confirmed parties for the next 14 days."
          className="overflow-hidden"
        >
          {upcoming.length === 0 ? (
            <EmptyState
              title="No upcoming visits"
              description="Paid bookings will appear here as soon as visitors book."
              action={<Button size="sm" variant="outline" render={<Link href="/#book" />}>Open booking page</Button>}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Visit date</TableHead>
                  <TableHead className="text-right">Parties</TableHead>
                  <TableHead className="text-right">Tickets</TableHead>
                  <TableHead className="text-right">Checked in</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {upcoming.map((day) => (
                  <TableRow key={day.date}>
                    <TableCell className="font-medium">{formatVisitDateShort(day.date, 'en')}</TableCell>
                    <TableCell className="text-right tabular-nums">{day.orders}</TableCell>
                    <TableCell className="text-right tabular-nums">{day.tickets}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {day.checkedIn > 0 ? (
                        <span className={day.checkedIn >= day.orders ? 'text-emerald-600 dark:text-emerald-400' : ''}>
                          {day.checkedIn}/{day.orders}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>

        <SectionCard title="Quick actions" description="The tools used most at the gate and in the office.">
          <div className="grid gap-2">
            <QuickLink
              href="/admin/check-in"
              icon={<QrCode className="size-4" />}
              title="Gate check-in"
              description="Scan a QR code or enter a booking reference."
            />
            <QuickLink
              href="/admin/sales-calendar"
              icon={<CalendarDays className="size-4" />}
              title="Monthly sales calendar"
              description="Revenue and tickets by visit date, with closures shown."
            />
            <QuickLink
              href="/admin/closed-dates"
              icon={<TrendingUp className="size-4" />}
              title="Closures"
              description="Close a date range or a recurring weekday."
            />
            <QuickLink
              href="/admin/settings/museum"
              icon={<Settings2 className="size-4" />}
              title="Museum settings"
              description="Prices, capacity, cutoff time and booking window."
            />
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Recent bookings"
        description="The latest museum orders, including unpaid checkouts."
        className="overflow-hidden"
        action={
          <Link href="/admin/orders?kind=MUSEUM" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            All orders <ArrowRight data-icon="inline-end" />
          </Link>
        }
      >
        {report.recentOrders.length === 0 ? (
          <EmptyState
            title="No bookings yet"
            description="Share the booking link and the first order will appear here."
            action={<Button size="sm" render={<Link href="/#book" />}>Open booking page</Button>}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Visit</TableHead>
                <TableHead className="text-right">Tickets</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Booked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.recentOrders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <Link href={`/admin/orders/${order.id}`} className="font-mono text-xs font-medium underline-offset-4 hover:underline">
                      {order.reference}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="grid">
                      <span className="truncate text-sm">{order.customerName}</span>
                      <span className="truncate text-xs text-muted-foreground">{order.customerEmail}</span>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    {order.visitDate ? formatVisitDateShort(order.visitDate, 'en') : '—'}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      <Users className="size-3.5 text-muted-foreground" />
                      {order.adultQty + order.childQty}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {order.adultQty} adult · {order.childQty} child
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    <Money minor={order.totalMinor} currency={order.currency} />
                  </TableCell>
                  <TableCell>
                    <OrderStatusBadge status={order.status as never} />
                    {order.checkedInAt ? (
                      <span className="mt-1 block text-[11px] text-emerald-600 dark:text-emerald-400">Checked in</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTime(order.createdAt, settings.timezone)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  )
}

function QuickLink({
  href,
  icon,
  title,
  description,
}: {
  href: string
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 rounded-lg border p-3 transition-colors hover:border-primary/40 hover:bg-muted/40"
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}
