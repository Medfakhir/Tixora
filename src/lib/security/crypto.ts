import crypto from 'node:crypto'
import { env } from '@/lib/config/env'

const KEY = Buffer.from(env.SMTP_ENCRYPTION_KEY, 'hex')
const VERSION = 'v1'

/**
 * Secrets for PayPal/SMTP are encrypted at rest with AES-256-GCM so a database
 * dump alone never yields usable credentials. Ciphertext is versioned, which
 * leaves room to rotate the key without destroying stored settings.
 */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':')
}

export function decryptSecret(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(':')
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Unrecognised encrypted secret format')
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
}

export function tryDecryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null
  try {
    return decryptSecret(stored)
  } catch {
    // Wrong key or corrupted row: callers fall back to env-based credentials.
    return null
  }
}

export function hashToken(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/** Value shown in the admin UI in place of a stored secret. Never the secret itself. */
export function maskSecret(stored: string | null | undefined): string | null {
  if (!stored) return null
  return stored.length > 0 ? '••••••••' : null
}

export function randomBytes(n: number): Buffer {
  return crypto.randomBytes(n)
}

export function sha256Hex(buffer: Buffer | string): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}
