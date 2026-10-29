import { z } from 'zod'
import { withApi, ok, readFormData, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { getStorage } from '@/lib/storage'
import { validateImage } from '@/lib/storage/image'
import { sanitiseDisplayName } from '@/lib/storage/pdf'
import { recordAudit } from '@/lib/auth/guards'

const MAX_IMAGES_PER_PRODUCT = 6

const fieldsSchema = z.object({
  productId: z.string().min(1),
  alt: z.string().trim().max(160).optional().or(z.literal('')),
})

export const POST = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'sensitive')
  const form = await readFormData(request)

  const payload = fieldsSchema.parse({
    productId: form.get('productId'),
    alt: form.get('alt') ?? '',
  })

  const product = await prisma.product.findUnique({ where: { id: payload.productId }, select: { id: true, name: true } })
  if (!product) throw new ApiError('Product not found.', 404, 'NOT_FOUND')

  const files = form.getAll('files').filter((entry): entry is File => entry instanceof File && entry.size > 0)
  if (files.length === 0) throw new ApiError('No image files were received.', 422, 'NO_FILES')

  const existing = await prisma.productImage.count({ where: { productId: product.id } })
  if (existing + files.length > MAX_IMAGES_PER_PRODUCT) {
    throw new ApiError(`A product carries at most ${MAX_IMAGES_PER_PRODUCT} images (${existing} already stored).`, 413, 'TOO_MANY_IMAGES')
  }

  const storage = getStorage()
  const accepted: { id: string; fileName: string; width: number | null; height: number | null }[] = []
  const rejected: { fileName: string; reason: string }[] = []
  let sortOrder = existing

  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer())
    const validated = validateImage(buffer, file.type)
    if (!validated.ok) {
      rejected.push({ fileName: sanitiseDisplayName(file.name, 'image'), reason: validated.reason })
      continue
    }

    const stored = await storage.put({
      body: buffer,
      contentType: validated.contentType,
      suggestedExtension: validated.extension,
      namespace: 'product-images',
    })

    const row = await prisma.productImage.create({
      data: {
        productId: product.id,
        storageKey: stored.key,
        alt: payload.alt || sanitiseDisplayName(file.name, 'image').replace(/\.[a-z]+$/i, ''),
        width: validated.width,
        height: validated.height,
        fileSize: buffer.byteLength,
        sortOrder: (sortOrder += 1),
      },
    })
    accepted.push({ id: row.id, fileName: row.alt, width: row.width, height: row.height })
  }

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'PRODUCT_IMAGE_UPLOAD',
    entityType: 'Product',
    entityId: product.id,
    summary: `Stored ${accepted.length} image(s) for ${product.name}${rejected.length ? `, rejected ${rejected.length}` : ''}`,
    metadata: { rejected },
    ip,
  })

  return ok({ accepted, rejected }, accepted.length > 0 ? 201 : 422)
})
