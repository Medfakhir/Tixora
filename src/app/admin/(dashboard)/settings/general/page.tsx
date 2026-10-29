import type { Metadata } from 'next'
import { requireAdminPage } from '@/lib/auth/guards'
import { getGeneral } from '@/lib/settings/service'
import { PageHeader } from '@/components/admin/page-primitives'
import { GeneralForm } from '@/components/admin/settings/general-form'

export const metadata: Metadata = { title: 'General settings' }

function supportedTimezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return []
  }
}

export default async function GeneralSettingsPage() {
  const admin = await requireAdminPage()
  const general = await getGeneral()

  return (
    <div className="grid gap-6">
      <PageHeader
        title="General settings"
        description="Store identity, tax, checkout rules and legal pages. Saving requires a super admin account."
      />
      <GeneralForm
        canEdit={admin.role === 'SUPER_ADMIN'}
        timezones={supportedTimezones()}
        initial={{
          storeName: general.storeName,
          supportEmail: general.supportEmail,
          supportPhone: general.supportPhone ?? '',
          storeAddress: general.storeAddress ?? '',
          timezone: general.timezone,
          defaultCurrency: general.defaultCurrency,
          taxLabel: general.taxLabel,
          taxRatePercent: String(general.taxRateBps / 100),
          receiptPrefix: general.receiptPrefix,
          reservationMinutes: String(general.reservationMinutes),
          maxTicketsPerOrder: String(general.maxTicketsPerOrder),
          requirePhone: general.requirePhone,
          billingRequired: general.billingRequired,
          maintenanceMode: general.maintenanceMode,
          privacyUrl: general.privacyUrl,
          termsUrl: general.termsUrl,
          privacyPolicy: general.privacyPolicy,
          termsAndConditions: general.termsAndConditions,
        }}
      />
    </div>
  )
}
