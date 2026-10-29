import { prisma } from '@/lib/db/prisma'
import { releaseReservation } from './claim'
import { recordAudit } from '@/lib/auth/guards'

export type ExpiryReport = { reservationsExpired: number; ticketsReleased: number; ordersCancelled: number }

/**
 * Called by the protected cron endpoint. Any order that is still waiting for
 * payment loses its hold; an order already PAID is never touched here, because a
 * late payment must be reconciled, not silently cancelled.
 */
export async function expireStaleReservations(now = new Date()): Promise<ExpiryReport> {
  const stale = await prisma.reservation.findMany({
    where: { status: 'ACTIVE', expiresAt: { lt: now } },
    select: { id: true, orderId: true },
    take: 500,
  })

  let ticketsReleased = 0
  const orderIds: string[] = []

  for (const reservation of stale) {
    ticketsReleased += await releaseReservation(reservation.id)
    await prisma.reservation.update({ where: { id: reservation.id }, data: { status: 'EXPIRED' } })
    if (reservation.orderId) orderIds.push(reservation.orderId)
  }

  // Only un-paid orders are cancelled. PAID/COMPLETED orders keep their state.
  const cancelled = await prisma.order.updateMany({
    where: {
      id: { in: orderIds },
      status: { in: ['PENDING', 'AWAITING_PAYMENT'] },
      reservationId: { in: stale.map((r) => r.id) },
    },
    data: { status: 'CANCELLED', cancelledAt: now, reservationId: null },
  })

  if (stale.length > 0) {
    await recordAudit({
      actorType: 'CRON',
      action: 'RESERVATION_EXPIRED',
      entityType: 'Reservation',
      summary: `Expired ${stale.length} reservation(s), released ${ticketsReleased} ticket(s), cancelled ${cancelled.count} order(s)`,
      metadata: { reservations: stale.map((r) => r.id) },
    })
  }

  return { reservationsExpired: stale.length, ticketsReleased, ordersCancelled: cancelled.count }
}
