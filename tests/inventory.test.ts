import { describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db/prisma'
import {
  claimForReservation,
  commitReservation,
  releaseReservation,
  availableTicketCount,
} from '@/lib/inventory/claim'
import { expireStaleReservations } from '@/lib/inventory/maintenance'
import { InsufficientInventoryError } from '@/lib/inventory/errors'

async function makeProduct(tickets: number, options: { perFile?: number; withSession?: boolean } = {}) {
  const product = await prisma.product.create({
    data: {
      slug: `p-${Math.random().toString(36).slice(2)}`,
      name: 'Test ticket',
      shortDescription: 's',
      description: 'd',
      priceMinor: 2500,
      status: 'PUBLISHED',
    },
  })
  const session = options.withSession === false
    ? null
    : await prisma.eventSession.create({
        data: { productId: product.id, date: new Date(Date.now() + 86_400_000), startTime: '18:00' },
      })
  await prisma.ticketInventory.createMany({
    data: Array.from({ length: tickets }, (_, i) => ({
      productId: product.id,
      eventSessionId: session?.id ?? null,
      storageKey: `k/${i}.pdf`,
      originalFileName: `ticket-${i}.pdf`,
      fileSize: 1000,
      checksum: `${i}-${Math.random()}`,
      ticketCount: options.perFile ?? 1,
      status: 'AVAILABLE' as const,
    })),
  })
  return { product, session }
}

async function newReservation(productId: string, quantity: number) {
  return prisma.reservation.create({
    data: {
      code: `r-${Math.random().toString(36).slice(2)}`,
      orderId: null,
      ticketCount: quantity,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60_000),
    },
  })
}

async function claim(productId: string, sessionId: string | null, quantity: number) {
  const reservation = await newReservation(productId, quantity)
  return claimForReservation({
    productId,
    eventSessionId: sessionId,
    reservationId: reservation.id,
    quantity,
    reservedUntil: new Date(Date.now() + 60_000),
  })
}

