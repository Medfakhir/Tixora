import { z } from 'zod'
import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { recordAudit } from '@/lib/auth/guards'
import { addDaysKey, dateKeyFromDate, parseDateKey } from '@/lib/museum/dates'

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

const addSchema = z.object({
  from: dateKey,
  to: dateKey.optional(),
  reason: z.string().trim().max(300).optional(),
})

const removeSchema = z.object({ id: z.string().min(1) })

export const GET = withApi(async (request: Request) => {
  await adminRequest(request)
  const rows = await prisma.closedDate.findMany({ orderBy: { date: 'asc' }, take: 1000 })
  return ok(
    rows.map((row) => ({
      id: row.id,
      date: dateKeyFromDate(row.date),
      reason: row.reason,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    })),
  )
})

/** Adds one date or an inclusive range. Re-adding a date updates its reason. */
export const POST = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'sensitive')
  const payload = addSchema.parse(await readJson(request))
  const from = payload.from
  const to = payload.to ?? payload.from
  if (to < from) throw new ApiError('The end date must be on or after the start date.', 422, 'INVALID_RANGE')
  if (addDaysKey(from, 366) < to) {
    throw new ApiError('Add closures in ranges of 366 days or fewer.', 422, 'RANGE_TOO_LARGE')
  }

  const reason = payload.reason?.trim() ?? ''
  const keys: string[] = []
  for (let key = from; key <= to; key = addDaysKey(key, 1)) keys.push(key)

  await prisma.$transaction(
    keys.map((key) =>
      prisma.closedDate.upsert({
        where: { date: parseDateKey(key)! },
        create: { date: parseDateKey(key)!, reason, createdBy: admin.email },
        update: { reason, createdBy: admin.email },
      }),
    ),
  )

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'MUSEUM_CLOSED_DATES_ADD',
    entityType: 'ClosedDate',
    summary: `Closed ${keys.length} date(s): ${from}${to !== from ? ` → ${to}` : ''}${reason ? ` (${reason})` : ''}`,
    metadata: { from, to, count: keys.length },
    ip,
  })

  return ok({ added: keys.length, from, to })
})

export const DELETE = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'sensitive')
  const payload = removeSchema.parse(await readJson(request))
  const row = await prisma.closedDate.findUnique({ where: { id: payload.id } })
  if (!row) throw new ApiError('That closure no longer exists.', 404, 'NOT_FOUND')

  await prisma.closedDate.delete({ where: { id: row.id } })
  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'MUSEUM_CLOSED_DATES_REMOVE',
    entityType: 'ClosedDate',
    entityId: row.id,
    summary: `Reopened ${dateKeyFromDate(row.date)}${row.reason ? ` (${row.reason})` : ''}`,
    ip,
  })

  return ok({ removed: true })
})
