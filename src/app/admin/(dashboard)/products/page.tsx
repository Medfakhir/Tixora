import Link from 'next/link'
import type { Prisma, ProductStatus } from '@prisma/client'
import { requireAdminPage } from '@/lib/auth/guards'
import { prisma } from '@/lib/db/prisma'
import { getGeneral } from '@/lib/settings/service'
import { formatDateTime } from '@/lib/format'
import { PageHeader, SectionCard, EmptyState } from '@/components/admin/page-primitives'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Money } from '@/components/shared/money'
import { ProductStatusBadge } from '@/components/shared/status-badges'
import { ProductStatusActions, type ProductPayload } from '@/components/admin/product-form'

export const metadata = { title: 'Products' }

const PAGE_SIZE = 20
const PRODUCT_STATUSES = ['DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED'] as const
const STATUS_LABELS: Record<ProductStatus, string> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  UNPUBLISHED: 'Unpublished',
  ARCHIVED: 'Archived',
}

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function parsePage(value: string): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function pickStatus(value: string): ProductStatus | null {
  return (PRODUCT_STATUSES as readonly string[]).includes(value) ? (value as ProductStatus) : null
}

function toPayload(product: {
  name: string
  slug: string
  shortDescription: string
  description: string
  categoryId: string | null
  status: ProductStatus
  priceMinor: number
  currency: string
  taxRateBps: number
  taxIncluded: boolean
  inventoryModel: 'ONE_PDF_PER_TICKET' | 'ONE_PDF_PER_GROUP'
  minTickets: number
  maxTickets: number
  requiresSession: boolean
  salesStartAt: Date | null
  salesEndAt: Date | null
  lowInventoryThreshold: number
}): ProductPayload {
  return {
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
}

export default async function ProductsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage()
  const params = await searchParams
  const general = await getGeneral()

  const search = first(params.q).trim()
  const status = pickStatus(first(params.status))
  const page = parsePage(first(params.page))

  const where: Prisma.ProductWhereInput = {}
  if (status) where.status = status
  if (search) {
    where.OR = [
      { name: { contains: search } },
      { slug: { contains: search } },
      { shortDescription: { contains: search } },
    ]
  }

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        category: { select: { name: true } },
        _count: { select: { sessions: true } },
      },
    }),
    prisma.product.count({ where }),
  ])

  const availability = products.length
    ? await prisma.ticketInventory.groupBy({
        by: ['productId'],
        where: { productId: { in: products.map((product) => product.id) }, status: 'AVAILABLE' },
        _sum: { ticketCount: true },
      })
    : []
  const availableByProduct = new Map(availability.map((row) => [row.productId, row._sum.ticketCount ?? 0]))

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageHref = (target: number) => {
    const next = new URLSearchParams()
    if (search) next.set('q', search)
    if (status) next.set('status', status)
    if (target > 1) next.set('page', String(target))
    const query = next.toString()
    return query ? `/admin/products?${query}` : '/admin/products'
  }
  const hasFilters = Boolean(search || status)

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Products"
        description="The catalogue guests can buy. Ticket availability is counted from unclaimed PDFs in inventory."
        actions={
          <Link href="/admin/products/new" className={buttonVariants({ size: 'sm' })}>
            New product
          </Link>
        }
      />

      <SectionCard title="Filters" description="Filters combine; submitting resets to the first page.">
        <form method="get" action="/admin/products" className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="grid gap-1.5 md:col-span-2">
            <Label htmlFor="q">Search</Label>
            <Input id="q" name="q" defaultValue={search} placeholder="Name, slug or short description" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="status">Status</Label>
            <select
              id="status"
              name="status"
              defaultValue={status ?? ''}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              <option value="">All statuses</option>
              {PRODUCT_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {STATUS_LABELS[option]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2 md:col-span-2 xl:col-span-4">
            <Button type="submit" size="sm">
              Apply filters
            </Button>
            {hasFilters ? (
              <Link href="/admin/products" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                Reset
              </Link>
            ) : null}
          </div>
        </form>
      </SectionCard>

      <SectionCard>
        {products.length === 0 ? (
          <EmptyState
            title={total === 0 ? 'No products found' : 'No products on this page'}
            description={
              total === 0
                ? hasFilters
                  ? 'No product matches the current filters.'
                  : 'Create the first product to start selling tickets.'
                : 'This page is past the end of the result set.'
            }
            action={
              total === 0 ? (
                hasFilters ? (
                  <Link href="/admin/products" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                    Clear filters
                  </Link>
                ) : (
                  <Link href="/admin/products/new" className={buttonVariants({ size: 'sm' })}>
                    New product
                  </Link>
                )
              ) : (
                <Link href={pageHref(1)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  Go to first page
                </Link>
              )
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="text-right">Available tickets</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product) => {
                const available = availableByProduct.get(product.id) ?? 0
                return (
                  <TableRow key={product.id}>
                    <TableCell>
                      <div className="grid">
                        <Link
                          href={`/admin/products/${product.id}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {product.name}
                        </Link>
                        <span className="text-xs text-muted-foreground">/{product.slug}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{product.category?.name ?? 'Uncategorised'}</TableCell>
                    <TableCell className="text-right">
                      <Money minor={product.priceMinor} currency={product.currency} className="tabular-nums" />
                    </TableCell>
                    <TableCell>
                      <ProductStatusBadge status={product.status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{product._count.sessions}</TableCell>
                    <TableCell className="text-right">
                      <div className="grid justify-items-end">
                        <span className="tabular-nums">{available}</span>
                        {available === 0 ? (
                          <span className="text-xs text-destructive">Out of stock</span>
                        ) : available <= product.lowInventoryThreshold ? (
                          <span className="text-xs text-amber-600 dark:text-amber-400">Low stock</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(product.updatedAt, general.timezone)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <ProductStatusActions
                          productId={product.id}
                          name={product.name}
                          status={product.status}
                          payload={toPayload(product)}
                        />
                        <Link
                          href={`/admin/products/${product.id}`}
                          className={buttonVariants({ variant: 'ghost', size: 'xs' })}
                        >
                          Edit
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>
          Page {Math.min(page, pages)} of {pages} · {total} product{total === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-2">
          {page <= 1 ? (
            <Button variant="outline" size="sm" disabled>
              Previous
            </Button>
          ) : (
            <Link href={pageHref(page - 1)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Previous
            </Link>
          )}
          {page >= pages ? (
            <Button variant="outline" size="sm" disabled>
              Next
            </Button>
          ) : (
            <Link href={pageHref(page + 1)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Next
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
