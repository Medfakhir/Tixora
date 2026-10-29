import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'

const BCRYPT_ROUNDS = 12
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32: no I, L, O, U

function randomFromAlphabet(length: number, alphabet = ALPHABET): string {
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length]
  return out
}

/** Opaque id handed to the browser for an order status page. Not guessable, not sequential. */
export function generatePublicId(): string {
  return randomFromAlphabet(22)
}

/** Human-facing receipt reference, e.g. KBR-2026-7QF3KZ. */
export function generateOrderReference(prefix: string, year = new Date().getUTCFullYear()): string {
  return `${prefix.toUpperCase()}-${year}-${randomFromAlphabet(6)}`
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export function generateReservationCode(): string {
  return `${Date.now().toString(36).toUpperCase()}-${randomFromAlphabet(8)}`
}

export function generateIdempotencyKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash)
  } catch {
    return false
  }
}
