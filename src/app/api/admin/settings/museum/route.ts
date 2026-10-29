import { z } from 'zod'
import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { recordAudit } from '@/lib/auth/guards'
import { getMuseumSettings, normaliseTime, saveMuseumSettings, type MuseumSettings } from '@/lib/museum/settings'

const schema = z.object({
  museumName: z.string().trim().min(2).max(120),
  museumTagline: z.string().trim().max(200),
  museumAddress: z.string().trim().max(300),
  supportEmail: z.email('Enter a valid support email').max(200),
  supportPhone: z.string().trim().max(40),
  timezone: z.string().trim().min(1).max(80),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  adultPriceCents: z.coerce.number().int().min(0).max(1_000_000),
  childPriceCents: z.coerce.number().int().min(0).max(1_000_000),
  dailyCapacity: z.coerce.number().int().min(0).max(100_000),
  cutoffTime: z.string().regex(/^\d{1,2}:\d{2}$/, 'Use HH:MM'),
  bookingWindowDays: z.coerce.number().int().min(1).max(730),
  maxAdultsPerOrder: z.coerce.number().int().min(1).max(50),
  maxChildrenPerOrder: z.coerce.number().int().min(0).max(50),
  officialPartner: z.boolean(),
})

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

export const GET = withApi(async (request: Request) => {
  await adminRequest(request)
  return ok(await getMuseumSettings())
})

export const POST = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'sensitive', 'SUPER_ADMIN')
  const payload = schema.parse(await readJson(request))
  if (!validTimezone(payload.timezone)) {
    throw new ApiError('Choose a valid IANA timezone (for example Africa/Casablanca).', 422, 'INVALID_TIMEZONE', {
      timezone: 'Unknown timezone',
    })
  }

  const before = await getMuseumSettings()
  const saved = await saveMuseumSettings({ ...payload, cutoffTime: normaliseTime(payload.cutoffTime) }, admin.id)

  // Keep the storefront chrome (header, footer, emails) in step with museum settings.
  await prisma.generalSettings.update({
    where: { key: 'singleton' },
    data: {
      storeName: saved.museumName,
      supportEmail: saved.supportEmail,
      supportPhone: saved.supportPhone,
      storeAddress: saved.museumAddress,
      timezone: saved.timezone,
      defaultCurrency: saved.currency,
    },
  })

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'SETTINGS_MUSEUM_SAVE',
    entityType: 'Setting',
    summary: describe(before, saved),
    metadata: {
      adultPriceCents: saved.adultPriceCents,
      childPriceCents: saved.childPriceCents,
      dailyCapacity: saved.dailyCapacity,
      cutoffTime: saved.cutoffTime,
    },
    ip,
  })

  return ok(saved)
})

function describe(before: MuseumSettings, after: MuseumSettings): string {
  const changes: string[] = []
  if (before.adultPriceCents !== after.adultPriceCents) changes.push(`adult ${before.adultPriceCents}→${after.adultPriceCents} cents`)
  if (before.childPriceCents !== after.childPriceCents) changes.push(`child ${before.childPriceCents}→${after.childPriceCents} cents`)
  if (before.dailyCapacity !== after.dailyCapacity) changes.push(`capacity ${before.dailyCapacity}→${after.dailyCapacity}`)
  if (before.cutoffTime !== after.cutoffTime) changes.push(`cutoff ${before.cutoffTime}→${after.cutoffTime}`)
  if (before.bookingWindowDays !== after.bookingWindowDays) changes.push(`window ${before.bookingWindowDays}→${after.bookingWindowDays} days`)
  return changes.length > 0 ? `Museum settings saved: ${changes.join(', ')}` : 'Museum settings saved'
}
