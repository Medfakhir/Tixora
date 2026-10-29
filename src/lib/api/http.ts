import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { UnauthorizedError, ForbiddenError } from '@/lib/auth/guards'
import { OrderError } from '@/lib/orders/service'
import { InventoryError } from '@/lib/inventory/errors'
import { PaypalApiError } from '@/lib/paypal/api'
import { MuseumBookingError } from '@/lib/museum/availability'
import { CheckInError } from '@/lib/museum/checkin'
import { fieldErrors } from '@/lib/validation'
import { isProduction, env } from '@/lib/config/env'

/** A failure the client is meant to see: safe message, HTTP status, optional field map. */
export class ApiError extends Error {
  status: number
  code: string
  fields?: Record<string, string>
  constructor(message: string, status = 400, code = 'BAD_REQUEST', fields?: Record<string, string>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.fields = fields
  }
}

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data }, { status })
}

export function fail(message: string, status = 400, code = 'BAD_REQUEST', fields?: Record<string, string>): NextResponse {
  return NextResponse.json({ ok: false, error: message, code, ...(fields ? { fields } : {}) }, { status })
}

/**
 * Cross-site request forgery guard for cookie-authenticated mutations. The session
 * cookie is SameSite=Lax, and this rejects any state change a browser sends from an
 * origin that is not this deployment. Requests without an Origin header (cron,
 * PayPal webhooks, server-to-server calls) carry no ambient cookie, so they pass.
 */
export function assertSameOrigin(request: Request): void {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return

  const origin = request.headers.get('origin')
  if (!origin) return

  const allowed = new Set<string>()
  const url = new URL(request.url)
  allowed.add(url.origin)
  try {
    allowed.add(new URL(env.APP_URL).origin)
  } catch {
    // A malformed APP_URL is caught by env validation at boot; treat it as absent here.
  }
  const forwardedHost = request.headers.get('x-forwarded-host')
  if (forwardedHost) {
    const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
    allowed.add(`${proto}://${forwardedHost}`)
  }

  if (!allowed.has(origin)) {
    throw new ApiError('This request came from an unrecognised origin.', 403, 'CSRF_REJECTED')
  }
}

/**
 * Wraps a handler so every thrown error becomes a JSON shape the forms understand and
 * nothing unexpected leaks a stack trace or driver message to the browser.
 */
export function withApi<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      const first = args[0]
      if (first instanceof Request) assertSameOrigin(first)
      return await handler(...args)
    } catch (error) {
      if (error instanceof ApiError) return fail(error.message, error.status, error.code, error.fields)
      if (error instanceof UnauthorizedError) return fail('Sign in required.', 401, 'UNAUTHORIZED')
      if (error instanceof ForbiddenError) return fail('You do not have access to this action.', 403, 'FORBIDDEN')
      if (error instanceof OrderError) return fail(error.message, error.status, error.code)
      if (error instanceof InventoryError) return fail(error.message, error.status, error.code)
      if (error instanceof MuseumBookingError) return fail(error.message, error.status, error.code)
      if (error instanceof CheckInError) return fail(error.message, error.status, error.code)
      if (error instanceof PaypalApiError) return fail(error.message, 502, 'PAYPAL_ERROR')
      if (error instanceof ZodError) return fail('Please correct the highlighted fields.', 422, 'VALIDATION', fieldErrors(error))

      console.error('[api] unhandled error', error)
      return fail(
        isProduction ? 'Something went wrong. Please try again.' : (error as Error).message,
        500,
        'INTERNAL_ERROR',
      )
    }
  }
}

/** Body parsing at the trust boundary: JSON only, and validated by the caller's schema. */
export async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new ApiError('A JSON body is required.', 415, 'UNSUPPORTED_MEDIA_TYPE')
  }
  try {
    return await request.json()
  } catch {
    throw new ApiError('Request body is not valid JSON.', 422, 'INVALID_JSON')
  }
}

export async function readFormData(request: Request): Promise<FormData> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('multipart/form-data')) {
    throw new ApiError('A multipart form upload is required.', 415, 'UNSUPPORTED_MEDIA_TYPE')
  }
  return request.formData()
}

/** Webhook verification needs the exact bytes PayPal signed, so the body is read as text. */
export async function readRawBody(request: Request): Promise<string> {
  return request.text()
}

export function searchParam(request: Request, name: string): string | null {
  const value = new URL(request.url).searchParams.get(name)
  return value === null || value === '' ? null : value
}

export function searchNumber(request: Request, name: string, fallback: number): number {
  const raw = searchParam(request, name)
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
