import type { Metadata } from 'next'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import { ProductCard } from '@/components/store/product-card'
import { listCategories, listPublishedProducts } from '@/lib/products/catalog'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'All tickets',
  description: 'Browse tickets on sale, choose a date, and check out securely with PayPal.',
}

const PAGE_SIZE = 12

type StoreSearchParams = Promise<{ [key: string]: string | string[] | undefined }>

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
}

function buildHref({ q, category, page }: { q?: string; category?: string; page?: number }): string {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (category) params.set('category', category)
  if (page && page > 1) params.set('page', String(page))
  const query = params.toString()
  return query ? `/products?${query}` : '/products'
}

function pageNumbers(current: number, pages: number): number[] {
  const size = 5
  const start = Math.max(1, Math.min(current - 2, pages - size + 1))
  const end = Math.min(pages, start + size - 1)
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

export default async function ProductsPage({ searchParams }: { searchParams: StoreSearchParams }) {
  const params = await searchParams
  const q = firstValue(params.q)
  const categorySlug = firstValue(params.category)
  const pageParam = Number(firstValue(params.page))
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1

  const [result, categories] = await Promise.all([
    listPublishedProducts({ search: q, category: categorySlug, page, pageSize: PAGE_SIZE }),
    listCategories(),
  ])

  const activeCategories = categories.filter((category) => category.productCount > 0)
  const hasFilters = Boolean(q || categorySlug)
  const pageBeyondResults = result.total > 0 && result.products.length === 0
  const firstItem = (result.page - 1) * result.pageSize + 1
  const lastItem = firstItem + result.products.length - 1

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:py-12">
      <header className="grid gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">Tickets</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          Choose your ticket, pick a date, and check out securely with PayPal. No account needed.
        </p>
      </header>

      <div className="mt-6 grid gap-4">
        <form action="/products" method="get" role="search" className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {categorySlug ? <input type="hidden" name="category" value={categorySlug} /> : null}
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Search tickets by name or description"
              aria-label="Search tickets"
              className="h-9 pl-8"
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" className="h-9">
              Search
            </Button>
            {hasFilters ? (
              <Button variant="ghost" className="h-9" render={<Link href="/products" />}>
                Clear
              </Button>
            ) : null}
          </div>
        </form>

        <div className="-mx-4 overflow-x-auto px-4 pb-1">
          <div className="flex w-max gap-2">
            <Button
              size="sm"
              variant={categorySlug ? 'outline' : 'default'}
              render={<Link href={buildHref({ q })} aria-current={categorySlug ? undefined : 'page'} />}
            >
              All tickets
            </Button>
            {activeCategories.map((category) => {
              const selected = category.slug === categorySlug
              return (
                <Button
                  key={category.id}
                  size="sm"
                  variant={selected ? 'default' : 'outline'}
                  render={
                    <Link
                      href={buildHref({ q, category: category.slug })}
                      aria-current={selected ? 'page' : undefined}
                    />
                  }
                >
                  {category.name}
                </Button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-b pb-3 text-sm text-muted-foreground">
        <p>
          {pageBeyondResults
            ? 'No tickets on this page'
            : result.total === 0
              ? 'No tickets found'
              : `${firstItem}–${lastItem} of ${result.total} ${result.total === 1 ? 'ticket' : 'tickets'}`}
        </p>
        {hasFilters ? <p>Filtered results</p> : null}
      </div>

      {result.products.length > 0 ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {result.products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      ) : (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-dashed bg-muted/30 px-6 py-12 text-center">
          <div className="grid gap-1">
            <h2 className="font-heading text-lg font-medium">
              {pageBeyondResults
                ? 'This page has no tickets'
                : hasFilters
                  ? 'No tickets match your filters'
                  : 'No tickets are on sale right now'}
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {pageBeyondResults
                ? 'The catalogue may have changed since this link was created.'
                : hasFilters
                  ? 'Try a different search term or category.'
                  : 'New tickets appear here as soon as they are published. Check back soon.'}
            </p>
          </div>
          {pageBeyondResults ? (
            <Button variant="outline" render={<Link href={buildHref({ q, category: categorySlug })} />}>
              Go to the first page
            </Button>
          ) : hasFilters ? (
            <Button variant="outline" render={<Link href="/products" />}>
              Clear filters
            </Button>
          ) : null}
        </div>
      )}

      {result.pages > 1 ? (
        <Pagination className="mt-8">
          <PaginationContent>
            {result.page > 1 ? (
              <PaginationItem>
                <PaginationPrevious href={buildHref({ q, category: categorySlug, page: result.page - 1 })} />
              </PaginationItem>
            ) : null}
            {pageNumbers(result.page, result.pages).map((number) => (
              <PaginationItem key={number}>
                <PaginationLink
                  href={buildHref({ q, category: categorySlug, page: number })}
                  isActive={number === result.page}
                >
                  {number}
                </PaginationLink>
              </PaginationItem>
            ))}
            {result.page < result.pages ? (
              <PaginationItem>
                <PaginationNext href={buildHref({ q, category: categorySlug, page: result.page + 1 })} />
              </PaginationItem>
            ) : null}
          </PaginationContent>
        </Pagination>
      ) : null}
    </div>
  )
}
