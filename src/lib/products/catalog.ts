import { cache } from 'react'
import { prisma } from '@/lib/db/prisma'
import { availableTicketCount } from '@/lib/inventory/claim'
import type { Category, EventSession, Prisma } from '@prisma/client'

/** A session stays sellable for 24h after its date, mirroring the checkout rules. */
const SESSION_GRACE_MS = 24 * 60 * 60 * 1000

function sellableSince(now = new Date()): Date {
  return new Date(now.getTime() - SESSION_GRACE_MS)
}

function catalogInclude(since: Date, images: { take?: number } = {}) {
  return {
    category: true,
    images: {
      orderBy: { sortOrder: 'asc' },
      ...(images.take ? { take: images.take } : {}),
    },
    sessions: {
      where: { isActive: true, date: { gte: since } },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    },
  } satisfies Prisma.ProductInclude
}

type ProductWithRelations = Prisma.ProductGetPayload<{
  include: { category: true; images: true; sessions: true }
}>

export type CatalogSession = EventSession & { available: number }

export type CatalogProduct = Omit<ProductWithRelations, 'sessions'> & {
  sessions: CatalogSession[]
  available: number
  soldOut: boolean
}

/**
 * Availability is read from the ticket pool, never inferred from product stock
 * columns. A session product keeps one pool per session, so each pool is counted
 * separately; the headline number is the best single date, not a cross-date sum.
 */
async function withAvailability(product: ProductWithRelations): Promise<CatalogProduct> {
  if (!product.requiresSession) {
    const available = await availableTicketCount(product.id, null)
    return { ...product, sessions: [], available, soldOut: available < product.minTickets }
  }

  const sessions = await Promise.all(
    product.sessions.map(async (session) => ({
      ...session,
      available: await availableTicketCount(product.id, session.id),
    })),
  )
  const available = sessions.reduce((best, session) => Math.max(best, session.available), 0)

  return { ...product, sessions, available, soldOut: available < product.minTickets }
}

export type ListPublishedProductsInput = {
  search?: string | null
  category?: string | null
  page?: number
  pageSize?: number
}

export type PublishedProductPage = {
  products: CatalogProduct[]
  total: number
  page: number
  pageSize: number
  pages: number
}

export async function listPublishedProducts({
  search,
  category,
  page = 1,
  pageSize = 12,
}: ListPublishedProductsInput = {}): Promise<PublishedProductPage> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1
  const safePageSize = Number.isFinite(pageSize) ? Math.min(48, Math.max(1, Math.floor(pageSize))) : 12
  const term = search?.trim()

  const where: Prisma.ProductWhereInput = { status: 'PUBLISHED', archivedAt: null }
  if (category?.trim()) where.category = { slug: category.trim() }
  if (term) {
    // MySQL's default collation is case-insensitive, so `contains` needs no mode flag.
    where.OR = [
      { name: { contains: term } },
      { shortDescription: { contains: term } },
      { description: { contains: term } },
      { search: { contains: term } },
    ]
  }

  const [total, rows] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      include: catalogInclude(sellableSince(), { take: 1 }),
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      skip: (safePage - 1) * safePageSize,
      take: safePageSize,
    }),
  ])

  const products = await Promise.all(rows.map(withAvailability))
  const pages = Math.max(1, Math.ceil(total / safePageSize))

  return { products, total, page: safePage, pageSize: safePageSize, pages }
}

export const getProductBySlug = cache(async (slug: string): Promise<CatalogProduct | null> => {
  const product = await prisma.product.findFirst({
    where: { slug, archivedAt: null },
    include: catalogInclude(sellableSince()),
  })
  return product ? withAvailability(product) : null
})

export const getPublishedProduct = cache(async (slug: string): Promise<CatalogProduct | null> => {
  const product = await getProductBySlug(slug)
  return product && product.status === 'PUBLISHED' ? product : null
})

export type CatalogCategory = Category & { productCount: number }

export async function listCategories(): Promise<CatalogCategory[]> {
  const categories = await prisma.category.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      _count: {
        select: { products: { where: { status: 'PUBLISHED', archivedAt: null } } },
      },
    },
  })

  return categories.map(({ _count, ...category }) => ({ ...category, productCount: _count.products }))
}
