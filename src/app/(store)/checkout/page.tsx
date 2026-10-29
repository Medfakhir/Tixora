import Link from 'next/link'
import { CalendarDays, ShieldCheck } from 'lucide-react'
import { getGeneral } from '@/lib/settings/service'
import { formatSessionDate, formatSessionDateKey, formatSessionLabel, formatSessionTime, priceSelection, type PricedSelection } from '@/lib/products/availability'
import { getPublishedProduct } from '@/lib/products/catalog'
import { ProductUnavailableError } from '@/lib/inventory/errors'
import { CheckoutForm } from '@/components/store/checkout-form'
import { CheckoutSessionPicker } from '@/components/store/checkout-session-picker'
import { Money } from '@/components/shared/money'
import { FieldRow } from '@/components/shared/field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'

export const metadata = { title: 'Checkout' }

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const slug = first(params.slug)
  const sessionId = first(params.session)
  const quantityParam = first(params.qty)
  const requestedQuantity = quantityParam === null ? null : Number.parseInt(quantityParam, 10)
  const general = await getGeneral()

  let priced: PricedSelection | null = null
  let errorMessage: string | null = null
  let sessionOptions: {
    id: string
    dateKey: string
    dateLabel: string
    startTime: string
    timeLabel: string
    name: string | null
    available: number
  }[] = []

  if (!slug) {
    errorMessage = 'No ticket was selected for checkout.'
  } else {
    const product = await getPublishedProduct(slug)

    if (!product) {
      errorMessage = 'This ticket is not currently on sale.'
    } else if (product.requiresSession && product.sessions.length === 0) {
      errorMessage = 'There are no dates currently available for this ticket.'
    } else {
      const minQuantity = product.minTickets
      const maxQuantity = Math.min(product.maxTickets, general.maxTicketsPerOrder)
      const selectedSession = product.requiresSession
        ? (product.sessions.find((session) => session.id === sessionId) ??
          product.sessions.find((session) => session.available >= minQuantity) ??
          product.sessions[0])
        : null
      const availableForSelection = product.requiresSession ? (selectedSession?.available ?? 0) : product.available
      const quantityUpperBound = Math.max(minQuantity, Math.min(maxQuantity, availableForSelection))
      const quantity =
        requestedQuantity !== null && Number.isFinite(requestedQuantity)
          ? Math.min(Math.max(Math.trunc(requestedQuantity), minQuantity), quantityUpperBound)
          : minQuantity

      sessionOptions = product.requiresSession
        ? product.sessions.map((session) => ({
            id: session.id,
            dateKey: formatSessionDateKey(session, general.timezone),
            dateLabel: formatSessionDate(session, general.timezone),
            startTime: session.startTime,
            timeLabel: formatSessionTime(session),
            name: session.label,
            available: session.available,
          }))
        : []

      try {
        priced = await priceSelection({ slug, eventSessionId: selectedSession?.id ?? null, quantity })
      } catch (error) {
        errorMessage =
          error instanceof ProductUnavailableError
            ? error.message
            : 'This ticket cannot be purchased right now. Please return to the ticket page and try again.'
      }
    }
  }

  if (!priced) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-12">
        <Card className="mx-auto max-w-lg p-6">
          <CardHeader className="px-0 pt-0">
            <CardTitle>Checkout unavailable</CardTitle>
            <CardDescription>{errorMessage}</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Button render={<Link href={slug ? `/products/${encodeURIComponent(slug)}` : '/products'} />}>
              {slug ? 'Back to the ticket' : 'Browse tickets'}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const sessionLabel = formatSessionLabel(priced.session, general.timezone)
  const insufficientStock = priced.available < priced.quantity
  const maintenance = general.maintenanceMode
  const productHref = `/products/${encodeURIComponent(priced.product.slug)}`

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <div className="grid gap-6">
          <div>
            <h1 className="font-heading text-2xl font-semibold tracking-tight">Checkout</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter your details, then complete payment on PayPal. Tickets are emailed after payment is confirmed.
            </p>
          </div>

          {!maintenance && sessionOptions.length > 0 ? (
            <CheckoutSessionPicker
              slug={priced.product.slug}
              sessions={sessionOptions}
              selectedId={priced.session?.id ?? null}
              quantity={priced.quantity}
              minTickets={priced.product.minTickets}
            />
          ) : null}

          {maintenance ? (
            <Card className="p-6">
              <Alert>
                <AlertTitle>Checkout is temporarily closed</AlertTitle>
                <AlertDescription>
                  The store is closed for maintenance right now. Your card has not been charged. Please try again
                  shortly.
                </AlertDescription>
              </Alert>
              <div className="mt-4">
                <Button variant="outline" render={<Link href={productHref} />}>
                  Back to the ticket
                </Button>
              </div>
            </Card>
          ) : insufficientStock ? (
            <Card className="p-6">
              <Alert variant="destructive">
                <AlertTitle>Not enough tickets remaining</AlertTitle>
                <AlertDescription>
                  Only {priced.available} ticket(s) are currently available for this selection. Choose another date or
                  reduce the quantity on the ticket page and try again.
                </AlertDescription>
              </Alert>
              <div className="mt-4">
                <Button variant="outline" render={<Link href={productHref} />}>
                  Back to the ticket
                </Button>
              </div>
            </Card>
          ) : (
            <CheckoutForm
              slug={priced.product.slug}
              eventSessionId={priced.session?.id ?? null}
              quantity={priced.quantity}
              requirePhone={general.requirePhone}
              totalMinor={priced.totalMinor}
              currency={priced.currency}
            />
          )}
        </div>

        <Card className="p-6 lg:sticky lg:top-20">
          <CardHeader className="px-0 pt-0">
            <CardTitle>Order summary</CardTitle>
            <CardDescription>{priced.product.name}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 px-0">
            <div className="flex items-start gap-3 rounded-lg bg-muted/60 p-3">
              <CalendarDays className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{sessionLabel}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {priced.quantity} ticket{priced.quantity === 1 ? '' : 's'}
                </p>
              </div>
            </div>

            <div>
              <FieldRow label="Price per ticket" value={<Money minor={priced.unitPriceMinor} currency={priced.currency} />} />
              <FieldRow label="Subtotal" value={<Money minor={priced.subtotalMinor} currency={priced.currency} />} />
              {priced.taxMinor > 0 ? (
                <FieldRow
                  label={general.taxLabel || 'Tax'}
                  value={<Money minor={priced.taxMinor} currency={priced.currency} />}
                />
              ) : null}
              <Separator className="my-2" />
              <FieldRow
                label="Total"
                value={<Money className="font-semibold" minor={priced.totalMinor} currency={priced.currency} />}
              />
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="size-4 shrink-0" />
              <span>Payment is processed securely by PayPal. We never see your card details.</span>
            </div>
            <p className="text-xs text-muted-foreground">{priced.available} ticket(s) available for this selection.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
