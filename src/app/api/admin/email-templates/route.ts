import { withApi, ok } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { ensureTemplates } from '@/lib/email/delivery'
import { TEMPLATE_KEYS } from '@/lib/email/templates'

/** Seeds any missing default template, then returns every row so an admin can edit wording. */
export const GET = withApi(async (request: Request) => {
  await adminRequest(request, 'sensitive')
  await ensureTemplates()

  const templates = await prisma.emailTemplate.findMany()
  const order = TEMPLATE_KEYS as readonly string[]

  return ok({
    templates: templates
      .map((template) => ({
        id: template.id,
        key: template.key,
        name: template.name,
        subject: template.subject,
        htmlBody: template.htmlBody,
        textBody: template.textBody,
        isActive: template.isActive,
        updatedAt: template.updatedAt,
      }))
      .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)),
  })
})
