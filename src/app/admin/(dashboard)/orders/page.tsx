import Link from 'next/link'
import { Download } from 'lucide-react'
import { requireAdminPage } from '@/lib/auth/guards'
import { getGeneral } from '@/lib/settings/service'
import { listOrders, type OrderFilters } from '@/lib/orders/query'
import { formatDateTime } from '@/lib/format'
import { formatVisitDateShort } from '@/lib/museum/dates'
import { PageHeader, SectionCard, EmptyState } from '@/components/admin/page-primitives'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { OrderStatusBadge, DeliveryStatusBadge, humanize } from '@/components/shared/status-badges'
import { Money } from '@/components/shared/money'
import type { DeliveryStatus, OrderKind, OrderStatus, PaymentEnvironment } from '@prisma/client'

export const metadata = { title: 'Orders' }

const PAGE_SIZE = 20

const ORDER_STATUSES = [
  'PENDING',
  'AWAITING_PAYMENT',
  'PAID',
  'PROCESSING',
  'COMPLETED',
  'PAYMENT_FAILED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'DELIVERY_FAILED',
] as const

const DELIVERY_STATUSES = ['NOT_REQUIRED', 'PENDING', 'QUEUED', 'SENT', 'PARTIALLY_SENT', 'FAILED'] as const
const ENVIRONMENTS = ['SANDBOX', 'LIVE'] as const
const KINDS = ['MUSEUM', 'TICKET'] as const

const SORTS = [
  { value: 'createdAt_desc', label: 'Newest first' },
  { value: 'createdAt_asc', label: 'Oldest first' },
  { value: 'totalMinor_desc', label: 'Highest total' },
  { value: 'reference_asc', label: 'Reference A to Z' },
] as const

type Sort = OrderFilters['sort']
type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function pick<T extends string>(value: string, allowed: readonly T[]): T | null {
  return (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function parsePage(value: string): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function parseDay(value: string, endOfDay = false): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

function inputDay(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : ''
}

function exportRange(from: Date | null, to: Date | null): string {
  if (!from) return 'month'
  const days = Math.ceil(((to ?? new Date()).getTime() - from.getTime()) / 86_400_000)
  if (days <= 1) return 'today'
  if (days <= 7) return '7d'
  if (days <= 31) return '30d'
  return 'year'
}

function FilterSelect({
  id,
  label,
  name,
  value,
  options,
  placeholder,
}: {
  id: string
  label: string
  name: string
  value: string
  options: readonly string[]
  placeholder: string
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        name={name}
        defaultValue={value}
        className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {humanize(option)}
          </option>
        ))}
      </select>
    </div>
  )
}

