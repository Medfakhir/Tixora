import crypto from 'node:crypto'

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

export type ImageValidationResult =
  | { ok: true; contentType: 'image/png' | 'image/jpeg' | 'image/webp'; width: number | null; height: number | null; extension: string; checksum: string }
  | { ok: false; reason: string }

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MARKER = Buffer.from([0xff, 0xd8, 0xff])
const WEBP_CONTAINER = 'RIFF'
const WEBP_TAG = 'WEBP'

/**
 * Marketing images are rendered straight into the storefront, so the type is decided by the
 * byte signature rather than the declared content type. SVG is refused outright: an uploaded
 * vector is a script carrier that would run on our own origin.
 */
export function validateImage(buffer: Buffer, declaredMimeType?: string): ImageValidationResult {
  if (!buffer || buffer.byteLength === 0) return { ok: false, reason: 'File is empty' }
  if (buffer.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: `Image exceeds the ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB limit` }
  if (declaredMimeType && !['image/png', 'image/jpeg', 'image/webp'].includes(declaredMimeType)) {
    return { ok: false, reason: `Unsupported media type "${declaredMimeType}"; PNG, JPEG and WebP are accepted` }
  }

  if (buffer.subarray(0, PNG.length).equals(PNG)) {
    const size = pngSize(buffer)
    return { ok: true, contentType: 'image/png', width: size?.width ?? null, height: size?.height ?? null, extension: 'png', checksum: checksum(buffer) }
  }
  if (buffer.subarray(0, 3).equals(JPEG_MARKER)) {
    const size = jpegSize(buffer)
    return { ok: true, contentType: 'image/jpeg', width: size?.width ?? null, height: size?.height ?? null, extension: 'jpg', checksum: checksum(buffer) }
  }
  if (
    buffer.subarray(0, 4).toString('latin1') === WEBP_CONTAINER &&
    buffer.subarray(8, 12).toString('latin1') === WEBP_TAG
  ) {
    return { ok: true, contentType: 'image/webp', width: null, height: null, extension: 'webp', checksum: checksum(buffer) }
  }

  return { ok: false, reason: 'File does not match a PNG, JPEG or WebP signature' }
}

function checksum(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR' || buffer.byteLength < 24) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** Walks the JPEG marker chain until it finds a start-of-frame segment. */
function jpegSize(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2
  while (offset + 9 < buffer.byteLength) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (isStartOfFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2) break
    offset += 2 + length
  }
  return null
}
