import path from 'node:path'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { env } from '@/lib/config/env'

export type PutObjectInput = {
  body: Buffer
  contentType: string
  /** Only the extension is honoured; user supplied filenames are never used as paths. */
  suggestedExtension?: string
  namespace?: string
}

export type StoredObject = { key: string; size: number }

export interface StorageAdapter {
  put(input: PutObjectInput): Promise<StoredObject>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
  /**
   * Short-lived URL for private files. Returns null when the backend cannot
   * pre-sign, in which case callers must stream through an authorised endpoint.
   */
  presign?(key: string, expiresInSeconds: number): Promise<string | null>
}

const LEADING_SLASH = /^[/\\]+/

function buildKey(namespace: string, extension: string): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const random = crypto.randomBytes(12).toString('hex')
  const suffix = extension ? `.${extension.replace(/[^a-z0-9]/gi, '').toLowerCase()}` : ''
  return `${namespace}/${stamp}/${random}${suffix}`
}

/**
 * Keys are generated here, never derived from the upload filename, so a crafted
 * name like `../../server.ts` cannot escape the private directory.
 */
function assertSafeKey(key: string): string {
  const normalised = key.replace(LEADING_SLASH, '')
  const resolved = path.posix.normalize(normalised)
  if (resolved.includes('..') || resolved.startsWith('/') || resolved.length === 0) {
    throw new Error(`Unsafe storage key: ${key}`)
  }
  return resolved
}

class LocalStorageAdapter implements StorageAdapter {
  private root: string

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir)
  }

  private resolve(key: string): string {
    const target = path.resolve(this.root, assertSafeKey(key))
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      throw new Error(`Storage key escapes private root: ${key}`)
    }
    return target
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const key = buildKey(input.namespace ?? 'files', input.suggestedExtension ?? '')
    const target = this.resolve(key)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, input.body, { mode: 0o600 })
    return { key, size: input.body.byteLength }
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key))
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true })
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key))
      return true
    } catch {
      return false
    }
  }
}

export function createLocalStorage(rootDir = env.STORAGE_LOCAL_DIR): StorageAdapter {
  return new LocalStorageAdapter(rootDir)
}
