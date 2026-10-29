import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAdminPage } from '@/lib/auth/guards'
import { prisma } from '@/lib/db/prisma'
import { getGeneral } from '@/lib/settings/service'
import { formatDateTime } from '@/lib/format'
import { formatVisitDate } from '@/lib/museum/dates'
import { PageHeader, SectionCard } from '@/components/admin/page-primitives'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DeliveryStatusBadge, EnvironmentBadge, OrderStatusBadge, TicketStatusBadge, humanize } from '@/components/shared/status-badges'
import { Money } from '@/components/shared/money'
import { OrderActions, OrderNotes } from '@/components/admin/order-actions'
import type { EmailDeliveryStatus, OrderStatus } from '@prisma/client'

export const metadata = { title: 'Order details' }

const CANCELLABLE: OrderStatus[] = ['PENDING', 'AWAITING_PAYMENT']
const REFUNDABLE: OrderStatus[] = ['PAID', 'PROCESSING', 'COMPLETED', 'DELIVERY_FAILED', 'PARTIALLY_REFUNDED']
const RETRYABLE: OrderStatus[] = ['PAID', 'PROCESSING', 'COMPLETED', 'DELIVERY_FAILED']

const EMAIL_TONES: Record<EmailDeliveryStatus, 'secondary' | 'outline' | 'destructive'> = {
  QUEUED: 'outline',
  SENDING: 'secondary',
  SENT: 'secondary',
  FAILED: 'destructive',
  SKIPPED: 'outline',
}

