import { prisma } from '@/lib/db/prisma'
import { priceSelection, formatSessionLabel } from '@/lib/products/availability'
import { claimForReservation, commitReservation, reclaimForPaidOrder } from '@/lib/inventory/claim'
import { generateOrderReference, generatePublicId, generateReservationCode } from '@/lib/security/ids'
import { getGeneral } from '@/lib/settings/service'
import { bumpReceiptCounter } from '@/lib/settings/service'
import { recordAudit } from '@/lib/auth/guards'
import { minorUnitsFor } from '@/lib/money'
import type { OrderStatus, PaymentEnvironment } from '@prisma/client'

export class OrderError extends Error {
  status: number
  code: string
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'OrderError'
    this.code = code
    this.status = status
  }
}

/** Statuses that may still legally transition to PAID. */
const PAYABLE: OrderStatus[] = ['PENDING', 'AWAITING_PAYMENT', 'PROCESSING', 'DELIVERY_FAILED']

export type CheckoutInput = {
  slug: string
  eventSessionId?: string | null
  quantity: number
  fullName: string
  email: string
  phone?: string | null
}

export function normaliseEmail(email: string): string {
  const [local, domain] = email.trim().toLowerCase().split('@')
  if (!domain) return email.trim().toLowerCase()
  // Gmail ignores dots and +suffixes in the local part; normalising keeps one
  // repeat guest customer from splitting into several records.
  if (domain === 'gmail.com' || domain.endsWith('.gmail.com')) {
    return `${local.replace(/\./g, '').split('+')[0]}@${domain}`
  }
  return `${local.split('+')[0]}@${domain}`
}

/**
 * Creates the order, the reservation and the ticket hold. Nothing here trusts the
 * browser for price, currency, quantity bounds or session validity.
 */
export async function startCheckout(input: CheckoutInput, context: { ip?: string; userAgent?: string }) {
  const [priced, settings] = await Promise.all([priceSelection(input), getGeneral()])
  if (priced.available < priced.quantity) {
    throw new OrderError('INSUFFICIENT_INVENTORY', `Only ${priced.available} ticket(s) remain for this selection.`, 409)
  }

  const email = normaliseEmail(input.email)
  // The customer row is resolved first so the order carries the relation from the start;
  // without customerId every customer-centric query would have to fall back to email text.
  const customer = await upsertCustomer({
    email,
    fullName: input.fullName.trim(),
    phone: input.phone ?? null,
    originalEmail: input.email.trim(),
  })
  const reference = await allocateReference(settings.receiptPrefix)
  const publicId = generatePublicId()

  const order = await prisma.order.create({
    data: {
      publicId,
      reference,
      customerId: customer.id,
      customerEmail: email,
      customerName: input.fullName.trim(),
      customerPhone: input.phone?.trim() || null,
      currency: priced.currency,
      subtotalMinor: priced.subtotalMinor,
      taxMinor: priced.taxMinor,
      totalMinor: priced.totalMinor,
      status: 'PENDING',
      deliveryStatus: 'PENDING',
      sessionSummary: formatSessionLabel(priced.session, settings.timezone),
      clientIp: context.ip ?? null,
      userAgent: context.userAgent?.slice(0, 300) ?? null,
      lines: {
        create: {
          productId: priced.product.id,
          eventSessionId: priced.session?.id ?? null,
          productName: priced.product.name,
          priceMinor: priced.unitPriceMinor,
          quantity: priced.quantity,
          lineTotalMinor: priced.unitPriceMinor * priced.quantity,
          currency: priced.currency,
        },
      },
    },
  })

  const expiresAt = new Date(Date.now() + settings.reservationMinutes * 60_000)
  const reservation = await prisma.reservation.create({
    data: { code: generateReservationCode(), orderId: order.id, ticketCount: priced.quantity, status: 'ACTIVE', expiresAt },
  })

  try {
    await claimForReservation({
      productId: priced.product.id,
      eventSessionId: priced.session?.id ?? null,
      reservationId: reservation.id,
      quantity: priced.quantity,
      reservedUntil: expiresAt,
    })
  } catch (error) {
    await prisma.order.delete({ where: { id: order.id } })
    await prisma.reservation.delete({ where: { id: reservation.id } })
    throw error
  }

  await prisma.order.update({
    where: { id: order.id },
    data: { reservationId: reservation.id, reservationExpiresAt: expiresAt },
  })

  await recordAudit({
    actorType: 'GUEST',
    actorLabel: email,
    action: 'CHECKOUT_STARTED',
    entityType: 'Order',
    entityId: order.id,
    summary: `Reservation created for ${priced.quantity} x ${priced.product.name} (${reference})`,
    metadata: { totalMinor: priced.totalMinor, currency: priced.currency, reservationId: reservation.id },
    ip: context.ip,
  })

  return {
    order: await prisma.order.findUnique({ where: { id: order.id } }),
    reservationCode: reservation.code,
    reservationExpiresAt: expiresAt,
    totalMinor: priced.totalMinor,
    currency: priced.currency,
    productName: priced.product.name,
  }
}

