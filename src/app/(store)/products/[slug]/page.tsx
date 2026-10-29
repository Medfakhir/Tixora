import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronRight, Ticket } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ProductGallery } from '@/components/store/product-gallery'
import { ProductPurchase } from '@/components/store/product-purchase'
import { formatDateTime } from '@/lib/format'
import { formatMoney } from '@/lib/money'
import { formatSessionDate, formatSessionDateKey, formatSessionTime } from '@/lib/products/availability'
import { getProductBySlug, getPublishedProduct } from '@/lib/products/catalog'
import { getGeneral } from '@/lib/settings/service'

export const dynamic = 'force-dynamic'

type ProductPageProps = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  const { slug } = await params
  const product = await getPublishedProduct(slug)
  if (!product) return { title: 'Ticket not available' }

  const image = product.images[0]
  return {
    title: product.name,
    description: product.shortDescription || product.description.slice(0, 160),
    openGraph: image
      ? { images: [{ url: `/api/products/image/${image.id}`, alt: image.alt || product.name }] }
      : undefined,
  }
}

function UnavailablePanel({
  title,
  message,
  supportEmail,
}: {
  title: string
  message: string
  supportEmail: string
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-3 px-4 py-16 text-center sm:py-24">
      <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Ticket className="size-5" aria-hidden="true" />
      </span>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{message}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Button render={<Link href="/products" />}>Browse tickets</Button>
        <Button variant="outline" render={<a href={`mailto:${supportEmail}`} />}>
          Contact support
        </Button>
      </div>
    </div>
  )
}

export default async function ProductDetailPage({ params }: ProductPageProps) {
  const { slug } = await params
  const [product, general] = await Promise.all([getPublishedProduct(slug), getGeneral()])

  if (!product) {
    const knownProduct = await getProductBySlug(slug)
    if (!knownProduct) notFound()

    return (
      <UnavailablePanel
        title="This ticket is not on sale"
        message="It is not currently published. Browse the catalogue to see the tickets that are available."
        supportEmail={general.supportEmail}
      />
    )
  }

  const now = new Date()
  const salesNotStarted = product.salesStartAt ? product.salesStartAt.getTime() > now.getTime() : false
  const salesEnded = product.salesEndAt ? product.salesEndAt.getTime() < now.getTime() : false
  const maxPerOrder = Math.min(product.maxTickets, general.maxTicketsPerOrder)
  const cannotPurchase = maxPerOrder < product.minTickets
  const descriptionBody = (product.description.trim() || product.shortDescription).trim()
  const paragraphs = descriptionBody ? descriptionBody.split(/\n\s*\n/).filter((paragraph) => paragraph.trim()) : []

  const purchaseSessions = product.sessions.map((session) => ({
    id: session.id,
    dateKey: formatSessionDateKey(session, general.timezone),
    dateLabel: formatSessionDate(session, general.timezone),
    startTime: session.startTime,
    timeLabel: formatSessionTime(session),
    name: session.label,
    available: session.available,
  }))

  const availabilityLabel = product.soldOut
    ? 'Sold out'
    : `${product.available} ${product.available === 1 ? 'ticket' : 'tickets'} left`

  let notice: { title: string; message: string } | null = null
  if (salesNotStarted && product.salesStartAt) {
    notice = {
      title: 'Sales have not opened yet',
      message: `Tickets for this event go on sale ${formatDateTime(product.salesStartAt, general.timezone)}.`,
    }
  } else if (salesEnded && product.salesEndAt) {
    notice = {
      title: 'Sales have closed',
      message: `Tickets for this event stopped being sold on ${formatDateTime(product.salesEndAt, general.timezone)}.`,
    }
  } else if (cannotPurchase) {
    notice = {
      title: 'Not available for online purchase',
      message: 'This ticket cannot be purchased online right now. Please contact support for help.',
    }
  } else if (product.soldOut) {
    notice =
      product.requiresSession && product.sessions.length === 0
        ? {
            title: 'No dates available',
            message: 'There are no upcoming dates on sale for this ticket right now.',
          }
        : {
            title: 'Sold out',
            message: product.requiresSession
              ? 'There are not enough tickets left on any date for the minimum order.'
              : 'All tickets for this event have been sold.',
          }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-10">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/products" className="underline-offset-4 hover:text-foreground hover:underline">
          Tickets
        </Link>
        <ChevronRight className="size-3.5" aria-hidden="true" />
        <span className="text-foreground" aria-current="page">
          {product.name}
        </span>
      </nav>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:items-start lg:gap-12">
        <div className="grid gap-6">
          <ProductGallery
            images={product.images.map((image) => ({
              id: image.id,
              alt: image.alt,
              width: image.width,
              height: image.height,
            }))}
            name={product.name}
          />

          {paragraphs.length > 0 ? (
            <section className="grid gap-3 border-t pt-6">
              <h2 className="font-heading text-lg font-medium">About this ticket</h2>
              <div className="grid gap-3 text-sm leading-relaxed text-foreground/90">
                {paragraphs.map((paragraph, index) => (
                  <p key={index} className="whitespace-pre-line">
                    {paragraph.trim()}
                  </p>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <div className="grid gap-5">
          <div className="flex flex-wrap items-center gap-2">
            {product.category ? (
              <Badge
                variant="secondary"
                render={<Link href={`/products?category=${encodeURIComponent(product.category.slug)}`} />}
              >
                {product.category.name}
              </Badge>
            ) : null}
            <Badge variant={product.soldOut ? 'destructive' : 'outline'} className="ml-auto">
              {availabilityLabel}
            </Badge>
          </div>

          <div className="grid gap-2">
            <h1 className="font-heading text-2xl leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
              {product.name}
            </h1>
            {product.shortDescription ? (
              <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">{product.shortDescription}</p>
            ) : null}
          </div>

          <div className="grid gap-1 border-y py-4">
            <p className="text-2xl font-semibold">{formatMoney(product.priceMinor, product.currency)}</p>
            <p className="text-xs text-muted-foreground">
              per ticket
              {product.taxIncluded
                ? ' · tax included'
                : product.taxRateBps > 0
                  ? ' · tax calculated at checkout'
                  : ''}
            </p>
          </div>

          {notice ? (
            <div className="grid gap-2 rounded-xl border bg-muted/40 p-4 sm:p-5">
              <p className="text-sm font-medium">{notice.title}</p>
              <p className="text-sm leading-relaxed text-muted-foreground">{notice.message}</p>
              <a
                href={`mailto:${general.supportEmail}`}
                className="mt-1 text-sm underline underline-offset-4 hover:text-foreground"
              >
                Contact {general.supportEmail}
              </a>
            </div>
          ) : (
            <div className="rounded-xl border bg-card p-4 sm:p-5">
              <ProductPurchase
                slug={product.slug}
                requiresSession={product.requiresSession}
                sessions={purchaseSessions}
                minTickets={product.minTickets}
                maxTickets={maxPerOrder}
                available={product.available}
              />
            </div>
          )}

          <p className="text-sm text-muted-foreground">
            Need help?{' '}
            <a
              href={`mailto:${general.supportEmail}`}
              className="underline underline-offset-4 hover:text-foreground"
            >
              {general.supportEmail}
            </a>
            {general.supportPhone ? ` · ${general.supportPhone}` : ''}
          </p>
        </div>
      </div>
    </div>
  )
}
