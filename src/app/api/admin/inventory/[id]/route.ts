import { withApi, ok, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { getStorage } from '@/lib/storage'
import { recordAudit } from '@/lib/auth/guards'

/**
 * Only an unclaimed file can be retired. A ticket that is RESERVED, SOLD, DELIVERED or
 * FAILED_DELIVERY belongs to an order and must stay retrievable, so it is refused here.
 */
export const DELETE = withApi(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const { admin, ip } = await adminRequest(request, 'sensitive')

  const ticket = await prisma.ticketInventory.findUnique({
    where: { id },
    select: { id: true, status: true, storageKey: true, originalFileName: true, productId: true, orderId: true },
  })
  if (!ticket) throw new ApiError('Ticket file not found.', 404, 'NOT_FOUND')
  if (ticket.status !== 'AVAILABLE') {
    throw new ApiError(`A ${ticket.status.toLowerCase()} ticket cannot be removed.`, 409, 'NOT_RETIRED')
  }

  const retired = await prisma.ticketInventory.update({ where: { id }, data: { status: 'RETIRED' } })
  // The row is kept for the audit trail; only the bytes go, so a retired key cannot leak.
  await getStorage()
    .delete(ticket.storageKey)
    .catch((error: Error) => console.error('retired file delete failed', { key: ticket.storageKey, error: error.message }))

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'INVENTORY_RETIRE',
    entityType: 'TicketInventory',
    entityId: id,
    summary: `Retired unused ticket file ${ticket.originalFileName}`,
    ip,
  })

  return ok({ id: retired.id, status: retired.status })
})
