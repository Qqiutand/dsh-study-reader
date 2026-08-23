import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as BlobLifecycleModule from '../lib/types/study/blob-lifecycle.js'
import { BlobGarbageCollector, collectLiveBlobKeys, PERSISTED_BLOB_REFERENCE_FIELDS } from '../lib/types/study/blob-gc.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const contexts: Array<{ ctx: Context; root: string }> = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(async ({ ctx, root }) => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-study-gc-'))
  const ctx = new Context()
  await ctx.plugin(Storage); await ctx.plugin(StorageJson, { root }); await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(BlobLifecycleModule, { storageRoot: join(root, 'study-reader') })
  contexts.push({ ctx, root })
  return ctx.studyBlobLifecycle
}

function table<T extends object>(records: readonly T[]) {
  return { entries: function * () { for (const [index, record] of records.entries()) yield [String(index), record] } }
}

describe('Blob GC safety checkpoint', () => {
  it('keeps every documented durable reference, including legacy block assets', async () => {
    const lifecycle = await setup(); const b = lifecycle.blobs
    const keys = await Promise.all([...Array(10)].map((_, index) => b.putBlob(new Uint8Array([index + 1]))))
    const [original, partBlocks, revisionOriginal, extraction, manifest, markdown, blocks, asset, setManifest, artifact] = keys
    const legacyBlocks = await b.putBlob(new TextEncoder().encode(`${JSON.stringify({ id: 'b', assetPath: asset })}\n`))
    const live = await collectLiveBlobKeys({
      blobs: b, lifecycle, candidates: lifecycle.candidates,
      imports: table([{ originalBlob: original, providerParts: [{ blocksBlob: partBlocks }] }]) as never,
      revisions: table([
        { originalBlob: revisionOriginal, extractionArtifactBlob: extraction, extractionManifestBlob: manifest, markdownBlob: markdown, blocksBlob: blocks, assetBlobs: [asset] },
        { markdownBlob: markdown, blocksBlob: legacyBlocks },
      ]) as never,
      artifactSets: table([{ manifestBlob: setManifest, artifacts: [{ blobKey: artifact }] }]) as never,
    })
    for (const key of [...keys, legacyBlocks]) expect(live.has(key)).toBe(true)
    expect(PERSISTED_BLOB_REFERENCE_FIELDS).toContain('RevisionRecord.assetBlobs')
    expect(PERSISTED_BLOB_REFERENCE_FIELDS).toContain('ProviderPartRecord.blocksBlob')
  })

  it('marks first, then deletes only an old orphan on a later sweep', async () => {
    const lifecycle = await setup(); const key = await lifecycle.blobs.putBlob(new Uint8Array([1, 2, 3]))
    const deps = { blobs: lifecycle.blobs, lifecycle, candidates: lifecycle.candidates, imports: table([]) as never, revisions: table([]) as never, artifactSets: table([]) as never }
    const mark = new BlobGarbageCollector(deps, { graceMs: 0, batchSize: 10 })
    const first = await mark.run()
    expect(first.candidatesMarked).toBe(1); expect(first.deleted).toBe(0)
    await lifecycle.candidates.put(key, { ...(lifecycle.candidates.get(key)!), firstSeenUnreferencedAt: 0 })
    const second = await new BlobGarbageCollector(deps, { graceMs: 0, batchSize: 10 }).run()
    expect(second.deleted).toBe(1); expect(await lifecycle.blobs.hasBlob(key)).toBe(false)
  })

  it('never deletes when legacy block parsing fails, and reports the safety failure', async () => {
    const lifecycle = await setup(); const orphan = await lifecycle.blobs.putBlob(new Uint8Array([9])); const corrupt = await lifecycle.blobs.putBlob(new TextEncoder().encode('{not-json}\n'))
    await lifecycle.candidates.put(orphan, { schemaVersion: 1, blobKey: orphan, firstSeenUnreferencedAt: 0, lastCheckedAt: 0, observedSizeBytes: 1 })
    const result = await new BlobGarbageCollector({ blobs: lifecycle.blobs, lifecycle, candidates: lifecycle.candidates, imports: table([]) as never, artifactSets: table([]) as never, revisions: table([{ markdownBlob: corrupt, blocksBlob: corrupt }]) as never }, { graceMs: 0, batchSize: 10 }).run()
    expect(result.deleted).toBe(0); expect(result.failures).toBe(1); expect(await lifecycle.blobs.hasBlob(orphan)).toBe(true)
  })

  it('clears a changed-size candidate without deleting and honors batch size', async () => {
    const lifecycle = await setup(); const first = await lifecycle.blobs.putBlob(new Uint8Array([1])); const second = await lifecycle.blobs.putBlob(new Uint8Array([2]))
    await lifecycle.candidates.put(first, { schemaVersion: 1, blobKey: first, firstSeenUnreferencedAt: 0, lastCheckedAt: 0, observedSizeBytes: 99 })
    const changed = await lifecycle.deleteCandidateIfUnreferenced(first, async () => false)
    expect(changed.sizeChanged).toBe(true); expect(await lifecycle.blobs.hasBlob(first)).toBe(true)
    await lifecycle.candidates.put(first, { schemaVersion: 1, blobKey: first, firstSeenUnreferencedAt: 0, lastCheckedAt: 0, observedSizeBytes: 1 })
    await lifecycle.candidates.put(second, { schemaVersion: 1, blobKey: second, firstSeenUnreferencedAt: 0, lastCheckedAt: 0, observedSizeBytes: 1 })
    const result = await new BlobGarbageCollector({ blobs: lifecycle.blobs, lifecycle, candidates: lifecycle.candidates, imports: table([]) as never, revisions: table([]) as never, artifactSets: table([]) as never }, { graceMs: 0, batchSize: 1 }).run()
    expect(result.deleted).toBe(1); expect(lifecycle.candidates.size).toBe(1)
    expect((await lifecycle.blobs.hasBlob(first)) || (await lifecycle.blobs.hasBlob(second))).toBe(true)
  })
})
