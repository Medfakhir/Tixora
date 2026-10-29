import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { Resend } from 'resend'
import { getSmtp, resolveSmtp, type SmtpResolved } from '@/lib/settings/service'
import { env } from '@/lib/config/env'

export type Attachment = { filename: string; content: Buffer; contentType: string }

/** Structural subset of nodemailer's SMTP transport options. */
type SmtpOptions = {
  host: string
  port: number
  secure: boolean
  requireTLS: boolean
  pool: boolean
  maxConnections: number
  tls: { rejectUnauthorized: boolean }
  auth?: { user: string; pass: string }
}

let cached: { fingerprint: string; transporter: Transporter } | null = null

function fingerprint(settings: SmtpResolved): string {
  // Rebuild the transporter only when the connection really changes.
  return [settings.host, settings.port, settings.secure, settings.requireTLS, settings.auth?.user, settings.pool].join('|')
}

function buildTransporter(settings: SmtpResolved): Transporter {
  const options: SmtpOptions = {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: settings.requireTLS,
    pool: settings.pool,
    maxConnections: 2,
    tls: {
      // Off by default; accepting a self-signed chain is an explicit admin opt-in.
      rejectUnauthorized: !settings.allowSelfSigned,
    },
  }
  if (settings.auth) options.auth = { user: settings.auth.user, pass: settings.auth.pass }
  return nodemailer.createTransport(options)
}

export async function getTransport(): Promise<{ transporter: Transporter; settings: SmtpResolved } | null> {
  const row = await getSmtp()
  const settings = resolveSmtp(row)
  if (!settings) return null
  const next = fingerprint(settings)
  if (!cached || cached.fingerprint !== next) cached = { fingerprint: next, transporter: buildTransporter(settings) }
  return { transporter: cached.transporter, settings }
}

/** Resend is the preferred provider when RESEND_API_KEY is present. */
export function resendConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY)
}

export async function canSendEmail(): Promise<boolean> {
  if (resendConfigured()) return true
  return Boolean(await getTransport())
}

export function resetTransportCache(): void {
  cached = null
}

export async function verifyConnection(): Promise<{ ok: boolean; message: string }> {
  const resolved = await getTransport()
  if (!resolved) {
    return { ok: false, message: 'SMTP is disabled or incomplete. Set host, sender email and enable delivery.' }
  }
  try {
    await resolved.transporter.verify()
    return { ok: true, message: `Connected to ${resolved.settings.host}:${resolved.settings.port}` }
  } catch (error) {
    // Never echo server challenges or credentials back to the UI.
    const message = (error as Error).message ?? 'SMTP verification failed'
    return { ok: false, message: message.split('\n')[0].slice(0, 300) }
  }
}

export async function sendEmail(input: {
  to: string
  subject: string
  html: string
  text: string
  attachments?: Attachment[]
  from?: string
  replyTo?: string | null
}): Promise<{ messageId: string }> {
  if (resendConfigured()) {
    const resend = new Resend(env.RESEND_API_KEY)
    const result = await resend.emails.send({
      from: input.from ?? env.RESEND_FROM ?? 'Badi Palace Museum <onboarding@resend.dev>',
      replyTo: input.replyTo ?? undefined,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      attachments: input.attachments?.length
        ? input.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: attachment.content.toString('base64'),
            contentType: attachment.contentType,
          }))
        : undefined,
    })
    if (result.error) throw new Error(result.error.message || 'Resend rejected the email')
    return { messageId: result.data?.id ?? '' }
  }

  const resolved = await getTransport()
  if (!resolved) throw new Error('No email provider is configured')
  const info = await resolved.transporter.sendMail({
    from: input.from ?? resolved.settings.from,
    replyTo: input.replyTo ?? resolved.settings.replyTo ?? undefined,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    attachments: input.attachments?.length ? input.attachments : undefined,
  })
  return { messageId: String(info.messageId ?? '') }
}
