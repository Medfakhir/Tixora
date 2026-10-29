import { prisma } from '@/lib/db/prisma'
import { OrderError, markOrderPaid, syncCustomerTotals } from './service'
import { createPaypalOrder, capturePaypalOrder, getPaypalOrder, type PaypalOrderDetails } from '@/lib/paypal/api'
import { getPayPal, payPalCredentialsFor } from '@/lib/settings/service'
import { getMuseumSettings } from '@/lib/museum/settings'
import { museumPaymentDescription } from '@/lib/museum/orders'
import { recordAudit } from '@/lib/auth/guards'
import { queueTicketDelivery, processDeliveryQueue } from '@/lib/email/delivery'
import { env } from '@/lib/config/env'
import type { OrderStatus, PaymentEnvironment } from '@prisma/client'

/** Statuses that already represent a settled PayPal capture and must not be re-captured. */
const SETTLED_STATUSES: OrderStatus[] = [
  'PAID',
  'PROCESSING',
  'COMPLETED',
  'DELIVERY_FAILED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
]

function base_url(): string {
  return env.APP_URL.replace(/\/$/, '')
}

/**
 * Sends a just-queued confirmation immediately so customers do not wait for the next
 * maintenance run. Vercel's Hobby plan cannot schedule a per-minute cron, and a delivery
 * failure must never fail the payment response — the queued row is retried later by
 * `POST /api/cron/expire-reservations` or by an admin re-delivery.
 */
async function flushDeliveries(limit = 2): Promise<void> {
  try {
    await processDeliveryQueue(limit)
  } catch (error) {
    console.error('[paypal] immediate delivery flush failed', { error: (error as Error).message })
  }
}

/**
 * Payment settings are read once per operation and pinned to the order's environment so a
 * mid-flight switch between Sandbox and Live cannot move an in-progress payment.
 */
async function credentialsFor(order: { paypalOrderId: string | null; paymentEnvironment: PaymentEnvironment | null }) {
  const settings = await getPayPal()
  const credentials = payPalCredentialsFor(settings, order.paymentEnvironment ?? settings.environment)
  if (!credentials) throw new OrderError('PAYPAL_NOT_CONFIGURED', 'PayPal is not configured yet. Contact support.', 503)
  // DB credentials respect the admin on/off switch; environment credentials are an
  // explicit deployment-level opt-in and work without touching the database.
  if (!settings.enabled && credentials.source === 'db') {
    throw new OrderError('PAYPAL_DISABLED', 'PayPal payments are currently disabled.', 409)
  }
  return { credentials, settings }
}

export async function beginPayment(input: { orderId: string; description: string; quantity: number }) {
  const order = await prisma.order.findUnique({ where: { id: input.orderId }, include: { lines: true } })
  if (!order) throw new OrderError('ORDER_NOT_FOUND', 'Order not found', 404)
  if (SETTLED_STATUSES.includes(order.status)) {
    return { alreadyPaid: true as const, approvalUrl: null, paypalOrderId: order.paypalOrderId }
  }
  if (!['PENDING', 'AWAITING_PAYMENT'].includes(order.status)) {
    throw new OrderError('ORDER_NOT_PAYABLE', `This order can no longer be paid (${order.status}).`, 409)
  }

  const { credentials } = await credentialsFor(order)
  const museum = order.kind === 'MUSEUM' ? await getMuseumSettings() : null
  const created = await createPaypalOrder({
    credentials,
    internalOrderId: order.id,
    internalReference: order.reference,
    amountMinor: order.totalMinor,
    currency: order.currency,
    description: museum ? museumPaymentDescription(order) : input.description,
    quantity: museum ? order.adultQty + order.childQty : input.quantity,
    brandName: museum?.museumName ?? 'Badi Palace Museum',
    returnUrl: `${base_url()}/checkout/success?order=${order.publicId}`,
    cancelUrl: `${base_url()}/book?cancelled=1`,
  })

  await prisma.order.update({
    where: { id: order.id },
    data: { paypalOrderId: created.paypalOrderId, paymentEnvironment: credentials.environment, status: 'AWAITING_PAYMENT' },
  })
  await prisma.payment.create({
    data: {
      orderId: order.id,
      environment: credentials.environment,
      status: 'CREATED',
      paypalOrderId: created.paypalOrderId,
      amountMinor: order.totalMinor,
      currency: order.currency,
    },
  })

  return { alreadyPaid: false as const, approvalUrl: created.approvalUrl, paypalOrderId: created.paypalOrderId }
}

/**
 * Captures server-side and only then marks the order paid. The PayPal order is matched back
 * to our own by invoice_id/reference_id, so a customer cannot approve someone else's order id
 * and have it credited here.
 *
 * The success page and the PayPal callback may both call this. If the order is already
 * settled we return it without talking to PayPal, so a missing credential or a completed
 * capture cannot turn a paid booking into an error page.
 */
