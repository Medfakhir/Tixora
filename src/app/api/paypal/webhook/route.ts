import { NextResponse } from 'next/server'
import { getPayPal, payPalCredentialsFor } from '@/lib/settings/service'
import { verifyWebhook, type WebhookVerification } from '@/lib/paypal/api'
import { handleWebhookEvent } from '@/lib/orders/payment-flow'
import { recordAudit } from '@/lib/auth/guards'
import { minorUnitsFor } from '@/lib/money'
import { isProduction } from '@/lib/config/env'

export const dynamic = 'force-dynamic'
// The handler re-captures from PayPal and sends the confirmation email in-request.
export const maxDuration = 30

type PaypalEvent = {
  id?: string
  event_type?: string
  resource?: {
    id?: string
    status?: string
    amount?: { currency_code?: string; value?: string }
    supplementary_data?: { related_ids?: { order_id?: string; capture_id?: string } }
  }
}

/**
 * Webhooks are the only payment signal we trust unconditionally, and only after PayPal
 * itself has confirmed the signature against the exact bytes we received.
 */
export async function POST(request: Request) {
  const rawBody = await request.text()
  const settings = await getPayPal()
  const environment = settings.environment
  const credentials = payPalCredentialsFor(settings, environment)
  const webhookId = credentials?.webhookId ?? null

  const headers: WebhookVerification = {
    certUrl: request.headers.get('paypal-cert-url'),
    authAlgo: request.headers.get('paypal-auth-algo'),
    transmissionId: request.headers.get('paypal-transmission-id'),
    transmissionSig: request.headers.get('paypal-transmission-sig'),
    transmissionTime: request.headers.get('paypal-transmission-time'),
    webhookId: webhookId ?? '',
  }

  let event: PaypalEvent
  try {
    event = JSON.parse(rawBody) as PaypalEvent
  } catch {
    return NextResponse.json({ received: false, reason: 'invalid_json' }, { status: 400 })
  }

  if (!credentials || !webhookId) {
    // Without a configured webhook id we cannot verify anything, so nothing is applied.
    await recordAudit({
      actorType: 'SYSTEM',
      action: 'WEBHOOK_REJECTED_UNCONFIGURED',
      entityType: 'PaymentWebhookEvent',
      entityId: event.id ?? null,
      summary: 'PayPal webhook received while no webhook id is configured',
    })
    return NextResponse.json({ received: false, reason: 'not_configured' }, { status: 503 })
  }

  const verification = await verifyWebhook(credentials, { headers, rawBody })
  const resource = event.resource ?? {}
  const related = resource.supplementary_data?.related_ids ?? {}
  const amountValue = resource.amount?.value
  const amountCurrency = resource.amount?.currency_code ?? null

  const result = await handleWebhookEvent({
    rawBody,
    eventType: event.event_type ?? 'UNKNOWN',
    eventId: event.id ?? null,
    resourceId: resource.id ?? null,
    resourceOrderId: related.order_id ?? resource.id ?? null,
    captureId: related.capture_id ?? resource.id ?? null,
    amountMinor: amountValue && amountCurrency ? Math.round(Number.parseFloat(amountValue) * 10 ** minorUnitsFor(amountCurrency)) : null,
    currency: amountCurrency,
    environment,
    verified: verification.valid,
    status: verification.valid ? 'RECEIVED' : 'SIGNATURE_INVALID',
    error: verification.error,
  })

  if (!verification.valid && !isProduction) {
    console.warn('[webhook] signature rejected', { event: event.id, reason: verification.error })
  }

  return NextResponse.json({ received: true, duplicate: result.duplicate, applied: result.orderPaid })
}
