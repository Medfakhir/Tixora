import { withApi, ok, readJson, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { productSchema } from '@/lib/validation'
import { prisma } from '@/lib/db/prisma'
import { recordAudit } from '@/lib/auth/guards'

/**
 * Creating a product never creates inventory: a product with no uploaded PDFs simply has
 * zero available tickets, which the storefront reflects immediately.
 */
export const POST = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'sensitive')
  const payload = productSchema.parse(await readJson(request))

  const clash = await prisma.product.findUnique({ where: { slug: payload.slug }, select: { id: true } })
  if (clash) throw new ApiError('That URL slug is already used by another product.', 409, 'SLUG_TAKEN', { slug: 'Already in use' })

  const product = await prisma.product.create({
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
    },
  })

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'PRODUCT_CREATE',
    entityType: 'Product',
    entityId: product.id,
    summary: `Created product ${product.name} (${product.slug})`,
    ip,
  })

  return ok(product, 201)
})
