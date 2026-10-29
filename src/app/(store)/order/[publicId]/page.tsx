import Link from 'next/link'
import { Download } from 'lucide-react'
import type { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getGeneral } from '@/lib/settings/service'
import { formatDateTime } from '@/lib/format'
import { formatVisitDate } from '@/lib/museum/dates'
import { qrDataUrl } from '@/lib/museum/qr'
import { Money } from '@/components/shared/money'
import { FieldRow } from '@/components/shared/field'
import { DeliveryStatusBadge, OrderStatusBadge } from '@/components/shared/status-badges'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'

export const metadata = { title: 'Order status' }
export const dynamic = 'force-dynamic'

const DOWNLOADABLE_STATES: OrderStatus[] = [
  'PAID',
  'PROCESSING',
  'COMPLETED',
  'DELIVERY_FAILED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
]

function statusMessage(status: OrderStatus): string {
  switch (status) {
    case 'PENDING':
      return 'No payment has been received for this order yet.'
    case 'AWAITING_PAYMENT':
      return 'Waiting for PayPal to confirm the payment.'
    case 'PAID':
      return 'Payment received. Your tickets are being prepared for delivery.'
    case 'PROCESSING':
      return 'Payment received. Ticket delivery is in progress.'
    case 'COMPLETED':
      return 'Payment received and tickets delivered.'
    case 'PAYMENT_FAILED':
      return 'The payment was not completed.'
    case 'CANCELLED':
      return 'This order was cancelled.'
    case 'REFUNDED':
      return 'The payment was refunded.'
    case 'PARTIALLY_REFUNDED':
      return 'Part of the payment was refunded.'
    case 'DELIVERY_FAILED':
      return 'Payment received, but the ticket email could not be delivered.'
  }
}

