import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as BlobLifecycleModule from '../lib/types/study/blob-lifecycle.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BlobKey } from '../lib/types/study/blob-store.js'

const contexts: Array<{ ctx: Context; root: string }> = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(async ({ ctx, root }) => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })) })

async function setupLifecycle() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-study-blob-lifecycle-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(BlobLifecycleModule, { storageRoot: join(root, 'study-reader') })
  contexts.push({ ctx, root })
  return ctx.studyBlobLifecycle
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('stable Blob lifecycle publication coordinator', () => {
  it('holds a Blob lock through candidate clearing and record publication', async () => {
    const lifecycle = await setupLifecycle()
    const key = await lifecycle.blobs.putBlob(new Uint8Array([1]))
    await lifecycle.candidates.put(key, { schemaVersion: 1, blobKey: key, firstSeenUnreferencedAt: 1, lastCheckedAt: 1, observedSizeBytes: 1 })
    const entered = deferred(); const release = deferred(); let deleting = false
    const publish = lifecycle.withBlobReferences([key], async () => {
      expect(lifecycle.candidates.get(key)).toBeUndefined()
      entered.resolve(); await release.promise
    })
    await entered.promise
    const deletion = lifecycle.withBlobDeletionLock(key, async () => { deleting = true })
    await Promise.resolve(); expect(deleting).toBe(false)
    release.resolve(); await publish; await deletion; expect(deleting).toBe(true)
  })

  it('makes a publisher fail without writing when deletion acquired the lock first', async () => {
    const lifecycle = await setupLifecycle()
    const key = await lifecycle.blobs.putBlob(new Uint8Array([2]))
    await lifecycle.candidates.put(key, { schemaVersion: 1, blobKey: key, firstSeenUnreferencedAt: 1, lastCheckedAt: 1, observedSizeBytes: 1 })
    await lifecycle.deleteCandidateIfUnreferenced(key, async () => false)
    let wrote = false
    await expect(lifecycle.withBlobReferences([key], async () => { wrote = true })).rejects.toThrow('blob is missing')
    expect(wrote).toBe(false)
  })

  it('keeps a live Blob when publication acquired the lock first', async () => {
    const lifecycle = await setupLifecycle()
    const key = await lifecycle.blobs.putBlob(new Uint8Array([3]))
    await lifecycle.candidates.put(key, { schemaVersion: 1, blobKey: key, firstSeenUnreferencedAt: 1, lastCheckedAt: 1, observedSizeBytes: 1 })
    const entered = deferred(); const release = deferred(); let recordLive = false
    const publish = lifecycle.withBlobReferences([key], async () => { entered.resolve(); await release.promise; recordLive = true })
    await entered.promise
    const deletion = lifecycle.deleteCandidateIfUnreferenced(key, async () => recordLive)
    release.resolve(); await publish
    // The authoritative record is visible before the deletion lock runs.
    await deletion
    expect(await lifecycle.blobs.hasBlob(key)).toBe(true)
    expect(lifecycle.candidates.get(key)).toBeUndefined()
  })

  it('serializes two publishers, sorts multi-Blob locks, and releases after errors', async () => {
    const lifecycle = await setupLifecycle()
    const a = await lifecycle.blobs.putBlob(new Uint8Array([4]))
    const b = await lifecycle.blobs.putBlob(new Uint8Array([5]))
    const order: string[] = []
    await Promise.all([
      lifecycle.withBlobReferences([b, a], async () => { order.push('first') }),
      lifecycle.withBlobReferences([a, b], async () => { order.push('second') }),
    ])
    expect(order).toEqual(['first', 'second'])
    await expect(lifecycle.withBlobReferences([a], async () => { throw new Error('record failed') })).rejects.toThrow('record failed')
    await lifecycle.withBlobReferences([a], async () => { order.push('after-error') })
    expect(order).toContain('after-error')
  })

  it('aborts a waiter without executing its publication callback', async () => {
    const lifecycle = await setupLifecycle()
    const key = await lifecycle.blobs.putBlob(new Uint8Array([6]))
    const entered = deferred(); const release = deferred(); const controller = new AbortController(); let ran = false
    const owner = lifecycle.withBlobReferences([key], async () => { entered.resolve(); await release.promise })
    await entered.promise
    const waiter = lifecycle.withBlobReferences([key], async () => { ran = true }, controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(waiter).rejects.toThrow('cancelled')
    release.resolve(); await owner; expect(ran).toBe(false)
  })

  it('leaves only a safe orphan when candidate clearing precedes a failed record write', async () => {
    const lifecycle = await setupLifecycle()
    const key = await lifecycle.blobs.putBlob(new Uint8Array([7]))
    await lifecycle.candidates.put(key, { schemaVersion: 1, blobKey: key, firstSeenUnreferencedAt: 1, lastCheckedAt: 1, observedSizeBytes: 1 })
    await expect(lifecycle.withBlobReferences([key], async () => { throw new Error('durability failure') })).rejects.toThrow('durability failure')
    expect(lifecycle.candidates.get(key)).toBeUndefined()
    expect(await lifecycle.blobs.hasBlob(key)).toBe(true)
  })

  it('rejects new admission after disposal while an admitted callback drains', async () => {
    const lifecycle = await setupLifecycle()
    const key = await lifecycle.blobs.putBlob(new Uint8Array([8])) as BlobKey
    const entered = deferred(); const release = deferred()
    const running = lifecycle.withBlobReferences([key], async () => { entered.resolve(); await release.promise })
    await entered.promise
    const disposing = lifecycle.dispose()
    await expect(lifecycle.withBlobReferences([key], async () => {})).rejects.toThrow('stopping')
    release.resolve(); await running; await disposing
  })
})
