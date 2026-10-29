import type { Metadata } from 'next'
import { requireAdminPage } from '@/lib/auth/guards'
import { getMuseumSettings } from '@/lib/museum/settings'
import { toMajorString } from '@/components/shared/money'
import { MuseumSettingsForm, type MuseumSettingsFormState } from '@/components/admin/museum-settings-form'

export const metadata: Metadata = { title: 'Museum settings' }
export const dynamic = 'force-dynamic'

function supportedTimezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return ['Africa/Casablanca', 'Europe/Paris', 'Europe/Madrid', 'UTC']
  }
}

export default async function MuseumSettingsPage() {
  const [admin, settings] = await Promise.all([requireAdminPage(), getMuseumSettings()])

  const initial: MuseumSettingsFormState = {
    museumName: settings.museumName,
    museumTagline: settings.museumTagline,
    museumAddress: settings.museumAddress,
    supportEmail: settings.supportEmail,
    supportPhone: settings.supportPhone,
    timezone: settings.timezone,
    currency: settings.currency,
    adultPrice: toMajorString(settings.adultPriceCents, settings.currency),
    childPrice: toMajorString(settings.childPriceCents, settings.currency),
    dailyCapacity: String(settings.dailyCapacity),
    cutoffTime: settings.cutoffTime,
    bookingWindowDays: String(settings.bookingWindowDays),
    maxAdultsPerOrder: String(settings.maxAdultsPerOrder),
    maxChildrenPerOrder: String(settings.maxChildrenPerOrder),
    officialPartner: settings.officialPartner,
  }

  return (
    <MuseumSettingsForm initial={initial} timezones={supportedTimezones()} canEdit={admin.role === 'SUPER_ADMIN'} />
  )
}
