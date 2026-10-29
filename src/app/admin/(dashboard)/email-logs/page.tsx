import Link from 'next/link'
import type { EmailDeliveryStatus } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getGeneral } from '@/lib/settings/service'
import { PageHeader, EmptyState } from '@/components/admin/page-primitives'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { humanize } from '@/components/shared/status-badges'
import { formatDateTime } from '@/lib/format'

export const metadata = { title: 'Email logs' }

const PAGE_SIZE = 25
const STATUSES: EmailDeliveryStatus[] = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED']

const STATUS_VARIANTS: Record<EmailDeliveryStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  QUEUED: 'outline',
  SENDING: 'secondary',
  SENT: 'default',
  FAILED: 'destructive',
  SKIPPED: 'secondary',
}

function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

export default async function AdminEmailLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const requestedStatus = readParam(params.status) as EmailDeliveryStatus
  const status = STATUSES.includes(requestedStatus) ? requestedStatus : undefined
  const requestedPage = Number.parseInt(readParam(params.page), 10)
  const initialPage = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1

  const where = status ? { status } : {}
  const [general, total] = await Promise.all([getGeneral(), prisma.emailDelivery.count({ where })])
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.min(initialPage, pages)
  const deliveries = await prisma.emailDelivery.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    include: { order: { select: { id: true, reference: true } } },
  })

  const pageHref = (target: number) => {
    const query = new URLSearchParams()
    if (status) query.set('status', status)
    query.set('page', String(target))
    return `/admin/email-logs?${query.toString()}`
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Email logs"
        description="Delivery attempts for order confirmations and ticket emails."
        actions={<Badge variant="secondary">{total} deliveries</Badge>}
      />

      <form action="/admin/email-logs" method="get" className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-3">
        <div className="grid gap-1">
          <Label htmlFor="status" className="text-xs text-muted-foreground">
            Status
          </Label>
          <select
            id="status"
            name="status"
            defaultValue={status ?? ''}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          >
            <option value="">All statuses</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" size="sm">
          Filter
        </Button>
        {status ? (
          <Button variant="ghost" size="sm" render={<Link href="/admin/email-logs" />}>
            Reset
          </Button>
        ) : null}
      </form>

      {deliveries.length === 0 ? (
        <EmptyState
          title={status ? `No ${humanize(status).toLowerCase()} deliveries` : 'No emails sent yet'}
          description={
            status
              ? 'Try another status or clear the filter.'
              : 'Order confirmations and ticket emails will be tracked here once checkout runs.'
          }
          action={
            status ? (
              <Button variant="outline" size="sm" render={<Link href="/admin/email-logs" />}>
                Clear filter
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="rounded-xl border bg-card p-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Recipient</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead>Next retry</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead>Order</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((delivery) => (
                <TableRow key={delivery.id}>
                  <TableCell>
                    <p className="font-medium">{delivery.toName ?? delivery.to}</p>
                    {delivery.toName ? <p className="text-xs text-muted-foreground">{delivery.to}</p> : null}
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{delivery.templateKey}</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[delivery.status]}>{humanize(delivery.status)}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{delivery.attempts}</TableCell>
                  <TableCell>
                    {delivery.lastError ? (
                      <p className="max-w-[260px] truncate text-xs text-destructive" title={delivery.lastError}>
                        {delivery.lastError.length > 90 ? `${delivery.lastError.slice(0, 90)}…` : delivery.lastError}
                      </p>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(delivery.nextRetryAt, general.timezone)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDateTime(delivery.sentAt, general.timezone)}</TableCell>
                  <TableCell>
                    {delivery.order ? (
                      <Link href={`/admin/orders/${delivery.order.id}`} className="font-medium hover:underline">
                        {delivery.order.reference}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-4 text-xs text-muted-foreground">
            <span>
              Page {page} of {pages} · {total} deliveries
            </span>
            <div className="flex items-center gap-1">
              {page > 1 ? (
                <Button variant="outline" size="sm" render={<Link href={pageHref(page - 1)} />}>
                  Previous
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  Previous
                </Button>
              )}
              {page < pages ? (
                <Button variant="outline" size="sm" render={<Link href={pageHref(page + 1)} />}>
                  Next
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  Next
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
