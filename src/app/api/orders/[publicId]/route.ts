import { withApi, ok, ApiError } from '@/lib/api/http'
import { prisma } from '@/lib/db/prisma'
import { qrDataUrl } from '@/lib/museum/qr'

/** Statuses in which the customer's own tickets may be fetched again from the status page. */
const DELIVERED_STATES = ['PAID', 'PROCESSING', 'COMPLETED', 'DELIVERY_FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED']

/**
 * Order status is addressable only by the random publicId handed to the customer, so this
 * stays a public route. It returns that customer's own order and nothing else: no payment
 * tokens, no internal ids, no other customers.
 */
export const GET = withApi(async (_request: Request, { params }: { params: Promise<{ publicId: string }> }) => {
  const { publicId } = await params
  const order = await prisma.order.findUnique({
    where: { publicId },
    include: {
      lines: true,
      tickets: { select: { id: true, status: true, ticketCount: true } },
      emails: { select: { id: true, status: true, templateKey: true, sentAt: true, attempts: true } },
    },
  })
  if (!order) throw new ApiError('Order not found.', 404, 'ORDER_NOT_FOUND')

  const ticketsReleased = DELIVERED_STATES.includes(order.status) && order.tickets.length > 0
  const museum = order.kind === 'MUSEUM'
  const qr = museum && DELIVERED_STATES.includes(order.status) ? await qrDataUrl(order) : null

  return ok({
    kind: order.kind,
    visitDate: order.visitDate,
    adultQty: order.adultQty,
    childQty: order.childQty,
    checkedInAt: order.checkedInAt,
    qrDataUrl: qr,
    reference: order.reference,
    status: order.status,
    deliveryStatus: order.deliveryStatus,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    currency: order.currency,
    subtotalMinor: order.subtotalMinor,
    taxMinor: order.taxMinor,
    totalMinor: order.totalMinor,
    refundedMinor: order.refundedMinor,
    sessionSummary: order.sessionSummary,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    reservationExpiresAt: order.reservationExpiresAt,
    lines: order.lines.map((line) => ({
      productName: line.productName,
      quantity: line.quantity,
      priceMinor: line.priceMinor,
      lineTotalMinor: line.lineTotalMinor,
    })),
    ticketCount: museum ? order.adultQty + order.childQty : order.lines.reduce((sum, line) => sum + line.quantity, 0),
    // Files are only ever listed once the order is paid; an unpaid order cannot pull tickets.
    tickets: ticketsReleased
      ? order.tickets.map((ticket) => ({
          id: ticket.id,
          status: ticket.status,
          ticketCount: ticket.ticketCount,
          downloadUrl: `/api/orders/${order.publicId}/tickets/${ticket.id}`,
        }))
      : [],
    emails: order.emails,
  })
})