describe('ticket allocation', () => {
  it('gives the final ticket to exactly one of several simultaneous buyers', async () => {
    const { product, session } = await makeProduct(1)
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => claim(product.id, session!.id, 1)),
    )
    const won = attempts.filter((a) => a.status === 'fulfilled')
    const soldRows = await prisma.ticketInventory.count({ where: { productId: product.id, status: 'RESERVED' } })

    expect(won).toHaveLength(1)
    expect(soldRows).toBe(1)
    expect(attempts.filter((a) => a.status === 'rejected')).toHaveLength(7)
  })

  it('never oversells a pool when many buyers race for more than is available', async () => {
    const { product, session } = await makeProduct(10)
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () => claim(product.id, session!.id, 3)),
    )
    const succeeded = attempts.filter((a) => a.status === 'fulfilled').length
    const held = await prisma.ticketInventory.count({
      where: { productId: product.id, status: { in: ['RESERVED', 'SOLD'] } },
    })

    expect(succeeded * 3).toBeLessThanOrEqual(10)
    expect(held).toBeLessThanOrEqual(10)
    expect(held).toBe(succeeded * 3)
  })

  it('reports insufficient inventory instead of partially selling', async () => {
    const { product, session } = await makeProduct(2)
    await expect(claim(product.id, session!.id, 5)).rejects.toBeInstanceOf(InsufficientInventoryError)
    // Nothing is left dangling in RESERVED after a failed claim.
    expect(await prisma.ticketInventory.count({ where: { productId: product.id, status: 'RESERVED' } })).toBe(0)
    expect(await availableTicketCount(product.id, session!.id)).toBe(2)
  })

  it('releases a reservation back to the pool', async () => {
    const { product, session } = await makeProduct(4)
    const reservation = await newReservation(product.id, 2)
    await claimForReservation({
      productId: product.id,
      eventSessionId: session!.id,
      reservationId: reservation.id,
      quantity: 2,
      reservedUntil: new Date(Date.now() + 60_000),
    })
    expect(await availableTicketCount(product.id, session!.id)).toBe(2)

    const released = await releaseReservation(reservation.id)
    expect(released).toBe(2)
    expect(await availableTicketCount(product.id, session!.id)).toBe(4)
  })

  it('keeps sessions isolated so a ticket for one session cannot serve another', async () => {
    const product = await prisma.product.create({
      data: { slug: `x-${Math.random().toString(36).slice(2)}`, name: 'x', shortDescription: 's', description: 'd', priceMinor: 100, status: 'PUBLISHED' },
    })
    const [a, b] = await Promise.all([
      prisma.eventSession.create({ data: { productId: product.id, date: new Date(Date.now() + 86_400_000), startTime: '10:00' } }),
      prisma.eventSession.create({ data: { productId: product.id, date: new Date(Date.now() + 86_400_000), startTime: '14:00' } }),
    ])
    await prisma.ticketInventory.create({
      data: { productId: product.id, eventSessionId: a.id, storageKey: 'only-a', originalFileName: 'a.pdf', fileSize: 10, checksum: 'a' },
    })

    await expect(claim(product.id, b.id, 1)).rejects.toBeInstanceOf(InsufficientInventoryError)
    expect(await prisma.ticketInventory.findFirst({ where: { eventSessionId: b.id, status: { not: 'AVAILABLE' } } })).toBeNull()
  })

  it('converts a reservation exactly once, so a replayed capture cannot re-sell tickets', async () => {
    const { product, session } = await makeProduct(3)
    const reservation = await newReservation(product.id, 2)
    await claimForReservation({
      productId: product.id,
      eventSessionId: session!.id,
      reservationId: reservation.id,
      quantity: 2,
      reservedUntil: new Date(Date.now() + 60_000),
    })
    const order = await prisma.order.create({ data: { publicId: 'o1', reference: 'R1', customerEmail: 'a@b.c', customerName: 'A', totalMinor: 5000 } })

    expect(await commitReservation(reservation.id, order.id)).toBe(2)
    // Second webhook for the same capture converts nothing.
    expect(await commitReservation(reservation.id, order.id)).toBe(0)
    expect(await prisma.ticketInventory.count({ where: { orderId: order.id, status: 'SOLD' } })).toBe(2)
  })

  it('covers a Model B group file without stranding the rest of the pool', async () => {
    const { product, session } = await makeProduct(3, { perFile: 5 })
    const result = await claim(product.id, session!.id, 4)

    expect(result.claimedInventoryIds).toHaveLength(1)
    expect(result.claimedTickets).toBe(5)
    // The two group files nobody needed are still sellable.
    expect(await availableTicketCount(product.id, session!.id)).toBe(10)
  })

  it('drops only expired holds and leaves paid orders untouched', async () => {
    const { product, session } = await makeProduct(5)
    const stale = await newReservation(product.id, 2)
    await claimForReservation({
      productId: product.id,
      eventSessionId: session!.id,
      reservationId: stale.id,
      quantity: 2,
      reservedUntil: new Date(Date.now() - 1000),
    })
    await prisma.reservation.update({ where: { id: stale.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    const paidOrder = await prisma.order.create({
      data: { publicId: 'paid1', reference: 'RP1', customerEmail: 'p@p.p', customerName: 'P', status: 'PAID', totalMinor: 100, reservationId: stale.id },
    })
    await prisma.reservation.update({ where: { id: stale.id }, data: { orderId: paidOrder.id } })

    const report = await expireStaleReservations()

    expect(report.reservationsExpired).toBe(1)
    expect(report.ticketsReleased).toBe(2)
    expect(report.ordersCancelled).toBe(0)
    expect(await prisma.order.findUnique({ where: { id: paidOrder.id } })).toHaveProperty('status', 'PAID')
  })
})
