import { NextResponse } from 'next/server'
import { withApi, ApiError } from '@/lib/api/http'
import { prisma } from '@/lib/db/prisma'
import { getStorage } from '@/lib/storage'

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

/**
 * Storefront imagery is the one stored object class a guest is allowed to pull directly, so
 * this route is public by design. The type comes from the generated key's extension, never
 * from anything the caller sent, and only images we stored can ever be resolved.
 */
export const GET = withApi(async (_request: Request, { params }: { params: Promise<{ imageId: string }> }) => {
  const { imageId } = await params
  const image = await prisma.productImage.findUnique({ where: { id: imageId }, select: { storageKey: true } })
  if (!image) throw new ApiError('Image not found.', 404, 'NOT_FOUND')

  const extension = image.storageKey.split('.').pop()?.toLowerCase() ?? ''
  const contentType = CONTENT_TYPES[extension]
  if (!contentType) throw new ApiError('Image not found.', 404, 'NOT_FOUND')

  const body = await getStorage().get(image.storageKey)

  return new NextResponse(new Uint8Array(body), {
    headers: {
      'content-type': contentType,
      'content-length': String(body.byteLength),
      'content-disposition': `inline; filename="image-${imageId}.${extension}"`,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  })
})
