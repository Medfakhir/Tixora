'use client'

export type ApiOk<T> = { ok: true; data: T; status: number }
export type ApiFail = { ok: false; error: string; code: string; fields?: Record<string, string>; status: number }
export type ApiResult<T> = ApiOk<T> | ApiFail

/**
 * Single client-side entry point for our own API routes. Everything a form needs to
 * show (message, per-field errors, status) comes back in one predictable shape.
 */
export async function api<T = unknown>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; signal?: AbortSignal } = {},
): Promise<ApiResult<T>> {
  const isForm = init.body instanceof FormData
  let response: Response
  try {
    response = await fetch(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      signal: init.signal,
      headers: isForm ? undefined : init.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: (isForm ? init.body : init.body === undefined ? undefined : JSON.stringify(init.body)) as BodyInit | undefined,
    })
  } catch {
    return { ok: false, error: 'Network error — please check your connection.', code: 'NETWORK', status: 0 }
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const body = (payload ?? {}) as { error?: string; code?: string; fields?: Record<string, string> }
    return {
      ok: false,
      error: body.error ?? 'Request failed',
      code: body.code ?? 'UNKNOWN',
      fields: body.fields,
      status: response.status,
    }
  }

  const body = (payload ?? {}) as { data?: T }
  return { ok: true, data: body.data as T, status: response.status }
}

export function errorMessage(result: { error?: string }, fallback = 'Something went wrong.'): string {
  return result.error?.trim() || fallback
}