function maskId(value: string | null | undefined): string {
  if (!value) return '—'
  return `******${value.slice(-6)}`
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{children}</dd>
    </div>
  )
}

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminPage()
  const { id } = await params

  const [order, general] = await Promise.all([
    prisma.order.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, emailOriginal: true, emailNormalized: true } },
        lines: { orderBy: { id: 'asc' } },
        payments: { orderBy: { createdAt: 'desc' } },
        refunds: { orderBy: { createdAt: 'desc' } },
        tickets: { orderBy: { createdAt: 'asc' } },
        emails: { orderBy: { createdAt: 'desc' } },
      },
    }),
    getGeneral(),
  ])

  if (!order) notFound()

  const customer =
    order.customer ??
    (await prisma.customer.findUnique({
      where: { emailNormalized: order.customerEmail },
      select: { id: true, emailOriginal: true, emailNormalized: true },
    }))

  const auditTrail = await prisma.auditLog.findMany({
    where: { entityType: 'Order', entityId: order.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  const refundable = Math.max(0, order.totalMinor - order.refundedMinor)
  const canCancel = CANCELLABLE.includes(order.status)
  const canRefund = admin.role === 'SUPER_ADMIN' && REFUNDABLE.includes(order.status) && refundable > 0 && Boolean(order.paypalCaptureId)
  const canRetryDelivery = order.deliveryStatus === 'FAILED' && RETRYABLE.includes(order.status)

  return (
    <div className="grid gap-6">
      <PageHeader
        title={order.reference}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <OrderStatusBadge status={order.status} />
            <DeliveryStatusBadge status={order.deliveryStatus} />
            <Badge variant="outline">{order.kind === 'MUSEUM' ? 'Museum booking' : 'Ticket order'}</Badge>
            {order.paymentEnvironment ? <EnvironmentBadge environment={order.paymentEnvironment} /> : null}
            <span>Created {formatDateTime(order.createdAt, general.timezone)}</span>
          </span>
        }
        actions={
          <Link href="/admin/orders" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <ArrowLeft />
            Back to orders
          </Link>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="grid content-start gap-6 lg:col-span-2">
          <SectionCard title="Customer">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-0.5">
                <span className="text-xs text-muted-foreground">Name</span>
                <span className="text-sm font-medium">{order.customerName}</span>
              </div>
              <div className="grid gap-0.5">
                <span className="text-xs text-muted-foreground">Email</span>
                <a href={`mailto:${order.customerEmail}`} className="text-sm underline-offset-4 hover:underline">
                  {order.customerEmail}
                </a>
              </div>
              <div className="grid gap-0.5">
                <span className="text-xs text-muted-foreground">Phone</span>
                <span className="text-sm">{order.customerPhone ?? '—'}</span>
              </div>
              <div className="grid gap-0.5">
                <span className="text-xs text-muted-foreground">Profile</span>
                <Link
                  href={customer ? `/admin/customers/${customer.id}` : `/admin/customers?q=${encodeURIComponent(order.customerEmail)}`}
                  className="text-sm underline-offset-4 hover:underline"
                >
                  {customer ? 'View customer' : 'Find customer'}
                </Link>
              </div>
              {customer && customer.emailOriginal !== customer.emailNormalized ? (
                <div className="grid gap-0.5 sm:col-span-2">
                  <span className="text-xs text-muted-foreground">Email as provided</span>
                  <span className="text-sm">{customer.emailOriginal}</span>
                </div>
              ) : null}
            </div>
          </SectionCard>

          <SectionCard title={order.kind === 'MUSEUM' ? 'Ticket breakdown' : 'Line items'}>
            {order.kind === 'MUSEUM' ? (
              <>
                <dl className="divide-y">
                  <Row label="Visit date">
                    {order.visitDate ? formatVisitDate(order.visitDate, 'en') : '—'}
                  </Row>
                  <Row label="Adults">{order.adultQty}</Row>
                  <Row label="Children">{order.childQty}</Row>
                  <Row label="Total tickets">{order.adultQty + order.childQty}</Row>
                  <Row label="Checked in">
                    {order.checkedInAt ? formatDateTime(order.checkedInAt, general.timezone, true) : 'Not yet'}
                  </Row>
                  {order.checkedInBy ? <Row label="Checked in by">{order.checkedInBy}</Row> : null}
                  <Row label="Subtotal">
                    <Money minor={order.subtotalMinor} currency={order.currency} />
                  </Row>
                  <Row label="Total">
                    <Money minor={order.totalMinor} currency={order.currency} />
                  </Row>
                  {order.refundedMinor > 0 ? (
                    <Row label="Refunded">
                      <span className="text-muted-foreground">
                        <Money minor={order.refundedMinor} currency={order.currency} />
                      </span>
                    </Row>
                  ) : null}
                  <Row label="Net paid">
                    <Money minor={order.totalMinor - order.refundedMinor} currency={order.currency} />
                  </Row>
                  <Row label="Refundable balance">
                    <Money minor={refundable} currency={order.currency} />
                  </Row>
                </dl>
              </>
            ) : order.lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">No line items recorded for this order.</p>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Unit price</TableHead>
                      <TableHead className="text-right">Quantity</TableHead>
                      <TableHead className="text-right">Line total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {order.lines.map((line) => (
                      <TableRow key={line.id}>
                        <TableCell>
                          <div className="grid">
                            <span>{line.productName}</span>
                            {order.sessionSummary ? <span className="text-xs text-muted-foreground">{order.sessionSummary}</span> : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Money minor={line.priceMinor} currency={line.currency} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{line.quantity}</TableCell>
                        <TableCell className="text-right">
                          <Money minor={line.lineTotalMinor} currency={line.currency} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <dl className="mt-4 divide-y border-t pt-2">
                  <Row label="Subtotal">
                    <Money minor={order.subtotalMinor} currency={order.currency} />
                  </Row>
                  <Row label={general.taxLabel}>
                    <Money minor={order.taxMinor} currency={order.currency} />
                  </Row>
                  <Row label="Total">
                    <Money minor={order.totalMinor} currency={order.currency} />
                  </Row>
                  {order.refundedMinor > 0 ? (
                    <Row label="Refunded">
                      <span className="text-muted-foreground">
                        <Money minor={order.refundedMinor} currency={order.currency} />
                      </span>
                    </Row>
                  ) : null}
                  <Row label="Net paid">
                    <Money minor={order.totalMinor - order.refundedMinor} currency={order.currency} />
                  </Row>
                  <Row label="Refundable balance">
                    <Money minor={refundable} currency={order.currency} />
                  </Row>
                </dl>
              </>
            )}
          </SectionCard>

          <SectionCard title="Payments" description="Capture identifiers are masked and show only the last six characters.">
            {order.payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payment recorded for this order.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead>Environment</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Capture ID</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.payments.map((payment) => (
                    <TableRow key={payment.id}>
                      <TableCell>{payment.provider}</TableCell>
                      <TableCell>
                        <EnvironmentBadge environment={payment.environment} />
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{humanize(payment.status)}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Money minor={payment.amountMinor} currency={payment.currency} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{maskId(payment.captureId)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDateTime(payment.createdAt, general.timezone)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {order.paypalOrderId ? (
              <p className="mt-3 text-xs text-muted-foreground">
                PayPal order: <span className="font-mono">{maskId(order.paypalOrderId)}</span>
              </p>
            ) : null}
          </SectionCard>

          {order.kind !== 'MUSEUM' ? (
          <SectionCard title="Ticket inventory" description="The ticket files allocated to this order.">
            {order.tickets.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tickets have been allocated to this order yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Tickets</TableHead>
                    <TableHead>Delivered</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.tickets.map((ticket) => (
                    <TableRow key={ticket.id}>
                      <TableCell>
                        <div className="grid">
                          <span className="max-w-64 truncate">{ticket.originalFileName}</span>
                          {ticket.lastError ? <span className="max-w-64 truncate text-xs text-destructive">{ticket.lastError}</span> : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <TicketStatusBadge status={ticket.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{ticket.ticketCount}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDateTime(ticket.deliveredAt, general.timezone)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SectionCard>
          ) : (
            <SectionCard title="QR check-in" description="Museum bookings use one QR code for the whole party.">
              <dl className="divide-y">
                <Row label="Visit date">{order.visitDate ? formatVisitDate(order.visitDate, 'en') : '—'}</Row>
                <Row label="Party size">{order.adultQty + order.childQty} ticket(s)</Row>
                <Row label="Status">{order.checkedInAt ? 'Checked in' : 'Not checked in'}</Row>
                <Row label="Checked in at">
                  {order.checkedInAt ? formatDateTime(order.checkedInAt, general.timezone, true) : '—'}
                </Row>
                <Row label="Checked in by">{order.checkedInBy ?? '—'}</Row>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                Use <Link href="/admin/check-in" className="underline underline-offset-4">gate check-in</Link> to scan
                the visitor&apos;s QR code.
              </p>
            </SectionCard>
          )}

          <SectionCard title="Email deliveries" description="Delivery attempts for this order, including the last error.">
            {order.emails.length === 0 ? (
              <p className="text-sm text-muted-foreground">No delivery emails recorded for this order.</p>
            ) : (
              <div className="grid gap-3">
                {order.emails.map((email) => (
                  <div key={email.id} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="grid gap-0.5">
                        <span className="text-sm font-medium">{email.templateKey}</span>
                        <span className="text-xs text-muted-foreground">{email.to}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={EMAIL_TONES[email.status]}>{humanize(email.status)}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {email.attempts} attempt{email.attempts === 1 ? '' : 's'}
                        </span>
                      </div>
                    </div>
                    <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                      <span>Created {formatDateTime(email.createdAt, general.timezone)}</span>
                      <span>Sent {formatDateTime(email.sentAt, general.timezone)}</span>
                    </div>
                    {email.lastError ? <p className="mt-2 text-xs text-destructive">{email.lastError}</p> : null}
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Refunds">
            {order.refunds.length === 0 ? (
              <p className="text-sm text-muted-foreground">No refunds have been issued for this order.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Refund</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Capture ID</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.refunds.map((refund) => (
                    <TableRow key={refund.id}>
                      <TableCell className="font-mono text-xs">{maskId(refund.paypalRefundId)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{humanize(refund.status)}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Money minor={refund.amountMinor} currency={refund.currency} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{maskId(refund.captureId)}</TableCell>
                      <TableCell className="max-w-56 truncate">{refund.reason ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDateTime(refund.createdAt, general.timezone)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SectionCard>

          <SectionCard title="Audit trail" description="Every recorded admin and system event for this order.">
            {auditTrail.length === 0 ? (
              <p className="text-sm text-muted-foreground">No audit entries recorded for this order.</p>
            ) : (
              <div className="grid gap-3">
                {auditTrail.map((entry) => (
                  <div key={entry.id} className="grid gap-1 border-b pb-3 last:border-b-0 last:pb-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">{entry.action}</span>
                      <span className="text-xs text-muted-foreground">{formatDateTime(entry.createdAt, general.timezone, true)}</span>
                    </div>
                    <p className="text-sm">{entry.summary}</p>
                    <p className="text-xs text-muted-foreground">
                      {humanize(entry.actorType)}
                      {entry.actorLabel ? ` · ${entry.actorLabel}` : ''}
                      {entry.ip ? ` · ${entry.ip}` : ''}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        <div className="grid content-start gap-6">
          <OrderActions
            orderId={order.id}
            reference={order.reference}
            currency={order.currency}
            totalMinor={order.totalMinor}
            refundedMinor={order.refundedMinor}
            canCancel={canCancel}
            canRefund={canRefund}
            canRetryDelivery={canRetryDelivery}
          />

          <SectionCard title="Timeline">
            <dl className="divide-y">
              <Row label="Created">{formatDateTime(order.createdAt, general.timezone)}</Row>
              <Row label="Paid">{formatDateTime(order.paidAt, general.timezone)}</Row>
              <Row label="Completed">{formatDateTime(order.completedAt, general.timezone)}</Row>
              <Row label="Cancelled">{formatDateTime(order.cancelledAt, general.timezone)}</Row>
              <Row label="Updated">{formatDateTime(order.updatedAt, general.timezone)}</Row>
            </dl>
          </SectionCard>

          <SectionCard title="Order details">
            <dl className="divide-y">
              <Row label="Reference">{order.reference}</Row>
              <Row label="Type">{order.kind === 'MUSEUM' ? 'Museum booking' : 'Ticket order'}</Row>
              <Row label="Visit date">{order.visitDate ? formatVisitDate(order.visitDate, 'en') : '—'}</Row>
              <Row label="Tickets">
                {order.kind === 'MUSEUM' ? `${order.adultQty} adult · ${order.childQty} child` : order.sessionSummary || '—'}
              </Row>
              <Row label="Currency">{order.currency}</Row>
              <Row label="PayPal order">{maskId(order.paypalOrderId)}</Row>
              <Row label="Capture">{maskId(order.paypalCaptureId)}</Row>
            </dl>
          </SectionCard>

          <OrderNotes orderId={order.id} initialNotes={order.internalNotes} />
        </div>
      </div>
    </div>
  )
}
