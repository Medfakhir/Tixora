import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, hashToken, maskSecret, sha256Hex, timingSafeEqual, tryDecryptSecret } from '@/lib/security/crypto'

describe('secret encryption', () => {
  it('round-trips a stored credential', () => {
    const secret = 'A1b2C3d4-paypal-client-secret'
    expect(decryptSecret(encryptSecret(secret))).toBe(secret)
  })

  it('never stores the plaintext inside the ciphertext', () => {
    const secret = 'super-secret-value'
    const stored = encryptSecret(secret)
    expect(stored).not.toContain(secret)
    expect(stored.startsWith('v1:')).toBe(true)
  })

  it('uses a fresh nonce so equal secrets have different ciphertexts', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
  })

  it('rejects a tampered ciphertext instead of returning garbage', () => {
    const parts = encryptSecret('tamper-me').split(':')
    const data = Buffer.from(parts[3], 'base64')
    data[0] ^= 0xff
    const tampered = [parts[0], parts[1], parts[2], data.toString('base64')].join(':')
    expect(() => decryptSecret(tampered)).toThrow()
    expect(tryDecryptSecret(tampered)).toBeNull()
  })

  it('rejects an unknown format version', () => {
    expect(tryDecryptSecret('v9:aaaa:bbbb:cccc')).toBeNull()
    expect(tryDecryptSecret('not-encrypted')).toBeNull()
    expect(tryDecryptSecret(null)).toBeNull()
    expect(tryDecryptSecret('')).toBeNull()
  })
})

describe('masking', () => {
  it('never returns the secret itself', () => {
    const stored = encryptSecret('my-smtp-password')
    const masked = maskSecret(stored)
    expect(masked).toBe('••••••••')
    expect(masked).not.toContain('my-smtp-password')
  })

  it('returns null for an unset secret', () => {
    expect(maskSecret(null)).toBeNull()
    expect(maskSecret(undefined)).toBeNull()
    expect(maskSecret('')).toBeNull()
  })
})

describe('token helpers', () => {
  it('hashes tokens deterministically to 64 hex characters', () => {
    expect(hashToken('token')).toBe(hashToken('token'))
    expect(hashToken('token')).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken('token')).not.toBe(hashToken('other'))
  })

  it('compares equal-length values without throwing', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })

  it('checksums bytes for duplicate-upload detection', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex(Buffer.from('abc')))
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/)
  })
})
