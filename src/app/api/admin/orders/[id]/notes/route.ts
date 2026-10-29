import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { orderNoteSchema } from '@/lib/validation'
import { prisma } from '@/lib/db/prisma'
import { recordAudit } from '@/lib/auth/guards'

export const POST = withApi(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const { admin, ip } = await adminRequest(request, 'sensitive')
  const { notes } = orderNoteSchema.parse(await readJson(request))

  const order = await prisma.order.findUnique({ where: { id }, select: { id: true, reference: true, internalNotes: true } })
  if (!order) throw new ApiError('Order not found.', 404, 'NOT_FOUND')

  const updated = await prisma.order.update({ where: { id }, data: { internalNotes: notes } })
  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'ORDER_NOTE',
    entityType: 'Order',
    entityId: id,
    summary: `Internal notes updated on ${order.reference}`,
    metadata: { changed: order.internalNotes !== notes },
    ip,
  })

  return ok({ internalNotes: updated.internalNotes })
})
