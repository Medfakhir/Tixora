import { describe, expect, it } from 'vitest'
import { DEFAULT_TEMPLATES, TEMPLATE_KEYS, buildTicketLinks, renderTemplate, type TemplateData } from '@/lib/email/templates'

const data: TemplateData = {
  storeName: 'Tixora',
  customerName: 'Ada Lovelace',
  orderReference: 'KBR-2026-ABC123',
  productName: 'Old Town Tour',
  sessionSummary: '2026-11-02 10:00',
  quantity: '2',
  totalPaid: '$70.00',
  supportEmail: 'support@example.com',
  supportPhone: '',
  orderUrl: 'http://localhost:3000/order/PUBLIC',
  ticketLinks: '',
  reason: '',
}

const template = DEFAULT_TEMPLATES.TICKET_DELIVERY

describe('renderTemplate', () => {
  it('substitutes every placeholder key', () => {
    const rendered = renderTemplate(template, data)
    expect(rendered.subject).toContain('KBR-2026-ABC123')
    expect(rendered.html).toContain('Old Town Tour')
    expect(rendered.text).toContain('Old Town Tour')
    expect(rendered.text).toContain('KBR-2026-ABC123')
    expect(rendered.html).not.toContain('{{')
  })

  it('escapes customer-supplied markup in the HTML body', () => {
    const rendered = renderTemplate(template, { ...data, customerName: '<script>alert(1)</script>' })
    expect(rendered.html).not.toContain('<script>')
    expect(rendered.html).toContain('&lt;script&gt;')
  })

  it('escapes quotes and ampersands', () => {
    const rendered = renderTemplate(template, { ...data, customerName: `Tom & "Jerry" O'Neil` })
    expect(rendered.html).toContain('&amp;')
    expect(rendered.html).toContain('&quot;')
    expect(rendered.html).toContain('&#39;')
  })

  it('leaves unknown placeholders untouched instead of printing undefined', () => {
    const rendered = renderTemplate({ subject: 'x', html: '{{missing}}', text: '{{missing}}' }, data)
    expect(rendered.html).toBe('{{missing}}')
    expect(rendered.text).toBe('{{missing}}')
  })

  it('inserts generated ticket links into HTML only, never into the text part', () => {
    const links = buildTicketLinks([{ fileName: 'ticket.pdf', url: 'http://localhost:3000/api/orders/P/tickets/1' }])
    const rendered = renderTemplate({ subject: 's', html: '{{ticketLinks}}', text: '{{ticketLinks}}' }, { ...data, ticketLinks: links })
    expect(rendered.html).toContain('<a href="http://localhost:3000/api/orders/P/tickets/1">')
    expect(rendered.text).toBe('')
  })

  it('escapes file names inside generated links', () => {
    const links = buildTicketLinks([{ fileName: '<img src=x onerror=alert(1)>.pdf', url: 'http://localhost/x' }])
    expect(links).not.toContain('<img')
    expect(links).toContain('&lt;img')
  })
})

describe('default templates', () => {
  it('covers every key with subject and both bodies', () => {
    for (const key of TEMPLATE_KEYS) {
      const entry = DEFAULT_TEMPLATES[key]
      expect(entry.subject.length).toBeGreaterThan(0)
      expect(entry.html.length).toBeGreaterThan(0)
      expect(entry.text.length).toBeGreaterThan(0)
      expect(entry.html).not.toContain('http://localhost:3000/order/undefined')
    }
  })
})
