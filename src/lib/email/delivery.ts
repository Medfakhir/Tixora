import { prisma } from '@/lib/db/prisma'
import { getStorage } from '@/lib/storage'
import { sendEmail, canSendEmail, type Attachment } from './transport'
import { DEFAULT_TEMPLATES, buildTicketLinks, money, renderTemplate, TEMPLATE_KEYS, type TemplateData, type TemplateKey } from './templates'
import { getGeneral, type General } from '@/lib/settings/service'
import { formatVisitDate } from '@/lib/museum/dates'
import { qrDataUrl, qrPng } from '@/lib/museum/qr'
import { env } from '@/lib/config/env'
import { markDelivered, markDeliveryFailed, stageForDeliveryRetry } from '@/lib/inventory/claim'
import { recordAudit } from '@/lib/auth/guards'

const MAX_ATTEMPTS = 5
const BACKOFF_MINUTES = [1, 5, 15, 60, 240]

export async function ensureTemplates(): Promise<number> {
  let created = 0
  for (const key of TEMPLATE_KEYS) {
    const existing = await prisma.emailTemplate.findUnique({ where: { key } })
    if (existing) continue
    const template = DEFAULT_TEMPLATES[key]
    await prisma.emailTemplate.create({
      data: { key, name: template.name, subject: template.subject, htmlBody: template.html, textBody: template.text, isActive: true },
    })
    created += 1
  }
  return created
}

async function templateFor(key: TemplateKey) {
  const row = await prisma.emailTemplate.findUnique({ where: { key } })
  if (row?.isActive) return { subject: row.subject, html: row.htmlBody, text: row.textBody }
  const fallback = DEFAULT_TEMPLATES[key]
  return { subject: fallback.subject, html: fallback.html, text: fallback.text }
}

/**
 * Queues the ticket email for a paid order. The idempotency key is derived from
 * the order, so a replayed webhook or a second capture attempt cannot queue a
 * second delivery of the same tickets.
 */
export async function queueTicketDelivery(orderId: string): Promise<{ queued: boolean; deliveryId: string | null }> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { lines: true, tickets: true } })
  if (!order) return { queued: false, deliveryId: null }
  if (!['PAID', 'PROCESSING', 'DELIVERY_FAILED', 'COMPLETED'].includes(order.status)) {
    return { queued: false, deliveryId: null }
  }
  if (order.kind === 'MUSEUM') return queueMuseumTicketDelivery(order.id)

  const idempotencyKey = `tickets:${order.id}`
  const existing = await prisma.emailDelivery.findUnique({ where: { idempotencyKey } })
  if (existing) {
    if (existing.status === 'SENT') return { queued: false, deliveryId: existing.id }
    if (existing.status === 'SENDING') return { queued: false, deliveryId: existing.id }
    // Re-queue a previously failed attempt for the same order.
    await prisma.emailDelivery.update({ where: { id: existing.id }, data: { status: 'QUEUED', nextRetryAt: new Date() } })
    return { queued: true, deliveryId: existing.id }
  }

  const [general, template] = await Promise.all([getGeneral(), templateFor('TICKET_DELIVERY')])
  const productName = order.lines.map((line) => line.productName).join(', ') || 'Your tickets'
  const rendered = renderTemplate(template, {
    storeName: general.storeName,
    customerName: order.customerName,
    orderReference: order.reference,
    productName,
    sessionSummary: order.sessionSummary,
    quantity: String(order.lines.reduce((sum, line) => sum + line.quantity, 0)),
    totalPaid: money(order.totalMinor, order.currency),
    supportEmail: general.supportEmail,
    supportPhone: general.supportPhone ? ` / ${general.supportPhone}` : '',
    orderUrl: `${appUrl()}/order/${order.publicId}`,
    ticketLinks: '',
    reason: '',
  })

  try {
    const delivery = await prisma.emailDelivery.create({
      data: {
        orderId: order.id,
        idempotencyKey,
        templateKey: 'TICKET_DELIVERY',
        to: order.customerEmail,
        toName: order.customerName,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        attachments: {
          create: order.tickets.map((ticket, index) => ({
            storageKey: ticket.storageKey,
            fileName: ticket.originalFileName,
            sortOrder: index,
          })),
        },
        status: 'QUEUED',
        nextRetryAt: new Date(),
      },
    })
    await prisma.order.update({ where: { id: order.id }, data: { deliveryStatus: 'QUEUED' } })
    return { queued: true, deliveryId: delivery.id }
  } catch {
    // Unique index hit: another concurrent worker already queued this order.
    const concurrent = await prisma.emailDelivery.findUnique({ where: { idempotencyKey } })
    return { queued: false, deliveryId: concurrent?.id ?? null }
  }
}