export async function completePayment(input: { publicId: string; paypalOrderId: string }) {
  const order = await prisma.order.findUnique({ where: { publicId: input.publicId }, include: { lines: true } })
  if (!order) throw new OrderError('ORDER_NOT_FOUND', 'Order not found', 404)

  if (SETTLED_STATUSES.includes(order.status)) {
    return {
      order,
      newlyMarkedPaid: false,
      ticketsCommitted: 0,
      needsManualResolution: false,
      queued: false,
    }
  }
  if (!['PENDING', 'AWAITING_PAYMENT'].includes(order.status)) {
    throw new OrderError('ORDER_NOT_PAYABLE', `This order can no longer be paid (${order.status}).`, 409)
  }

  const { credentials } = await credentialsFor(order)
  const captured = await capturePaypalOrder(credentials, input.paypalOrderId)

  assertMatchesOrder(captured, order, credentials.environment)

  const capture = captured.captures.find((candidate) => candidate.id && candidate.status !== 'PENDING') ?? captured.captures[0]
  if (!capture?.id || !capture.amount) {
    throw new OrderError('NOT_CAPTURED', 'PayPal has not completed this payment yet.', 409)
  }

  const result = await markOrderPaid({
    orderId: order.id,
    environment: credentials.environment,
    paypalOrderId: captured.id,
    captureId: capture.id,
    amountMinor: capture.amount.minor,
    currency: capture.amount.currency,
    raw: captured.raw,
  })

  const queued = result.newlyMarkedPaid ? (await queueTicketDelivery(order.id)).queued : false
  if (queued) await flushDeliveries()

  return { ...result, queued }
}

function assertMatchesOrder(
  details: PaypalOrderDetails,
  order: { id: string; reference: string; totalMinor: number; currency: string },
  environment: PaymentEnvironment,
): void {
  if (details.referenceId !== order.id && details.invoiceId !== order.reference) {
    throw new OrderError('PAYPAL_ORDER_MISMATCH', 'That PayPal order does not belong to this purchase.', 409)
  }
  void environment
}

/**
 * Webhook path: the same money check as the browser path, but driven entirely by what PayPal
 * reports. A duplicate delivery is recorded and ignored instead of being re-applied.
 */
