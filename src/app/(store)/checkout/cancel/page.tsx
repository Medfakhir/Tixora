import Link from 'next/link'
import { Clock3, ShieldCheck } from 'lucide-react'
import { prisma } from '@/lib/db/prisma'
import { getGeneral } from '@/lib/settings/service'
import { formatDateTime } from '@/lib/format'
import { Money } from '@/components/shared/money'
import { FieldRow } from '@/components/shared/field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'

export const metadata = { title: 'Checkout cancelled' }

const PAID_STATES = ['PAID', 'PROCESSING', 'COMPLETED', 'DELIVERY_FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED']

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export default async function CheckoutCancelPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const publicId = first(params.order) ?? first(params.publicId)
  const general = await getGeneral()

  const order = publicId
    ? await prisma.order.findUnique({
        where: { publicId },
        select: {
          reference: true,
          status: true,
          currency: true,
          totalMinor: true,
          reservationExpiresAt: true,
          sessionSummary: true,
          lines: {
            take: 1,
            select: {
              quantity: true,
              productName: true,
              eventSessionId: true,
              product: { select: { slug: true } },
            },
          },
        },
      })
    : null

  const line = order?.lines[0] ?? null
  const alreadyPaid = order ? PAID_STATES.includes(order.status) : false
  const productHref = line ? `/products/${encodeURIComponent(line.product.slug)}` : '/products'
  const retryHref = line
    ? `/checkout?slug=${encodeURIComponent(line.product.slug)}${
        line.eventSessionId ? `&session=${encodeURIComponent(line.eventSessionId)}` : ''
      }&qty=${line.quantity}`
    : '/products'
  const holdExpired = Boolean(order?.reservationExpiresAt && order.reservationExpiresAt < new Date())
  const orderHref = publicId ? `/order/${encodeURIComponent(publicId)}` : '/order'

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12">
      <Card className="p-6">
        <CardHeader className="px-0 pt-0">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Clock3 className="size-5" />
            </span>
            <div className="grid gap-1">
              <CardTitle className="text-xl">
                {alreadyPaid ? 'This order has already been paid' : 'Payment cancelled'}
              </CardTitle>
              <CardDescription>
                {alreadyPaid
                  ? 'PayPal may have completed the payment before the cancellation reached us. Check the order status before trying to pay again.'
                  : 'You cancelled at PayPal before completing the payment, so nothing has been charged.'}
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="grid gap-5 px-0">
          {alreadyPaid ? (
            <Alert>
              <AlertTitle>Payment may still be confirmed</AlertTitle>
              <AlertDescription>
                No further charge is needed. Open the order status page to see whether the payment was captured.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert>
              <AlertTitle>No payment was taken</AlertTitle>
              <AlertDescription>
                Your card and PayPal account have not been charged for this checkout.
                {order?.reservationExpiresAt
                  ? holdExpired
                    ? ` The booking hold expired on ${formatDateTime(order.reservationExpiresAt, general.timezone)}.`
                    : ` Your tickets stay on hold until ${formatDateTime(order.reservationExpiresAt, general.timezone)}, after which they return to sale automatically.`
                  : ''}
              </AlertDescription>
            </Alert>
          )}

          {order ? (
            <>
              <div>
                <FieldRow label="Order reference" value={order.reference} mono />
                {line ? <FieldRow label="Ticket" value={line.productName} /> : null}
                {order.sessionSummary ? <FieldRow label="Date and time" value={order.sessionSummary} /> : null}
                {line ? <FieldRow label="Quantity" value={line.quantity} /> : null}
                <Separator className="my-2" />
                <FieldRow
                  label={alreadyPaid ? 'Total paid' : 'Amount not charged'}
                  value={<Money className="font-semibold" minor={order.totalMinor} currency={order.currency} />}
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              If you cancelled at PayPal, no payment was taken. If you are unsure, look up your order with the
              reference and email address from your receipt.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {order && alreadyPaid ? (
              <Button render={<Link href={orderHref} />}>View order status</Button>
            ) : (
              <>
                <Button render={<Link href={retryHref} />}>Try checkout again</Button>
                <Button variant="outline" render={<Link href={productHref} />}>
                  Back to the ticket
                </Button>
              </>
            )}
            <Button variant="ghost" render={<Link href="/order" />}>
              Find my order
            </Button>
          </div>

          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0" />
            <span>If a payment appears on your statement without an order, contact support with the PayPal receipt.</span>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