function appUrl(): string {
  return env.APP_URL.replace(/\/$/, '')
}

function museumData(
  order: {
    customerName: string
    reference: string
    visitDate: Date | null
    adultQty: number
    childQty: number
    totalMinor: number
    currency: string
    publicId: string
  },
  general: General,
  qrImage: string,
): TemplateData {
  const visitDate = formatVisitDate(order.visitDate, 'en')
  return {
    storeName: general.storeName,
    customerName: order.customerName,
    orderReference: order.reference,
    productName: 'Badi Palace Museum entrance',
    sessionSummary: visitDate,
    quantity: String(order.adultQty + order.childQty),
    totalPaid: money(order.totalMinor, order.currency),
    supportEmail: general.supportEmail,
    supportPhone: general.supportPhone ? ` / ${general.supportPhone}` : '',
    orderUrl: `${appUrl()}/order/${order.publicId}`,
    ticketLinks: '',
    reason: '',
    visitDate,
    adults: String(order.adultQty),
    children: String(order.childQty),
    qrImage,
    timezone: general.timezone,
  }
}

/**
 * Queues the museum confirmation. The QR is regenerated at send time so a retry
 * always attaches a valid current code; the message itself is idempotent per order.
 */
export async function queueMuseumTicketDelivery(orderId: string): Promise<{ queued: boolean; deliveryId: string | null }> {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order || order.kind !== 'MUSEUM') return { queued: false, deliveryId: null }
  if (!['PAID', 'PROCESSING', 'COMPLETED', 'DELIVERY_FAILED'].includes(order.status)) {
    return { queued: false, deliveryId: null }
  }

  const idempotencyKey = `museum:${order.id}`
  const existing = await prisma.emailDelivery.findUnique({ where: { idempotencyKey } })
  if (existing) {
    if (existing.status === 'SENT' || existing.status === 'SENDING') return { queued: false, deliveryId: existing.id }
    await prisma.emailDelivery.update({ where: { id: existing.id }, data: { status: 'QUEUED', nextRetryAt: new Date() } })
    return { queued: true, deliveryId: existing.id }
  }

  const [general, template] = await Promise.all([getGeneral(), templateFor('MUSEUM_TICKET')])
  const rendered = renderTemplate(template, museumData(order, general, ''))

  try {
    const delivery = await prisma.emailDelivery.create({
      data: {
        orderId: order.id,
        idempotencyKey,
        templateKey: 'MUSEUM_TICKET',
        to: order.customerEmail,
        toName: order.customerName,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        status: 'QUEUED',
        nextRetryAt: new Date(),
      },
    })
    await prisma.order.update({ where: { id: order.id }, data: { deliveryStatus: 'QUEUED' } })
    return { queued: true, deliveryId: delivery.id }
  } catch {
    const concurrent = await prisma.emailDelivery.findUnique({ where: { idempotencyKey } })
    return { queued: false, deliveryId: concurrent?.id ?? null }
  }
}

export async function queueAdminAlert(input: { orderId: string; reason: string; templateKey?: TemplateKey }): Promise<void> {
  const [general, template] = await Promise.all([getGeneral(), templateFor(input.templateKey ?? 'DELIVERY_FAILURE')])
  const order = await prisma.order.findUnique({ where: { id: input.orderId }, include: { lines: true } })
  if (!order) return
  const rendered = renderTemplate(template, {
    storeName: general.storeName,
    customerName: order.customerName,
    orderReference: order.reference,
    productName: order.lines?.[0]?.productName ?? '',
    sessionSummary: order.sessionSummary,
    quantity: '1',
    totalPaid: money(order.totalMinor, order.currency),
    supportEmail: order.customerEmail,
    supportPhone: general.supportPhone ? ` / ${general.supportPhone}` : '',
    orderUrl: `${appUrl()}/admin/orders/${order.id}`,
    ticketLinks: '',
    reason: input.reason,
  })
  const key = `admin-alert:${order.id}:${input.reason.slice(0, 40)}`
  const existing = await prisma.emailDelivery.findUnique({ where: { idempotencyKey: key } })
  if (existing) return
  await prisma.emailDelivery.create({
    data: {
      orderId: order.id,
      idempotencyKey: key,
      templateKey: input.templateKey ?? 'DELIVERY_FAILURE',
      to: general.supportEmail,
      ccAdmin: true,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      status: 'QUEUED',
      nextRetryAt: new Date(),
    },
  })
}

