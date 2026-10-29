import { describe, expect, it } from 'vitest'
import {
  MAX_PDF_BYTES,
  assertBatchLimits,
  sanitiseDisplayName,
  sanitiseFileName,
  validatePdf,
} from '@/lib/storage/pdf'

function pdf(body = '1 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n'): Buffer {
  return Buffer.from(`%PDF-1.7\n${body}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1')
}

describe('validatePdf', () => {
  it('accepts a well-formed PDF and returns a checksum and safe name', () => {
    const result = validatePdf(pdf(), 'guest-ticket.pdf', 'application/pdf')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(result.sanitisedFileName).toBe('guest-ticket.pdf')
    expect(result.pageHint).toBe(1)
  })

  it('ignores a missing declared mime type because the signature decides', () => {
    expect(validatePdf(pdf(), 'ticket.pdf').ok).toBe(true)
  })

  it('rejects empty files, wrong media types and oversized uploads', () => {
    expect(validatePdf(Buffer.alloc(0), 'empty.pdf')).toMatchObject({ ok: false })
    expect(validatePdf(pdf(), 'ticket.pdf', 'text/html')).toMatchObject({ ok: false })
    const oversized = Buffer.concat([pdf(), Buffer.alloc(MAX_PDF_BYTES)])
    expect(validatePdf(oversized, 'big.pdf')).toMatchObject({ ok: false })
  })

  it('rejects content that only claims to be a PDF', () => {
    expect(validatePdf(Buffer.from('<html>not a pdf</html>'), 'evil.pdf', 'application/pdf')).toMatchObject({ ok: false })
  })

  it('rejects a truncated PDF without its trailer', () => {
    expect(validatePdf(Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Page >>'), 'cut.pdf')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('%%EOF'),
    })
  })

  it('rejects PDFs carrying JavaScript or Launch actions', () => {
    expect(validatePdf(pdf('1 0 obj\n<< /S /JavaScript >>\nendobj\n'), 'js.pdf')).toMatchObject({ ok: false })
    expect(validatePdf(pdf('1 0 obj\n<< /Type /Action /S /Launch >>\nendobj\n'), 'launch.pdf')).toMatchObject({ ok: false })
  })
})

describe('file naming', () => {
  it('strips directory components so a user name can never become a path', () => {
    const result = validatePdf(pdf(), '../../../../etc/passwd')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sanitisedFileName).toBe('passwd.pdf')
    expect(result.sanitisedFileName).not.toContain('/')
    expect(result.sanitisedFileName).not.toContain('..')
  })

  it('forces a single .pdf extension', () => {
    expect(sanitiseFileName('invoice.PDF')).toBe('invoice.pdf')
    expect(sanitiseFileName('invoice.pdf.pdf')).toBe('invoice.pdf')
    expect(sanitiseFileName('   ')).toBe('ticket.pdf')
  })

  it('keeps display names readable without the pdf forcing', () => {
    expect(sanitiseDisplayName('My Photo (1).png')).toBe('My Photo 1.png')
    expect(sanitiseDisplayName('')).toBe('file')
    expect(sanitiseDisplayName('x'.repeat(400)).length).toBeLessThanOrEqual(120)
  })
})

describe('batch limits', () => {
  it('rejects empty batches and oversized counts', () => {
    expect(assertBatchLimits([])).toMatch(/No files/)
    expect(assertBatchLimits(Array.from({ length: 101 }, () => ({ size: 1 })))).toMatch(/file limit/)
  })

  it('rejects a batch that is too large in total', () => {
    expect(assertBatchLimits([{ size: 25 * 1024 * 1024 }, { size: 25 * 1024 * 1024 }])).toMatch(/MB limit/)
  })

  it('accepts a normal batch', () => {
    expect(assertBatchLimits([{ size: 1024 * 1024 }, { size: 2048 }])).toBeNull()
  })
})
