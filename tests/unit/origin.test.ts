import { describe, expect, it } from 'vitest'
import { assertSameOrigin } from '@/lib/api/http'

function request(method: string, headers: Record<string, string> = {}, url = 'http://localhost:3000/api/admin/settings/general') {
  return new Request(url, { method, headers })
}

describe('same-origin guard', () => {
  it('allows safe methods from any origin', () => {
    expect(() => assertSameOrigin(request('GET', { origin: 'https://evil.example' }))).not.toThrow()
    expect(() => assertSameOrigin(request('HEAD', { origin: 'https://evil.example' }))).not.toThrow()
  })

  it('allows a mutation from the deployment origin', () => {
    expect(() => assertSameOrigin(request('POST', { origin: 'http://localhost:3000' }))).not.toThrow()
  })

  it('allows APP_URL even when the request arrived through another host alias', () => {
    expect(() => assertSameOrigin(request('POST', { origin: 'http://localhost:3000' }, 'http://127.0.0.1:3000/api/x'))).not.toThrow()
  })

  it('rejects a cross-site mutation that would ride the admin cookie', () => {
    expect(() => assertSameOrigin(request('POST', { origin: 'https://evil.example' }))).toThrow(/unrecognised origin/)
    expect(() => assertSameOrigin(request('DELETE', { origin: 'null' }))).toThrow()
  })

  it('allows origin-less requests, which carry no ambient cookie', () => {
    expect(() => assertSameOrigin(request('POST'))).not.toThrow()
  })

  it('trusts the forwarded host of a reverse proxy', () => {
    const proxied = request('POST', {
      origin: 'https://tickets.example.com',
      'x-forwarded-host': 'tickets.example.com',
      'x-forwarded-proto': 'https',
    })
    expect(() => assertSameOrigin(proxied)).not.toThrow()
  })
})
