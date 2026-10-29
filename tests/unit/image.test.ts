import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_BYTES, validateImage } from '@/lib/storage/image'

function png(width = 64, height = 32): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(8)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  return Buffer.concat([header, Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR', 'latin1'), ihdr, Buffer.alloc(16)])
}

function jpeg(width = 32, height = 16): Buffer {
  const sof = Buffer.alloc(13)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(0x0011, 2) // segment length
  sof[4] = 8 // precision
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(16)])
}

describe('validateImage', () => {
  it('accepts a PNG and reads its dimensions', () => {
    const result = validateImage(png(640, 480), 'image/png')
    expect(result).toMatchObject({ ok: true, contentType: 'image/png', width: 640, height: 480, extension: 'png' })
  })

  it('accepts a JPEG and reads its dimensions', () => {
    const result = validateImage(jpeg(800, 600), 'image/jpeg')
    expect(result).toMatchObject({ ok: true, contentType: 'image/jpeg', width: 800, height: 600, extension: 'jpg' })
  })

  it('accepts a WebP container', () => {
    const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(8)])
    expect(validateImage(webp, 'image/webp')).toMatchObject({ ok: true, contentType: 'image/webp', extension: 'webp' })
  })

  it('refuses SVG, which would execute script on our own origin', () => {
    expect(validateImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'image/svg+xml')).toMatchObject({ ok: false })
    expect(validateImage(Buffer.from('<svg onload="alert(1)"/>'))).toMatchObject({ ok: false })
  })

  it('refuses an HTML file renamed to .png', () => {
    expect(validateImage(Buffer.from('<html><body>hi</body></html>'), 'image/png')).toMatchObject({ ok: false })
  })

  it('refuses empty and oversized payloads', () => {
    expect(validateImage(Buffer.alloc(0))).toMatchObject({ ok: false })
    const big = Buffer.concat([png(), Buffer.alloc(MAX_IMAGE_BYTES)])
    expect(validateImage(big)).toMatchObject({ ok: false })
  })

  it('ignores a declared mime type that contradicts the signature', () => {
    expect(validateImage(png(), 'text/plain')).toMatchObject({ ok: false })
  })
})
