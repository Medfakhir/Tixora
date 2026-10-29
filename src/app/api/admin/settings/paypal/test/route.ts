import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { z } from 'zod'
import { getPayPal, payPalCredentialsFor } from '@/lib/settings/service'
import { testCredentials, clearTokenCache } from '@/lib/paypal/api'
import { recordAudit } from '@/lib/auth/guards'
import { prisma } from '@/lib/db/prisma'
import type { PaymentEnvironment } from '@prisma/client'

const schema = z.object({ environment: z.enum(['SANDBOX', 'LIVE']).optional() })

/**
 * Tests the stored credentials for one environment without exposing them, and records the
 * outcome so the settings screen can show a real last-checked state instead of a guess.
 */
export const POST = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'sensitive', 'SUPER_ADMIN')
  const body = (await readJson(request).catch(() => ({}))) as { environment?: PaymentEnvironment }
  const environment = schema.parse(body).environment ?? (await getPayPal()).environment

  const settings = await getPayPal()
  const credentials = payPalCredentialsFor(settings, environment)
  if (!credentials) {
    await prisma.payPalSettings.update({
      where: { id: settings.id },
      data: { lastTestAt: new Date(), lastTestOk: false, lastTestError: `${environment} credentials are not configured` },
    })
    throw new ApiError(`No ${environment} client id and secret are configured.`, 400, 'NOT_CONFIGURED')
  }

  clearTokenCache()
  const result = await testCredentials(credentials)
  await prisma.payPalSettings.update({
    where: { id: settings.id },
    data: { lastTestAt: new Date(), lastTestOk: result.ok, lastTestError: result.ok ? null : result.message.slice(0, 400) },
  })
  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'SETTINGS_PAYPAL_TEST',
    entityType: 'PayPalSettings',
    entityId: settings.id,
    summary: `PayPal ${environment} connection test ${result.ok ? 'succeeded' : 'failed'}`,
    // The message is credential-adjacent text; only a boolean and length are logged.
    metadata: { environment, ok: result.ok },
    ip,
  })

  return ok({ ok: result.ok, environment, message: result.ok ? 'Connection verified.' : result.message })
})
