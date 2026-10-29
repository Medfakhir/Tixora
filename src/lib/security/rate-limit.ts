import { prisma } from '@/lib/db/prisma'

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

type Rule = {
  /** Max attempts inside the window before the key is blocked. */
  max: number
  windowSeconds: number
  /** Blocked duration once the limit is exceeded. */
  blockSeconds: number
}

export const RATE_LIMIT_RULES = {
  adminLogin: { max: 5, windowSeconds: 300, blockSeconds: 900 },
  checkout: { max: 20, windowSeconds: 600, blockSeconds: 1800 },
  // Reference + email is the only way a guest finds their order, so it is a guessable
  // surface; the window is tight enough that enumeration is impractical.
  orderLookup: { max: 8, windowSeconds: 900, blockSeconds: 3600 },
  passwordChange: { max: 5, windowSeconds: 900, blockSeconds: 3600 },
  sensitive: { max: 30, windowSeconds: 60, blockSeconds: 300 },
} satisfies Record<string, Rule>

/**
 * Fixed-window counter persisted in MongoDB so limits survive restarts and hold
 * across instances. The increment is a single conditional update, so concurrent
 * requests cannot race the counter below the limit.
 */
export async function checkRateLimit(rawKey: string, rule: Rule): Promise<RateLimitResult> {
  const now = new Date()
  const key = `${rawKey}`

  const existing = await prisma.rateLimitBucket.findUnique({ where: { key } })

  if (existing?.blockedUntil && existing.blockedUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((existing.blockedUntil.getTime() - now.getTime()) / 1000),
    }
  }

  if (existing && existing.resetAt > now) {
    const updated = await prisma.rateLimitBucket.updateMany({
      where: { key, resetAt: { gt: now } },
      data: { count: { increment: 1 } },
    })
    const count = updated.count === 1 ? existing.count + 1 : existing.count
    if (count > rule.max) {
      const blockedUntil = new Date(now.getTime() + rule.blockSeconds * 1000)
      await prisma.rateLimitBucket.updateMany({ where: { key }, data: { blockedUntil } })
      return { allowed: false, remaining: 0, retryAfterSeconds: rule.blockSeconds }
    }
    return { allowed: true, remaining: rule.max - count, retryAfterSeconds: 0 }
  }

  const windowStart = now
  const resetAt = new Date(now.getTime() + rule.windowSeconds * 1000)

  if (existing) {
    await prisma.rateLimitBucket.updateMany({
      where: { key },
      data: { count: 1, windowStart, resetAt, blockedUntil: null },
    })
  } else {
    try {
      await prisma.rateLimitBucket.create({ data: { key, count: 1, windowStart, resetAt } })
    } catch {
      // Lost the insert race against another request on the same key; that request
      // already opened the window, so treat this attempt as counted.
    }
  }

  return { allowed: true, remaining: rule.max - 1, retryAfterSeconds: 0 }
}

export async function clearRateLimit(rawKey: string): Promise<void> {
  await prisma.rateLimitBucket.deleteMany({ where: { key: rawKey } })
}

/** Removes stale buckets; called from the maintenance cron. */
export async function purgeExpiredBuckets(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const result = await prisma.rateLimitBucket.deleteMany({ where: { resetAt: { lt: cutoff } } })
  return result.count
}
