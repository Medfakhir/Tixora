import { z } from 'zod'
import { withApi, ok, readJson } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { recordAudit } from '@/lib/auth/guards'

const schema = z.object({
  dayOfWeek: z.coerce.number().int().min(0).max(6),
  isActive: z.boolean(),
  reason: z.string().trim().max(300).optional(),
})

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const GET = withApi(async (request: Request) => {
  await adminRequest(request)
  const rows = await prisma.weeklyClosure.findMany({ orderBy: { dayOfWeek: 'asc' } })
  return ok(rows)
})

/** Weekly closures are upserted per weekday, so the table always has at most 7 rows. */
export const POST = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'sensitive')
  const payload = schema.parse(await readJson(request))

  const row = await prisma.weeklyClosure.upsert({
    where: { dayOfWeek: payload.dayOfWeek },
    create: {
      dayOfWeek: payload.dayOfWeek,
      isActive: payload.isActive,
      reason: payload.reason ?? '',
    },
    update: { isActive: payload.isActive, reason: payload.reason ?? '' },
  })

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'MUSEUM_WEEKLY_CLOSURE_SAVE',
    entityType: 'WeeklyClosure',
    entityId: row.id,
    summary: `${DAY_NAMES[payload.dayOfWeek]} closure ${payload.isActive ? 'enabled' : 'disabled'}`,
    ip,
  })

  return ok(row)
})
