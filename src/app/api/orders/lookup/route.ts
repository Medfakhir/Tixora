import { z } from 'zod'
import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { anonymousRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { normaliseEmail } from '@/lib/orders/service'
import { recordAudit } from '@/lib/auth/guards'

const schema = z.object({
  reference: z.string().trim().min(4).max(40),
  email: z.email('Enter a valid email address'),
})

const NOT_FOUND = 'No order matches that reference and email address.'

/**
 * Guests have no accounts, so the order reference on their receipt plus the address they
 * booked with is the whole credential. Both must match a single row, the answer is the same
 * whether one or both are wrong, and the route is rate limited to keep references
 * un-enumerable.
 */
export const POST = withApi(async (request: Request) => {
  const { ip } = await anonymousRequest(request, 'orderLookup')
  const payload = schema.parse(await readJson(request))
  const email = normaliseEmail(payload.email)

  const order = await prisma.order.findFirst({
    where: { reference: payload.reference.toUpperCase(), customerEmail: email },
    select: { publicId: true, reference: true },
  })

  if (!order) {
    const partial = await prisma.order.findFirst({ where: { reference: payload.reference.toUpperCase() }, select: { id: true } })
    if (partial) {
      await recordAudit({
        actorType: 'GUEST',
        actorLabel: email,
        action: 'ORDER_LOOKUP_MISMATCH',
        entityType: 'Order',
        entityId: partial.id,
        summary: 'Order lookup rejected: reference matched but the email address did not',
        ip,
      })
    }
    throw new ApiError(NOT_FOUND, 404, 'ORDER_NOT_FOUND')
  }

  return ok({ publicId: order.publicId })
})
