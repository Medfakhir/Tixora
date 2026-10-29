import Link from 'next/link'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getGeneral } from '@/lib/settings/service'
import { PageHeader, EmptyState } from '@/components/admin/page-primitives'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { humanize } from '@/components/shared/status-badges'
import { formatDateTime } from '@/lib/format'

export const metadata = { title: 'Activity log' }

const PAGE_SIZE = 25

function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

export default async function AdminActivityLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const action = readParam(params.action).trim()
  const entityType = readParam(params.entityType).trim()
  const requestedPage = Number.parseInt(readParam(params.page), 10)
  const initialPage = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1

  const where: Prisma.AuditLogWhereInput = {}
  if (action) where.action = { contains: action }
  if (entityType) where.entityType = { contains: entityType }

  const [general, total] = await Promise.all([getGeneral(), prisma.auditLog.count({ where })])
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.min(initialPage, pages)
  const logs = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  })

  const hasFilters = Boolean(action || entityType)
  const pageHref = (target: number) => {
    const query = new URLSearchParams()
    if (action) query.set('action', action)
    if (entityType) query.set('entityType', entityType)
    query.set('page', String(target))
    return `/admin/activity-logs?${query.toString()}`
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Activity log"
        description="Every administrative and system action, newest first."
        actions={<Badge variant="secondary">{total} entries</Badge>}
      />

      <form action="/admin/activity-logs" method="get" className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-3">
        <div className="grid gap-1">
          <Label htmlFor="action" className="text-xs text-muted-foreground">
            Action contains
          </Label>
          <Input id="action" name="action" defaultValue={action} placeholder="ORDER_REFUND" className="w-48" />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="entityType" className="text-xs text-muted-foreground">
            Entity type contains
          </Label>
          <Input id="entityType" name="entityType" defaultValue={entityType} placeholder="Order" className="w-48" />
        </div>
        <Button type="submit" size="sm">
          Filter
        </Button>
        {hasFilters ? (
          <Button variant="ghost" size="sm" render={<Link href="/admin/activity-logs" />}>
            Reset
          </Button>
        ) : null}
      </form>

      {logs.length === 0 ? (
        <EmptyState
          title={hasFilters ? 'No activity matches these filters' : 'No activity yet'}
          description={
            hasFilters
              ? 'Try a broader action or entity type.'
              : 'Administrative actions and system events will be recorded here.'
          }
          action={
            hasFilters ? (
              <Button variant="outline" size="sm" render={<Link href="/admin/activity-logs" />}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="rounded-xl border bg-card p-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead>IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(log.createdAt, general.timezone, true)}
                  </TableCell>
                  <TableCell>
                    <p className="font-medium">{log.actorLabel ?? humanize(log.actorType)}</p>
                    <p className="text-xs text-muted-foreground">{humanize(log.actorType)}</p>
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{log.action}</code>
                  </TableCell>
                  <TableCell>
                    <p>{log.entityType}</p>
                    {log.entityId ? (
                      <p className="max-w-[140px] truncate text-xs text-muted-foreground" title={log.entityId}>
                        {log.entityId}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <p className="max-w-[360px] truncate" title={log.summary}>
                      {log.summary}
                    </p>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{log.ip ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-4 text-xs text-muted-foreground">
            <span>
              Page {page} of {pages} · {total} entries
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
