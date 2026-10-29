import { z } from 'zod'
import { withApi, ok, readJson } from '@/lib/api/http'
import { anonymousRequest } from '@/lib/api/admin'
import { completePayment } from '@/lib/orders/payment-flow'
import { assertStoreOpen } from '@/lib/settings/maintenance'

// Capture talks to PayPal and then sends the confirmation email in-request.
export const maxDuration = 30

const schema = z.object({
  publicId: z.string().min(8),
  // The only payment fact accepted from the browser is *which* PayPal order to capture.
  paypalOrderId: z.string().min(8).max(64),
})

/**
 * Reaching the success page is not proof of payment. This handler re-captures
 * server-side and the service layer verifies amount, currency and ownership.
 */
export const POST = withApi(async (request: Request) => {
  await anonymousRequest(request, 'checkout')
  await assertStoreOpen()

  const payload = schema.parse(await readJson(request))
  const result = await completePayment(payload)

  return ok({
    status: result.order.status,
    deliveryStatus: result.order.deliveryStatus,
    reference: result.order.reference,
    publicId: result.order.publicId,
    newlyMarkedPaid: result.newlyMarkedPaid,
    ticketsCommitted: result.ticketsCommitted,
    needsManualResolution: result.needsManualResolution,
    queued: result.queued,
  })
})
