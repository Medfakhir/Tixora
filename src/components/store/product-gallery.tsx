'use client'

import { useState } from 'react'
import { Ticket } from 'lucide-react'
import { cn } from 'cn'

export type ProductGalleryImage = {
  id: string
  alt: string
  width: number | null
  height: number | null
}

export function ProductGallery({ images, name }: { images: ProductGalleryImage[]; name: string }) {
  const [active, setActive] = useState(0)

  if (images.length === 0) {
    return (
      <div className="flex aspect-[4/3] w-full items-center justify-center rounded-xl border bg-muted text-muted-foreground">
        <Ticket className="size-10" aria-hidden="true" />
        <span className="sr-only">No image available</span>
      </div>
    )
  }

  const current = images[Math.min(active, images.length - 1)]

  return (
    <div className="grid gap-3">
      <div className="overflow-hidden rounded-xl border bg-muted">
        <img
          src={`/api/products/image/${current.id}`}
          alt={current.alt || name}
          width={current.width ?? undefined}
          height={current.height ?? undefined}
          loading="lazy"
          className="aspect-[4/3] w-full object-cover"
        />
      </div>

      {images.length > 1 ? (
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-6">
          {images.map((image, index) => {
            const selected = index === Math.min(active, images.length - 1)
            return (
              <button
                key={image.id}
                type="button"
                onClick={() => setActive(index)}
                aria-label={`View image ${index + 1} of ${images.length}`}
                aria-pressed={selected}
                className={cn(
                  'overflow-hidden rounded-lg border bg-muted outline-none transition focus-visible:ring-3 focus-visible:ring-ring/50',
                  selected ? 'border-primary ring-1 ring-primary' : 'border-border opacity-80 hover:opacity-100',
                )}
              >
                <img
                  src={`/api/products/image/${image.id}`}
                  alt=""
                  width={image.width ?? undefined}
                  height={image.height ?? undefined}
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