export default async function OrderStatusPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params

  const [general, order] = await Promise.all([
    getGeneral(),
    prisma.order.findUnique({
      where: { publicId },
      select: {
        reference: true,
        status: true,
        deliveryStatus: true,
        kind: true,
        currency: true,
        visitDate: true,
        adultQty: true,
        childQty: true,
        checkedInAt: true,
        subtotalMinor: true,
        taxMinor: true,
        totalMinor: true,
        refundedMinor: true,
        sessionSummary: true,
        createdAt: true,
        paidAt: true,
        reservationExpiresAt: true,
        lines: {
          select: { productName: true, quantity: true, priceMinor: true, lineTotalMinor: true },
        },
        tickets: {
          select: { id: true, ticketCount: true },
        },
      },
    }),
  ])

  if (!order) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-12">
        <Card className="mx-auto max-w-lg p-6">
          <CardHeader className="px-0 pt-0">
            <CardTitle>Order not found</CardTitle>
            <CardDescription>
              We could not find an order for this link. Check that the address is complete, or look up your order with
              the reference and email address from your receipt.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Button render={<Link href="/order" />}>Find my order</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const museum = order.kind === 'MUSEUM'
  const ticketCount = museum ? order.adultQty + order.childQty : order.lines.reduce((sum, line) => sum + line.quantity, 0)
  const canDownload = DOWNLOADABLE_STATES.includes(order.status) && order.tickets.length > 0
  const awaitingPayment = order.status === 'PENDING' || order.status === 'AWAITING_PAYMENT'
  const qr = museum && DOWNLOADABLE_STATES.includes(order.status) ? await qrDataUrl({ publicId }) : null

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12">
      <div className="grid gap-6">
        <Card className="p-6">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="text-xl">Order {order.reference}</CardTitle>
            <CardDescription>Placed on {formatDateTime(order.createdAt, general.timezone, true)}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 px-0">
            <div className="flex flex-wrap items-center gap-2">
              <OrderStatusBadge status={order.status} />
              <DeliveryStatusBadge status={order.deliveryStatus} />
            </div>
            <p className="text-sm text-muted-foreground">{statusMessage(order.status)}</p>
            {order.paidAt ? (
              <p className="text-sm text-muted-foreground">
                Paid on {formatDateTime(order.paidAt, general.timezone, true)}.
              </p>
            ) : null}
            {awaitingPayment && order.reservationExpiresAt ? (
              <p className="text-sm text-muted-foreground">
                The booking hold expires on {formatDateTime(order.reservationExpiresAt, general.timezone)}.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card className="p-6">
          <CardHeader className="px-0 pt-0">
            <CardTitle>Order details</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {museum ? (
              <>
                <FieldRow label="Visit date" value={formatVisitDate(order.visitDate, 'en')} />
                <FieldRow label="Adults" value={order.adultQty} />
                <FieldRow label="Children" value={order.childQty} />
                {order.checkedInAt ? (
                  <FieldRow label="Checked in" value={formatDateTime(order.checkedInAt, general.timezone, true)} />
                ) : null}
              </>
            ) : (
              order.lines.map((line, index) => (
                <div key={`${line.productName}-${index}`} className="py-1">
                  <FieldRow label="Ticket" value={line.productName} />
                  <FieldRow label="Quantity" value={line.quantity} />
                  <FieldRow label="Price per ticket" value={<Money minor={line.priceMinor} currency={order.currency} />} />
                </div>
              ))
            )}
            {!museum && order.sessionSummary ? <FieldRow label="Date and time" value={order.sessionSummary} /> : null}
            <Separator className="my-2" />
            <FieldRow label="Subtotal" value={<Money minor={order.subtotalMinor} currency={order.currency} />} />
            {order.taxMinor > 0 ? (
              <FieldRow
                label={general.taxLabel || 'Tax'}
                value={<Money minor={order.taxMinor} currency={order.currency} />}
              />
            ) : null}
            <FieldRow
              label="Total"
              value={<Money className="font-semibold" minor={order.totalMinor} currency={order.currency} />}
            />
            {order.refundedMinor > 0 ? (
              <FieldRow
                label="Refunded"
                value={<Money minor={order.refundedMinor} currency={order.currency} />}
              />
            ) : null}
          </CardContent>
        </Card>

        <Card className="p-6">
          <CardHeader className="px-0 pt-0">
            <CardTitle>{museum ? 'Your entrance QR code' : 'Your tickets'}</CardTitle>
            <CardDescription>
              {museum
                ? qr
                  ? `${ticketCount} ticket${ticketCount === 1 ? '' : 's'} for your visit. Show this QR code at the entrance.`
                  : awaitingPayment
                    ? 'Your QR code appears once payment is confirmed.'
                    : 'Your booking is confirmed. Contact support if the QR code does not appear.'
                : canDownload
                  ? `${ticketCount} ticket${ticketCount === 1 ? '' : 's'} in ${order.tickets.length} file${
                      order.tickets.length === 1 ? '' : 's'
                    }.`
                  : awaitingPayment
                    ? 'Download links appear here once payment is confirmed.'
                    : 'Tickets are not available for download yet. If this does not update, contact support.'}
            </CardDescription>
          </CardHeader>
          {qr ? (
            <CardContent className="flex flex-col items-center gap-2 px-0 text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt={`QR code for booking ${order.reference}`} width={240} height={240} className="rounded-lg border bg-white p-2" />
              <p className="font-mono text-xs text-muted-foreground">{order.reference}</p>
              <p className="text-xs text-muted-foreground">Each booking has one QR code. Present it for your whole party.</p>
            </CardContent>
          ) : null}
          {canDownload ? (
            <CardContent className="grid gap-2 px-0">
              {order.tickets.map((ticket, index) => (
                <div
                  key={ticket.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div>
                    <p className="text-sm font-medium">Ticket file {index + 1}</p>
                    <p className="text-xs text-muted-foreground">
                      {ticket.ticketCount} ticket{ticket.ticketCount === 1 ? '' : 's'} in this file
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    render={<a href={`/api/orders/${encodeURIComponent(publicId)}/tickets/${ticket.id}`} />}
                  >
                    <Download />
                    Download
                  </Button>
                </div>
              ))}
            </CardContent>
          ) : null}
        </Card>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" render={<Link href="/order" />}>
            Look up another order
          </Button>
          <Button variant="ghost" render={<Link href="/#book" />}>
            Book another visit
          </Button>
        </div>
      </div>
    </div>
  )
}
