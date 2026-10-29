import { z } from 'zod'
import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { recordAudit } from '@/lib/auth/guards'

const patchSchema = z.object({ isActive: z.boolean().optional(), label: z.string().trim().max(80).optional(), startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional() })

export const PATCH = withApi(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const { admin, ip } = await adminRequest(request, 'sensitive')
  const payload = patchSchema.parse(await readJson(request))

  const session = await prisma.eventSession.findUnique({ where: { id } })
  if (!session) throw new ApiError('Session not found.', 404, 'NOT_FOUND')

  const updated = await prisma.eventSession.update({ where: { id }, data: payload })
  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'SESSION_UPDATE',
    entityType: 'EventSession',
    entityId: id,
    summary: `Session ${session.date.toISOString().slice(0, 10)} ${session.startTime} updated (active=${updated.isActive})`,
    ip,
  })
  return ok(updated)
})

/**
 * A session with tickets or orders attached is deactivated instead of removed, so no
 * allocated file or historical line is ever orphaned.
 */
export const DELETE = withApi(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const { admin, ip } = await adminRequest(request, 'sensitive')

  const session = await prisma.eventSession.findUnique({ where: { id }, include: { _count: { select: { inventory: true } } } })
  if (!session) throw new ApiError('Session not found.', 404, 'NOT_FOUND')

  const lines = await prisma.orderLine.count({ where: { eventSessionId: id } })
  if (session._count.inventory > 0 || lines > 0) {
    const deactivated = await prisma.eventSession.update({ where: { id }, data: { isActive: false } })
    await recordAudit({
      actorType: 'ADMIN',
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'SESSION_DEACTIVATE',
      entityType: 'EventSession',
      entityId: id,
      summary: `Deactivated session (kept ${session._count.inventory} ticket file(s), ${lines} order line(s))`,
      ip,
    })
    return ok({ deactivated: true, session: deactivated })
  }

  await prisma.eventSession.delete({ where: { id } })
  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'SESSION_DELETE',
    entityType: 'EventSession',
    entityId: id,
    summary: 'Deleted unused session',
    ip,
  })
  return ok({ deactivated: false })
})
