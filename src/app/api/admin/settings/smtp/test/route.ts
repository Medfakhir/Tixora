import { withApi, ok, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { verifyConnection } from '@/lib/email/transport'
import { getSmtp } from '@/lib/settings/service'
import { prisma } from '@/lib/db/prisma'
import { recordAudit } from '@/lib/auth/guards'

/** Verifies the stored SMTP configuration by authenticating; nothing is sent. */
export const POST = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'sensitive', 'SUPER_ADMIN')
  const settings = await getSmtp()
  if (!settings.host) throw new ApiError('Save an SMTP host before testing the connection.', 400, 'NOT_CONFIGURED')

  const result = await verifyConnection()
  await prisma.smtpSettings.update({
    where: { id: settings.id },
    data: { lastTestAt: new Date(), lastTestOk: result.ok, lastTestError: result.ok ? null : result.message.slice(0, 400) },
  })

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'SETTINGS_SMTP_TEST',
    entityType: 'SmtpSettings',
    entityId: settings.id,
    summary: `SMTP connection test ${result.ok ? 'succeeded' : 'failed'}`,
    // Only the outcome is recorded; server challenges can echo credential material.
    metadata: { ok: result.ok },
    ip,
  })

  return ok({ ok: result.ok, message: result.ok ? 'Connection verified.' : result.message })
})
