import { formatMoney } from '@/lib/money'

export type TemplateKey =
  | 'ORDER_CONFIRMATION'
  | 'PAYMENT_CONFIRMATION'
  | 'TICKET_DELIVERY'
  | 'MUSEUM_TICKET'
  | 'DELIVERY_FAILURE'
  | 'REFUND_NOTIFICATION'
  | 'ADMIN_ALERT'

export const TEMPLATE_KEYS: TemplateKey[] = [
  'ORDER_CONFIRMATION',
  'PAYMENT_CONFIRMATION',
  'TICKET_DELIVERY',
  'MUSEUM_TICKET',
  'DELIVERY_FAILURE',
  'REFUND_NOTIFICATION',
  'ADMIN_ALERT',
]

export type TemplateData = {
  storeName: string
  customerName: string
  orderReference: string
  productName: string
  sessionSummary: string
  quantity: string
  totalPaid: string
  supportEmail: string
  supportPhone: string
  orderUrl: string
  ticketLinks: string
  reason: string
  /** Museum-only fields; optional so legacy templates keep working. */
  visitDate?: string
  adults?: string
  children?: string
  qrImage?: string
  timezone?: string
}

/**
 * Templates live in the database so an admin can edit wording without a deploy.
 * These defaults seed the first install.
 */
