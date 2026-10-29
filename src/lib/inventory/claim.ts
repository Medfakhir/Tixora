import { prisma } from '@/lib/db/prisma'
import { InsufficientInventoryError } from './errors'
import type { Prisma } from '@prisma/client'

const CLAIM_ATTEMPTS = 6

type WhereBase = { productId: string; status: 'AVAILABLE' }

function candidateWhere(productId: string, eventSessionId: string | null | undefined): Prisma.TicketInventoryWhereInput {
  const base: WhereBase = { productId, status: 'AVAILABLE' }
  return eventSessionId ? { ...base, eventSessionId } : { ...base, eventSessionId: null }
}

/**
 * Atomically flips up to `limit` AVAILABLE rows to RESERVED for this reservation.
 *
 * The `status: AVAILABLE` predicate inside the update is what makes this safe:
 * InnoDB re-evaluates it against the latest committed row under a write lock, so
 * when two requests race for the last ticket exactly one update matches. The loser
 * sees `count: 0` and re-queries. No explicit transaction is needed, so allocation
 * cannot be broken by a connection being returned to the pool mid-flow.
 */
async function claimBatch(
  productId: string,
  eventSessionId: string | null | undefined,
  reservationId: string,
  limit: number,
  reservedUntil: Date,
): Promise<number> {
  const candidates = await prisma.ticketInventory.findMany({
    where: candidateWhere(productId, eventSessionId),
    take: limit,
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (candidates.length === 0) return 0

  const flipped = await prisma.ticketInventory.updateMany({
    where: { id: { in: candidates.map((c) => c.id) }, status: 'AVAILABLE' },
    data: { status: 'RESERVED', reservationId, reservedUntil },
  })
  return flipped.count
}

export type ClaimResult = { claimedInventoryIds: string[]; claimedTickets: number }

/** Available tickets (not files) for a product/session pool. */
export async function availableTicketCount(productId: string, eventSessionId?: string | null): Promise<number> {
  const rows = await prisma.ticketInventory.findMany({
    where: candidateWhere(productId, eventSessionId),
    select: { ticketCount: true },
    take: 5000,
  })
  return rows.reduce((sum, row) => sum + row.ticketCount, 0)
}

/** Hands lapsed holds back to the pool for this product/session before a new claim. */
async function releaseLapsedHolds(productId: string, eventSessionId: string | null | undefined): Promise<void> {
  const where: Prisma.TicketInventoryWhereInput = {
    productId,
    ...(eventSessionId ? { eventSessionId } : { eventSessionId: null }),
    status: 'RESERVED',
    reservedUntil: { lt: new Date() },
  }
  await prisma.ticketInventory.updateMany({
    where,
    data: { status: 'AVAILABLE', reservationId: null, reservedUntil: null },
  })
}

/**
 * Model A (ONE_PDF_PER_TICKET): each file is one ticket, so N tickets need N files.
 * Model B (ONE_PDF_PER_GROUP): a file carries `ticketCount` tickets and files are
 * summed until the quantity is covered.
 */
export async function claimForReservation(input: {
  productId: string
  eventSessionId?: string | null
  reservationId: string
  quantity: number
  reservedUntil: Date
}): Promise<ClaimResult> {
  const { productId, eventSessionId = null, reservationId, quantity, reservedUntil } = input
  // The maintenance job runs on a schedule; this keeps a sale from failing on holds
  // that have already lapsed but are not collected yet.
  await releaseLapsedHolds(productId, eventSessionId)
  let owned = await prisma.ticketInventory.findMany({
    where: { reservationId, status: 'RESERVED' },
    select: { id: true, ticketCount: true },
  })
  let tickets = owned.reduce((sum, row) => sum + row.ticketCount, 0)

  for (let attempt = 0; tickets < quantity && attempt < CLAIM_ATTEMPTS; attempt += 1) {
    // A file may carry several tickets, so `quantity` rows is always enough to cover
    // the order; a couple of extra rows absorb losses in the race below.
    await claimBatch(productId, eventSessionId, reservationId, quantity + 2, reservedUntil)
    owned = await prisma.ticketInventory.findMany({
      where: { reservationId, status: 'RESERVED' },
      select: { id: true, ticketCount: true },
    })
    tickets = owned.reduce((sum, row) => sum + row.ticketCount, 0)
  }

  if (tickets < quantity) {
    // Counted before releasing, otherwise our own rows would be double-counted.
    const available = await availableTicketCount(productId, eventSessionId)
    await releaseReservation(reservationId)
    throw new InsufficientInventoryError(quantity, available)
  }

  // Racing batches can overshoot; hand the surplus back so it stays sellable. A row is
  // only dropped when what remains still covers the order, since group files carry N tickets.
  if (tickets > quantity) {
    for (let i = owned.length - 1; i >= 0 && tickets > quantity; i -= 1) {
      const row = owned[i]
      if (tickets - row.ticketCount < quantity) continue
      const freed = await prisma.ticketInventory.updateMany({
        where: { id: row.id, status: 'RESERVED', reservationId },
        data: { status: 'AVAILABLE', reservationId: null, reservedUntil: null },
      })
      if (freed.count === 1) {
        tickets -= row.ticketCount
        owned = owned.filter((candidate) => candidate.id !== row.id)
      }
    }
  }

  return { claimedInventoryIds: owned.map((row) => row.id), claimedTickets: tickets }
}

/** Returns every RESERVED row of a reservation to the AVAILABLE pool. */
export async function releaseReservation(reservationId: string): Promise<number> {
  const released = await prisma.ticketInventory.updateMany({
    where: { reservationId, status: 'RESERVED' },
    data: { status: 'AVAILABLE', reservationId: null, reservedUntil: null },
  })
  await prisma.reservation.updateMany({
    where: { id: reservationId, status: 'ACTIVE' },
    data: { status: 'RELEASED', releasedAt: new Date() },
  })
  return released.count
}

/**
 * Moves RESERVED to SOLD for a paid order. Restricted to `status: RESERVED` so a
 * repeated webhook or a second capture attempt converts nothing the second time;
 * callers check the returned count to detect a duplicate.
 */
export async function commitReservation(reservationId: string, orderId: string): Promise<number> {
  const sold = await prisma.ticketInventory.updateMany({
    where: { reservationId, status: 'RESERVED' },
    data: { status: 'SOLD', orderId, allocatedAt: new Date(), reservedUntil: null },
  })
  await prisma.reservation.updateMany({
    where: { id: reservationId, status: { in: ['ACTIVE', 'EXPIRED'] } },
    data: { status: 'CONVERTED', orderId: orderId },
  })
  return sold.count
}

/**
 * Payment succeeded but the hold lapsed. Re-claims fresh tickets; if the pool is
 * empty the caller must flag the order for manual resolution instead of overselling.
 */
export async function reclaimForPaidOrder(input: {
  productId: string
  eventSessionId?: string | null
  quantity: number
  orderId: string
}): Promise<ClaimResult | null> {
  const temporary = await prisma.reservation.create({
    data: {
      code: `paid-${input.orderId}-${Date.now().toString(36)}`,
      orderId: input.orderId,
      ticketCount: input.quantity,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  })
  try {
    const claim = await claimForReservation({
      productId: input.productId,
      eventSessionId: input.eventSessionId,
      reservationId: temporary.id,
      quantity: input.quantity,
      reservedUntil: new Date(Date.now() + 60 * 60 * 1000),
    })
    await commitReservation(temporary.id, input.orderId)
    return claim
  } catch {
    await prisma.reservation.update({ where: { id: temporary.id }, data: { status: 'RELEASED', releasedAt: new Date() } })
    return null
  }
}

export async function markDelivered(inventoryIds: string[]): Promise<number> {
  if (inventoryIds.length === 0) return 0
  const marked = await prisma.ticketInventory.updateMany({
    where: { id: { in: inventoryIds }, status: { in: ['SOLD', 'DELIVERED'] } },
    data: { status: 'DELIVERED', deliveredAt: new Date(), lastError: null },
  })
  return marked.count
}

export async function markDeliveryFailed(inventoryIds: string[], error: string): Promise<void> {
  if (inventoryIds.length === 0) return
  // Tickets stay owned by the order: a failed email must never re-sell them.
  await prisma.ticketInventory.updateMany({
    where: { id: { in: inventoryIds }, status: { notIn: ['AVAILABLE', 'RESERVED'] } },
    data: { status: 'FAILED_DELIVERY', lastError: error.slice(0, 500) },
  })
}

/** Recovery helper: FAILED_DELIVERY rows go back to SOLD so delivery can be retried. */
export async function stageForDeliveryRetry(inventoryIds: string[]): Promise<void> {
  if (inventoryIds.length === 0) return
  await prisma.ticketInventory.updateMany({
    where: { id: { in: inventoryIds }, status: 'FAILED_DELIVERY' },
    data: { status: 'SOLD', lastError: null },
  })
}

export async function countAvailable(productId: string, eventSessionId?: string | null): Promise<number> {
  return availableTicketCount(productId, eventSessionId)
}
