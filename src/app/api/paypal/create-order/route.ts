import { z } from 'zod'
import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { anonymousRequest } from '@/lib/api/admin'
import { beginPayment } from '@/lib/orders/payment-flow'
import { prisma } from '@/lib/db/prisma'
import { assertStoreOpen } from '@/lib/settings/maintenance'

const schema = z.object({ publicId: z.string().min(8) })

/**
 * The browser names the order it wants to pay for; the amount, currency and PayPal
 * account all come from the server-side order row, never from this request.
 */
export const POST = withApi(async (request: Request) => {
  await anonymousRequest(request, 'checkout')
  await assertStoreOpen()

  const { publicId } = schema.parse(await readJson(request))
  const order = await prisma.order.findUnique({ where: { publicId }, include: { lines: true } })
  if (!order) throw new ApiError('Order not found.', 404, 'ORDER_NOT_FOUND')
  if (order.kind !== 'MUSEUM' && order.reservationExpiresAt && order.reservationExpiresAt < new Date()) {
    throw new ApiError('This booking hold has expired. Please start the purchase again.', 410, 'RESERVATION_EXPIRED')
  }

  const line = order.lines[0]
  const result = await beginPayment({
    orderId: order.id,
    description: line?.productName ?? 'Badi Palace Museum entrance',
    quantity: order.kind === 'MUSEUM' ? order.adultQty + order.childQty : order.lines.reduce((sum, candidate) => sum + candidate.quantity, 0),
  })

  if (result.alreadyPaid) return ok({ alreadyPaid: true, approvalUrl: null, paypalOrderId: result.paypalOrderId })
  if (!result.approvalUrl) throw new ApiError('PayPal did not return an approval URL.', 502, 'PAYPAL_APPROVAL_MISSING')

  return ok({ alreadyPaid: false, approvalUrl: result.approvalUrl, paypalOrderId: result.paypalOrderId })
})
