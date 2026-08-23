/**
 * Stable, Host-owned Blob lifecycle seam.  This is deliberately a separate
 * Cordis row: providers may be rebuilt, but a publication/deletion lock must
 * outlive them.  The coordinator is process-local; sharing a storage root
 * between independent Host processes is unsupported.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { BlobStore, isBlobKey, type BlobKey } from './blob-store.ts'
import { studyDomain } from './domain.ts'
import { migrateLegacyRevisions } from './revision-migration.ts'
import type { BlobGcCandidateRecord, RevisionId, RevisionRecord } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { studyBlobLifecycle: BlobLifecycleService }
}

export interface BlobLifecycleConfig { readonly storageRoot: string }
export const name = 'study-blob-lifecycle'
export const inject = ['storageDomain']

type LockRelease = () => void
interface Lock { tail: Promise<void> }

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('blob lifecycle operation aborted')
}

/** Wait for a FIFO per-key lock without leaving a poisoned tail on abort. */
async function acquire(lock: Lock, signal: AbortSignal): Promise<LockRelease> {
  if (signal.aborted) throw abortError(signal)
  const prior = lock.tail
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  // Keep an aborted waiter's slot behind its predecessor.  Releasing it
  // immediately would let the next waiter overtake the current lock holder.
  lock.tail = prior.then(() => held, () => held)
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([prior, aborted])
  } catch (error) {
    void prior.finally(release)
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  return release
}

/**
 * Owns BlobStore, candidate access and all per-blob publication/deletion
 * mutual exclusion for one Host process.  It intentionally makes no claim of
 * cross-process safety.
 */
export class BlobLifecycleService extends Service {
  readonly blobs: BlobStore
  readonly domain: Domain<typeof studyDomain>
  readonly candidates: KvTable<string, BlobGcCandidateRecord>
  private readonly locks = new Map<BlobKey, Lock>()
  private readonly stopping = new AbortController()
  private accepting = true
  private inCallback = 0
  private readonly drained = new Set<() => void>()

  constructor(ctx: Context, config: BlobLifecycleConfig, domain: Domain<typeof studyDomain>) {
    super(ctx, 'studyBlobLifecycle')
    this.blobs = new BlobStore(config.storageRoot)
    this.domain = domain
    this.candidates = domain.table('blob_gc_candidates') as unknown as KvTable<string, BlobGcCandidateRecord>
  }

  async withBlobReferences<T>(blobKeys: readonly BlobKey[], publish: () => Promise<T>, signal: AbortSignal = this.stopping.signal): Promise<T> {
    return this.withLocks(blobKeys, signal, async keys => {
      for (const key of keys) {
        if (await this.blobs.statBlob(key) === undefined) throw new Error(`blob is missing or not a regular file: ${key}`)
      }
      for (const key of keys) await this.candidates.delete(key)
      return publish()
    })
  }

  /** Internal-only future GC primitive. No timer, Remote, Agent or Tool calls it today. */
  async withBlobDeletionLock<T>(blobKey: BlobKey, operation: () => Promise<T>, signal: AbortSignal = this.stopping.signal): Promise<T> {
    return this.withLocks([blobKey], signal, async () => operation())
  }

  /** Internal GC deletion transaction; only BlobGarbageCollector calls it. */
  async deleteCandidateIfUnreferenced(blobKey: BlobKey, isLive: () => Promise<boolean>, signal: AbortSignal = this.stopping.signal): Promise<{ readonly deleted: boolean; readonly retained: boolean; readonly sizeChanged: boolean }> {
    return this.withBlobDeletionLock(blobKey, async () => {
      const candidate = this.candidates.get(blobKey)
      if (candidate === undefined) return { deleted: false, retained: false, sizeChanged: false }
      const info = await this.blobs.statBlob(blobKey)
      if (info === undefined) {
        await this.candidates.delete(blobKey)
        return { deleted: false, retained: false, sizeChanged: false }
      }
      if (info.sizeBytes !== candidate.observedSizeBytes) {
        await this.candidates.delete(blobKey)
        return { deleted: false, retained: false, sizeChanged: true }
      }
      if (await isLive()) {
        await this.candidates.delete(blobKey)
        return { deleted: false, retained: true, sizeChanged: false }
      }
      const deletion = await this.blobs.deleteBlob(blobKey)
      await this.candidates.delete(blobKey)
      return { deleted: deletion.deleted, retained: false, sizeChanged: false }
    }, signal)
  }

  private async withLocks<T>(rawKeys: readonly BlobKey[], signal: AbortSignal, operation: (keys: readonly BlobKey[]) => Promise<T>): Promise<T> {
    if (!this.accepting) throw new Error('blob lifecycle is stopping')
    const keys = [...new Set(rawKeys)].sort()
    if (keys.some(key => !isBlobKey(key))) throw new Error('invalid blob key')
    const releases: LockRelease[] = []
    try {
      for (const key of keys) releases.push(await acquire(this.locks.get(key) ?? this.createLock(key), signal))
      if (!this.accepting || signal.aborted) throw abortError(signal)
      this.inCallback += 1
      try { return await operation(keys) } finally {
        this.inCallback -= 1
        if (!this.accepting && this.inCallback === 0) this.resolveDrained()
      }
    } finally {
      for (const release of releases.reverse()) release()
    }
  }

  private createLock(key: BlobKey): Lock { const lock = { tail: Promise.resolve() }; this.locks.set(key, lock); return lock }
  private resolveDrained(): void { for (const resolve of this.drained) resolve(); this.drained.clear() }

  async dispose(): Promise<void> {
    if (!this.accepting) { if (this.inCallback !== 0) await new Promise<void>(resolve => this.drained.add(resolve)); return }
    this.accepting = false
    this.stopping.abort(new Error('study blob lifecycle stopped'))
    if (this.inCallback !== 0) await new Promise<void>(resolve => this.drained.add(resolve))
  }
}

export async function apply(ctx: Context, config: BlobLifecycleConfig): Promise<void> {
  const domain = await ctx.storageDomain.open(studyDomain)
  await migrateLegacyRevisions(domain.table('revisions') as unknown as KvTable<RevisionId, RevisionRecord>)
  const lifecycle = new BlobLifecycleService(ctx, config, domain)
  ctx.effect(() => async () => { await lifecycle.dispose(); await domain.close() }, 'study: blob lifecycle')
}
