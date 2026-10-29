import Link from 'next/link'
import { CalendarDays, ChevronLeft, ChevronRight, Download, Lock } from 'lucide-react'
import { PageHeader, SectionCard, StatCard } from '@/components/admin/page-primitives'
import { Button, buttonVariants } from '@/components/ui/button'
import { Money } from '@/components/shared/money'
import { buildSalesCalendar } from '@/lib/museum/reports'
import { monthLabel, parseMonthKey, shiftMonth } from '@/lib/museum/dates'

export const metadata = { title: 'Sales calendar' }
export const dynamic = 'force-dynamic'

const WEEK_ORDER = [0, 1, 2, 3, 4, 5, 6] as const
const WEEK_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default async function SalesCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const rawMonth = Array.isArray(params.month) ? params.month[0] : params.month
  const { year, month } = parseMonthKey(rawMonth, 'Africa/Casablanca')
  const calendar = await buildSalesCalendar(year, month)
  const previous = shiftMonth(year, month, -1)
  const next = shiftMonth(year, month, 1)
  const firstWeekday = calendar.days[0]?.weekday ?? 0

  const closedDays = calendar.days.filter((day) => day.closed || day.weeklyClosed).length

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Sales calendar"
        description="Revenue and tickets grouped by visit date. Closed dates and capacity are shown alongside sales."
        actions={
          <Button variant="outline" size="sm" render={<Link href="/api/admin/orders/export?range=month" />}>
            <Download data-icon="inline-start" /> Export orders CSV
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Month revenue"
          value={<Money minor={calendar.totals.revenueMinor} currency={calendar.currency} />}
          hint={`${calendar.totals.orders} paid order${calendar.totals.orders === 1 ? '' : 's'}`}
          tone="positive"
        />
        <StatCard
          label="Tickets"
          value={calendar.totals.tickets.toLocaleString()}
          hint={`${calendar.totals.adults} adult · ${calendar.totals.children} child`}
        />
        <StatCard label="Closed days" value={closedDays} hint="Closed dates plus weekly closures in this month" />
        <StatCard
          label="Daily capacity"
          value={calendar.capacity > 0 ? calendar.capacity.toLocaleString() : 'Unlimited'}
          hint={calendar.capacity > 0 ? 'Remaining places are shown per day' : 'Set a capacity in museum settings'}
        />
      </div>

      <SectionCard
        title={monthLabel(year, month, 'en')}
        description="Click a day to see its bookings. Sales are counted by visit date, not payment date."
        action={
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="icon-sm" render={<Link href={`/admin/sales-calendar?month=${previous.year}-${String(previous.month).padStart(2, '0')}`} />} aria-label="Previous month">
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="sm" render={<Link href="/admin/sales-calendar" />}>
              Today
            </Button>
            <Button variant="outline" size="icon-sm" render={<Link href={`/admin/sales-calendar?month=${next.year}-${String(next.month).padStart(2, '0')}`} />} aria-label="Next month">
              <ChevronRight />
            </Button>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <div className="min-w-[720px]">
            <div className="grid grid-cols-7 gap-1 pb-1">
              {WEEK_ORDER.map((weekday) => (
                <div key={weekday} className="px-2 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {WEEK_LABELS[weekday]}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: firstWeekday }, (_, index) => (
                <div key={`blank-${index}`} className="min-h-24 rounded-lg border border-transparent" />
              ))}
              {calendar.days.map((day) => {
                const isToday = day.date === calendar.today
                const closed = day.closed || day.weeklyClosed
                const visitHref = `/admin/orders?kind=MUSEUM&visitDate=${day.date}`
                return (
                  <Link
                    key={day.date}
                    href={visitHref}
                    className={[
                      'group relative flex min-h-24 flex-col gap-1 rounded-lg border p-2 transition-colors',
                      closed ? 'border-dashed bg-muted/40' : 'bg-card hover:border-primary/40 hover:bg-muted/30',
                      isToday ? 'ring-1 ring-primary/50' : '',
                    ].join(' ')}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className={['text-sm font-semibold tabular-nums', closed ? 'text-muted-foreground' : ''].join(' ')}>
                        {day.day}
                      </span>
                      {closed ? <Lock className="size-3 text-muted-foreground" aria-label="Closed" /> : null}
                      {day.orders > 0 && !closed ? (
                        <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                          {day.orders}
                        </span>
                      ) : null}
                    </div>
                    {closed ? (
                      <p className="text-[10px] leading-snug text-muted-foreground">
                        {day.weeklyClosed ? 'Weekly closure' : day.reason || 'Closed'}
                      </p>
                    ) : day.orders > 0 ? (
                      <>
                        <p className="text-xs font-medium tabular-nums">
                          <Money minor={day.revenueMinor} currency={calendar.currency} />
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {day.tickets} ticket{day.tickets === 1 ? '' : 's'} · {day.adults}A/{day.children}C
                        </p>
                        <p className="mt-auto text-[10px] text-muted-foreground">
                          {day.checkedIn > 0 ? `${day.checkedIn}/${day.orders} checked in` : '\u00A0'}
                        </p>
                      </>
                    ) : (
                      <p className="text-[10px] text-muted-foreground">No sales</p>
                    )}
                    {day.capacity > 0 && !closed ? (
                      <p className="text-[10px] text-muted-foreground">{day.remaining} left</p>
                    ) : null}
                  </Link>
                )
              })}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-4 border-t pt-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-emerald-500" /> Paid bookings
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Lock className="size-3" /> Closed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="size-3" /> Click a day for its orders
          </span>
        </div>
      </SectionCard>

      <SectionCard title="Plan ahead" description="Open the closure manager to close a holiday or a recurring weekday.">
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/closed-dates" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Manage closures
          </Link>
          <Link href="/admin/settings/museum" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Capacity &amp; pricing
          </Link>
          <Link href="/admin/orders?kind=MUSEUM" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            All museum orders
          </Link>
        </div>
      </SectionCard>
    </div>
  )
}
