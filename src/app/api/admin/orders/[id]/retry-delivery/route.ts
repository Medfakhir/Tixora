import { withApi, ok, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { retryDelivery } from '@/lib/email/delivery'

/**
 * Retry never re-sells the tickets and never marks the payment as failed; it re-arms the
 * same idempotent delivery row and processes it immediately.
 */
export const POST = withApi(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const { admin } = await adminRequest(request, 'sensitive')
  const result = await retryDelivery(id, { id: admin.id, email: admin.email })
  if (!result.ok) throw new ApiError(result.message, 409, 'DELIVERY_RETRY_REFUSED')
  return ok({ message: result.message })
})