export const DEFAULT_TEMPLATES: Record<TemplateKey, { name: string; subject: string; html: string; text: string }> = {
  ORDER_CONFIRMATION: {
    name: 'Order confirmation',
    subject: 'Your {{storeName}} order {{orderReference}}',
    html: `<h2>Thanks for your order, {{customerName}}</h2>
<p>We have received your booking for <strong>{{productName}}</strong>.</p>
<ul>
  <li>Order: <strong>{{orderReference}}</strong></li>
  <li>Date and time: {{sessionSummary}}</li>
  <li>Tickets: {{quantity}}</li>
  <li>Total: {{totalPaid}}</li>
</ul>
<p>Your tickets are on their way to this inbox. Order status: <a href="{{orderUrl}}">{{orderReference}}</a></p>
<p>Questions? Reply to {{supportEmail}}{{supportPhone}}.</p>`,
    text: `Thanks for your order, {{customerName}}.
Order: {{orderReference}}
{{productName}} - {{sessionSummary}}
Tickets: {{quantity}}
Total: {{totalPaid}}
Status: {{orderUrl}}
Support: {{supportEmail}}{{supportPhone}}`,
  },
  PAYMENT_CONFIRMATION: {
    name: 'Payment confirmation',
    subject: 'Payment confirmed - {{orderReference}}',
    html: `<h2>Payment received</h2>
<p>We have confirmed your payment of <strong>{{totalPaid}}</strong> for order <strong>{{orderReference}}</strong>.</p>
<p>{{productName}} &middot; {{sessionSummary}} &middot; {{quantity}} ticket(s)</p>
<p>You can view your order at any time: <a href="{{orderUrl}}">{{orderUrl}}</a></p>`,
    text: `Payment received: {{totalPaid}} for order {{orderReference}}.
{{productName}} - {{sessionSummary}} ({{quantity}} ticket(s))
{{orderUrl}}`,
  },
  TICKET_DELIVERY: {
    name: 'Ticket delivery',
    subject: 'Your {{storeName}} tickets - {{orderReference}}',
    html: `<h2>Your tickets are attached, {{customerName}}</h2>
<p>{{productName}} &mdash; {{sessionSummary}}</p>
<p>Order <strong>{{orderReference}}</strong> &middot; {{quantity}} ticket(s) &middot; {{totalPaid}}</p>
<p>Each attached PDF is your ticket. Please present it at entry; a screenshot will not be accepted because the barcode must be scanned from the original file.</p>
<div>{{ticketLinks}}</div>
<p>Need help? {{supportEmail}}{{supportPhone}}</p>`,
    text: `Your tickets are attached.
{{productName}} - {{sessionSummary}}
Order {{orderReference}} | {{quantity}} ticket(s) | {{totalPaid}}
Support: {{supportEmail}}{{supportPhone}}`,
  },
  MUSEUM_TICKET: {
    name: 'Museum entrance ticket',
    subject: 'Your Badi Palace Museum ticket — {{visitDate}} ({{orderReference}})',
    html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#292524">
<h1 style="font-size:22px;margin:0 0 8px">Your visit is confirmed</h1>
<p>Hello {{customerName}},</p>
<p>Thank you for booking <strong>{{productName}}</strong>. Your visit is confirmed for <strong>{{visitDate}}</strong>.</p>
<table style="border-collapse:collapse;width:100%;margin:16px 0">
  <tr><td style="padding:4px 0;color:#78716c">Booking reference</td><td style="padding:4px 0;text-align:right;font-weight:bold">{{orderReference}}</td></tr>
  <tr><td style="padding:4px 0;color:#78716c">Adults</td><td style="padding:4px 0;text-align:right">{{adults}}</td></tr>
  <tr><td style="padding:4px 0;color:#78716c">Children</td><td style="padding:4px 0;text-align:right">{{children}}</td></tr>
  <tr><td style="padding:4px 0;color:#78716c">Total paid</td><td style="padding:4px 0;text-align:right;font-weight:bold">{{totalPaid}}</td></tr>
</table>
<div style="text-align:center;margin:24px 0;padding:16px;border:1px solid #e7e5e4;border-radius:12px">
  <p style="margin:0 0 12px;font-weight:bold">Entrance QR code</p>
  <img src="{{qrImage}}" alt="Entrance QR code for {{orderReference}}" width="240" height="240" style="display:block;margin:0 auto" />
  <p style="margin:8px 0 0;color:#78716c;font-size:13px">Present this code at the entrance for your whole party.</p>
</div>
<p>You can also open your booking online: <a href="{{orderUrl}}">{{orderUrl}}</a></p>
<p style="color:#78716c;font-size:13px">This is an independent booking service and is not the official ticket office of Badi Palace Museum. Questions? {{supportEmail}}{{supportPhone}}</p>
</div>`,
    text: `Your Badi Palace Museum visit is confirmed.
Booking: {{orderReference}}
Visit date: {{visitDate}}
Adults: {{adults}} | Children: {{children}}
Total paid: {{totalPaid}}
Your entrance QR code is attached to this email as a PNG file. Present it at the entrance.
Booking page: {{orderUrl}}
Support: {{supportEmail}}{{supportPhone}}`,
  },
  DELIVERY_FAILURE: {
    name: 'Delivery failure (admin)',
    subject: '[Action needed] Ticket delivery failed - {{orderReference}}',
    html: `<h2>Ticket delivery failed</h2>
<p>Order <strong>{{orderReference}}</strong> was paid but the tickets could not be emailed.</p>
<p>Customer: {{customerName}} &lt;{{supportEmail}}&gt;<br/>Reason: {{reason}}</p>
<p>Tickets remain reserved to this order and have not been re-sold. Retry delivery from the admin order screen.</p>`,
    text: `Ticket delivery failed for {{orderReference}}. Reason: {{reason}}. Tickets are still held.`,
  },
  REFUND_NOTIFICATION: {
    name: 'Refund notification',
    subject: 'Refund issued - {{orderReference}}',
    html: `<h2>Refund confirmed</h2>
<p>A refund of <strong>{{totalPaid}}</strong> has been issued for order <strong>{{orderReference}}</strong>.</p>
<p>{{reason}}</p>
<p>It can take up to 5 business days to appear on your PayPal statement.</p>`,
    text: `Refund of {{totalPaid}} issued for order {{orderReference}}. {{reason}}`,
  },
  ADMIN_ALERT: {
    name: 'Administrative alert',
    subject: '[Tixora] {{productName}}',
    html: `<h2>System alert</h2>
<p>{{reason}}</p>
<p>Order: {{orderReference}}</p>`,
    text: `System alert: {{reason}} (order {{orderReference}})`,
  },
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))
}

/**
 * Placeholders are substituted against a fixed key list and HTML-escaped, so no
 * customer-supplied text can inject markup into an email body. `ticketLinks` is
 * the one trusted field (we generate the anchors) and is inserted unescaped.
 */
export function renderTemplate(template: { subject: string; html: string; text: string }, data: TemplateData): { subject: string; html: string; text: string } {
  const { ticketLinks, qrImage, ...rest } = data
  const values = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, value ?? ''])) as Record<string, string>
  const fill = (input: string, escape: boolean) =>
    input.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
      const replacement = values[key]
      if (replacement === undefined) return match
      return escape ? escapeHtml(replacement) : replacement
    })
  return {
    subject: fill(template.subject, false),
    html: fill(template.html, true)
      .replace(/\{\{ticketLinks\}\}/g, ticketLinks ?? '')
      .replace(/\{\{qrImage\}\}/g, qrImage ?? ''),
    text: fill(template.text, true).replace(/\{\{ticketLinks\}\}/g, ''),
  }
}

export function buildTicketLinks(links: { fileName: string; url: string }[]): string {
  if (links.length === 0) return ''
  return `<p><strong>Backup download links</strong> (each ticket is also attached to this email):</p><ul>${links
    .map((link) => `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.fileName)}</a></li>`)
    .join('')}</ul>`
}

export function money(minor: number, currency: string): string {
  return formatMoney(minor, currency)
}
