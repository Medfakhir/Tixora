import { redirect } from 'next/navigation'
import { getSessionContext, type AdminSessionUser } from './session'
import { prisma } from '@/lib/db/prisma'
import type { AdminRole, AuditActorType } from '@prisma/client'

export class UnauthorizedError extends Error {
  status = 401
  constructor(message = 'Authentication required') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends Error {
  status = 403
  constructor(message = 'Not permitted') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

const ROLE_RANK: Record<AdminRole, number> = { ADMIN: 1, SUPER_ADMIN: 2 }

/** Throws for API/route handlers; admin pages use requireAdminPage instead. */
export async function requireAdmin(): Promise<AdminSessionUser> {
  const context = await getSessionContext()
  if (!context) throw new UnauthorizedError()
  return context.user
}

export async function requireRole(role: AdminRole): Promise<AdminSessionUser> {
  const user = await requireAdmin()
  if (ROLE_RANK[user.role] < ROLE_RANK[role]) throw new ForbiddenError(`Requires ${role}`)
  return user
}

/** Server components redirect to the login screen instead of throwing JSON. */
export async function requireAdminPage(role?: AdminRole): Promise<AdminSessionUser> {
  const context = await getSessionContext()
  if (!context) redirect('/admin/login')
  if (role && ROLE_RANK[context.user.role] < ROLE_RANK[role]) redirect('/admin')
  return context.user
}

export async function getCurrentAdmin(): Promise<AdminSessionUser | null> {
  const context = await getSessionContext()
  return context?.user ?? null
}

export type AuditInput = {
  actorType: AuditActorType
  actorId?: string | null
  actorLabel?: string | null
  action: string
  entityType: string
  entityId?: string | null
  summary: string
  metadata?: Record<string, unknown> | null
  ip?: string | null
  userAgent?: string | null
}

/**
 * Audit writes must never break the business operation they describe, so a
 * failure is swallowed after logging the reason rather than thrown.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        actorLabel: input.actorLabel ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        summary: input.summary,
        metadata: (input.metadata ?? undefined) as object | undefined,
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      },
    })
  } catch (error) {
    console.error('audit write failed', { action: input.action, error: (error as Error).message })
  }
}

export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return headers.get('x-real-ip')
}
