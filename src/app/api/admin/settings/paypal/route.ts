import { z } from 'zod'
import { withApi, ok, readJson } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { paypalSettingsSchema } from '@/lib/validation'
import { savePaypal, getPayPal, publicPayPal } from '@/lib/settings/service'
import { recordAudit } from '@/lib/auth/guards'

/** Explicit deletion switches, separate from the payload so an empty secret means "unchanged". */
const secretFlagsSchema = z.object({
  clearSandboxSecret: z.boolean().optional(),
  clearLiveSecret: z.boolean().optional(),
})

export const GET = withApi(async (request: Request) => {
  await adminRequest(request, 'sensitive', 'SUPER_ADMIN')
  return ok(publicPayPal(await getPayPal()))
})

/**
 * Secrets are write-only. A blank field means "keep what is stored"; only an explicit
 * clearSecrets flag can remove them, so an ordinary save cannot wipe a live credential.
 */
export const POST = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'sensitive', 'SUPER_ADMIN')
  const body = await readJson(request)
  const payload = paypalSettingsSchema.parse(body)
  const flags = secretFlagsSchema.parse(body)
  const { sandboxClientSecret, liveClientSecret, ...rest } = payload

  const saved = await savePaypal({
    ...rest,
    sandboxClientSecret: flags.clearSandboxSecret ? null : sandboxClientSecret || undefined,
    liveClientSecret: flags.clearLiveSecret ? null : liveClientSecret || undefined,
    updatedBy: admin.id,
  })

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'SETTINGS_PAYPAL_SAVE',
    entityType: 'PayPalSettings',
    entityId: saved.id,
    summary: `PayPal settings saved (${saved.environment}, enabled=${saved.enabled})`,
    metadata: {
      sandboxSecretUpdated: Boolean(sandboxClientSecret) || Boolean(flags.clearSandboxSecret),
      liveSecretUpdated: Boolean(liveClientSecret) || Boolean(flags.clearLiveSecret),
    },
    ip,
  })

  return ok(publicPayPal(saved))
})
