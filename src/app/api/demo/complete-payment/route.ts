import { z } from 'zod'
import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { anonymousRequest } from '@/lib/api/admin'
import { assertStoreOpen } from '@/lib/settings/maintenance'
import { completeDemoPayment } from '@/lib/orders/payment-flow'
import { demoPaymentsEnabled } from '@/lib/config/env'

const schema = z.object({
  publicId: z.string().trim().min(8, 'Missing order id').max(64, 'Invalid order id'),
})

/**
 * Test-only counterpart to POST /api/paypal/capture-order. It marks a pending order as
 * paid so the confirmation email + success page can be tested without PayPal.
 *
 * Gated twice: the service refuses unless DEMO_PAYMENTS=true, and this route answers
 * 404 when the flag is off so a probe cannot even learn the endpoint exists. The body
 * only ever carries the order's public id — amounts come from the stored order.
 */
export const POST = withApi(async (request: Request) => {
  const { ip, userAgent } = await anonymousRequest(request, 'checkout')
  void ip
  void userAgent
  await assertStoreOpen()

  if (!demoPaymentsEnabled) {
    throw new ApiError('Not found', 404, 'NOT_FOUND')
  }

  const payload = schema.parse(await readJson(request))
  const result = await completeDemoPayment({ publicId: payload.publicId })

  return ok({
    status: result.order.status,
    reference: result.order.reference,
    publicId: result.order.publicId,
    alreadyPaid: result.alreadyPaid,
    queued: result.queued,
  })
})
