import type { Metadata } from 'next'
import { requireAdminPage } from '@/lib/auth/guards'
import { prisma } from '@/lib/db/prisma'
import { ensureTemplates } from '@/lib/email/delivery'
import { TEMPLATE_KEYS } from '@/lib/email/templates'
import { PageHeader } from '@/components/admin/page-primitives'
import { EmailTemplateEditor, type EmailTemplateRow } from '@/components/admin/settings/email-template-editor'

export const metadata: Metadata = { title: 'Email templates' }

export default async function EmailTemplatesPage() {
  await requireAdminPage('SUPER_ADMIN')
  await ensureTemplates()

  const rows = await prisma.emailTemplate.findMany()
  const order = TEMPLATE_KEYS as readonly string[]
  const templates: EmailTemplateRow[] = rows
    .map((template) => ({
      id: template.id,
      key: template.key,
      name: template.name,
      subject: template.subject,
      htmlBody: template.htmlBody,
      textBody: template.textBody,
      isActive: template.isActive,
      updatedAt: template.updatedAt.toISOString(),
    }))
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Email templates"
        description="Order and delivery emails. Changes apply to new messages and are audited."
      />
      <EmailTemplateEditor initialTemplates={templates} />
    </div>
  )
}
