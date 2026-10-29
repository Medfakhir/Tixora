import { withApi, ok, readJson } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { refundSchema } from '@/lib/validation'
import { issueRefund } from '@/lib/orders/refund'

/**
 * Refunds are restricted to SUPER_ADMIN because they move real money and are the one
 * admin action that can be performed against a completed order.
 */
export const POST = withApi(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const { admin, ip } = await adminRequest(request, 'sensitive', 'SUPER_ADMIN')
  const payload = refundSchema.parse(await readJson(request))

  const result = await issueRefund({
    orderId: id,
    amountMinor: payload.amountMinor,
    reason: payload.reason || undefined,
    actor: { id: admin.id, email: admin.email },
    ip,
  })

  return ok({ refundId: result.refund.id, fullyRefunded: result.fullyRefunded, status: result.refund.status })
})
