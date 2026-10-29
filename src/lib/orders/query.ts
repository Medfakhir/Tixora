import { prisma } from '@/lib/db/prisma'
import type { Prisma, OrderStatus, DeliveryStatus, PaymentEnvironment, OrderKind } from '@prisma/client'

export type OrderFilters = {
  search?: string | null
  status?: OrderStatus | null
  deliveryStatus?: DeliveryStatus | null
  environment?: PaymentEnvironment | null
  kind?: OrderKind | null
  visitDate?: Date | null
  productId?: string | null
  from?: Date | null
  to?: Date | null
  page: number
  pageSize: number
  sort: 'createdAt_desc' | 'createdAt_asc' | 'totalMinor_desc' | 'reference_asc'
}

export function ordersWhere(filters: OrderFilters): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {}

  if (filters.status) where.status = filters.status
  if (filters.deliveryStatus) where.deliveryStatus = filters.deliveryStatus
  if (filters.environment) where.paymentEnvironment = filters.environment
  if (filters.kind) where.kind = filters.kind
  if (filters.visitDate) where.visitDate = filters.visitDate
  if (filters.from || filters.to) {
    where.createdAt = { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) }
  }
  if (filters.productId) where.lines = { some: { productId: filters.productId } }

  const search = filters.search?.trim()
  if (search) {
    // A partial email or reference must find the order without exposing anyone else's.
    // MySQL's default utf8mb4 collation is case-insensitive, so `contains` already
    // matches "Ada@" for "ada@" without a Postgres-style mode flag.
    const needle = { contains: search }
    where.OR = [{ reference: needle }, { customerEmail: needle }, { customerName: needle }, { paypalOrderId: needle }]
  }

  return where
}

function orderDirection(sort: OrderFilters['sort']): Prisma.OrderOrderByWithRelationInput {
  switch (sort) {
    case 'createdAt_asc':
      return { createdAt: 'asc' }
    case 'totalMinor_desc':
      return { totalMinor: 'desc' }
    case 'reference_asc':
      return { reference: 'asc' }
    default:
      return { createdAt: 'desc' }
  }
}

/** Orders list with their lines so the table can show product and session without N+1. */
export async function listOrders(filters: OrderFilters) {
  const where = ordersWhere(filters)
  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      include: { lines: { select: { productName: true, quantity: true } }, tickets: { select: { status: true } } },
      orderBy: orderDirection(filters.sort),
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
  ])

  return {
    total,
    pages: Math.max(1, Math.ceil(total / filters.pageSize)),
    orders: orders.map((order) => ({
      ...order,
      ticketCount:
        order.kind === 'MUSEUM'
          ? order.adultQty + order.childQty
          : order.lines.reduce((sum, line) => sum + line.quantity, 0),
      productName:
        order.kind === 'MUSEUM'
          ? 'Badi Palace Museum entrance'
          : order.lines.map((line) => line.productName).join(', '),
    })),
  }
}

export type CustomerFilters = {
  search?: string | null
  page: number
  pageSize: number
}

export async function listCustomers(filters: CustomerFilters) {
  const search = filters.search?.trim()
  const where: Prisma.CustomerWhereInput = search
    ? { OR: [{ emailNormalized: { contains: search } }, { fullName: { contains: search } }] }
    : {}

  const [total, customers] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: [{ lastPurchaseAt: 'desc' }, { createdAt: 'desc' }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      include: { _count: { select: { orders: true } } },
    }),
  ])

  return { total, pages: Math.max(1, Math.ceil(total / filters.pageSize)), customers }
}
