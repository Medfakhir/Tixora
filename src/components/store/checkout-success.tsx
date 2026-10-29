'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Clock3, QrCode, TriangleAlert } from 'lucide-react'
import type { DeliveryStatus, OrderStatus } from '@prisma/client'
import { api } from '@/lib/api/client'
import { Money } from '@/components/shared/money'
import { DeliveryStatusBadge, OrderStatusBadge } from '@/components/shared/status-badges'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { formatVisitDate } from '@/lib/museum/dates'
import { createTranslator, type Locale } from '@/lib/i18n/messages'

const POLL_INTERVAL_MS = 3000
const POLL_WINDOW_MS = 60_000

type PublicOrder = {
  kind: 'TICKET' | 'MUSEUM'
  reference: string
  status: OrderStatus
  deliveryStatus: DeliveryStatus
  currency: string
  totalMinor: number
  sessionSummary: string
  visitDate: string | null
  adultQty: number
  childQty: number
  checkedInAt: string | null
  qrDataUrl: string | null
  lines: { productName: string; quantity: number }[]
  emails: { status: string; sentAt: string | null }[]
}

type Phase = 'capturing' | 'polling' | 'done' | 'timeout'

const TERMINAL_ORDER_STATUSES: OrderStatus[] = [
  'COMPLETED',
  'DELIVERY_FAILED',
  'PAYMENT_FAILED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
]

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function isTerminal(order: PublicOrder): boolean {
  if (TERMINAL_ORDER_STATUSES.includes(order.status)) return true
  return order.deliveryStatus === 'SENT' || order.deliveryStatus === 'FAILED' || order.deliveryStatus === 'NOT_REQUIRED'
}

