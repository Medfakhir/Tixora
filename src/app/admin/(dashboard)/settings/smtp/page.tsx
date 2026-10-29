import type { Metadata } from 'next'
import { requireAdminPage } from '@/lib/auth/guards'
import { getSmtp, publicSmtp } from '@/lib/settings/service'
import { PageHeader } from '@/components/admin/page-primitives'
import { SmtpForm } from '@/components/admin/settings/smtp-form'

export const metadata: Metadata = { title: 'SMTP settings' }

export default async function SmtpSettingsPage() {
  await requireAdminPage('SUPER_ADMIN')
  const smtp = publicSmtp(await getSmtp())

  return (
    <div className="grid gap-6">
      <PageHeader
        title="SMTP"
        description="Outbound email delivery. The stored password is encrypted at rest and never returned to the browser."
      />
      <SmtpForm
        initial={{
          enabled: smtp.enabled,
          host: smtp.host ?? '',
          port: String(smtp.port),
          encryption: smtp.encryption,
          username: smtp.username ?? '',
          hasPassword: smtp.hasPassword,
          senderName: smtp.senderName ?? '',
          senderEmail: smtp.senderEmail ?? '',
          replyToEmail: smtp.replyToEmail ?? '',
          allowSelfSigned: smtp.allowSelfSigned,
          pool: smtp.pool,
          lastTestAt: smtp.lastTestAt ? smtp.lastTestAt.toISOString() : null,
          lastTestOk: smtp.lastTestOk,
          lastTestError: smtp.lastTestError,
          ready: smtp.ready,
        }}
      />
    </div>
  )
}
