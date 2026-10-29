import { env } from '@/lib/config/env'
import { createLocalStorage, type StorageAdapter } from './local'
import { createS3Adapter } from './s3'

let adapter: StorageAdapter | null = null

/**
 * STORAGE_PROVIDER selects the backend: private local disk for development,
 * private S3-compatible object storage in production. Nothing else in the code
 * base knows which one is in use.
 */
export function getStorage(): StorageAdapter {
  if (adapter) return adapter
  if (env.STORAGE_PROVIDER === 'S3') {
    if (env.NODE_ENV === 'production' && (!env.STORAGE_BUCKET || !env.STORAGE_REGION)) {
      throw new Error('STORAGE_PROVIDER=S3 requires STORAGE_BUCKET and STORAGE_REGION in production')
    }
    adapter = createS3Adapter()
  } else {
    adapter = createLocalStorage()
  }
  return adapter
}

export type { StorageAdapter, StoredObject } from './local'
