import { prisma } from '@/lib/db/prisma'
import { env } from '@/lib/config/env'
import { encryptSecret, maskSecret, tryDecryptSecret } from '@/lib/security/crypto'
import type { EncryptionMode, GeneralSettings, PaymentEnvironment, PayPalSettings, SmtpSettings } from '@prisma/client'

const SINGLETON = 'singleton'

export type General = GeneralSettings
export type PayPalRow = PayPalSettings
export type SmtpRow = SmtpSettings

/**
 * CONFIGURATION POLICY
 * 1. Values saved through the admin UI are stored encrypted in MongoDB and win.
 * 2. Environment variables are fallback defaults only, used when a row/field is unset.
 * 3. Plaintext secrets are never persisted and never returned to the browser.
 */

/**
 * `upsert` is not safe when several server workers initialise a fresh database at
 * the same moment (Next.js page-data collection does exactly that). An idempotent
 * insert followed by a read removes the duplicate-key noise while still creating
 * the singleton on first boot.
 */
export async function getGeneral(): Promise<General> {
  await prisma.generalSettings.createMany({ data: [{ key: SINGLETON }], skipDuplicates: true })
  return prisma.generalSettings.findUniqueOrThrow({ where: { key: SINGLETON } })
}

export async function getPayPal(): Promise<PayPalRow> {
  await prisma.payPalSettings.createMany({ data: [{ key: SINGLETON }], skipDuplicates: true })
  return prisma.payPalSettings.findUniqueOrThrow({ where: { key: SINGLETON } })
}

export async function getSmtp(): Promise<SmtpRow> {
  await prisma.smtpSettings.createMany({ data: [{ key: SINGLETON }], skipDuplicates: true })
  return prisma.smtpSettings.findUniqueOrThrow({ where: { key: SINGLETON } })
}

export type PayPalCredentials = {
  clientId: string
  secret: string
  environment: PaymentEnvironment
  webhookId: string | null
  source: 'db' | 'env'
}

export function resolvePayPalCredentials(settings: PayPalRow): PayPalCredentials | null {
  return payPalCredentialsFor(settings, settings.environment)
}

/**
 * The environment argument is explicit because a refund must run against the
 * account the payment was captured in, which can differ from the environment the
 * admin has selected right now.
 */
export function payPalCredentialsFor(
  settings: PayPalRow,
  environment: PaymentEnvironment,
): PayPalCredentials | null {
  const dbId = environment === 'LIVE' ? settings.liveClientId : settings.sandboxClientId
  const dbSecret = tryDecryptSecret(environment === 'LIVE' ? settings.liveClientSecret : settings.sandboxClientSecret)
  const envId = environment === 'LIVE' ? env.PAYPAL_LIVE_CLIENT_ID : env.PAYPAL_SANDBOX_CLIENT_ID
  const envSecret = environment === 'LIVE' ? env.PAYPAL_LIVE_CLIENT_SECRET : env.PAYPAL_SANDBOX_CLIENT_SECRET
  const envWebhook = environment === 'LIVE' ? env.PAYPAL_WEBHOOK_ID_LIVE : env.PAYPAL_WEBHOOK_ID_SANDBOX

  // Support the prompt's generic PAYPAL_CLIENT_ID/SECRET names as a fallback for
  // the environment selected by PAYPAL_MODE.
  const genericMode: PaymentEnvironment = env.PAYPAL_MODE === 'live' ? 'LIVE' : 'SANDBOX'
  const genericId = genericMode === environment ? env.PAYPAL_CLIENT_ID : undefined
  const genericSecret = genericMode === environment ? env.PAYPAL_CLIENT_SECRET : undefined

  const clientId = dbId || envId || genericId
  const secret = dbSecret || envSecret || genericSecret
  if (!clientId || !secret) return null

  return {
    clientId,
    secret,
    environment,
    webhookId:
      (environment === 'LIVE' ? settings.webhookIdLive : settings.webhookIdSandbox) ||
      envWebhook ||
      (genericMode === environment ? env.PAYPAL_WEBHOOK_ID : null) ||
      null,
    source: dbId && dbSecret ? 'db' : 'env',
  }
}

export type SmtpResolved = {
  host: string
  port: number
  secure: boolean
  requireTLS: boolean
  auth: { user: string; pass: string } | null
  from: string
  senderName: string
  replyTo: string | null
  allowSelfSigned: boolean
  pool: boolean
}

export function resolveSmtp(settings: SmtpRow): SmtpResolved | null {
  if (!settings.enabled || !settings.host || !settings.senderEmail) return null
  const password = tryDecryptSecret(settings.password)
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.encryption === 'TLS',
    requireTLS: settings.encryption === 'STARTTLS',
    auth: settings.username && password ? { user: settings.username, pass: password } : null,
    from: settings.senderName ? `"${settings.senderName}" <${settings.senderEmail}>` : settings.senderEmail,
    senderName: settings.senderName ?? settings.senderEmail,
    replyTo: settings.replyToEmail ?? settings.senderEmail,
    allowSelfSigned: settings.allowSelfSigned,
    pool: settings.pool,
  }
}

