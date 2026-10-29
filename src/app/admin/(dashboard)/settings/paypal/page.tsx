import type { Metadata } from 'next'
import { requireAdminPage } from '@/lib/auth/guards'
import { getPayPal, publicPayPal } from '@/lib/settings/service'
import { PageHeader } from '@/components/admin/page-primitives'
import { PayPalForm } from '@/components/admin/settings/paypal-form'

export const metadata: Metadata = { title: 'PayPal settings' }

export default async function PayPalSettingsPage() {
  await requireAdminPage('SUPER_ADMIN')
  const paypal = publicPayPal(await getPayPal())

  return (
    <div className="grid gap-6">
      <PageHeader
        title="PayPal"
        description="Credentials and checkout environment. Secrets are encrypted at rest and never returned to the browser."
      />
      <PayPalForm
        initial={{
          enabled: paypal.enabled,
          environment: paypal.environment,
          sandboxClientId: paypal.sandboxClientId ?? '',
          hasSandboxSecret: paypal.hasSandboxSecret,
          liveClientId: paypal.liveClientId ?? '',
          hasLiveSecret: paypal.hasLiveSecret,
          webhookIdSandbox: paypal.webhookIdSandbox ?? '',
          webhookIdLive: paypal.webhookIdLive ?? '',
          currency: paypal.currency,
          lastTestAt: paypal.lastTestAt ? paypal.lastTestAt.toISOString() : null,
          lastTestOk: paypal.lastTestOk,
          lastTestError: paypal.lastTestError,
          ready: paypal.ready,
        }}
      />
    </div>
  )
}
