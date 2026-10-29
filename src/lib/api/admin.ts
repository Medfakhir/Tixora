import { requireAdmin, requireRole, clientIp } from '@/lib/auth/guards'
import { checkRateLimit, RATE_LIMIT_RULES } from '@/lib/security/rate-limit'
import { ApiError } from '@/lib/api/http'
import type { AdminRole } from '@prisma/client'

export type RuleName = keyof typeof RATE_LIMIT_RULES

/**
 * Every admin route calls this first: session check, then a per-actor limit, so a
 * stolen-but-valid cookie still cannot be used to hammer sensitive endpoints.
 */
export async function adminRequest(request: Request, rule: RuleName = 'sensitive', role?: AdminRole) {
  const admin = role ? await requireRole(role) : await requireAdmin()
  const key = `admin:${rule}:${admin.id}`
  const allowed = await checkRateLimit(key, RATE_LIMIT_RULES[rule])
  if (!allowed.allowed) {
    throw new ApiError(`Too many requests. Try again in ${Math.ceil(allowed.retryAfterSeconds / 60)} minute(s).`, 429, 'RATE_LIMITED')
  }
  return { admin, ip: clientIp(request.headers) }
}

/** Rate limiting keyed by client for unauthenticated endpoints (login, checkout). */
export async function anonymousRequest(request: Request, rule: RuleName) {
  const ip = clientIp(request.headers) ?? 'unknown'
  const allowed = await checkRateLimit(`${rule}:${ip}`, RATE_LIMIT_RULES[rule])
  if (!allowed.allowed) {
    throw new ApiError(`Too many attempts. Try again in ${Math.ceil(allowed.retryAfterSeconds / 60)} minute(s).`, 429, 'RATE_LIMITED')
  }
  return { ip, userAgent: request.headers.get('user-agent') }
}
