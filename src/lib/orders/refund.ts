import { prisma } from '@/lib/db/prisma'
import { OrderError } from './service'
import { syncCustomerTotals } from './service'
import { refundCapture } from '@/lib/paypal/api'
import { getPayPal, payPalCredentialsFor } from '@/lib/settings/service'
import { recordAudit } from '@/lib/auth/guards'
import { queueRefundNotification } from '@/lib/email/delivery'
import type { PaymentEnvironment } from '@prisma/client'

const REFUNDABLE = ['PAID', 'PROCESSING', 'COMPLETED', 'DELIVERY_FAILED', 'PARTIALLY_REFUNDED']

/**
 * Refunds are matched to the environment the payment was captured in, never to whichever
 * environment the admin currently has selected, so a Sandbox-then-Live switch cannot
 * strand historical orders against the wrong account.
 */
export async function issueRefund(input: {
  orderId: string
  amountMinor: number
  reason?: string
  actor: { id: string; email: string }
  ip?: string | null
}) {
  const order = await prisma.order.findUnique({ where: { id: input.orderId }, include: { lines: true, payments: true } })
  if (!order) throw new OrderError('ORDER_NOT_FOUND', 'Order not found', 404)
  if (!REFUNDABLE.includes(order.status)) {
    throw new OrderError('NOT_REFUNDABLE', `An order with status ${order.status} cannot be refunded.`, 409)
  }
  if (!order.paypalCaptureId) {
    throw new OrderError('NO_CAPTURE', 'This order has no captured payment to refund.', 409)
  }

  const refundable = order.totalMinor - order.refundedMinor
  if (input.amountMinor > refundable) {
    throw new OrderError('AMOUNT_TOO_HIGH', `Only ${refundable} of this order remains refundable.`, 409)
  }

  const environment = (order.paymentEnvironment ?? (await getPayPal()).environment) as PaymentEnvironment
  const settings = await getPayPal()
  if (!settings.enabled) throw new OrderError('PAYPAL_DISABLED', 'PayPal is disabled in settings; refunds need the API.', 409)
  const credentials = payPalCredentialsFor(settings, environment)
  if (!credentials) {
    throw new OrderError('PAYPAL_NOT_CONFIGURED', `No ${environment.toLowerCase()} PayPal credentials are configured.`, 409)
  }

  const result = await refundCapture(credentials, order.paypalCaptureId, input.amountMinor, order.currency, input.reason)

  const row = await prisma.refund.create({
    data: {
      orderId: order.id,
      captureId: order.paypalCaptureId,
      paypalRefundId: result.refundId,
      amountMinor: input.amountMinor,
      currency: order.currency,
      environment,
      status: result.status === 'COMPLETED' ? 'REFUNDED' : 'CREATED',
      reason: input.reason ?? null,
      requestedBy: input.actor.id,
      raw: result.raw as object,
    },
  })

  const totalRefunded = order.refundedMinor + input.amountMinor
  const fullyRefunded = totalRefunded >= order.totalMinor
  await prisma.order.update({
    where: { id: order.id },
    data: { refundedMinor: totalRefunded, status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
  })
  await prisma.payment.updateMany({
    where: { orderId: order.id, captureId: order.paypalCaptureId },
    data: { status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
  })
  await syncCustomerTotals(order.customerEmail)

  await recordAudit({
    actorType: 'ADMIN',
    actorId: input.actor.id,
    actorLabel: input.actor.email,
    action: 'ORDER_REFUND',
    entityType: 'Order',
    entityId: order.id,
    summary: `Refunded ${input.amountMinor} (${order.currency}) on ${order.reference}`,
    metadata: { refundId: result.refundId, status: result.status, reason: input.reason ?? null },
    ip: input.ip,
  })

  // The customer hears about it from the refund template, not from a support ticket.
  await queueRefundNotification(order.id, row.id, `Refund of ${input.amountMinor} ${order.currency}${input.reason ? ` — ${input.reason}` : ''}`)

  return { refund: row, fullyRefunded }
}
