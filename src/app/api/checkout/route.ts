import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { anonymousRequest } from '@/lib/api/admin'
import { checkoutRequestSchema } from '@/lib/validation'
import { startCheckout } from '@/lib/orders/service'
import { getGeneral } from '@/lib/settings/service'
import { assertStoreOpen } from '@/lib/settings/maintenance'

export const POST = withApi(async (request: Request) => {
  const { ip, userAgent } = await anonymousRequest(request, 'checkout')
  await assertStoreOpen()

  const payload = checkoutRequestSchema.parse(await readJson(request))
  const general = await getGeneral()
  if (general.requirePhone && !payload.phone) {
    throw new ApiError('A phone number is required for this purchase.', 422, 'VALIDATION', { phone: 'Required for this purchase' })
  }

  const result = await startCheckout(
    {
      slug: payload.slug,
      eventSessionId: payload.eventSessionId ?? null,
      quantity: payload.quantity,
      fullName: payload.fullName,
      email: payload.email,
      phone: payload.phone || null,
    },
    { ip, userAgent: userAgent ?? undefined },
  )

  // Only what the guest browser needs; nothing about the internal order id is exposed.
  return ok(
    {
      publicId: result.order?.publicId ?? null,
      reference: result.order?.reference ?? null,
      totalMinor: result.totalMinor,
      currency: result.currency,
      productName: result.productName,
      reservationExpiresAt: result.reservationExpiresAt,
    },
    201,
  )
})
