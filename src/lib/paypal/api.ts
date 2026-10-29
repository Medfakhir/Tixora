import { minorUnitsFor } from '@/lib/money'
import type { PaymentEnvironment } from '@prisma/client'

export type PaypalCredentials = { clientId: string; secret: string; environment: PaymentEnvironment }

const BASE_URL: Record<PaymentEnvironment, string> = {
  SANDBOX: 'https://api-m.sandbox.paypal.com',
  LIVE: 'https://api-m.paypal.com',
}

export class PaypalApiError extends Error {
  status: number
  details: unknown
  constructor(message: string, status = 502, details?: unknown) {
    super(message)
    this.name = 'PaypalApiError'
    this.status = status
    this.details = details
  }
}

type CachedToken = { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>()

/**
 * Access tokens are cached ~30s shorter than their real lifetime and are never
 * returned to a caller that could serialise them into a response body.
 */
export async function getAccessToken(credentials: PaypalCredentials): Promise<string> {
  const cacheKey = `${credentials.environment}:${credentials.clientId}`
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.token

  const response = await fetch(`${BASE_URL[credentials.environment]}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
    cache: 'no-store',
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new PaypalApiError(
      `PayPal rejected the credentials (${response.status}). Check the client ID and secret for ${credentials.environment} mode.`,
      response.status,
      redact(body),
    )
  }

  const json = (await response.json()) as { access_token: string; expires_in: number }
  tokenCache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + Math.max(0, json.expires_in - 30) * 1000 })
  return json.access_token
}

export function clearTokenCache(): void {
  tokenCache.clear()
}

function redact(text: string): string {
  return text.replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[redacted]"').slice(0, 2000)
}

async function paypalFetch(
  credentials: PaypalCredentials,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const token = await getAccessToken(credentials)
  const response = await fetch(`${BASE_URL[credentials.environment]}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body, headers: response.headers }
}

export function toPaypalAmount(minor: number, currency: string): { currency_code: string; value: string } {
  const exponent = minorUnitsFor(currency)
  return { currency_code: currency.toUpperCase(), value: (minor / 10 ** exponent).toFixed(exponent) }
}

export function fromPaypalAmount(amount: { currency_code?: string; value?: string } | undefined): { minor: number; currency: string } | null {
  if (!amount?.value) return null
  const currency = (amount.currency_code ?? 'USD').toUpperCase()
  const numeric = Number.parseFloat(amount.value)
  if (!Number.isFinite(numeric)) return null
  return { minor: Math.round(numeric * 10 ** minorUnitsFor(currency)), currency }
}

export type CreateOrderArgs = {
  credentials: PaypalCredentials
  /** Internal order id — echoed back so a capture can be tied to one order. */
  internalOrderId: string
  internalReference: string
  amountMinor: number
  currency: string
  description: string
  quantity: number
  brandName?: string
  returnUrl: string
  cancelUrl: string
}

export type CreatedPaypalOrder = { paypalOrderId: string; approvalUrl: string | null }

export async function createPaypalOrder(args: CreateOrderArgs): Promise<CreatedPaypalOrder> {
  const payload = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: args.internalOrderId,
        invoice_id: args.internalReference,
        description: args.description.slice(0, 127),
        custom_id: args.internalOrderId,
        quantity: String(args.quantity),
        amount: {
          currency_code: args.currency.toUpperCase(),
          value: toPaypalAmount(args.amountMinor, args.currency).value,
          breakdown: { total: { currency_code: args.currency.toUpperCase(), value: toPaypalAmount(args.amountMinor, args.currency).value } },
        },
      },
    ],
    application_context: {
      brand_name: args.brandName ?? 'Badi Palace Museum',
      user_action: 'PAY_NOW',
      return_url: args.returnUrl,
      cancel_url: args.cancelUrl,
    },
  }

  const { status, body } = await paypalFetch(args.credentials, '/v2/checkout/orders', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  if (status >= 400) throw new PaypalApiError('PayPal could not create the order.', status, body)
  const order = body as { id: string; links?: { rel: string; href: string }[] }
  const approval = order.links?.find((link) => link.rel === 'payer-action' || link.rel === 'approve')?.href ?? null
  return { paypalOrderId: order.id, approvalUrl: approval }
}

export type PaypalOrderDetails = {
  id: string
  status: string
  invoiceId: string | null
  referenceId: string | null
  captures: { id: string; status: string; amount: { minor: number; currency: string } | null; sellerEmail: string | null }[]
  raw: unknown
}

type PaypalOrderBody = {
  id?: string
  status?: string
  payee?: { email_address?: string }
  purchase_units?: {
    invoice_id?: string
    reference_id?: string
    payments?: {
      captures?: {
        id?: string
        status?: string
        amount?: { currency_code?: string; value?: string }
        supplementary_data?: { related_ids?: { capture_id?: string } }
      }[]
    }
  }[]
}

