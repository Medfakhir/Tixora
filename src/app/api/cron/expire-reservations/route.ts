import { NextResponse } from 'next/server'
import { expireStaleReservations } from '@/lib/inventory/maintenance'
import { processDeliveryQueue } from '@/lib/email/delivery'
import { purgeExpiredBuckets } from '@/lib/security/rate-limit'
import { hashToken, timingSafeEqual } from '@/lib/security/crypto'
import { env } from '@/lib/config/env'

export const dynamic = 'force-dynamic'
// Drains the email queue; give the SMTP sends room on serverless hosts.
export const maxDuration = 60

/**
 * Scheduled maintenance: release expired holds, drain the email queue, drop stale rate
 * limit buckets. Protected by CRON_SECRET, which never appears in a response or a log.
 * The token is accepted only in a header: a query string would land in proxy and
 * access logs along with the secret.
 */
export async function POST(request: Request) {
  return run(request)
}

/** Vercel Cron issues GET requests and injects `Authorization: Bearer $CRON_SECRET`. */
export async function GET(request: Request) {
  return run(request)
}

async function run(request: Request) {
  const header = request.headers.get('authorization') ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  const token = bearer || request.headers.get('x-cron-secret') || ''

  if (!token || !timingSafeEqual(hashToken(token), hashToken(env.CRON_SECRET))) {
    return NextResponse.json({ ok: false, error: 'Invalid cron token' }, { status: 401 })
  }

  const expiry = await expireStaleReservations()
  const queue = await processDeliveryQueue(25)
  const purged = await purgeExpiredBuckets()

  return NextResponse.json({ ok: true, data: { expiry, queue, purged } })
}
