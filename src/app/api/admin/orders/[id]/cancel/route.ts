import { withApi, ok, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { releaseReservation } from '@/lib/inventory/claim'
import { syncCustomerTotals } from '@/lib/orders/service'
import { recordAudit } from '@/lib/auth/guards'

const CANCELLABLE = ['PENDING', 'AWAITING_PAYMENT']

/**
 * Cancelling only ever applies to an unpaid order, and returns its held tickets to the
 * pool in the same operation. A paid order is refunded instead — never cancelled.
 */
export const POST = withApi(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const { admin, ip } = await adminRequest(request, 'sensitive')

  const order = await prisma.order.findUnique({ where: { id }, select: { id: true, reference: true, status: true, reservationId: true, customerEmail: true } })
  if (!order) throw new ApiError('Order not found.', 404, 'NOT_FOUND')
  if (!CANCELLABLE.includes(order.status)) {
    throw new ApiError(`An order with status ${order.status} cannot be cancelled. Use refund instead.`, 409, 'NOT_CANCELLABLE')
  }

  const released = order.reservationId ? await releaseReservation(order.reservationId) : 0
  if (order.reservationId) {
    await prisma.reservation.updateMany({ where: { id: order.reservationId }, data: { status: 'RELEASED', releasedAt: new Date() } })
  }
  const updated = await prisma.order.update({
    where: { id },
    data: { status: 'CANCELLED', cancelledAt: new Date(), reservationId: null, reservationExpiresAt: null },
  })
  await syncCustomerTotals(order.customerEmail)

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'ORDER_CANCEL',
    entityType: 'Order',
    entityId: id,
    summary: `Cancelled unpaid order ${order.reference} and released ${released} ticket(s)`,
    ip,
  })

  return ok({ status: updated.status, ticketsReleased: released })
})
