import { withApi } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { recordAudit } from '@/lib/auth/guards'
import { resolveRange, type RangeKey } from '@/lib/analytics/report'
import { getGeneral } from '@/lib/settings/service'
import { minorUnitsFor } from '@/lib/money'
import { ordersWhere, type OrderFilters } from '@/lib/orders/query'
import { parseDateKey } from '@/lib/museum/dates'
import type { OrderKind, OrderStatus } from '@prisma/client'

const RANGE_KEYS: RangeKey[] = ['today', '7d', '30d', 'month', 'year']

const ORDER_STATUSES: OrderStatus[] = [
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
]

/**
 * CSV export carries customer PII, so it is authorised, bounded and audited: a date range
 * is mandatory and the row cap is enforced at the query level rather than after fetching.
 */
export const GET = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'sensitive', 'SUPER_ADMIN')
  const url = new URL(request.url)
  const rangeParam = url.searchParams.get('range') as RangeKey | null
  const rangeKey = rangeParam && RANGE_KEYS.includes(rangeParam) ? rangeParam : 'month'
  const general = await getGeneral()
  const range = resolveRange(rangeKey, general.timezone)

  const kindParam = url.searchParams.get('kind')
  const kind: OrderKind | null = kindParam === 'MUSEUM' || kindParam === 'TICKET' ? kindParam : null
  const statusParam = url.searchParams.get('status') as OrderStatus | null
  const status = statusParam && ORDER_STATUSES.includes(statusParam) ? statusParam : null
  const visitDate = parseDateKey(url.searchParams.get('visitDate') ?? '')
  const search = url.searchParams.get('q')?.trim() || null

  const filters: OrderFilters = {
    search,
    status,
    kind,
    visitDate,
    from: range.from,
    to: range.to,
    page: 1,
    pageSize: 5000,
    sort: 'createdAt_desc',
  }

  const orders = await prisma.order.findMany({
    where: ordersWhere(filters),
    orderBy: { createdAt: 'desc' },
    take: 5000,
    include: { lines: true },
  })

  const header = [
    'kind',
    'reference',
    'status',
    'delivery_status',
    'customer_name',
    'customer_email',
    'customer_phone',
    'visit_date',
    'adults',
    'children',
    'session',
    'product',
    'quantity',
    'subtotal',
    'tax',
    'total',
    'refunded',
    'currency',
    'checked_in_at',
    'checked_in_by',
    'payment_environment',
    'paypal_order_id',
    'paypal_capture_id',
    'created_at',
    'paid_at',
  ]

  const rows = orders.map((order) => [
    order.kind,
    order.reference,
    order.status,
    order.deliveryStatus,
    order.customerName,
    order.customerEmail,
    order.customerPhone ?? '',
    order.visitDate ? order.visitDate.toISOString().slice(0, 10) : '',
    order.kind === 'MUSEUM' ? String(order.adultQty) : '',
    order.kind === 'MUSEUM' ? String(order.childQty) : '',
    order.sessionSummary,
    order.kind === 'MUSEUM' ? 'Badi Palace Museum entrance' : order.lines.map((line) => line.productName).join(' | '),
    String(
      order.kind === 'MUSEUM'
        ? order.adultQty + order.childQty
        : order.lines.reduce((sum, line) => sum + line.quantity, 0),
    ),
    // Cents are exported as decimal units because that is what a spreadsheet expects.
    decimal(order.subtotalMinor, order.currency),
    decimal(order.taxMinor, order.currency),
    decimal(order.totalMinor, order.currency),
    decimal(order.refundedMinor, order.currency),
    order.currency,
    order.checkedInAt?.toISOString() ?? '',
    order.checkedInBy ?? '',
    order.paymentEnvironment ?? '',
    order.paypalOrderId ?? '',
    order.paypalCaptureId ?? '',
    order.createdAt.toISOString(),
    order.paidAt?.toISOString() ?? '',
  ])

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'ORDERS_EXPORT',
    entityType: 'Order',
    summary: `Exported ${rows.length} order(s) for ${range.label}${kind ? ` (${kind})` : ''}`,
    metadata: { range: rangeKey, kind, status, visitDate: visitDate?.toISOString().slice(0, 10) ?? null },
    ip,
  })

  const csv = [header, ...rows].map((line) => line.map(escapeCell).join(',')).join('\r\n')
  // A BOM keeps Excel from mangling UTF-8 names in the spreadsheet.
  const body = `\uFEFF${csv}`

  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="badipalace-orders-${rangeKey}.csv"`,
      'cache-control': 'private, no-store',
    },
  })
})

function decimal(minor: number, currency: string): string {
  return (minor / 10 ** minorUnitsFor(currency)).toFixed(minorUnitsFor(currency))
}

/** Neutralises spreadsheet formula injection (=cmd, +cmd, @cmd, -cmd). */
function escapeCell(value: string): string {
  const text = value ?? ''
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  if (/[",\r\n]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`
  return guarded
}
