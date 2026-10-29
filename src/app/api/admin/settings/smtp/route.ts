import { z } from 'zod'
import { withApi, ok, readJson } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { smtpSettingsSchema } from '@/lib/validation'
import { getSmtp, publicSmtp, saveSmtp } from '@/lib/settings/service'
import { resetTransportCache } from '@/lib/email/transport'
import { recordAudit } from '@/lib/auth/guards'

const secretFlagsSchema = z.object({ clearPassword: z.boolean().optional() })

export const GET = withApi(async (request: Request) => {
  await adminRequest(request, 'sensitive', 'SUPER_ADMIN')
  return ok(publicSmtp(await getSmtp()))
})

/** The password is write-only: blank means unchanged, and no response ever carries it. */
export const POST = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'sensitive', 'SUPER_ADMIN')
  const body = await readJson(request)
  const { password, ...rest } = smtpSettingsSchema.parse(body)
  const flags = secretFlagsSchema.parse(body)

  const saved = await saveSmtp({ ...rest, password: flags.clearPassword ? null : password || undefined, updatedBy: admin.id })
  resetTransportCache()

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'SETTINGS_SMTP_SAVE',
    entityType: 'SmtpSettings',
    entityId: saved.id,
    summary: `SMTP settings saved (${saved.host ?? 'unset'}:${saved.port}, enabled=${saved.enabled})`,
    metadata: { passwordUpdated: Boolean(password) || Boolean(flags.clearPassword) },
    ip,
  })

  return ok(publicSmtp(saved))
})
