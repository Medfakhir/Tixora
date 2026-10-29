import { z } from 'zod'
import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { hashPassword, verifyPassword } from '@/lib/security/ids'
import { createSession, revokeAllSessionsFor } from '@/lib/auth/session'
import { recordAudit } from '@/lib/auth/guards'

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(200),
  newPassword: z.string().min(12, 'Use at least 12 characters').max(200),
})

/**
 * A password change signs out every other device. The current session is replaced
 * with a fresh token rather than left in place, so a leaked cookie stops working.
 */
export const POST = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'passwordChange')
  const payload = changePasswordSchema.parse(await readJson(request))
  const userAgent = request.headers.get('user-agent')

  const user = await prisma.adminUser.findUnique({
    where: { id: admin.id },
    select: { id: true, email: true, passwordHash: true },
  })
  if (!user) throw new ApiError('Account not found.', 404, 'NOT_FOUND')

  if (!(await verifyPassword(payload.currentPassword, user.passwordHash))) {
    throw new ApiError('The current password is incorrect.', 400, 'INVALID_PASSWORD')
  }

  if (await verifyPassword(payload.newPassword, user.passwordHash)) {
    throw new ApiError('Choose a password you have not used before.', 400, 'PASSWORD_REUSED')
  }

  await prisma.adminUser.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(payload.newPassword),
      passwordChanged: new Date(),
      failedLogins: 0,
      lockedUntil: null,
    },
  })

  await revokeAllSessionsFor(user.id)
  await createSession(user.id, { ip, userAgent })

  await recordAudit({
    actorType: 'ADMIN',
    actorId: user.id,
    actorLabel: user.email,
    action: 'ADMIN_PASSWORD_CHANGE',
    entityType: 'AdminUser',
    entityId: user.id,
    summary: `${user.email} changed their password; other sessions were revoked`,
    metadata: { sessionsRevoked: true },
    ip,
    userAgent,
  })

  return ok({ changed: true })
})
