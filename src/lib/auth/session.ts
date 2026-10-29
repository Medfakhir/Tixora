import { cookies } from 'next/headers'
import { prisma } from '@/lib/db/prisma'
import { hashToken } from '@/lib/security/crypto'
import { generateSessionToken } from '@/lib/security/ids'
import { isProduction } from '@/lib/config/env'
import type { AdminRole } from '@prisma/client'

export const SESSION_COOKIE = 'tixora_admin_session'
const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const IDLE_RENEW_MS = 60 * 60 * 1000

export type AdminSessionUser = {
  id: string
  email: string
  name: string
  role: AdminRole
}

export type SessionContext = {
  token: string
  session: { id: string; expiresAt: Date }
  user: AdminSessionUser
}

function cookieOptions(maxAgeSeconds: number) {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isProduction,
    path: '/',
    maxAge: maxAgeSeconds,
  }
}

/**
 * Only a SHA-256 digest of the session token is stored, so a database read alone
 * cannot be replayed as a valid admin cookie.
 */
export async function createSession(
  adminUserId: string,
  request?: { ip?: string | null; userAgent?: string | null },
): Promise<void> {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await prisma.adminSession.create({
    data: {
      tokenHash: hashToken(token),
      adminUserId,
      expiresAt,
      ip: request?.ip ?? null,
      userAgent: request?.userAgent?.slice(0, 300) ?? null,
    },
  })
  const store = await cookies()
  store.set({ ...cookieOptions(Math.floor(SESSION_TTL_MS / 1000)), value: token })
}

export async function destroySession(): Promise<void> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (token) {
    await prisma.adminSession.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }
  store.delete(SESSION_COOKIE)
}

export async function getSessionContext(): Promise<SessionContext | null> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (!token) return null

  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { admin: { select: { id: true, email: true, name: true, role: true, isActive: true } } },
  })

  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null
  if (!session.admin.isActive) return null

  // Sliding expiry, written at most once an hour to keep reads cheap.
  if (session.expiresAt.getTime() - Date.now() < IDLE_RENEW_MS) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    await prisma.adminSession.update({ where: { id: session.id }, data: { expiresAt } })
    store.set({ ...cookieOptions(Math.floor(SESSION_TTL_MS / 1000)), value: token })
  }

  return {
    token,
    session: { id: session.id, expiresAt: session.expiresAt },
    user: session.admin,
  }
}

/** Used by tests and by the login flow to revoke every other device. */
export async function revokeAllSessionsFor(adminUserId: string): Promise<void> {
  await prisma.adminSession.updateMany({
    where: { adminUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}
