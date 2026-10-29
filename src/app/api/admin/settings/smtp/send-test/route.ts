import { z } from 'zod'
import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { sendEmail, getTransport } from '@/lib/email/transport'
import { getGeneral } from '@/lib/settings/service'
import { recordAudit } from '@/lib/auth/guards'

const schema = z.object({ to: z.email().optional() })

/** Sends one real message through the configured transport to prove delivery end to end. */
export const POST = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'sensitive', 'SUPER_ADMIN')

  const transport = await getTransport()
  if (!transport) throw new ApiError('Email delivery is disabled or SMTP is incomplete.', 409, 'SMTP_DISABLED')

  const general = await getGeneral()
  const body = (await readJson(request).catch(() => ({}))) as { to?: string }
  const to = schema.parse(body).to ?? admin.email

  await sendEmail({
    to,
    subject: `${general.storeName} — SMTP test`,
    html: `<p>This is a test message from the ${general.storeName} admin console.</p><p>If you received it, SMTP delivery is working.</p>`,
    text: `This is a test message from the ${general.storeName} admin console.`,
  })

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'SETTINGS_SMTP_TEST_EMAIL',
    entityType: 'SmtpSettings',
    entityId: transport.settings.host,
    summary: `Test email sent to ${to}`,
    ip,
  })

  return ok({ sent: true, to })
})