/**
 * A notification with no attachments (refunds, confirmations, admin alerts).
 * The caller supplies the idempotency key, so the same financial event can never
 * produce two emails even if the request is retried.
 */
async function queueSimpleEmail(input: {
  orderId: string
  templateKey: TemplateKey
  idempotencyKey: string
  to?: string
  reason?: string
}): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: input.orderId }, include: { lines: true } })
  if (!order) return
  const [general, template] = await Promise.all([getGeneral(), templateFor(input.templateKey)])
  const recipient = input.to ?? order.customerEmail
  const rendered = renderTemplate(template, {
    storeName: general.storeName,
    customerName: order.customerName,
    orderReference: order.reference,
    productName: order.lines.map((line) => line.productName).join(', ') || 'Your order',
    sessionSummary: order.sessionSummary,
    quantity: String(order.lines.reduce((sum, line) => sum + line.quantity, 0)),
    totalPaid: money(order.totalMinor, order.currency),
    supportEmail: general.supportEmail,
    supportPhone: general.supportPhone ? ` / ${general.supportPhone}` : '',
    orderUrl: `${appUrl()}/order/${order.publicId}`,
    ticketLinks: '',
    reason: input.reason ?? '',
  })

  const existing = await prisma.emailDelivery.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
  if (existing) return
  await prisma.emailDelivery.create({
    data: {
      orderId: order.id,
      idempotencyKey: input.idempotencyKey,
      templateKey: input.templateKey,
      to: recipient,
      toName: order.customerName,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      status: 'QUEUED',
      nextRetryAt: new Date(),
    },
  })
}

export async function queueRefundNotification(orderId: string, refundId: string, note: string): Promise<void> {
  await queueSimpleEmail({
    orderId,
    templateKey: 'REFUND_NOTIFICATION',
    idempotencyKey: `refund:${refundId}`,
    reason: note,
  })
}

export async function queueOrderConfirmation(orderId: string): Promise<void> {
  await queueSimpleEmail({ orderId, templateKey: 'ORDER_CONFIRMATION', idempotencyKey: `confirm:${orderId}` })
}

