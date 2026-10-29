import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { anonymousRequest } from '@/lib/api/admin'
import { loginSchema } from '@/lib/validation'
import { prisma } from '@/lib/db/prisma'
import { verifyPassword } from '@/lib/security/ids'
import { createSession } from '@/lib/auth/session'
import { clearRateLimit } from '@/lib/security/rate-limit'
import { recordAudit } from '@/lib/auth/guards'

const LOCK_MINUTES = 15
const MAX_FAILURES = 5

/**
 * Login is deliberately a route handler rather than a server action: one obvious place for
 * the IP limit, the per-account lockout and the audit record. No password hash, token or
 * session material is ever returned — the caller receives only the profile it already knows.
 */
export const POST = withApi(async (request: Request) => {
  const { ip, userAgent } = await anonymousRequest(request, 'adminLogin')
  const { email, password } = loginSchema.parse(await readJson(request))
  const normalised = email.trim().toLowerCase()

  const admin = await prisma.adminUser.findUnique({ where: { email: normalised } })
  const usable = admin && admin.isActive && (!admin.lockedUntil || admin.lockedUntil <= new Date())

  // Unknown address, deactivated account and locked account all answer identically.
  if (!admin || !usable) {
    if (admin?.isActive) await registerFailure(admin, ip, userAgent)
    throw new ApiError('Invalid email or password.', 401, 'INVALID_CREDENTIALS')
  }

  if (!(await verifyPassword(password, admin.passwordHash))) {
    await registerFailure(admin, ip, userAgent)
    throw new ApiError('Invalid email or password.', 401, 'INVALID_CREDENTIALS')
  }

  await clearRateLimit(`adminLogin:${ip}`)
  await prisma.adminUser.update({ where: { id: admin.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } })
  await createSession(admin.id, { ip, userAgent })
  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'ADMIN_LOGIN',
    entityType: 'AdminUser',
    entityId: admin.id,
    summary: `${admin.email} signed in`,
    ip,
    userAgent,
  })

  return ok({ id: admin.id, email: admin.email, name: admin.name, role: admin.role })
})

async function registerFailure(admin: { id: string; email: string; failedLogins: number }, ip: string | null, userAgent: string | null) {
  const failedLogins = admin.failedLogins + 1
  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { failedLogins, lockedUntil: failedLogins >= MAX_FAILURES ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null },
  })
  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'ADMIN_LOGIN_FAILED',
    entityType: 'AdminUser',
    entityId: admin.id,
    summary: `Failed sign-in for ${admin.email}`,
    ip,
    userAgent,
  })
}