export async function handleWebhookEvent(input: {
  rawBody: string
  eventType: string
  eventId: string | null
  resourceId: string | null
  resourceOrderId: string | null
  captureId: string | null
  amountMinor: number | null
  currency: string | null
  environment: PaymentEnvironment
  verified: boolean
  status: 'PROCESSED' | 'IGNORED_DUPLICATE' | 'SIGNATURE_INVALID' | 'FAILED' | 'RECEIVED'
  error?: string
}) {
  const existing = input.eventId ? await prisma.paymentWebhookEvent.findUnique({ where: { eventId: input.eventId } }) : null
  if (existing) {
    return { duplicate: true, orderPaid: false }
  }

  const row = await prisma.paymentWebhookEvent.create({
    data: {
      eventId: input.eventId ?? `unkeyed:${input.captureId ?? input.resourceOrderId}:${Date.now()}`,
      eventType: input.eventType,
      status: input.status,
      resourceType: input.eventType.split('.')[0] ?? null,
      payload: safeParse(input.rawBody),
      error: input.error ?? null,
    },
  })

  if (!input.verified) return { duplicate: false, orderPaid: false, id: row.id }
  if (input.status !== 'RECEIVED') return { duplicate: false, orderPaid: false, id: row.id }

  if (input.eventType === 'CHECKOUT.ORDER.APPROVED' || input.eventType === 'PAYMENT.CAPTURE.COMPLETED') {
    const orderId = await resolveOrderFromWebhook(input)
    if (!orderId) {
      await prisma.paymentWebhookEvent.update({ where: { id: row.id }, data: { status: 'FAILED', error: 'No matching order' } })
      return { duplicate: false, orderPaid: false, id: row.id }
    }

    try {
      const { credentials } = await credentialsFor({ paypalOrderId: input.resourceOrderId, paymentEnvironment: input.environment })
      // Never trust the webhook's own amounts: re-read the order from PayPal and capture it.
      const details =
        input.eventType === 'CHECKOUT.ORDER.APPROVED' && input.resourceOrderId
          ? await capturePaypalOrder(credentials, input.resourceOrderId)
          : await getPaypalOrder(credentials, input.resourceOrderId ?? '')
      const capture = details.captures.find((candidate) => candidate.id && candidate.amount)
      if (!capture?.id || !capture.amount) throw new OrderError('NOT_CAPTURED', 'No capture available yet', 409)

      const result = await markOrderPaid({
        orderId,
        environment: input.environment,
        paypalOrderId: details.id || input.resourceOrderId || '',
        captureId: capture.id,
        amountMinor: capture.amount.minor,
        currency: capture.amount.currency,
        raw: details.raw,
      })
      if (result.newlyMarkedPaid) {
        await queueTicketDelivery(orderId)
        await flushDeliveries()
      }
      await prisma.paymentWebhookEvent.update({ where: { id: row.id }, data: { status: 'PROCESSED', orderId, processedAt: new Date() } })
      return { duplicate: false, orderPaid: result.newlyMarkedPaid, id: row.id }
    } catch (error) {
      const message = (error as Error).message
      await prisma.paymentWebhookEvent.update({ where: { id: row.id }, data: { status: 'FAILED', error: message.slice(0, 400) } })
      await recordAudit({
        actorType: 'SYSTEM',
        action: 'WEBHOOK_FAILED',
        entityType: 'PaymentWebhookEvent',
        entityId: row.id,
        summary: `Webhook ${input.eventType} could not be applied: ${message.slice(0, 200)}`,
      })
      return { duplicate: false, orderPaid: false, error: message, id: row.id }
    }
  }

  if (input.eventType === 'PAYMENT.CAPTURE.DENIED' || input.eventType === 'PAYMENT.CAPTURE.REVERSED') {
    const orderId = await resolveOrderFromWebhook(input)
    if (orderId) {
      await prisma.order.update({ where: { id: orderId }, data: { status: 'PAYMENT_FAILED' } })
      await recordAudit({
        actorType: 'SYSTEM',
        action: 'WEBHOOK_PAYMENT_FAILED',
        entityType: 'Order',
        entityId: orderId,
        summary: `PayPal reported ${input.eventType}`,
      })
    }
    await prisma.paymentWebhookEvent.update({ where: { id: row.id }, data: { status: 'PROCESSED', orderId, processedAt: new Date() } })
  }

  if (input.eventType === 'PAYMENT.CAPTURE.REFUNDED') {
    const orderId = await resolveOrderFromWebhook(input)
    if (!orderId) {
      await prisma.paymentWebhookEvent.update({ where: { id: row.id }, data: { status: 'FAILED', error: 'No matching order' } })
      return { duplicate: false, orderPaid: false, id: row.id }
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } })
    if (!order) {
      await prisma.paymentWebhookEvent.update({ where: { id: row.id }, data: { status: 'FAILED', error: 'Order not found' } })
      return { duplicate: false, orderPaid: false, id: row.id }
    }

    // A refund issued from the admin page already writes its row and updates the
    // order, so PayPal's echo of that refund must be a no-op.
    const alreadyApplied = input.resourceId
      ? await prisma.refund.findFirst({ where: { paypalRefundId: input.resourceId }, select: { id: true } })
      : null
    if (!alreadyApplied) {
      const amount = input.amountMinor ?? 0
      if (amount <= 0) {
        await prisma.paymentWebhookEvent.update({
          where: { id: row.id },
          data: { status: 'FAILED', error: 'Refund event has no usable amount' },
        })
        return { duplicate: false, orderPaid: false, id: row.id }
      }

      const totalRefunded = Math.min(order.totalMinor, order.refundedMinor + amount)
      const fullyRefunded = totalRefunded >= order.totalMinor
      const captureId = input.captureId ?? order.paypalCaptureId

      await prisma.$transaction([
        prisma.refund.create({
          data: {
            orderId: order.id,
            captureId: captureId ?? 'unknown',
            paypalRefundId: input.resourceId,
            amountMinor: amount,
            currency: (input.currency ?? order.currency).toUpperCase(),
            environment: input.environment,
            status: 'REFUNDED',
            reason: 'Refund reported by PayPal webhook',
            raw: safeParse(input.rawBody),
          },
        }),
        prisma.order.update({
          where: { id: order.id },
          data: { refundedMinor: totalRefunded, status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
        }),
        prisma.payment.updateMany({
          where: { orderId: order.id },
          data: { status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
        }),
      ])

      await syncCustomerTotals(order.customerEmail)
      await recordAudit({
        actorType: 'SYSTEM',
        action: 'WEBHOOK_REFUND_APPLIED',
        entityType: 'Order',
        entityId: order.id,
        summary: `PayPal refund of ${amount} ${order.currency} applied to ${order.reference}`,
        metadata: { refundId: input.resourceId, fullyRefunded },
      })
    }

    await prisma.paymentWebhookEvent.update({ where: { id: row.id }, data: { status: 'PROCESSED', orderId, processedAt: new Date() } })
    return { duplicate: false, orderPaid: false, id: row.id }
  }

  return { duplicate: false, orderPaid: false, id: row.id }
}

async function resolveOrderFromWebhook(input: { resourceOrderId: string | null; captureId: string | null }): Promise<string | null> {
  if (input.resourceOrderId) {
    const byPaypalOrder = await prisma.order.findFirst({ where: { paypalOrderId: input.resourceOrderId }, select: { id: true } })
    if (byPaypalOrder) return byPaypalOrder.id
  }
  if (input.captureId) {
    const byCapture = await prisma.payment.findFirst({ where: { captureId: input.captureId }, select: { orderId: true } })
    if (byCapture) return byCapture.orderId
  }
  return null
}

function safeParse(raw: string): object {
  try {
    return JSON.parse(raw) as object
  } catch {
    return { unparseable: true }
  }
}