export default async function OrdersPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage()
  const params = await searchParams
  const general = await getGeneral()

  const search = first(params.q).trim()
  const status = pick<OrderStatus>(first(params.status), ORDER_STATUSES)
  const deliveryStatus = pick<DeliveryStatus>(first(params.delivery), DELIVERY_STATUSES)
  const environment = pick<PaymentEnvironment>(first(params.env), ENVIRONMENTS)
  const kind = pick<OrderKind>(first(params.kind), KINDS)
  const visitDate = parseDay(first(params.visitDate))
  const sort = pick<Sort>(first(params.sort), SORTS.map((option) => option.value)) ?? 'createdAt_desc'
  const from = parseDay(first(params.from))
  const to = parseDay(first(params.to), true)
  const page = parsePage(first(params.page))

  const filters: OrderFilters = {
    search: search || null,
    status,
    deliveryStatus,
    environment,
    kind,
    visitDate,
    from,
    to,
    page,
    pageSize: PAGE_SIZE,
    sort,
  }
  const { orders, total, pages } = await listOrders(filters)

  const baseParams = new URLSearchParams()
  if (search) baseParams.set('q', search)
  if (status) baseParams.set('status', status)
  if (deliveryStatus) baseParams.set('delivery', deliveryStatus)
  if (environment) baseParams.set('env', environment)
  if (kind) baseParams.set('kind', kind)
  if (visitDate) baseParams.set('visitDate', inputDay(visitDate))
  if (from) baseParams.set('from', inputDay(from))
  if (to) baseParams.set('to', inputDay(to))
  if (sort !== 'createdAt_desc') baseParams.set('sort', sort)

  const pageHref = (target: number) => {
    const next = new URLSearchParams(baseParams)
    if (target > 1) next.set('page', String(target))
    const query = next.toString()
    return query ? `/admin/orders?${query}` : '/admin/orders'
  }

  const exportParams = new URLSearchParams(baseParams)
  exportParams.set('range', exportRange(from, to))
  const exportHref = `/api/admin/orders/export?${exportParams.toString()}`

  const hasFilters = baseParams.toString().length > 0

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Orders"
        description="Every order stored by the storefront. Search, filter and open an order to manage it."
        actions={
          <a href={exportHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <Download />
            Export CSV
          </a>
        }
      />

      <SectionCard title="Filters" description="Filters combine; submitting resets to the first page.">
        <form method="get" action="/admin/orders" className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="grid gap-1.5 md:col-span-2">
            <Label htmlFor="q">Search</Label>
            <Input id="q" name="q" defaultValue={search} placeholder="Reference, customer email, name or PayPal order" />
          </div>
          <FilterSelect id="status" name="status" label="Order status" value={status ?? ''} options={ORDER_STATUSES} placeholder="All statuses" />
          <FilterSelect
            id="delivery"
            name="delivery"
            label="Delivery status"
            value={deliveryStatus ?? ''}
            options={DELIVERY_STATUSES}
            placeholder="All delivery statuses"
          />
          <FilterSelect id="env" name="env" label="Environment" value={environment ?? ''} options={ENVIRONMENTS} placeholder="All environments" />
          <FilterSelect id="kind" name="kind" label="Order type" value={kind ?? ''} options={KINDS} placeholder="All types" />
          <div className="grid gap-1.5">
            <Label htmlFor="visitDate">Visit date</Label>
            <Input id="visitDate" name="visitDate" type="date" defaultValue={inputDay(visitDate)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="from">Created from</Label>
            <Input id="from" name="from" type="date" defaultValue={inputDay(from)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="to">Created to</Label>
            <Input id="to" name="to" type="date" defaultValue={inputDay(to)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sort">Sort</Label>
            <select
              id="sort"
              name="sort"
              defaultValue={sort}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2 md:col-span-2 xl:col-span-4">
            <Button type="submit" size="sm">
              Apply filters
            </Button>
            {hasFilters ? (
              <Link href="/admin/orders" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                Reset
              </Link>
            ) : null}
          </div>
        </form>
      </SectionCard>

      <SectionCard>
        {orders.length === 0 ? (
          <EmptyState
            title={total === 0 ? 'No orders found' : 'No orders on this page'}
            description={total === 0 ? 'No order matches the current filters.' : 'This page is past the end of the result set.'}
            action={
              total === 0 ? null : (
                <Link href={pageHref(1)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  Go to first page
                </Link>
              )
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Visit / product</TableHead>
                <TableHead className="text-right">Tickets</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Check-in / delivery</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <Link href={`/admin/orders/${order.id}`} className="font-medium underline-offset-4 hover:underline">
                      {order.reference}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="grid">
                      <Link href={`/admin/orders/${order.id}`} className="max-w-48 truncate underline-offset-4 hover:underline">
                        {order.customerName}
                      </Link>
                      <span className="max-w-48 truncate text-xs text-muted-foreground">{order.customerEmail}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="grid">
                      {order.kind === 'MUSEUM' ? (
                        <>
                          <span className="max-w-56 truncate font-medium">
                            {order.visitDate ? formatVisitDateShort(order.visitDate, 'en') : 'No visit date'}
                          </span>
                          <span className="max-w-56 truncate text-xs text-muted-foreground">
                            {order.adultQty} adult · {order.childQty} child
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="max-w-56 truncate">{order.productName || 'No line items'}</span>
                          {order.sessionSummary ? (
                            <span className="max-w-56 truncate text-xs text-muted-foreground">{order.sessionSummary}</span>
                          ) : null}
                        </>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{order.ticketCount}</TableCell>
                  <TableCell className="text-right">
                    <div className="grid justify-items-end">
                      <Money minor={order.totalMinor} currency={order.currency} className="tabular-nums" />
                      {order.refundedMinor > 0 ? (
                        <span className="text-xs text-muted-foreground">
                          <Money minor={order.refundedMinor} currency={order.currency} /> refunded
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <OrderStatusBadge status={order.status} />
                  </TableCell>
                  <TableCell>
                    {order.kind === 'MUSEUM' ? (
                      order.checkedInAt ? (
                        <div className="grid">
                          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Checked in</span>
                          <span className="text-[11px] text-muted-foreground">
                            {formatDateTime(order.checkedInAt, general.timezone)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">Not checked in</span>
                      )
                    ) : (
                      <DeliveryStatusBadge status={order.deliveryStatus} />
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDateTime(order.createdAt, general.timezone)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>
          Page {Math.min(page, pages)} of {pages} · {total} order{total === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-2">
          {page <= 1 ? (
            <Button variant="outline" size="sm" disabled>
              Previous
            </Button>
          ) : (
            <Link href={pageHref(page - 1)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Previous
            </Link>
          )}
          {page >= pages ? (
            <Button variant="outline" size="sm" disabled>
              Next
            </Button>
          ) : (
            <Link href={pageHref(page + 1)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Next
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
