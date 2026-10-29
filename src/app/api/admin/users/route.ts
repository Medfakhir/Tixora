import crypto from 'node:crypto'
import { z } from 'zod'
import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { hashPassword } from '@/lib/security/ids'
import { recordAudit } from '@/lib/auth/guards'
import type { Prisma } from '@prisma/client'

const ADMIN_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  passwordChanged: true,
  createdAt: true,
  updatedAt: true,
} as const

type AdminRow = Prisma.AdminUserGetPayload<{ select: typeof ADMIN_SELECT }>

const createAdminSchema = z.object({
  email: z.email('Enter a valid email address').max(191),
  name: z.string().trim().min(2, 'Name is required').max(120),
  role: z.enum(['ADMIN', 'SUPER_ADMIN']),
  password: z.string().min(12, 'Use at least 12 characters').max(200).optional(),
})

function generateTemporaryPassword(): string {
  return crypto.randomBytes(12).toString('base64url')
}

export const GET = withApi(async (request: Request) => {
  await adminRequest(request, 'sensitive', 'SUPER_ADMIN')

  const admins = await prisma.adminUser.findMany({
    orderBy: { createdAt: 'asc' },
    select: ADMIN_SELECT,
  })

  return ok({ admins })
})

export const POST = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'sensitive', 'SUPER_ADMIN')
  const payload = createAdminSchema.parse(await readJson(request))
  const email = payload.email.trim().toLowerCase()

  const existing = await prisma.adminUser.findUnique({ where: { email }, select: { id: true } })
  if (existing) throw new ApiError('An administrator with that email already exists.', 409, 'EMAIL_TAKEN')

  const temporaryPassword = payload.password ?? generateTemporaryPassword()

  let created: AdminRow
  try {
    created = await prisma.adminUser.create({
      data: {
        email,
        name: payload.name,
        role: payload.role,
        passwordHash: await hashPassword(temporaryPassword),
      },
      select: ADMIN_SELECT,
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new ApiError('An administrator with that email already exists.', 409, 'EMAIL_TAKEN')
    }
    throw error
  }

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'ADMIN_CREATE',
    entityType: 'AdminUser',
    entityId: created.id,
    summary: `Created ${created.role} account ${created.email}`,
    metadata: { role: created.role },
    ip,
  })

  return ok({ admin: created, temporaryPassword }, 201)
})
