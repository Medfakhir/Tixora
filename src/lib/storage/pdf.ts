import crypto from 'node:crypto'

export const MAX_PDF_BYTES = 8 * 1024 * 1024
export const MAX_BATCH_BYTES = 40 * 1024 * 1024
export const MAX_BATCH_FILES = 100

const HEADER = Buffer.from('%PDF-')

export type PdfValidationResult =
  | { ok: true; checksum: string; sanitisedFileName: string; pageHint: number | null }
  | { ok: false; reason: string }

/**
 * Content-type and extension are attacker controlled, so acceptance is decided
 * by the file signature and structural markers only.
 */
export function validatePdf(buffer: Buffer, declaredFileName: string, declaredMimeType?: string): PdfValidationResult {
  if (!buffer || buffer.byteLength === 0) {
    return { ok: false, reason: 'File is empty' }
  }
  if (buffer.byteLength > MAX_PDF_BYTES) {
    return { ok: false, reason: `File exceeds the ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB per-file limit` }
  }
  if (declaredMimeType && declaredMimeType !== 'application/pdf') {
    return { ok: false, reason: `Unsupported media type "${declaredMimeType}"; only PDF is accepted` }
  }
  if (buffer.byteLength < HEADER.length || !buffer.subarray(0, 1024).includes(HEADER)) {
    return { ok: false, reason: 'File does not start with a PDF header' }
  }

  // The trailer lives at the end of a well-formed PDF; its absence means truncation.
  const tail = buffer.subarray(Math.max(0, buffer.byteLength - 4096))
  if (!tail.includes('%%EOF')) {
    return { ok: false, reason: 'PDF trailer (%%EOF) not found; the file appears truncated or corrupted' }
  }

  // Reject obvious script payloads carried inside a PDF attachment.
  const head = buffer.subarray(0, 2048).toString('latin1').toLowerCase()
  if (head.includes('/launch') || head.includes('/js') || head.includes('/javascript')) {
    return { ok: false, reason: 'PDF contains active content (JavaScript/Launch) and was rejected' }
  }

  const pageMatch = buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g)

  return {
    ok: true,
    checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
    sanitisedFileName: sanitiseFileName(declaredFileName),
    pageHint: pageMatch ? pageMatch.length : null,
  }
}

/** Display name only. Never used to build a filesystem path. */
export function sanitiseDisplayName(name: string, fallback = 'file'): string {
  const base = (name || fallback).split(/[\\/]/).pop() ?? fallback
  const cleaned = base.normalize('NFKD').replace(/[^\w.\- ]/g, '').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 120) || fallback
}

export function sanitiseFileName(name: string): string {
  // Collapses repeated .pdf suffixes so "invoice.pdf.pdf" becomes "invoice.pdf".
  return `${sanitiseDisplayName(name, 'ticket.pdf').replace(/(\.pdf)+$/i, '')}.pdf`
}

export function assertBatchLimits(files: { size: number }[]): string | null {
  if (files.length === 0) return 'No files were uploaded'
  if (files.length > MAX_BATCH_FILES) return `Batch size ${files.length} exceeds the ${MAX_BATCH_FILES} file limit`
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > MAX_BATCH_BYTES) {
    return `Batch total ${Math.round(total / 1024 / 1024)}MB exceeds the ${Math.round(MAX_BATCH_BYTES / 1024 / 1024)}MB limit`
  }
  return null
}
