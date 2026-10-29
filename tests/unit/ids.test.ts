import { describe, expect, it } from 'vitest'
import {
  generateIdempotencyKey,
  generateOrderReference,
  generatePublicId,
  generateReservationCode,
  generateSessionToken,
  hashPassword,
  verifyPassword,
} from '@/lib/security/ids'

describe('public ids and references', () => {
  it('generates 22-character public ids from an unambiguous alphabet', () => {
    const id = generatePublicId()
    expect(id).toHaveLength(22)
    expect(id).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/)
    expect(id).not.toMatch(/[ILOU]/)
  })

  it('does not repeat public ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generatePublicId()))
    expect(ids.size).toBe(500)
  })

  it('builds a shareable receipt reference with the store prefix', () => {
    expect(generateOrderReference('kbr', 2026)).toMatch(/^KBR-2026-[0-9A-Z]{6}$/)
  })

  it('makes session tokens long enough to be unguessable', () => {
    const token = generateSessionToken()
    expect(token.length).toBeGreaterThanOrEqual(40)
    expect(generateSessionToken()).not.toBe(token)
  })

  it('scopes idempotency keys by prefix', () => {
    expect(generateIdempotencyKey('TICKET_DELIVERY')).toMatch(/^TICKET_DELIVERY:[0-9a-f-]{36}$/)
  })

  it('formats reservation codes', () => {
    expect(generateReservationCode()).toMatch(/^[0-9A-Z]+-[0-9A-Z]{8}$/)
  })
})

describe('password hashing', () => {
  it('verifies the original password and rejects another', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).not.toContain('correct horse')
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
    expect(await verifyPassword('wrong password', hash)).toBe(false)
  })

  it('treats a malformed hash as a failed verification instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-bcrypt-hash')).toBe(false)
  })
})
