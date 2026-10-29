import Link from 'next/link'
import { Ticket } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/money'
import type { CatalogProduct } from '@/lib/products/catalog'

export function ProductCard({ product }: { product: CatalogProduct }) {
  const image = product.images[0]
  const availability = product.soldOut
    ? 'Sold out'
    : `${product.available} ${product.available === 1 ? 'ticket' : 'tickets'} left`

  return (
    <article className="group relative flex h-full flex-col overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-md focus-within:ring-3 focus-within:ring-ring/40">
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
        {image ? (
          <img
            src={`/api/products/image/${image.id}`}
            alt={image.alt || product.name}
            width={image.width ?? undefined}
            height={image.height ?? undefined}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Ticket className="size-10" aria-hidden="true" />
            <span className="sr-only">No image available</span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {product.category ? <Badge variant="secondary">{product.category.name}</Badge> : null}
          <Badge variant={product.soldOut ? 'destructive' : 'outline'} className="ml-auto">
            {availability}
          </Badge>
        </div>

        <div className="grid gap-1">
          <h3 className="font-heading text-base leading-snug font-medium">
            <Link
              href={`/products/${product.slug}`}
              className="outline-none after:absolute after:inset-0 after:content-['']"
            >
              {product.name}
            </Link>
          </h3>
          <p className="line-clamp-2 text-sm text-muted-foreground">{product.shortDescription}</p>
        </div>

        <div className="mt-auto flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 pt-1">
          <p className="text-base font-semibold">{formatMoney(product.priceMinor, product.currency)}</p>
          <span className="text-xs text-muted-foreground">per ticket</span>
        </div>
      </div>
    </article>
  )
}