export async function allocateReference(prefix: string): Promise<string> {
  // Retried on the unique index so a random collision can never surface as a 500.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const counter = await bumpReceiptCounter()
    const candidate = `${generateOrderReference(prefix)}-${String(counter).padStart(3, '0')}`
    const clash = await prisma.order.findUnique({ where: { reference: candidate }, select: { id: true } })
    if (!clash) return candidate
  }
  throw new OrderError('REFERENCE_EXHAUSTED', 'Could not allocate an order reference. Please retry.', 500)
}

async function upsertCustomer(input: { email: string; fullName: string; phone: string | null; originalEmail: string }) {
  return prisma.customer.upsert({
    where: { emailNormalized: input.email },
    create: {
      emailNormalized: input.email,
      emailOriginal: input.originalEmail,
      fullName: input.fullName,
      phone: input.phone,
    },
    update: {
      fullName: input.fullName,
      phone: input.phone ?? undefined,
    },
  })
}

export type PaidResult = {
  order: Awaited<ReturnType<typeof loadOrder>>
  newlyMarkedPaid: boolean
  ticketsCommitted: number
  needsManualResolution: boolean
}

/**
 * Single entry point for "this order is paid", called by both the capture
 * response and the webhook. Idempotent: the status guard is a conditional update,
 * so the second call commits zero tickets instead of duplicating delivery.
 */
