import { prisma } from '@/lib/db/prisma'
import { getGeneral } from '@/lib/settings/service'
import { allocateReference, normaliseEmail, OrderError } from '@/lib/orders/service'
import { generatePublicId } from '@/lib/security/ids'
import { recordAudit } from '@/lib/auth/guards'
import { priceMuseumSelection, describeTickets, type PricedMuseumSelection } from './availability'
import { formatVisitDate } from './dates'

export type MuseumCheckoutInput = {
  date: string
  adults: number
  children: number
  fullName: string
  email: string
  phone?: string | null
}

/**
 * Creates a PENDING museum order after re-pricing and re-checking availability
 * from the database. The browser never supplies a price or a total.
 */
export async function startMuseumCheckout(
  input: MuseumCheckoutInput,
  context: { ip?: string; userAgent?: string },
): Promise<{ orderId: string; publicId: string; reference: string; priced: PricedMuseumSelection }> {
  const priced = await priceMuseumSelection({ date: input.date, adults: input.adults, children: input.children })
  if (priced.totalCents <= 0) {
    throw new OrderError('ZERO_TOTAL', 'This selection has no payable amount.', 422)
  }

  const email = normaliseEmail(input.email)
  const fullName = input.fullName.trim()
  const customer = await prisma.customer.upsert({
    where: { emailNormalized: email },
    create: {
      emailNormalized: email,
      emailOriginal: input.email.trim(),
      fullName,
      phone: input.phone?.trim() || null,
    },
    update: { fullName, phone: input.phone?.trim() || null },
  })

  const general = await getGeneral()
  const reference = await allocateReference(general.receiptPrefix || 'BVP')
  const publicId = generatePublicId()

  const order = await prisma.order.create({
    data: {
      publicId,
      reference,
      kind: 'MUSEUM',
      customerId: customer.id,
      customerEmail: email,
      customerName: fullName,
      customerPhone: input.phone?.trim() || null,
      currency: priced.currency,
      subtotalMinor: priced.subtotalCents,
      taxMinor: 0,
      totalMinor: priced.totalCents,
      status: 'PENDING',
      deliveryStatus: 'PENDING',
      visitDate: priced.visitDate,
      adultQty: priced.adultQty,
      childQty: priced.childQty,
      sessionSummary: `${formatVisitDate(priced.dateKey, 'en')} · ${describeTickets(priced.adultQty, priced.childQty)}`,
      clientIp: context.ip ?? null,
      userAgent: context.userAgent?.slice(0, 300) ?? null,
    },
  })

  await recordAudit({
    actorType: 'GUEST',
    actorLabel: email,
    action: 'MUSEUM_CHECKOUT_STARTED',
    entityType: 'Order',
    entityId: order.id,
    summary: `Museum booking ${reference}: ${describeTickets(priced.adultQty, priced.childQty)} on ${priced.dateKey}`,
    metadata: {
      totalMinor: priced.totalCents,
      currency: priced.currency,
      adultQty: priced.adultQty,
      childQty: priced.childQty,
      visitDate: priced.dateKey,
    },
    ip: context.ip,
  })

  return { orderId: order.id, publicId: order.publicId, reference: order.reference, priced }
}

/** Human description used for the PayPal purchase unit. */
export function museumPaymentDescription(order: {
  visitDate: Date | null
  adultQty: number
  childQty: number
}): string {
  const date = order.visitDate ? formatVisitDate(order.visitDate, 'en') : 'Museum visit'
  return `Badi Palace Museum — ${describeTickets(order.adultQty, order.childQty)} — ${date}`.slice(0, 127)
}
