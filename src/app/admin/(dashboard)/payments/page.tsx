import Link from 'next/link'
import type { PaymentStatus } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getGeneral } from '@/lib/settings/service'
import { PageHeader, SectionCard, EmptyState } from '@/components/admin/page-primitives'
import { Money } from '@/components/shared/money'
import { EnvironmentBadge, humanize } from '@/components/shared/status-badges'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTime } from '@/lib/format'

export const metadata = { title: 'Payments' }

const PAYMENT_STATUS_VARIANTS: Record<PaymentStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  CREATED: 'outline',
  APPROVED: 'secondary',
  CAPTURED: 'default',
  FAILED: 'destructive',
  DENIED: 'destructive',
  REFUNDED: 'secondary',
  PARTIALLY_REFUNDED: 'outline',
  VOIDED: 'outline',
}

function maskCapture(value: string | null): string {
  if (!value) return '—'
  return `…${value.slice(-6)}`
}

export default async function AdminPaymentsPage() {
  const [general, payments, refunds, paymentCount, refundCount] = await Promise.all([
    getGeneral(),
    prisma.payment.findMany({
      orderBy: { createdAt: 'desc' },
      take: 25,
      include: { order: { select: { id: true, reference: true } } },
    }),
    prisma.refund.findMany({
      orderBy: { createdAt: 'desc' },
      take: 25,
      include: { order: { select: { id: true, reference: true } } },
    }),
    prisma.payment.count(),
    prisma.refund.count(),
  ])

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Payments"
        description="PayPal captures and refunds recorded against orders."
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{paymentCount} payments</Badge>
            <Badge variant="secondary">{refundCount} refunds</Badge>
          </div>
        }
      />

      <SectionCard
        title="Payments"
        description={`Showing the latest ${payments.length} of ${paymentCount} payment records`}
      >
        {payments.length === 0 ? (
          <EmptyState
            title="No payments yet"
            description="Payment attempts appear here as soon as a checkout reaches PayPal."
            action={
              <Button variant="outline" size="sm" render={<Link href="/admin/orders" />}>
                View orders
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Environment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Capture ID</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell>
                    <Link href={`/admin/orders/${payment.order.id}`} className="font-medium hover:underline">
                      {payment.order.reference}
                    </Link>
                  </TableCell>
                  <TableCell>{humanize(payment.provider)}</TableCell>
                  <TableCell>
                    <EnvironmentBadge environment={payment.environment} />
                  </TableCell>
                  <TableCell>
                    <Badge variant={PAYMENT_STATUS_VARIANTS[payment.status]}>{humanize(payment.status)}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Money minor={payment.amountMinor} currency={payment.currency} />
                  </TableCell>
                  <TableCell>
                    <code className="text-xs text-muted-foreground">{maskCapture(payment.captureId)}</code>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDateTime(payment.createdAt, general.timezone)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <SectionCard title="Refunds" description={`Showing the latest ${refunds.length} of ${refundCount} refund records`}>
        {refunds.length === 0 ? (
          <EmptyState title="No refunds recorded" description="Refunds issued from the orders screen will appear here." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Environment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Capture ID</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {refunds.map((refund) => (
                <TableRow key={refund.id}>
                  <TableCell>
                    <Link href={`/admin/orders/${refund.order.id}`} className="font-medium hover:underline">
                      {refund.order.reference}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <EnvironmentBadge environment={refund.environment} />
                  </TableCell>
                  <TableCell>
                    <Badge variant={PAYMENT_STATUS_VARIANTS[refund.status]}>{humanize(refund.status)}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Money minor={refund.amountMinor} currency={refund.currency} />
                  </TableCell>
                  <TableCell>
                    <code className="text-xs text-muted-foreground">{maskCapture(refund.captureId)}</code>
                  </TableCell>
                  <TableCell>
                    {refund.reason ? (
                      <span className="block max-w-[240px] truncate text-xs text-muted-foreground" title={refund.reason}>
                        {refund.reason}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDateTime(refund.createdAt, general.timezone)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  )
}