export type ProcessReport = { processed: number; sent: number; failed: number; skipped: number }
/** Drains the queue. Safe to call from the cron endpoint and from admin retries. */
export async function processDeliveryQueue(limit = 10): Promise<ProcessReport> {
  const now = new Date()
  const report: ProcessReport = { processed: 0, sent: 0, failed: 0, skipped: 0 }
  const candidates = await prisma.emailDelivery.findMany({
    where: { status: { in: ['QUEUED', 'FAILED'] }, attempts: { lt: MAX_ATTEMPTS }, OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
  })

  for (const candidate of candidates) {
    // Claim atomically so two workers never send the same message twice.
    const claimed = await prisma.emailDelivery.updateMany({
      where: { id: candidate.id, status: { in: ['QUEUED', 'FAILED'] } },
      data: { status: 'SENDING' },
    })
    if (claimed.count !== 1) {
      report.skipped += 1
      continue
    }
    report.processed += 1
    const result = await deliverOne(candidate.id)
    if (result.ok) report.sent += 1
    else report.failed += 1
  }

  return report
}

async function deliverOne(deliveryId: string): Promise<{ ok: boolean; error?: string }> {
  const delivery = await prisma.emailDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      attachments: { orderBy: { sortOrder: 'asc' } },
      order: { include: { tickets: true, lines: true } },
    },
  })
  if (!delivery) return { ok: false, error: 'Delivery row vanished' }

  if (!(await canSendEmail())) {
    return fail(delivery, 'No email provider is configured (set RESEND_API_KEY or SMTP)')
  }

  try {
    const storage = getStorage()
    const publicId = delivery.order?.publicId ?? ''
    const attachmentKeys = new Set(delivery.attachments.map((attachment) => attachment.storageKey))
    const selected = (delivery.order?.tickets ?? []).filter((ticket) => attachmentKeys.has(ticket.storageKey))
    const attachments: Attachment[] = []
    for (const [index, ticket] of selected.entries()) {
      const bytes = await storage.get(ticket.storageKey)
      attachments.push({
        // Deterministic, safe filename: no raw upload names reach the MIME part.
        filename: `${delivery.order?.reference ?? 'ticket'}-${index + 1}.pdf`,
        content: bytes,
        contentType: 'application/pdf',
      })
    }

    const isMuseum = delivery.templateKey === 'MUSEUM_TICKET' || delivery.order?.kind === 'MUSEUM'
    let qrImage = ''
    if (isMuseum && delivery.order) {
      qrImage = await qrDataUrl(delivery.order)
      attachments.push({
        filename: `QR-${delivery.order.reference}.png`,
        content: await qrPng(delivery.order),
        contentType: 'image/png',
      })
    }

    if (delivery.attachments.length > 0 && attachments.length === 0) {
      return fail(delivery, 'Ticket files could not be read from storage')
    }

    const general = await getGeneral()
    const orderUrl = `${appUrl()}/${publicId ? `order/${publicId}` : ''}`
    // Links carry the ticket id, never the internal storage key.
    const links = buildTicketLinks(
      attachments.map((attachment, index) => ({
        fileName: attachment.filename,
        url: publicId ? `${appUrl()}/api/orders/${publicId}/tickets/${selected[index].id}` : '',
      })),
    )
    const template = await templateFor(delivery.templateKey as TemplateKey)
    const rendered = renderTemplate(
      template,
      delivery.order && isMuseum
        ? museumData(delivery.order, general, qrImage)
        : {
            storeName: general.storeName,
            customerName: delivery.order?.customerName ?? delivery.toName ?? 'there',
            orderReference: delivery.order?.reference ?? '',
            productName: delivery.order?.lines?.[0]?.productName ?? 'Your tickets',
            sessionSummary: delivery.order?.sessionSummary ?? '',
            quantity: String(delivery.order?.tickets.length ?? 1),
            totalPaid: delivery.order ? money(delivery.order.totalMinor, delivery.order.currency) : '',
            supportEmail: general.supportEmail,
            supportPhone: general.supportPhone ? ` / ${general.supportPhone}` : '',
            orderUrl,
            ticketLinks: links,
            reason: '',
          },
    )

    await sendEmail({
      to: delivery.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      attachments,
    })

    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 }, lastError: null, nextRetryAt: null, subject: rendered.subject, html: rendered.html, text: rendered.text },
    })

    if (delivery.order) {
      if (delivery.order.kind === 'MUSEUM') {
        // Museum orders stay PAID; the confirmation email is not a ticket allocation.
        await prisma.order.update({ where: { id: delivery.order.id }, data: { deliveryStatus: 'SENT' } })
      } else {
        await markDelivered(delivery.order.tickets.map((ticket) => ticket.id))
        await prisma.order.update({
          where: { id: delivery.order.id },
          data: { status: 'COMPLETED', completedAt: delivery.order.completedAt ?? new Date(), deliveryStatus: 'SENT' },
        })
      }
    }
    await recordAudit({
      actorType: 'SYSTEM',
      action: 'EMAIL_SENT',
      entityType: 'EmailDelivery',
      entityId: delivery.id,
      summary: `Delivered ${attachments.length} ticket file(s) to ${delivery.to}`,
      metadata: { attempts: delivery.attempts + 1 },
    })
    return { ok: true }
  } catch (error) {
    return fail(delivery, (error as Error).message ?? 'Unknown SMTP error')
  }
}

/**
 * A failed email must never look like a failed payment: the order stays PAID,
 * the tickets stay allocated to it, and only the delivery row moves to FAILED.
 */
