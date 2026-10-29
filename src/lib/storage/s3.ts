import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import crypto from 'node:crypto'
import { env } from '@/lib/config/env'
import type { PutObjectInput, StorageAdapter, StoredObject } from './local'

function buildKey(namespace: string, extension: string): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `${namespace}/${stamp}/${crypto.randomBytes(12).toString('hex')}${extension ? `.${extension}` : ''}`
}

async function readStream(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

/** Private S3-compatible bucket. Objects are written without a public ACL. */
export function createS3Adapter(): StorageAdapter {
  const bucket = env.STORAGE_BUCKET
  const region = env.STORAGE_REGION
  if (!bucket || !region) {
    throw new Error('S3 storage requires STORAGE_BUCKET and STORAGE_REGION')
  }

  const client = new S3Client({
    region,
    endpoint: env.STORAGE_ENDPOINT || undefined,
    forcePathStyle: Boolean(env.STORAGE_ENDPOINT),
    credentials: env.STORAGE_ACCESS_KEY && env.STORAGE_SECRET_KEY
      ? { accessKeyId: env.STORAGE_ACCESS_KEY, secretAccessKey: env.STORAGE_SECRET_KEY }
      : undefined,
  })

  return {
    async put(input: PutObjectInput): Promise<StoredObject> {
      const key = buildKey(input.namespace ?? 'files', (input.suggestedExtension ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase())
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: input.body,
          ContentType: input.contentType,
          ServerSideEncryption: env.STORAGE_ENDPOINT ? undefined : 'AES256',
        }),
      )
      return { key, size: input.body.byteLength }
    },

    async get(key: string): Promise<Buffer> {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      if (!response.Body) throw new Error(`Empty response body for ${key}`)
      return readStream(response.Body as AsyncIterable<Uint8Array>)
    },

    async delete(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    },

    async exists(key: string): Promise<boolean> {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        return true
      } catch {
        return false
      }
    },

    async presign(key: string, expiresInSeconds: number): Promise<string | null> {
      const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSeconds })
      return url
    },
  }
}
