import { prisma } from '@/lib/db/prisma'
import { ProductUnavailableError } from '@/lib/inventory/errors'
import { availableTicketCount } from '@/lib/inventory/claim'
import { computeTotals } from '@/lib/money'
import { getGeneral } from '@/lib/settings/service'
import type { EventSession, InventoryModel, Product } from '@prisma/client'

export type PurchasableProduct = Product & { sessions: EventSession[] }

export type SelectionInput = {
  slug: string
  eventSessionId?: string | null
  quantity: number
}

export type PricedSelection = {
  product: Product
  session: EventSession | null
  quantity: number
  unitPriceMinor: number
  currency: string
  inventoryModel: InventoryModel
  subtotalMinor: number
  taxMinor: number
  totalMinor: number
  available: number
}

/**
 * Everything about a purchasable line — price, quantity bounds, which session is
 * valid, whether stock exists — is derived from the database here. The browser
 * never supplies any of it, so a tampered payload cannot change a total.
 */
export async function priceSelection(input: SelectionInput): Promise<PricedSelection> {
  const product = await prisma.product.findUnique({
    where: { slug: input.slug },
    include: { sessions: { where: { isActive: true }, orderBy: { date: 'asc' } } },
  })
  if (!product || product.status !== 'PUBLISHED') {
    throw new ProductUnavailableError('This ticket is not currently on sale.')
  }

  const now = new Date()
  if (product.salesStartAt && product.salesStartAt > now) {
    throw new ProductUnavailableError('Sales for this ticket have not opened yet.')
  }
  if (product.salesEndAt && product.salesEndAt < now) {
    throw new ProductUnavailableError('Sales for this ticket have closed.')
  }

  const settings = await getGeneral()
  const maxQuantity = Math.min(product.maxTickets, settings.maxTicketsPerOrder)
  if (!Number.isInteger(input.quantity) || input.quantity < product.minTickets) {
    throw new ProductUnavailableError(`Minimum ${product.minTickets} ticket(s) per order.`)
  }
  if (input.quantity > maxQuantity) {
    throw new ProductUnavailableError(`Maximum ${maxQuantity} ticket(s) per order.`)
  }

  let session: EventSession | null = null
  if (product.requiresSession) {
    if (!input.eventSessionId) throw new ProductUnavailableError('Select a valid date and time.')
    session = product.sessions.find((candidate) => candidate.id === input.eventSessionId) ?? null
    if (!session) throw new ProductUnavailableError('The selected date and time is not offered for this ticket.')
    // Past sessions are not sellable; compare on the session's own date boundary.
    if (session.date.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
      throw new ProductUnavailableError('The selected date has already passed.')
    }
  }

  const totals = computeTotals({
    unitPriceMinor: product.priceMinor,
    quantity: input.quantity,
    taxRateBps: product.taxRateBps,
    taxIncluded: product.taxIncluded,
  })

  // Counted in tickets, not files: a Model B group file carries several tickets.
  const available = await availableTicketCount(product.id, product.requiresSession ? session!.id : null)

  return {
    product,
    session,
    quantity: input.quantity,
    unitPriceMinor: product.priceMinor,
    currency: product.currency,
    inventoryModel: product.inventoryModel,
    ...totals,
    available,
  }
}

export function formatSessionDate(session: EventSession, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  }).format(session.date)
}

/** YYYY-MM-DD in the store timezone, for native date inputs. */
export function formatSessionDateKey(session: EventSession, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(session.date)
}

export function formatSessionTime(session: EventSession): string {
  return `${session.startTime}${session.endTime ? `–${session.endTime}` : ''}`
}

export function formatSessionLabel(session: EventSession | null, timezone: string): string {
  if (!session) return 'Any available date'
  return `${formatSessionDate(session, timezone)} · ${formatSessionTime(session)}${session.label ? ` · ${session.label}` : ''}`
}
