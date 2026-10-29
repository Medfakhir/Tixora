import crypto from 'node:crypto'
import { z } from 'zod'
import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { hashPassword } from '@/lib/security/ids'
import { revokeAllSessionsFor } from '@/lib/auth/session'
import { recordAudit } from '@/lib/auth/guards'
import type { AdminRole } from '@prisma/client'

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

const updateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('toggle'), isActive: z.boolean() }),
  z.object({ action: z.literal('role'), role: z.enum(['ADMIN', 'SUPER_ADMIN']) }),
  z.object({
    action: z.literal('reset-password'),
    password: z.string().min(12, 'Use at least 12 characters').max(200).optional(),
  }),
])

function generateTemporaryPassword(): string {
  return crypto.randomBytes(12).toString('base64url')
}

async function assertSuperAdminRemains(
  target: { id: string; role: AdminRole; isActive: boolean },
  next: { role?: AdminRole; isActive?: boolean },
): Promise<void> {
  if (target.role !== 'SUPER_ADMIN' || !target.isActive) return

  const remainsActiveSuperAdmin =
    (next.role ?? target.role) === 'SUPER_ADMIN' && (next.isActive ?? target.isActive)
  if (remainsActiveSuperAdmin) return

  const otherActiveSuperAdmins = await prisma.adminUser.count({
    where: { role: 'SUPER_ADMIN', isActive: true, id: { not: target.id } },
  })
  if (otherActiveSuperAdmins === 0) {
    throw new ApiError('At least one active super admin must remain.', 409, 'LAST_SUPER_ADMIN')
  }
}

export const PATCH = withApi(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const { admin, ip } = await adminRequest(request, 'sensitive', 'SUPER_ADMIN')
  const payload = updateSchema.parse(await readJson(request))

  const target = await prisma.adminUser.findUnique({ where: { id }, select: ADMIN_SELECT })
  if (!target) throw new ApiError('Administrator not found.', 404, 'NOT_FOUND')

  if (payload.action === 'toggle') {
    if (target.id === admin.id && !payload.isActive) {
      throw new ApiError('You cannot deactivate your own account.', 409, 'SELF_DEACTIVATE')
    }
    await assertSuperAdminRemains(target, { isActive: payload.isActive })

    const updated = await prisma.adminUser.update({
      where: { id },
      data: { isActive: payload.isActive },
      select: ADMIN_SELECT,
    })

    await recordAudit({
      actorType: 'ADMIN',
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'ADMIN_UPDATE',
      entityType: 'AdminUser',
      entityId: updated.id,
      summary: `${payload.isActive ? 'Activated' : 'Deactivated'} administrator ${updated.email}`,
      metadata: { isActive: updated.isActive },
      ip,
    })

    return ok({ admin: updated })
  }

  if (payload.action === 'role') {
    await assertSuperAdminRemains(target, { role: payload.role })

    const updated = await prisma.adminUser.update({
      where: { id },
      data: { role: payload.role },
      select: ADMIN_SELECT,
    })

    await recordAudit({
      actorType: 'ADMIN',
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'ADMIN_UPDATE',
      entityType: 'AdminUser',
      entityId: updated.id,
      summary: `Changed ${updated.email} role from ${target.role} to ${updated.role}`,
      metadata: { fromRole: target.role, toRole: updated.role },
      ip,
    })

    return ok({ admin: updated })
  }

  const temporaryPassword = payload.password ?? generateTemporaryPassword()
  const updated = await prisma.adminUser.update({
    where: { id },
    data: {
      passwordHash: await hashPassword(temporaryPassword),
      passwordChanged: new Date(),
      failedLogins: 0,
      lockedUntil: null,
    },
    select: ADMIN_SELECT,
  })
  await revokeAllSessionsFor(id)

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'ADMIN_PASSWORD_RESET',
    entityType: 'AdminUser',
    entityId: updated.id,
    summary: `Reset the password for ${updated.email}; sessions were revoked`,
    metadata: { sessionsRevoked: true },
    ip,
  })

  return ok({ admin: updated, temporaryPassword })
})
