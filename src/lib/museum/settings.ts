import { prisma } from '@/lib/db/prisma'

/**
 * Museum operational settings live in the `Setting` key/value table. Prices and
 * capacity are read from here on every booking, so an admin change applies
 * immediately without a deploy.
 */
export type MuseumSettings = {
  museumName: string
  museumTagline: string
  museumAddress: string
  supportEmail: string
  supportPhone: string
  timezone: string
  currency: string
  adultPriceCents: number
  childPriceCents: number
  dailyCapacity: number
  cutoffTime: string
  bookingWindowDays: number
  maxAdultsPerOrder: number
  maxChildrenPerOrder: number
  officialPartner: boolean
}

export const MUSEUM_SETTING_DEFAULTS: MuseumSettings = {
  museumName: 'Badi Palace Museum',
  museumTagline: 'A Saadian masterpiece in the heart of Marrakech.',
  museumAddress: 'Kssibat Nohas, Marrakech 40000, Morocco',
  supportEmail: 'tickets@visitbadipalace.com',
  supportPhone: '+212 5 24 38 95 64',
  timezone: 'Africa/Casablanca',
  currency: 'EUR',
  adultPriceCents: 1299,
  childPriceCents: 699,
  dailyCapacity: 0,
  cutoffTime: '14:00',
  bookingWindowDays: 180,
  maxAdultsPerOrder: 20,
  maxChildrenPerOrder: 20,
  officialPartner: false,
}

const KEYS = {
  museumName: 'museum_name',
  museumTagline: 'museum_tagline',
  museumAddress: 'museum_address',
  supportEmail: 'museum_support_email',
  supportPhone: 'museum_support_phone',
  timezone: 'museum_timezone',
  currency: 'museum_currency',
  adultPriceCents: 'adult_price_cents',
  childPriceCents: 'child_price_cents',
  dailyCapacity: 'daily_capacity',
  cutoffTime: 'same_day_cutoff',
  bookingWindowDays: 'booking_window_days',
  maxAdultsPerOrder: 'max_adults_per_order',
  maxChildrenPerOrder: 'max_children_per_order',
  officialPartner: 'official_partner',
} satisfies Record<keyof MuseumSettings, string>

function asInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function asBool(value: string | undefined, fallback: boolean): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export async function getMuseumSettings(): Promise<MuseumSettings> {
  const rows = await prisma.setting.findMany({ where: { key: { in: Object.values(KEYS) } } })
  const map = new Map(rows.map((row) => [row.key, row.value]))
  const d = MUSEUM_SETTING_DEFAULTS

  return {
    museumName: map.get(KEYS.museumName) ?? d.museumName,
    museumTagline: map.get(KEYS.museumTagline) ?? d.museumTagline,
    museumAddress: map.get(KEYS.museumAddress) ?? d.museumAddress,
    supportEmail: map.get(KEYS.supportEmail) ?? d.supportEmail,
    supportPhone: map.get(KEYS.supportPhone) ?? d.supportPhone,
    timezone: map.get(KEYS.timezone) ?? d.timezone,
    currency: (map.get(KEYS.currency) ?? d.currency).toUpperCase(),
    adultPriceCents: Math.max(0, asInt(map.get(KEYS.adultPriceCents), d.adultPriceCents)),
    childPriceCents: Math.max(0, asInt(map.get(KEYS.childPriceCents), d.childPriceCents)),
    dailyCapacity: Math.max(0, asInt(map.get(KEYS.dailyCapacity), d.dailyCapacity)),
    cutoffTime: normaliseTime(map.get(KEYS.cutoffTime) ?? d.cutoffTime),
    bookingWindowDays: Math.max(1, asInt(map.get(KEYS.bookingWindowDays), d.bookingWindowDays)),
    maxAdultsPerOrder: Math.max(1, asInt(map.get(KEYS.maxAdultsPerOrder), d.maxAdultsPerOrder)),
    maxChildrenPerOrder: Math.max(0, asInt(map.get(KEYS.maxChildrenPerOrder), d.maxChildrenPerOrder)),
    officialPartner: asBool(map.get(KEYS.officialPartner), d.officialPartner),
  }
}

export async function saveMuseumSettings(input: Partial<MuseumSettings>, updatedBy?: string): Promise<MuseumSettings> {
  const entries: [keyof MuseumSettings, string][] = []
  for (const key of Object.keys(KEYS) as (keyof MuseumSettings)[]) {
    const value = input[key]
    if (value === undefined) continue
    entries.push([key, typeof value === 'boolean' ? String(value) : String(value)])
  }

  await prisma.$transaction(
    entries.map(([key, value]) =>
      prisma.setting.upsert({
        where: { key: KEYS[key] },
        create: { key: KEYS[key], value, updatedBy: updatedBy ?? null },
        update: { value, updatedBy: updatedBy ?? null },
      }),
    ),
  )

  return getMuseumSettings()
}

export function normaliseTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return MUSEUM_SETTING_DEFAULTS.cutoffTime
  const hours = Math.min(23, Math.max(0, Number.parseInt(match[1], 10)))
  const minutes = Math.min(59, Math.max(0, Number.parseInt(match[2], 10)))
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export { KEYS as MUSEUM_SETTING_KEYS }