export async function markOrderPaid(input: {
  orderId: string
  environment: PaymentEnvironment
  paypalOrderId: string
  captureId: string
  amountMinor: number
  currency: string
  raw?: unknown
}): Promise<PaidResult> {
  const order = await prisma.order.findUnique({ where: { id: input.orderId }, include: { lines: true } })
  if (!order) throw new OrderError('ORDER_NOT_FOUND', 'Order not found', 404)

  if (input.currency.toUpperCase() !== order.currency.toUpperCase()) {
    await recordAudit({
      actorType: 'SYSTEM',
      action: 'PAYMENT_CURRENCY_MISMATCH',
      entityType: 'Order',
      entityId: order.id,
      summary: `Captured ${input.currency} for an order priced in ${order.currency}`,
      metadata: { captured: input.currency, expected: order.currency },
    })
    throw new OrderError('CURRENCY_MISMATCH', 'Payment currency does not match the order.', 409)
  }
  if (input.amountMinor !== order.totalMinor) {
    await recordAudit({
      actorType: 'SYSTEM',
      action: 'PAYMENT_AMOUNT_MISMATCH',
      entityType: 'Order',
      entityId: order.id,
      summary: `Captured ${input.amountMinor} but the order total is ${order.totalMinor}`,
      metadata: { captured: input.amountMinor, expected: order.totalMinor },
    })
    throw new OrderError('AMOUNT_MISMATCH', 'Payment amount does not match the order total.', 409)
  }

  // Atomic guard: only one concurrent caller wins the flip into PAID.
  const flip = await prisma.order.updateMany({
    where: { id: order.id, status: { in: PAYABLE } },
    data: {
      status: 'PAID',
      paidAt: order.paidAt ?? new Date(),
      paymentEnvironment: input.environment,
      paypalOrderId: input.paypalOrderId,
      paypalCaptureId: input.captureId,
    },
  })
  const newlyMarkedPaid = flip.count === 1

  // captureId is unique, so a replayed capture resolves to the same payment row instead
  // of creating a second one under a race between two concurrent callers.
  await prisma.payment.upsert({
    where: { captureId: input.captureId },
    create: {
      orderId: order.id,
      environment: input.environment,
      status: 'CAPTURED',
      paypalOrderId: input.paypalOrderId,
      captureId: input.captureId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      raw: (input.raw ?? undefined) as object | undefined,
    },
    update: {},
  })

  let ticketsCommitted = 0
  let needsManualResolution = false

  if (newlyMarkedPaid) {
    if (order.kind === 'MUSEUM') {
      // Museum capacity is counted from paid orders, so there is no PDF allocation.
      ticketsCommitted = 0
      needsManualResolution = false
    } else if (order.reservationId) {
      ticketsCommitted = await commitReservation(order.reservationId, order.id)
      if (ticketsCommitted === 0) {
        // Hold lapsed or was released while the payment was still in flight.
        const line = order.lines[0]
        const reclaimed = line
          ? await reclaimForPaidOrder({
              productId: line.productId,
              eventSessionId: line.eventSessionId,
              quantity: line.quantity,
              orderId: order.id,
            })
          : null
        ticketsCommitted = reclaimed?.claimedInventoryIds.length ?? 0
        needsManualResolution = ticketsCommitted === 0
        if (needsManualResolution) {
          await prisma.order.update({
            where: { id: order.id },
            data: { status: 'DELIVERY_FAILED', deliveryStatus: 'FAILED' },
          })
        }
      }
    } else {
      needsManualResolution = true
    }

    await syncCustomerTotals(order.customerEmail)
    await recordAudit({
      actorType: 'SYSTEM',
      action: 'ORDER_PAID',
      entityType: 'Order',
      entityId: order.id,
      summary: `Order ${order.reference} paid via PayPal (${input.environment})`,
      metadata: { captureId: input.captureId, amountMinor: input.amountMinor, ticketsCommitted, needsManualResolution },
    })
  }

  return { order: await loadOrder(order.id), newlyMarkedPaid, ticketsCommitted, needsManualResolution }
}

/** Recomputes lifetime customer spend from real orders, not incremental guesses. */
export async function syncCustomerTotals(emailNormalized: string): Promise<void> {
  const orders = await prisma.order.findMany({
    where: { customerEmail: emailNormalized, status: { in: ['PAID', 'PROCESSING', 'COMPLETED', 'DELIVERY_FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
    select: { totalMinor: true, refundedMinor: true, paidAt: true, createdAt: true },
  })
  const customer = await prisma.customer.findUnique({ where: { emailNormalized } })
  if (!customer) return

  const paid = orders.filter((o) => o.paidAt)
  await prisma.customer.update({
    where: { id: customer.id },
    data: {
      totalOrders: paid.length,
      totalSpentMinor: paid.reduce((sum, o) => sum + o.totalMinor, 0),
      totalRefundedMinor: orders.reduce((sum, o) => sum + o.refundedMinor, 0),
      firstPurchaseAt: paid.reduce<Date | null>((earliest, o) => (o.paidAt && (!earliest || o.paidAt < earliest) ? o.paidAt : earliest), null),
      lastPurchaseAt: paid.reduce<Date | null>((latest, o) => (o.paidAt && (!latest || o.paidAt > latest) ? o.paidAt : latest), null),
    },
  })
}

export async function loadOrder(id: string) {
  return prisma.order.findUniqueOrThrow({
    where: { id },
    include: {
      lines: true,
      payments: { orderBy: { createdAt: 'desc' } },
      refunds: { orderBy: { createdAt: 'desc' } },
      tickets: { select: { id: true, status: true, storageKey: true, originalFileName: true, ticketCount: true, eventSessionId: true } },
      emails: { orderBy: { createdAt: 'desc' } },
    },
  })
}

export function minorFrompaypalAmount(amount: { currency_code?: string; value?: string } | undefined): number | null {
  if (!amount?.value) return null
  const exponent = minorUnitsFor(amount.currency_code ?? 'USD')
  const numeric = Number.parseFloat(amount.value)
  if (Number.isNaN(numeric)) return null
  return Math.round(numeric * 10 ** exponent)
}