export function CheckoutSuccessClient({
  locale,
  params,
}: {
  locale: Locale
  params: Record<string, string | string[] | undefined>
}) {
  const t = createTranslator(locale)
  const publicId = first(params.order) ?? first(params.publicId)
  const paypalOrderId = first(params.token) ?? first(params.paypalOrderId)

  const [order, setOrder] = useState<PublicOrder | null>(null)
  const [phase, setPhase] = useState<Phase>(paypalOrderId ? 'capturing' : 'polling')
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!publicId) return
    const orderPublicId = publicId

    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const startedAt = Date.now()

    async function poll() {
      const result = await api<PublicOrder>(`/api/orders/${encodeURIComponent(orderPublicId)}`, {
        signal: controller.signal,
      })
      if (!active) return

      if (result.ok) {
        setOrder(result.data)
        setLoadError(null)
        if (isTerminal(result.data)) {
          setPhase('done')
          return
        }
        setPhase('polling')
        if (Date.now() - startedAt >= POLL_WINDOW_MS) {
          setPhase('timeout')
          return
        }
      } else {
        setLoadError(result.error)
        if (result.status === 404) {
          setPhase('done')
          return
        }
        setPhase('polling')
      }

      if (Date.now() - startedAt >= POLL_WINDOW_MS) {
        setPhase('timeout')
        return
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS)
    }

    async function capturePayment() {
      const captured = await api('/api/paypal/capture-order', {
        method: 'POST',
        body: { publicId: orderPublicId, paypalOrderId },
        signal: controller.signal,
      })
      if (!active) return
      if (!captured.ok) setCaptureError(captured.error)
    }

    async function run() {
      if (paypalOrderId) void capturePayment()
      await poll()
    }

    void run()

    return () => {
      active = false
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [publicId, paypalOrderId])

  if (!publicId) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-12">
        <Card className="mx-auto max-w-lg p-6">
          <CardHeader className="px-0 pt-0">
            <CardTitle>{t('success.order')}</CardTitle>
            <CardDescription>{t('success.subtitle')}</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Button render={<Link href="/order" />}>{t('actions.findOrder')}</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const museum = order?.kind === 'MUSEUM'
  const delivered = order?.deliveryStatus === 'SENT'
  const pending = phase === 'capturing' || (phase === 'polling' && !delivered)
  const paymentConfirmed = Boolean(
    order && ['PAID', 'PROCESSING', 'COMPLETED', 'DELIVERY_FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(order.status),
  )

  const headline = !order
    ? phase === 'capturing'
      ? t('success.pendingTitle')
      : t('success.pendingTitle')
    : museum
      ? paymentConfirmed
        ? t('success.title')
        : t('success.pendingTitle')
      : order.status === 'PAYMENT_FAILED'
        ? 'Payment not completed'
        : order.status === 'CANCELLED'
          ? 'Order cancelled'
          : order.status === 'REFUNDED' || order.status === 'PARTIALLY_REFUNDED'
            ? 'Order refunded'
            : order.status === 'DELIVERY_FAILED'
              ? 'Payment received — ticket delivery failed'
              : order.status === 'COMPLETED' || delivered
                ? 'Payment received and tickets delivered'
                : order.status === 'PAID' || order.status === 'PROCESSING'
                  ? 'Payment received'
                  : t('success.pendingTitle')

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-14">
      <Card className="p-6">
        <CardHeader className="px-0 pt-0">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              {delivered || (museum && paymentConfirmed) ? (
                <CheckCircle2 className="size-5" />
              ) : pending ? (
                <Clock3 className="size-5" />
              ) : (
                <TriangleAlert className="size-5" />
              )}
            </span>
            <div className="grid gap-1">
              <CardTitle className="text-xl">{headline}</CardTitle>
              <CardDescription>
                {museum && paymentConfirmed ? t('success.subtitle') : order ? t('success.pendingSubtitle') : t('success.pendingSubtitle')}
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="grid gap-5 px-0">
          {captureError && !paymentConfirmed ? (
            <Alert variant="destructive">
              <AlertTitle>We could not confirm the payment automatically</AlertTitle>
              <AlertDescription>{captureError} We will keep checking the order status.</AlertDescription>
            </Alert>
          ) : null}

          {loadError && !order ? (
            <Alert variant="destructive">
              <AlertTitle>{phase === 'done' ? 'Order not found' : 'Order status unavailable'}</AlertTitle>
              <AlertDescription>
                {loadError}
                {phase === 'done' ? ' Check the link or look up the order with your reference and email.' : ''}
              </AlertDescription>
            </Alert>
          ) : null}

          {order ? (
            <>
              {museum && order.qrDataUrl ? (
                <div className="grid gap-3 rounded-xl border bg-muted/30 p-5 text-center">
                  <p className="flex items-center justify-center gap-2 text-sm font-medium">
                    <QrCode className="size-4" /> {t('success.qr')}
                  </p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={order.qrDataUrl}
                    alt={`QR code for booking ${order.reference}`}
                    width={240}
                    height={240}
                    className="mx-auto rounded-lg bg-white p-2"
                  />
                  <p className="text-xs text-muted-foreground">{t('success.qrHint')}</p>
                  <p className="font-mono text-xs text-muted-foreground">{order.reference}</p>
                  {order.checkedInAt ? (
                    <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{t('success.checkedIn')}</p>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">{t('success.order')}</span>
                  <span className="font-mono text-sm font-medium">{order.reference}</span>
                </div>
                {museum && order.visitDate ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-sm text-muted-foreground">{t('success.visit')}</span>
                    <span className="text-sm font-medium">{formatVisitDate(order.visitDate, locale)}</span>
                  </div>
                ) : null}
                {museum ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-sm text-muted-foreground">{t('success.tickets')}</span>
                    <span className="text-sm font-medium">
                      {order.adultQty} × {t('tickets.adult')} · {order.childQty} × {t('tickets.child')}
                    </span>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">{t('success.total')}</span>
                  <Money className="text-sm font-medium" minor={order.totalMinor} currency={order.currency} />
                </div>
                <Separator />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">Payment</span>
                  <OrderStatusBadge status={order.status} />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">{t('success.email')}</span>
                  <DeliveryStatusBadge status={order.deliveryStatus} />
                </div>
                {!museum && order.lines.length > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {order.lines.map((line) => `${line.quantity} × ${line.productName}`).join(', ')}
                    {order.sessionSummary ? ` · ${order.sessionSummary}` : ''}
                  </p>
                ) : null}
              </div>

              {phase === 'timeout' ? (
                <Alert>
                  <AlertTitle>Still waiting for confirmation</AlertTitle>
                  <AlertDescription>
                    This is taking longer than usual. Payment may still be processing, so open your order page for the
                    latest status instead of paying again.
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button render={<Link href={`/order/${encodeURIComponent(publicId)}`} />}>{t('actions.viewOrder')}</Button>
                <Button variant="outline" render={<Link href="/#book" />}>
                  {t('actions.bookAnother')}
                </Button>
              </div>
            </>
          ) : phase === 'timeout' ? (
            <Alert>
              <AlertTitle>Still waiting for confirmation</AlertTitle>
              <AlertDescription>
                This is taking longer than usual. Payment may still be processing, so open your order page for the
                latest status instead of paying again.
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-sm text-muted-foreground">{t('success.pendingSubtitle')}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