function parseOrder(body: unknown): PaypalOrderDetails {
  const order = (body ?? {}) as PaypalOrderBody
  const units = order.purchase_units ?? []
  const captures = units.flatMap((unit) =>
    (unit.payments?.captures ?? []).map((capture) => ({
      id: capture.supplementary_data?.related_ids?.capture_id ?? capture.id ?? '',
      status: capture.status ?? 'PENDING',
      amount: fromPaypalAmount(capture.amount),
      sellerEmail: order.payee?.email_address ?? null,
    })),
  )
  return {
    id: order.id ?? '',
    status: order.status ?? 'UNKNOWN',
    invoiceId: units[0]?.invoice_id ?? null,
    referenceId: units[0]?.reference_id ?? null,
    captures,
    raw: body,
  }
}

export async function getPaypalOrder(credentials: PaypalCredentials, paypalOrderId: string): Promise<PaypalOrderDetails> {
  const { status, body } = await paypalFetch(credentials, `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`)
  if (status === 404) throw new PaypalApiError('PayPal order not found.', 404, body)
  if (status >= 400) throw new PaypalApiError('Could not read the PayPal order.', status, body)
  return parseOrder(body)
}

/**
 * Server-side capture. The browser only ever supplies the PayPal order id; the
 * amount, currency and internal order are re-read from PayPal and matched by
 * invoice_id, so a forged or replayed approval cannot mark anything paid.
 */
export async function capturePaypalOrder(credentials: PaypalCredentials, paypalOrderId: string): Promise<PaypalOrderDetails> {
  const { status, body } = await paypalFetch(credentials, `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: 'POST',
    headers: { 'PayPal-Request-Id': `capture-${paypalOrderId}` },
  })
  // A duplicate capture returns 422 UNPROCESSABLE_ENTITY with the original order,
  // which we then read back rather than treating as a failure.
  if (status >= 400 && status !== 422) throw new PaypalApiError('PayPal capture failed.', status, body)
  const details = parseOrder(body)
  if (status === 422) {
    const fresh = await getPaypalOrder(credentials, paypalOrderId).catch(() => null)
    if (fresh) return fresh
  }
  return details
}

export async function refundCapture(
  credentials: PaypalCredentials,
  captureId: string,
  amountMinor: number,
  currency: string,
  note?: string,
): Promise<{ refundId: string; status: string; raw: unknown }> {
  const { status, body } = await paypalFetch(credentials, `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    method: 'POST',
    headers: { 'PayPal-Request-Id': `refund-${captureId}-${amountMinor}` },
    body: JSON.stringify({
      amount: { currency_code: currency.toUpperCase(), value: toPaypalAmount(amountMinor, currency).value },
      description: note?.slice(0, 127) ?? 'Refund issued from Badi Palace Museum admin',
    }),
  })
  if (status >= 400) throw new PaypalApiError('PayPal refund failed.', status, body)
  const result = body as { id: string; status: string }
  return { refundId: result.id, status: result.status, raw: body }
}

export type WebhookVerification = {
  certUrl: string | null
  authAlgo: string | null
  transmissionId: string | null
  transmissionSig: string | null
  transmissionTime: string | null
  webhookId: string
}

/**
 * Signature checking is delegated to PayPal's official verify-webhook-signature
 * endpoint, which re-derives the CRC against the exact raw request body.
 */
export async function verifyWebhook(
  credentials: PaypalCredentials,
  payload: { headers: WebhookVerification; rawBody: string },
): Promise<{ valid: boolean; verificationStatus: string | null; error?: string }> {
  const { headers, rawBody } = payload
  if (!headers.certUrl || !headers.authAlgo || !headers.transmissionId || !headers.transmissionSig || !headers.transmissionTime) {
    return { valid: false, verificationStatus: null, error: 'Missing PayPal webhook signature headers' }
  }
  // The certificate must come from PayPal, not an attacker-supplied URL.
  // PayPal sandbox cert URLs use two labels (api.sandbox.paypal.com), so allow any
  // number of subdomain labels while still restricting the registered domain.
  if (!/^https:\/\/([a-z0-9-]+\.)*paypal\.com\//i.test(headers.certUrl)) {
    return { valid: false, verificationStatus: null, error: 'Webhook cert_url host is not PayPal' }
  }

  let event: unknown
  try {
    event = rawBody ? JSON.parse(rawBody) : {}
  } catch {
    return { valid: false, verificationStatus: null, error: 'Webhook body is not valid JSON' }
  }

  const { status, body } = await paypalFetch(credentials, '/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: JSON.stringify({
      auth_algo: headers.authAlgo,
      cert_url: headers.certUrl,
      transmission_id: headers.transmissionId,
      transmission_sig: headers.transmissionSig,
      transmission_time: headers.transmissionTime,
      webhook_id: headers.webhookId,
      webhook_event: event,
    }),
  })

  if (status >= 400) return { valid: false, verificationStatus: null, error: `Verification request failed (${status})` }
  const result = body as { verification_status: string }
  return { valid: result.verification_status === 'SUCCESS', verificationStatus: result.verification_status }
}

/** Used by the admin "test connection" button. */
export async function testCredentials(credentials: PaypalCredentials): Promise<{ ok: boolean; message: string }> {
  try {
    const token = await getAccessToken(credentials)
    return { ok: true, message: `Authenticated against ${credentials.environment} (token received, ${token.length} chars)` }
  } catch (error) {
    const err = error as PaypalApiError
    return { ok: false, message: err.message || 'PayPal authentication failed' }
  }
}
