import { z } from 'zod'
import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { recordAudit } from '@/lib/auth/guards'

const patchSchema = z.object({
  subject: z.string().trim().min(1, 'A subject is required').max(255),
  htmlBody: z.string().trim().min(1, 'The HTML body cannot be empty').max(200_000),
  textBody: z.string().trim().min(1, 'The plain-text body cannot be empty').max(200_000),
  isActive: z.boolean(),
})

/**
 * Templates are stored in the database so wording changes never need a deploy. The
 * placeholder set is fixed and every customer-supplied value is escaped at render time
 * (see src/lib/email/templates.ts), so editing a body cannot introduce stored XSS into
 * an outbound email.
 */
export const PATCH = withApi(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const { admin, ip } = await adminRequest(request, 'sensitive', 'SUPER_ADMIN')
  const payload = patchSchema.parse(await readJson(request))

  const existing = await prisma.emailTemplate.findUnique({ where: { id } })
  if (!existing) throw new ApiError('Template not found.', 404, 'NOT_FOUND')

  const updated = await prisma.emailTemplate.update({
    where: { id },
    data: {
      subject: payload.subject,
      htmlBody: payload.htmlBody,
      textBody: payload.textBody,
      isActive: payload.isActive,
    },
  })

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'EMAIL_TEMPLATE_UPDATE',
    entityType: 'EmailTemplate',
    entityId: updated.id,
    summary: `Updated the ${updated.key} email template`,
    metadata: { isActive: updated.isActive, subjectChanged: existing.subject !== updated.subject },
    ip,
  })

  return ok({
    id: updated.id,
    key: updated.key,
    name: updated.name,
    subject: updated.subject,
    htmlBody: updated.htmlBody,
    textBody: updated.textBody,
    isActive: updated.isActive,
    updatedAt: updated.updatedAt,
  })
})
