import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { productSchema } from '@/lib/validation'
import { prisma } from '@/lib/db/prisma'
import { recordAudit } from '@/lib/auth/guards'

export const PATCH = withApi(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const { admin, ip } = await adminRequest(request, 'sensitive')
  const payload = productSchema.parse(await readJson(request))

  const existing = await prisma.product.findUnique({ where: { id }, include: { _count: { select: { orderLines: true, inventory: true } } } })
  if (!existing) throw new ApiError('Product not found.', 404, 'NOT_FOUND')

  const slugClash = await prisma.product.findUnique({ where: { slug: payload.slug }, select: { id: true } })
  if (slugClash && slugClash.id !== id) throw new ApiError('That URL slug is already used.', 409, 'SLUG_TAKEN', { slug: 'Already in use' })

  // History must survive edits: an archived product keeps its lines and inventory rows.
  const product = await prisma.product.update({
    where: { id },
    data: {
      name: payload.name,
      slug: payload.slug,
      shortDescription: payload.shortDescription,
      description: payload.description,
      categoryId: payload.categoryId || null,
      status: payload.status,
      priceMinor: payload.priceMinor,
      currency: payload.currency,
      taxRateBps: payload.taxRateBps,
      taxIncluded: payload.taxIncluded,
      inventoryModel: payload.inventoryModel,
      minTickets: payload.minTickets,
      maxTickets: payload.maxTickets,
      requiresSession: payload.requiresSession,
      salesStartAt: payload.salesStartAt ? new Date(payload.salesStartAt) : null,
      salesEndAt: payload.salesEndAt ? new Date(payload.salesEndAt) : null,
      lowInventoryThreshold: payload.lowInventoryThreshold,
      archivedAt: payload.status === 'ARCHIVED' ? existing.archivedAt ?? new Date() : null,
    },
  })

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'PRODUCT_UPDATE',
    entityType: 'Product',
    entityId: product.id,
    summary: `Updated product ${product.name}`,
    metadata: { status: product.status, priceMinor: product.priceMinor },
    ip,
  })

  return ok(product)
})

/**
 * Products referenced by orders are never hard-deleted; they are archived so historical
 * receipts keep their product name, price and ticket links intact.
 */
export const DELETE = withApi(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const { admin, ip } = await adminRequest(request, 'sensitive')

  const product = await prisma.product.findUnique({ where: { id }, include: { _count: { select: { orderLines: true, inventory: true } } } })
  if (!product) throw new ApiError('Product not found.', 404, 'NOT_FOUND')

  const referenced = product._count.orderLines > 0 || product._count.inventory > 0
  if (referenced) {
    const archived = await prisma.product.update({ where: { id }, data: { status: 'ARCHIVED', archivedAt: new Date() } })
    await recordAudit({
      actorType: 'ADMIN',
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'PRODUCT_ARCHIVE',
      entityType: 'Product',
      entityId: id,
      summary: `Archived ${product.name} (${product._count.orderLines} order line(s), ${product._count.inventory} ticket file(s) retained)`,
      ip,
    })
    return ok({ archived: true, product: archived })
  }

  await prisma.product.delete({ where: { id } })
  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'PRODUCT_DELETE',
    entityType: 'Product',
    entityId: id,
    summary: `Deleted unused product ${product.name}`,
    ip,
  })
  return ok({ archived: false })
})
