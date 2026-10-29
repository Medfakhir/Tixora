import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { eventSessionSchema } from '@/lib/validation'
import { prisma } from '@/lib/db/prisma'
import { recordAudit } from '@/lib/auth/guards'

export const POST = withApi(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id: productId } = await params
  const { admin, ip } = await adminRequest(request, 'sensitive')
  const payload = eventSessionSchema.parse(await readJson(request))

  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, name: true } })
  if (!product) throw new ApiError('Product not found.', 404, 'NOT_FOUND')

  const date = new Date(`${payload.date}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) throw new ApiError('Invalid date.', 422, 'VALIDATION', { date: 'Invalid' })

  try {
    const session = await prisma.eventSession.create({
      data: {
        productId,
        date,
        startTime: payload.startTime,
        endTime: payload.endTime || null,
        label: payload.label || null,
      },
    })
    await recordAudit({
      actorType: 'ADMIN',
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'SESSION_CREATE',
      entityType: 'EventSession',
      entityId: session.id,
      summary: `Added session ${payload.date} ${payload.startTime} to ${product.name}`,
      ip,
    })
    return ok(session, 201)
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new ApiError('That date and time already exists for this product.', 409, 'SESSION_EXISTS')
    }
    throw error
  }
})
