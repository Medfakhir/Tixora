import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAdminPage } from '@/lib/auth/guards'
import { prisma } from '@/lib/db/prisma'
import { getGeneral } from '@/lib/settings/service'
import { formatDateTime } from '@/lib/format'
import { PageHeader, SectionCard, StatCard, EmptyState } from '@/components/admin/page-primitives'
import { buttonVariants } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DeliveryStatusBadge, OrderStatusBadge } from '@/components/shared/status-badges'
import { Money } from '@/components/shared/money'

export const metadata = { title: 'Customer profile' }

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage()
  const { id } = await params

  const [customer, general] = await Promise.all([
    prisma.customer.findUnique({ where: { id } }),
    getGeneral(),
  ])

  if (!customer) notFound()

  const orders = await prisma.order.findMany({
    where: { customerEmail: customer.emailNormalized },
    orderBy: { createdAt: 'desc' },
    include: {
      lines: { select: { quantity: true } },
      _count: { select: { tickets: true } },
    },
  })

  const currency = general.defaultCurrency

  return (
    <div className="grid gap-6">
      <PageHeader
        title={customer.fullName}
        description={
          <span className="flex flex-wrap gap-2">
            <span>{customer.emailOriginal}</span>
            <span>·</span>
            <span>Customer since {formatDateTime(customer.createdAt, general.timezone)}</span>
          </span>
        }
        actions={
          <Link href="/admin/customers" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <ArrowLeft />
            Back to customers
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Paid orders" value={customer.totalOrders} hint={`${orders.length} order(s) in total`} />
        <StatCard label="Lifetime spent" value={<Money minor={customer.totalSpentMinor} currency={currency} />} tone="positive" />
        <StatCard label="Lifetime refunded" value={<Money minor={customer.totalRefundedMinor} currency={currency} />} />
        <StatCard
          label="Last purchase"
          value={customer.lastPurchaseAt ? formatDateTime(customer.lastPurchaseAt, general.timezone) : 'Never'}
          hint={customer.firstPurchaseAt ? `First purchase ${formatDateTime(customer.firstPurchaseAt, general.timezone)}` : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard title="Contact details" className="lg:col-span-1">
          <dl className="divide-y">
            <div className="grid gap-0.5 py-2 first:pt-0">
              <dt className="text-xs text-muted-foreground">Email as provided</dt>
              <dd>
                <a href={`mailto:${customer.emailOriginal}`} className="text-sm underline-offset-4 hover:underline">
                  {customer.emailOriginal}
                </a>
              </dd>
            </div>
            <div className="grid gap-0.5 py-2">
              <dt className="text-xs text-muted-foreground">Normalized email</dt>
              <dd className="font-mono text-sm">{customer.emailNormalized}</dd>
            </div>
            <div className="grid gap-0.5 py-2">
              <dt className="text-xs text-muted-foreground">Phone</dt>
              <dd className="text-sm">{customer.phone ?? '—'}</dd>
            </div>
            <div className="grid gap-0.5 py-2">
              <dt className="text-xs text-muted-foreground">First purchase</dt>
              <dd className="text-sm">{formatDateTime(customer.firstPurchaseAt, general.timezone)}</dd>
            </div>
            <div className="grid gap-0.5 py-2 last:pb-0">
              <dt className="text-xs text-muted-foreground">Last purchase</dt>
              <dd className="text-sm">{formatDateTime(customer.lastPurchaseAt, general.timezone)}</dd>
            </div>
          </dl>
        </SectionCard>

        <SectionCard title="Orders" description={`${orders.length} order(s) placed by this customer.`} className="lg:col-span-2">
          {orders.length === 0 ? (
            <EmptyState title="No orders yet" description="This customer started checkout but has not placed an order." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Delivery</TableHead>
                  <TableHead className="text-right">Tickets</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((order) => {
                  const sold = order.lines.reduce((sum, line) => sum + line.quantity, 0)
                  return (
                    <TableRow key={order.id}>
                      <TableCell>
                        <Link href={`/admin/orders/${order.id}`} className="font-medium underline-offset-4 hover:underline">
                          {order.reference}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDateTime(order.createdAt, general.timezone)}</TableCell>
                      <TableCell>
                        <OrderStatusBadge status={order.status} />
                      </TableCell>
                      <TableCell>
                        <DeliveryStatusBadge status={order.deliveryStatus} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="grid justify-items-end">
                          <span className="tabular-nums">{sold}</span>
                          <span className="text-xs text-muted-foreground">{order._count.tickets} file(s)</span>
                        </div>
                      </TableCell>
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
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </SectionCard>
      </div>
    </div>
  )
}
