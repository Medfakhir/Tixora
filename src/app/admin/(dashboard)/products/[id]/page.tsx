import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireAdminPage, recordAudit } from '@/lib/auth/guards'
import { prisma } from '@/lib/db/prisma'
import { getGeneral } from '@/lib/settings/service'
import { getStorage } from '@/lib/storage'
import { ProductForm, type ProductPayload } from '@/components/admin/product-form'
import { PageHeader, StatCard } from '@/components/admin/page-primitives'
import { buttonVariants } from '@/components/ui/button'

export const metadata = { title: 'Edit product' }

async function removeProductImage(productId: string, imageId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  'use server'

  const admin = await requireAdminPage()
  const image = await prisma.productImage.findFirst({
    where: { id: imageId, productId },
    select: { id: true, storageKey: true, alt: true },
  })
  if (!image) return { ok: false, error: 'Image not found.' }

  await getStorage()
    .delete(image.storageKey)
    .catch((error: Error) => console.error('product image delete failed', { key: image.storageKey, error: error.message }))
  await prisma.productImage.delete({ where: { id: image.id } })

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'PRODUCT_IMAGE_DELETE',
    entityType: 'Product',
    entityId: productId,
    summary: `Deleted image ${image.alt || image.id} from product ${productId}`,
  })

  return { ok: true }
}

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage()
  const { id } = await params

  const [product, general, categories] = await Promise.all([
    prisma.product.findUnique({
      where: { id },
      include: {
        images: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { id: true, alt: true } },
        sessions: { orderBy: [{ date: 'asc' }, { startTime: 'asc' }] },
      },
    }),
    getGeneral(),
    prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
  ])
  if (!product) notFound()

  const [available, sold] = await Promise.all([
    prisma.ticketInventory.aggregate({
      where: { productId: product.id, status: 'AVAILABLE' },
      _sum: { ticketCount: true },
    }),
    prisma.ticketInventory.aggregate({
      where: { productId: product.id, status: { in: ['SOLD', 'DELIVERED', 'FAILED_DELIVERY'] } },
      _sum: { ticketCount: true },
    }),
  ])

  const availableCount = available._sum.ticketCount ?? 0
  const soldCount = sold._sum.ticketCount ?? 0

  const initial: ProductPayload = {
    name: product.name,
    slug: product.slug,
    shortDescription: product.shortDescription,
    description: product.description,
    categoryId: product.categoryId,
    status: product.status,
    priceMinor: product.priceMinor,
    currency: product.currency,
    taxRateBps: product.taxRateBps,
    taxIncluded: product.taxIncluded,
    inventoryModel: product.inventoryModel,
    minTickets: product.minTickets,
    maxTickets: product.maxTickets,
    requiresSession: product.requiresSession,
    salesStartAt: product.salesStartAt ? product.salesStartAt.toISOString() : '',
    salesEndAt: product.salesEndAt ? product.salesEndAt.toISOString() : '',
    lowInventoryThreshold: product.lowInventoryThreshold,
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title={product.name}
        description={`Editing /products/${product.slug}. Available tickets are counted from unclaimed inventory files.`}
        actions={
          <>
            <Link href="/admin/products" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Back to products
            </Link>
            <Link
              href={`/admin/inventory?product=${product.id}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Manage inventory
            </Link>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard
          label="Available tickets"
          value={availableCount.toLocaleString()}
          hint={`Low-stock threshold: ${product.lowInventoryThreshold}`}
          tone={availableCount <= product.lowInventoryThreshold ? 'warning' : 'positive'}
        />
        <StatCard
          label="Sold tickets"
          value={soldCount.toLocaleString()}
          hint="Paid, delivered or awaiting delivery"
        />
      </div>

      <ProductForm
        categories={categories}
        defaultCurrency={general.defaultCurrency}
        product={{ id: product.id, status: product.status, initial }}
        sessions={product.sessions.map((session) => ({
          id: session.id,
          date: session.date.toISOString().slice(0, 10),
          startTime: session.startTime,
          endTime: session.endTime ?? '',
          label: session.label ?? '',
          isActive: session.isActive,
        }))}
        images={product.images}
        onDeleteImage={removeProductImage.bind(null, product.id)}
      />
    </div>
  )
}