/** Shape safe for the admin UI: secret material is replaced with a mask. */
export function publicPayPalConfig(settings: PayPalRow) {
  const credentials = payPalCredentialsFor(settings, settings.environment)
  const enabled = Boolean(credentials) && (settings.enabled || credentials?.source === 'env')
  return {
    enabled,
    clientId: credentials?.clientId ?? null,
    environment: settings.environment,
    currency: settings.currency,
  }
}

export function publicPayPal(settings: PayPalRow) {
  const credentials = resolvePayPalCredentials(settings)
  return {
    enabled: settings.enabled,
    environment: settings.environment,
    sandboxClientId: settings.sandboxClientId ?? env.PAYPAL_SANDBOX_CLIENT_ID ?? null,
    hasSandboxSecret: Boolean(maskSecret(settings.sandboxClientSecret) || env.PAYPAL_SANDBOX_CLIENT_SECRET),
    liveClientId: settings.liveClientId ?? env.PAYPAL_LIVE_CLIENT_ID ?? null,
    hasLiveSecret: Boolean(maskSecret(settings.liveClientSecret) || env.PAYPAL_LIVE_CLIENT_SECRET),
    webhookIdSandbox: settings.webhookIdSandbox ?? env.PAYPAL_WEBHOOK_ID_SANDBOX ?? null,
    webhookIdLive: settings.webhookIdLive ?? env.PAYPAL_WEBHOOK_ID_LIVE ?? null,
    currency: settings.currency,
    lastTestAt: settings.lastTestAt,
    lastTestOk: settings.lastTestOk,
    lastTestError: settings.lastTestError,
    updatedAt: settings.updatedAt,
    ready: Boolean(credentials && settings.enabled),
  }
}

export function publicSmtp(settings: SmtpRow) {
  return {
    enabled: settings.enabled,
    host: settings.host,
    port: settings.port,
    encryption: settings.encryption as EncryptionMode,
    username: settings.username,
    hasPassword: Boolean(settings.password),
    senderName: settings.senderName,
    senderEmail: settings.senderEmail,
    replyToEmail: settings.replyToEmail,
    allowSelfSigned: settings.allowSelfSigned,
    pool: settings.pool,
    lastTestAt: settings.lastTestAt,
    lastTestOk: settings.lastTestOk,
    lastTestError: settings.lastTestError,
    updatedAt: settings.updatedAt,
    ready: Boolean(settings.enabled && settings.host && settings.senderEmail),
  }
}

export async function savePaypal(
  input: Partial<Omit<PayPalSettings, 'id' | 'key' | 'createdAt' | 'updatedAt' | 'updatedBy' | 'sandboxClientSecret' | 'liveClientSecret'>> & {
    sandboxClientSecret?: string | null
    liveClientSecret?: string | null
    updatedBy?: string
  },
): Promise<PayPalRow> {
  const current = await getPayPal()
  const { sandboxClientSecret, liveClientSecret, updatedBy, ...rest } = input

  const data: Record<string, unknown> = { ...rest }
  // An empty string means "clear"; undefined means "leave the stored secret alone".
  if (sandboxClientSecret !== undefined) data.sandboxClientSecret = sandboxClientSecret ? encryptSecret(sandboxClientSecret) : null
  if (liveClientSecret !== undefined) data.liveClientSecret = liveClientSecret ? encryptSecret(liveClientSecret) : null

  return prisma.payPalSettings.update({
    where: { id: current.id },
    data: data as PayPalSettings,
  })
}

export async function saveSmtp(
  input: Partial<Omit<SmtpSettings, 'id' | 'key' | 'updatedAt' | 'updatedBy' | 'password'>> & {
    password?: string | null
    updatedBy?: string
  },
): Promise<SmtpRow> {
  const current = await getSmtp()
  const { password, updatedBy, ...rest } = input
  const data: Record<string, unknown> = { ...rest }
  if (password !== undefined) data.password = password ? encryptSecret(password) : null
  return prisma.smtpSettings.update({ where: { id: current.id }, data: data as SmtpSettings })
}

export async function saveGeneral(
  input: Partial<Omit<GeneralSettings, 'id' | 'key' | 'updatedAt' | 'updatedBy'>> & { updatedBy?: string },
): Promise<General> {
  const current = await getGeneral()
  const { updatedBy, ...rest } = input
  return prisma.generalSettings.update({ where: { id: current.id }, data: rest })
}

/**
 * Receipt numbering uses an atomic counter increment, so two concurrent orders
 * can never receive the same reference.
 */
export async function bumpReceiptCounter(): Promise<number> {
  const current = await getGeneral()
  const updated = await prisma.generalSettings.updateMany({
    where: { id: current.id },
    data: { receiptCounter: { increment: 1 } },
  })
  if (updated.count !== 1) throw new Error('Failed to increment receipt counter')
  const row = await prisma.generalSettings.findUnique({ where: { id: current.id }, select: { receiptCounter: true } })
  return row?.receiptCounter ?? 1
}
