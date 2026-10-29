import { prisma } from '@/lib/db/prisma'
import { recordAudit } from '@/lib/auth/guards'
import type { AdminSessionUser } from '@/lib/auth/session'
import { dateKeyFromDate, formatVisitDate, todayKey } from './dates'
import { getMuseumSettings } from './settings'
import { MUSEUM_ADMISSION_STATUSES } from './reports'

export class CheckInError extends Error {
  status: number
  code: string
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'CheckInError'
    this.code = code
    this.status = status
  }
}

export type CheckInResult = {
  alreadyCheckedIn: boolean
  order: {
    id: string
    publicId: string
    reference: string
    customerName: string
    customerEmail: string
    visitDate: string | null
    visitDateLabel: string
    adultQty: number
    childQty: number
    tickets: number
    status: string
    checkedInAt: string | null
    checkedInBy: string | null
    totalMinor: number
    currency: string
  }
}

/**
 * The QR payload is the order's `publicId`; staff can also type the human
 * reference. A scan is idempotent: scanning the same code twice reports the
 * original check-in instead of overwriting it.
 */
export async function checkInOrder(
  input: { code: string; allowAnyDate?: boolean; note?: string | null },
  admin: AdminSessionUser,
): Promise<CheckInResult> {
  const code = input.code.trim()
  if (!code) throw new CheckInError('CODE_REQUIRED', 'Scan a QR code or enter a booking reference.', 422)

  const settings = await getMuseumSettings()
  const today = todayKey(settings.timezone)

  const order = await prisma.order.findFirst({
    where: {
      kind: 'MUSEUM',
      OR: [{ publicId: code }, { reference: code.toUpperCase() }],
    },
  })
  if (!order) {
    throw new CheckInError('ORDER_NOT_FOUND', 'No museum booking matches that code.', 404)
  }
  if (!MUSEUM_ADMISSION_STATUSES.includes(order.status as (typeof MUSEUM_ADMISSION_STATUSES)[number])) {
    throw new CheckInError(
      'NOT_ADMISSIBLE',
      `Booking ${order.reference} is ${order.status.toLowerCase().replace(/_/g, ' ')}. Only paid, non-refunded bookings can be checked in.`,
      409,
    )
  }

  const visitDate = order.visitDate ? dateKeyFromDate(order.visitDate) : null
  if (visitDate && visitDate !== today && !input.allowAnyDate) {
    throw new CheckInError(
      'WRONG_DATE',
      `This booking is for ${formatVisitDate(order.visitDate, 'en')}, not today. Enable “accept any visit date” if you really need to check it in.`,
      409,
    )
  }

  const previous = order.checkedInAt
  if (!previous) {
    // Conditional update makes two simultaneous scans safe: only one wins.
    const updated = await prisma.order.updateMany({
      where: { id: order.id, checkedInAt: null },
      data: {
        checkedInAt: new Date(),
        checkedInBy: admin.email,
        internalNotes: input.note?.trim()
          ? `${order.internalNotes ? `${order.internalNotes}\n` : ''}[${new Date().toISOString()}] ${admin.email}: ${input.note.trim()}`
          : order.internalNotes,
      },
    })

    if (updated.count > 0) {
      await recordAudit({
        actorType: 'ADMIN',
        actorId: admin.id,
        actorLabel: admin.email,
        action: 'MUSEUM_CHECK_IN',
        entityType: 'Order',
        entityId: order.id,
        summary: `Checked in ${order.reference} (${order.adultQty + order.childQty} ticket(s))`,
        metadata: { visitDate, adults: order.adultQty, children: order.childQty },
      })
    }
  }

  const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })

  return {
    alreadyCheckedIn: Boolean(previous),
    order: {
      id: fresh.id,
      publicId: fresh.publicId,
      reference: fresh.reference,
      customerName: fresh.customerName,
      customerEmail: fresh.customerEmail,
      visitDate,
      visitDateLabel: formatVisitDate(fresh.visitDate, 'en'),
      adultQty: fresh.adultQty,
      childQty: fresh.childQty,
      tickets: fresh.adultQty + fresh.childQty,
      status: fresh.status,
      checkedInAt: fresh.checkedInAt?.toISOString() ?? null,
      checkedInBy: fresh.checkedInBy,
      totalMinor: fresh.totalMinor,
      currency: fresh.currency,
    },
  }
}
