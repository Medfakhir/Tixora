import Link from 'next/link'
import { requireAdminPage } from '@/lib/auth/guards'
import { getGeneral } from '@/lib/settings/service'
import { listCustomers } from '@/lib/orders/query'
import { prisma } from '@/lib/db/prisma'
import { formatDateTime } from '@/lib/format'
import { PageHeader, SectionCard, EmptyState } from '@/components/admin/page-primitives'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Money } from '@/components/shared/money'

export const metadata = { title: 'Customers' }

const PAGE_SIZE = 20

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function parsePage(value: string): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

export default async function CustomersPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage()
  const params = await searchParams
  const general = await getGeneral()

  const search = first(params.q).trim()
  const page = parsePage(first(params.page))

  const { customers, total, pages } = await listCustomers({ search: search || null, page, pageSize: PAGE_SIZE })

  const orderCounts = await prisma.order.groupBy({
    by: ['customerEmail'],
    where: { customerEmail: { in: customers.map((customer) => customer.emailNormalized) } },
    _count: { _all: true },
  })
  const countByEmail = new Map(orderCounts.map((row) => [row.customerEmail, row._count._all]))

  const pageHref = (target: number) => {
    const next = new URLSearchParams()
    if (search) next.set('q', search)
    if (target > 1) next.set('page', String(target))
    const query = next.toString()
    return query ? `/admin/customers?${query}` : '/admin/customers'
  }

  return (
    <div className="grid gap-6">
      <PageHeader title="Customers" description="Guests who have started checkout, with their order history and lifetime spend." />

      <SectionCard title="Filters">
        <form method="get" action="/admin/customers" className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-64 flex-1 gap-1.5">
            <Label htmlFor="q">Search</Label>
            <Input id="q" name="q" defaultValue={search} placeholder="Name or email address" />
          </div>
          <Button type="submit" size="sm">
            Apply filters
          </Button>
          {search ? (
            <Link href="/admin/customers" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              Reset
            </Link>
          ) : null}
        </form>
      </SectionCard>

      <SectionCard>
        {customers.length === 0 ? (
          <EmptyState
            title={total === 0 ? 'No customers found' : 'No customers on this page'}
            description={total === 0 ? 'No customer matches the current search.' : 'This page is past the end of the result set.'}
            action={
              total === 0 ? null : (
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
                <TableHead>Customer</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="text-right">Orders</TableHead>
                <TableHead className="text-right">Total spent</TableHead>
                <TableHead>Last purchase</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((customer) => (
                <TableRow key={customer.id}>
                  <TableCell>
                    <div className="grid">
                      <Link href={`/admin/customers/${customer.id}`} className="font-medium underline-offset-4 hover:underline">
                        {customer.fullName}
                      </Link>
                      <span className="max-w-56 truncate text-xs text-muted-foreground">{customer.emailOriginal}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{customer.phone ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="grid justify-items-end">
                      <span className="tabular-nums">{countByEmail.get(customer.emailNormalized) ?? 0}</span>
                      <span className="text-xs text-muted-foreground">{customer.totalOrders} paid</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Money minor={customer.totalSpentMinor} currency={general.defaultCurrency} className="tabular-nums" />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {customer.lastPurchaseAt ? formatDateTime(customer.lastPurchaseAt, general.timezone) : 'Never'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>
          Page {Math.min(page, pages)} of {pages} · {total} customer{total === 1 ? '' : 's'}
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
