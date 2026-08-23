/**
 * Content-addressed blob storage for large study payloads (Markdown, blocks
 * JSONL, images). Blobs live under `<storageRoot>/blobs/sha256/<hex>` and are
 * written atomically (temp file in the same directory, then rename), so a
 * crash never leaves a partially written blob that a RevisionRecord could
 * reference. Import scratch files live under `<storageRoot>/tmp/<importId>/`.
 * @module @deepseek-ai/dsh-study/blob-store
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access, copyFile, lstat, mkdir, opendir, readFile, rename, rm, unlink, writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** One blob key: the `sha256/<hex>` form relative to the blobs root. */
export type BlobKey = `sha256/${string}`

const BLOB_KEY = /^sha256\/[a-f0-9]{64}$/i
export function isBlobKey(value: string): value is BlobKey { return BLOB_KEY.test(value) }

/** Filesystem layout owner for the study reader. */
export class BlobStore {
  /**
   * @param storageRoot - absolute configured root (`dshHomePath('study-reader')`).
   */
  constructor(private readonly storageRoot: string) {}

  /** Absolute directory holding content-addressed blobs. */
  private get blobsDir(): string {
    return join(this.storageRoot, 'blobs', 'sha256')
  }

  /**
   * Absolute path of one blob key.
   * @param key - the `sha256/<hex>` key.
   * @returns the absolute file path.
   */
  blobPath(key: BlobKey): string {
    this.assertKey(key)
    return join(this.blobsDir, key.slice('sha256/'.length))
  }

  private assertKey(key: string): asserts key is BlobKey {
    if (!BLOB_KEY.test(key) || key.includes('..') || key.includes('/') && !key.startsWith('sha256/')) throw new Error('invalid blob key')
  }

  private safePath(key: BlobKey): string {
    this.assertKey(key)
    const target = resolve(this.blobsDir, key.slice(7))
    if (dirname(target) !== resolve(this.blobsDir) || relative(resolve(this.blobsDir), target).includes(sep)) throw new Error('unsafe blob path')
    return target
  }

  /**
   * Absolute scratch path of one import.
   * @param importId - the owning import.
   * @param name - file name inside the scratch directory.
   * @returns the absolute path.
   */
  tmpPath(importId: string, name: string): string {
    return join(this.storageRoot, 'tmp', importId, name)
  }

  /**
   * Write bytes to scratch storage, creating the directory.
   * @param importId - the owning import.
   * @param name - file name.
   * @param data - bytes.
   */
  async writeTmp(importId: string, name: string, data: Uint8Array): Promise<void> {
    const path = this.tmpPath(importId, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data)
  }

  /**
   * Remove one import's scratch directory.
   * @param importId - the owning import.
   */
  async clearTmp(importId: string): Promise<void> {
    await rm(this.tmpPath(importId, ''), { recursive: true, force: true })
  }

  /**
   * Persist bytes as a content-addressed blob and return its key. Idempotent:
   * an existing blob with the same hash is left untouched.
   * @param data - the blob bytes.
   * @returns the blob key.
   */
  async putBlob(data: Uint8Array): Promise<BlobKey> {
    const hash = sha256Hex(data)
    const key = `sha256/${hash}` as BlobKey
    await mkdir(this.blobsDir, { recursive: true })
    const target = this.safePath(key)
    try {
      await access(target)
      return key
    } catch (error) {
      // Blob absent (or unreadable — fail the write rather than overwrite a
      // potentially corrupt-but-present file): write next to it, then rename.
      const tmp = join(this.blobsDir, `.tmp-${hash}-${process.pid}-${Math.random().toString(36).slice(2)}`)
      await writeFile(tmp, data)
      await rename(tmp, target)
    }
    return key
  }

  /**
   * Persist an existing file as a content-addressed blob without loading it
   * wholly into memory. The source is removed after a successful commit by
   * default, which is ideal for upload scratch files.
   * @param path - absolute source path.
   * @param removeSource - whether to unlink the source after the blob exists.
   * @returns the blob key.
   */
  async putFile(path: string, removeSource: boolean = true): Promise<BlobKey> {
    const hash = await sha256File(path)
    const key = `sha256/${hash}` as BlobKey
    await mkdir(this.blobsDir, { recursive: true })
    const target = this.blobPath(key)
    try {
      await access(target)
    } catch {
      const tmp = join(this.blobsDir, `.tmp-${hash}-${process.pid}-${Math.random().toString(36).slice(2)}`)
      await copyFile(path, tmp)
      try {
        await rename(tmp, target)
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {})
        // A concurrent writer may have committed the same hash. Preserve the
        // original failure only when the target still does not exist.
        try {
          await access(target)
        } catch {
          throw error
        }
      }
    }
    if (removeSource) await unlink(path).catch(() => {})
    return key
  }

  /**
   * Read one blob.
   * @param key - the blob key.
   * @returns the blob bytes.
   */
  async readBlob(key: BlobKey): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.blobPath(key)))
  }

  /** Test whether a referenced content-addressed blob is still present. */
  async hasBlob(key: BlobKey): Promise<boolean> {
    try {
      await access(this.blobPath(key))
      return true
    } catch {
      return false
    }
  }

  /** Enumerate only ordinary, non-symlink content-addressed files. */
  async listContentBlobs(): Promise<readonly BlobKey[]> {
    try {
      const dir = await opendir(this.blobsDir)
      const keys: BlobKey[] = []
      for await (const entry of dir) {
        if (!entry.isFile() || !BLOB_KEY.test(`sha256/${entry.name}`)) continue
        const key = `sha256/${entry.name}` as BlobKey
        const info = await lstat(this.safePath(key))
        if (info.isFile() && !info.isSymbolicLink()) keys.push(key)
      }
      return keys.sort()
    } catch (error: any) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  async statBlob(key: BlobKey): Promise<{ readonly sizeBytes: number; readonly createdAt: number } | undefined> {
    const path = this.safePath(key)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('blob is not a regular file')
      return { sizeBytes: info.size, createdAt: info.birthtimeMs || info.ctimeMs }
    } catch (error: any) { if (error?.code === 'ENOENT') return undefined; throw error }
  }

  /** Delete exactly one verified regular blob. BlobLifecycleService owns locking. */
  async deleteBlob(key: BlobKey): Promise<{ readonly deleted: boolean; readonly sizeBytes: number }> {
    const info = await this.statBlob(key)
    if (info === undefined) return { deleted: false, sizeBytes: 0 }
    await unlink(this.safePath(key))
    return { deleted: true, sizeBytes: info.sizeBytes }
  }
}

/** Compute the sha256 hex digest of bytes. */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Compute the sha256 hex digest of a file without loading it wholly.
 * @param path - absolute file path.
 * @returns the hex digest.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk as Buffer))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return hash.digest('hex')
}
