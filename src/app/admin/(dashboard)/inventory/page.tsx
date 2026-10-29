import Link from 'next/link'
import type { Prisma, ProductStatus, TicketInventoryStatus } from '@prisma/client'
import { requireAdminPage } from '@/lib/auth/guards'
import { prisma } from '@/lib/db/prisma'
import { getGeneral } from '@/lib/settings/service'
import { formatDateTime } from '@/lib/format'
import { PageHeader, SectionCard, EmptyState } from '@/components/admin/page-primitives'
import { Button, buttonVariants } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TicketStatusBadge, humanize } from '@/components/shared/status-badges'
import { InventoryRetireAction, InventoryUploadPanel } from '@/components/admin/inventory-upload'

export const metadata = { title: 'Ticket inventory' }

const PAGE_SIZE = 25
const TICKET_STATUSES = [
  'AVAILABLE',
  'RESERVED',
  'SOLD',
  'DELIVERED',
  'FAILED_DELIVERY',
  'RETIRED',
] as const

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function parsePage(value: string): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function pickStatus(value: string): TicketInventoryStatus | null {
  return (TICKET_STATUSES as readonly string[]).includes(value) ? (value as TicketInventoryStatus) : null
}

function sessionSummary(session: { date: Date; startTime: string; endTime: string | null; label: string | null } | null) {
  if (!session) return 'Product-wide pool'
  const day = session.date.toISOString().slice(0, 10)
  const time = session.endTime ? `${session.startTime}–${session.endTime}` : session.startTime
  return `${day} · ${time}${session.label ? ` · ${session.label}` : ''}`
}