async function fail(delivery: { id: string; attempts: number; orderId: string | null; to: string }, message: string): Promise<{ ok: boolean; error: string }> {
  const attempts = delivery.attempts + 1
  const backoff = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]
  const exhausted = attempts >= MAX_ATTEMPTS
  await prisma.emailDelivery.update({
    where: { id: delivery.id },
    data: {
      status: 'FAILED',
      attempts,
      lastError: message.slice(0, 500),
      nextRetryAt: exhausted ? null : new Date(Date.now() + backoff * 60_000),
    },
  })
  if (delivery.orderId) {
    const order = await prisma.order.findUnique({ where: { id: delivery.orderId }, select: { kind: true } })
    if (order?.kind === 'MUSEUM') {
      // A failed email never invalidates a paid museum ticket or its QR code.
      await prisma.order.update({ where: { id: delivery.orderId }, data: { deliveryStatus: 'FAILED' } })
    } else {
      const tickets = await prisma.ticketInventory.findMany({ where: { orderId: delivery.orderId }, select: { id: true } })
      await markDeliveryFailed(tickets.map((ticket) => ticket.id), message)
      await prisma.order.update({ where: { id: delivery.orderId }, data: { status: 'DELIVERY_FAILED', deliveryStatus: 'FAILED' } })
    }
  }
  if (exhausted) {
    await queueAdminAlert({ orderId: delivery.orderId ?? '', reason: `Ticket delivery permanently failed for ${delivery.to}: ${message.slice(0, 200)}` })
  }
  await recordAudit({
    actorType: 'SYSTEM',
    action: 'EMAIL_FAILED',
    entityType: 'EmailDelivery',
    entityId: delivery.id,
    summary: `Delivery attempt ${attempts} failed for ${delivery.to}`,
    metadata: { error: message.slice(0, 300), exhausted },
  })
  return { ok: false, error: message }
}

/** Admin retry: re-arms the same delivery row, so no second email can duplicate the first. */
export async function retryDelivery(orderId: string, actor: { id: string; email: string }): Promise<{ ok: boolean; message: string }> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { tickets: true, lines: true } })
  if (!order) return { ok: false, message: 'Order not found' }
  if (!['PAID', 'DELIVERY_FAILED', 'COMPLETED', 'PROCESSING'].includes(order.status)) {
    return { ok: false, message: 'Only paid orders can be re-delivered.' }
  }

  if (order.kind === 'MUSEUM') {
    const museumDelivery = await prisma.emailDelivery.findUnique({ where: { idempotencyKey: `museum:${order.id}` } })
    if (museumDelivery) {
      await prisma.emailDelivery.update({
        where: { id: museumDelivery.id },
        data: { status: 'QUEUED', attempts: 0, nextRetryAt: new Date(), lastError: null },
      })
    } else {
      await queueMuseumTicketDelivery(order.id)
    }
    const report = await processDeliveryQueue(2)
    await recordAudit({
      actorType: 'ADMIN',
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'DELIVERY_RETRY',
      entityType: 'Order',
      entityId: order.id,
      summary: `Manual museum confirmation retry for ${order.reference}`,
      metadata: report,
    })
    return { ok: true, message: `Retry processed: ${report.sent} sent, ${report.failed} failed` }
  }

  await stageForDeliveryRetry(order.tickets.map((ticket) => ticket.id))
  const delivery = await prisma.emailDelivery.findUnique({ where: { idempotencyKey: `tickets:${order.id}` } })

  if (delivery?.status === 'SENT') {
    // Explicit, audited override: the tickets were already delivered once.
    if (!order.tickets.some((ticket) => ticket.status === 'FAILED_DELIVERY')) {
      return { ok: false, message: 'Tickets were already delivered. Reset the delivery row to force a resend.' }
    }
  }

  if (delivery) {
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: { status: 'QUEUED', attempts: 0, nextRetryAt: new Date(), lastError: null },
    })
  } else {
    await queueTicketDelivery(order.id)
  }

  const report = await processDeliveryQueue(2)
  await recordAudit({
    actorType: 'ADMIN',
    actorId: actor.id,
    actorLabel: actor.email,
    action: 'DELIVERY_RETRY',
    entityType: 'Order',
    entityId: order.id,
    summary: `Manual delivery retry for ${order.reference}`,
    metadata: report,
  })
  return { ok: true, message: `Retry processed: ${report.sent} sent, ${report.failed} failed` }
}