export default async function InventoryPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage()
  const params = await searchParams
  const general = await getGeneral()

  const productId = first(params.product)
  const sessionId = first(params.session)
  const status = pickStatus(first(params.status))
  const page = parsePage(first(params.page))

  const where: Prisma.TicketInventoryWhereInput = {}
  if (productId) where.productId = productId
  if (sessionId) where.eventSessionId = sessionId
  if (status) where.status = status

  const [tickets, total, products, sessions] = await Promise.all([
    prisma.ticketInventory.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        product: { select: { id: true, name: true, slug: true } },
        eventSession: { select: { date: true, startTime: true, endTime: true, label: true } },
        order: { select: { id: true, reference: true } },
        reservation: { select: { code: true, status: true } },
      },
    }),
    prisma.ticketInventory.count({ where }),
    prisma.product.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, status: true, requiresSession: true, inventoryModel: true },
    }),
    prisma.eventSession.findMany({
      orderBy: [{ date: 'desc' }, { startTime: 'asc' }],
      select: {
        id: true,
        productId: true,
        date: true,
        startTime: true,
        endTime: true,
        label: true,
        isActive: true,
        product: { select: { name: true } },
      },
    }),
  ])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageHref = (target: number) => {
    const next = new URLSearchParams()
    if (productId) next.set('product', productId)
    if (sessionId) next.set('session', sessionId)
    if (status) next.set('status', status)
    if (target > 1) next.set('page', String(target))
    const query = next.toString()
    return query ? `/admin/inventory?${query}` : '/admin/inventory'
  }
  const hasFilters = Boolean(productId || sessionId || status)

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Ticket inventory"
        description="Private PDF files waiting to be sold. Availability is a count of unclaimed files, weighted by ticket count."
      />

      <InventoryUploadPanel
        defaultProductId={productId}
        products={products.map((product) => ({
          id: product.id,
          name: product.name,
          status: product.status as ProductStatus,
          requiresSession: product.requiresSession,
          inventoryModel: product.inventoryModel,
        }))}
        sessions={sessions.map((session) => ({
          id: session.id,
          productId: session.productId,
          date: session.date.toISOString().slice(0, 10),
          startTime: session.startTime,
          endTime: session.endTime ?? '',
          label: session.label ?? '',
          isActive: session.isActive,
        }))}
      />

      <SectionCard title="Filters" description="Filters combine; submitting resets to the first page.">
        <form method="get" action="/admin/inventory" className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="grid gap-1.5">
            <Label htmlFor="product">Product</Label>
            <select
              id="product"
              name="product"
              defaultValue={productId}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              <option value="">All products</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                  {product.status === 'ARCHIVED' ? ' (archived)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="session">Session</Label>
            <select
              id="session"
              name="session"
              defaultValue={sessionId}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              <option value="">All sessions</option>
              {sessions
                .filter((session) => !productId || session.productId === productId)
                .map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.product.name} · {session.date.toISOString().slice(0, 10)} {session.startTime}
                    {session.label ? ` · ${session.label}` : ''}
                    {session.isActive ? '' : ' (inactive)'}
                  </option>
                ))}
            </select>
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
              {TICKET_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {humanize(option)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end gap-2 md:col-span-2 xl:col-span-4">
            <Button type="submit" size="sm">
              Apply filters
            </Button>
            {hasFilters ? (
              <Link href="/admin/inventory" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                Reset
              </Link>
            ) : null}
          </div>
        </form>
      </SectionCard>

      <SectionCard>
        {tickets.length === 0 ? (
          <EmptyState
            title={total === 0 ? 'No ticket files found' : 'No ticket files on this page'}
            description={
              total === 0
                ? hasFilters
                  ? 'No inventory row matches the current filters.'
                  : 'Upload PDFs above to make tickets available for sale.'
                : 'This page is past the end of the result set.'
            }
            action={
              total === 0
                ? hasFilters ? (
                    <Link href="/admin/inventory" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                      Clear filters
                    </Link>
                  ) : null
                : (
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
                <TableHead>File</TableHead>
                <TableHead>Product / session</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tickets</TableHead>
                <TableHead>Order / reservation</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tickets.map((ticket) => (
                <TableRow key={ticket.id}>
                  <TableCell>
                    <span className="block max-w-56 truncate font-medium" title={ticket.originalFileName}>
                      {ticket.originalFileName}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="grid">
                      <Link
                        href={`/admin/products/${ticket.productId}`}
                        className="max-w-56 truncate underline-offset-4 hover:underline"
                      >
                        {ticket.product.name}
                      </Link>
                      <span className="max-w-64 truncate text-xs text-muted-foreground">
                        {sessionSummary(ticket.eventSession)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <TicketStatusBadge status={ticket.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{ticket.ticketCount}</TableCell>
                  <TableCell>
                    {ticket.order ? (
                      <Link
                        href={`/admin/orders/${ticket.order.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {ticket.order.reference}
                      </Link>
                    ) : ticket.reservation ? (
                      <span className="text-muted-foreground" title={`Reservation status: ${humanize(ticket.reservation.status)}`}>
                        Reservation {ticket.reservation.code.slice(0, 12)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(ticket.createdAt, general.timezone)}
                  </TableCell>
                  <TableCell>
                    {ticket.lastError ? (
                      <span className="block max-w-56 truncate text-xs text-destructive" title={ticket.lastError}>
                        {ticket.lastError}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {ticket.status === 'RETIRED' ? (
                        <span className="text-xs text-muted-foreground">File removed</span>
                      ) : (
                        <>
                          <a
                            href={`/api/admin/inventory/${ticket.id}/file`}
                            target="_blank"
                            rel="noreferrer"
                            className={buttonVariants({ variant: 'ghost', size: 'xs' })}
                          >
                            View
                          </a>
                          <a
                            href={`/api/admin/inventory/${ticket.id}/file?download=1`}
                            className={buttonVariants({ variant: 'ghost', size: 'xs' })}
                          >
                            Download
                          </a>
                        </>
                      )}
                      <InventoryRetireAction
                        id={ticket.id}
                        fileName={ticket.originalFileName}
                        status={ticket.status}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>
          Page {Math.min(page, pages)} of {pages} · {total} file{total === 1 ? '' : 's'}
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
