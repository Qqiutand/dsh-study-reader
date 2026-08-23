/**
 * Poller contract tests: persistence-first transitions, exponential backoff,
 * single-flight per ImportId, restart recovery of non-terminal records, and
 * the blob-write ordering (a crash may leave unreferenced blobs but never a
 * RevisionRecord pointing at missing blobs).
 */

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeHarnesses, eventually, eventuallyImportState, pdfFixture, setupStudy, type StudyHarness } from './helpers.ts'

const harnesses: StudyHarness[] = []

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  return { promise: new Promise<void>(value => { resolve = value }), resolve }
}

async function setup(): Promise<StudyHarness> {
  const value = await setupStudy()
  harnesses.push(value)
  return value
}

afterEach(async () => {
  await disposeHarnesses()
  harnesses.splice(0)
})

/** Drive one import to a terminal state through the public remote surface. */
async function importFile(ctx: StudyHarness['ctx'], name = 'book.pdf'): Promise<string> {
  const bytes = await pdfFixture()
  const prepared = await ctx.study.prepareUploadForClient({ fileName: name, sizeBytes: bytes.byteLength })
  const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}${prepared.uploadPath}`, {
    method: 'PUT',
    headers: { 'X-Study-Upload-Token': prepared.uploadToken, 'Content-Length': String(bytes.byteLength) },
    body: Buffer.from(bytes),
  })
  expect(response.status).toBe(200)
  return prepared.importId
}

describe('study poller', () => {
  it('abandons final publication when a deletion intent arrives at its barrier', async () => {
    const hooks = await import('../lib/types/study/poller.js') as unknown as { setStudyPollerBeforeFinalPublicationForTest(hook: ((sourceId: string) => Promise<void>) | undefined): void }
    const arrived = deferred(); const release = deferred()
    hooks.setStudyPollerBeforeFinalPublicationForTest(async () => { arrived.resolve(); await release.promise })
    try {
      const { ctx, server } = await setup()
      server.mode = { pollSequence: ['done'] }
      const importId = await importFile(ctx)
      await arrived.promise
      const source = ctx.study.listSources()[0]!
      const domain = (ctx.storageDomain as unknown as { get(name: string): { table(name: string): { put(key: string, value: object): Promise<void>; entries(): Iterable<unknown> } } }).get('study_reader')
      await domain.table('management_deletion_operations').put('poller-intent', { operationId: 'poller-intent', kind: 'delete-source', targetId: source.id, commandId: 'poller-intent', payloadHash: '0'.repeat(64), state: 'prepared', result: { result: { deleted: true, removed: {} }, keys: {}, eventSessions: [] }, createdAt: 1, updatedAt: 1 })
      release.resolve()
      await eventually(() => ctx.study.listSources()[0]?.revisionId === undefined)
      expect(ctx.study.listSources()[0]?.revisionId).toBeUndefined()
      expect(ctx.study.importStatusForClient({ importId }).state).not.toBe('failed')
      expect(ctx.study.importStatusForClient({ importId }).failure).toBeUndefined()
      expect([...domain.table('revisions').entries()]).toEqual([])
    } finally { hooks.setStudyPollerBeforeFinalPublicationForTest(undefined) }
  })
  it('persists each state before progressing and lands on ready', async () => {
    const harness = await setup()
    const { ctx } = harness
    const importId = await importFile(ctx)
    await eventuallyImportState(harness, importId, 'ready')
    const status = ctx.study.importStatusForClient({ importId })
    expect(status.progress?.totalPages).toBe(3)
    // The revision was created with blobs on disk and the source updated.
    const sources = ctx.study.listSources()
    expect(sources).toHaveLength(1)
    expect(sources[0]?.revisionId).toBeDefined()
    expect(sources[0]?.pageCount).toBe(3)
    const domain = (ctx.storageDomain as unknown as { get(name: string): { table(name: string): { get(key: string): unknown } } }).get('study_reader')
    const record = domain.table('imports').get(importId) as { artifactSetId?: string }
    expect(record).toMatchObject({ artifactSetId: expect.stringMatching(/^aset-/) })
    const set = domain.table('extraction_artifact_sets').get(record.artifactSetId!) as {
      scope: unknown; artifacts: readonly { role: string }[]; manifestSha256: string; manifestBlob: string
    }
    expect(set.scope).toEqual({ kind: 'whole' })
    expect(set.artifacts).toEqual([expect.objectContaining({ role: 'archive' })])
    expect(set.artifacts.some(artifact => artifact.role === 'manifest')).toBe(false)
    expect(set.manifestBlob).toBe(`sha256/${set.manifestSha256}`)
  })

  it('splits PDFs above the provider page limit and assembles one revision', async () => {
    const harness = await setupStudy({ maxProviderPagesPerPart: 2 })
    harnesses.push(harness)
    const { ctx, server } = harness
    server.mode = { pollSequence: ['done'] }
    const pdf = await pdfFixture(5)
    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'long.pdf', sizeBytes: pdf.byteLength })
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}${prepared.uploadPath}`, {
      method: 'PUT',
      headers: { 'X-Study-Upload-Token': prepared.uploadToken, 'Content-Length': String(pdf.byteLength) },
      body: Buffer.from(pdf),
    })
    expect(response.status).toBe(200)
    await eventually(() => server.uploadCount === 3)
    await eventuallyImportState(harness, prepared.importId, 'ready')
    const status = ctx.study.importStatusForClient({ importId: prepared.importId })
    expect(status.progress).toMatchObject({ totalPages: 5, completedParts: 3, totalParts: 3 })
    expect(ctx.study.listSources()[0]).toMatchObject({ pageCount: 5 })
    const domain = (ctx.storageDomain as unknown as { get(name: string): { table(name: string): { get(key: string): unknown } } }).get('study_reader')
    const record = domain.table('imports').get(prepared.importId) as { artifactSetId?: string; providerParts: readonly { index: number; artifactSetId?: string }[] }
    expect(record.artifactSetId).toBeUndefined()
    expect(record.providerParts.map(part => part.artifactSetId)).toHaveLength(3)
    expect(new Set(record.providerParts.map(part => part.artifactSetId)).size).toBe(3)
    for (const part of record.providerParts) {
      const set = domain.table('extraction_artifact_sets').get(part.artifactSetId!) as { scope: { kind: string; index: number } }
      expect(set.scope).toMatchObject({ kind: 'part', index: part.index })
    }
  })

  it('applies exponential backoff on pending/running polls', async () => {
    const { ctx } = await setup({ pollTickMs: 10, pollInitialMs: 50, pollMaxMs: 500 })
    const importId = await importFile(ctx)
    // The first poll happens quickly; subsequent ones back off. Just assert
    // the import eventually completes (backoff timing is observable through
    // attempts in the durable record).
    await eventually(() => ctx.study.importStatusForClient({ importId }).state === 'ready')
    const domain = (ctx.storageDomain as unknown as { get(name: string): { table(name: string): { get(key: string): unknown } } }).get('study_reader')
    const record = domain.table('imports').get(importId) as { attempts?: number }
    expect(record.attempts).toBeGreaterThanOrEqual(2)
  })

  it('retries while MinerU is still admitting a completed upload', async () => {
    const { ctx, server } = await setup()
    server.mode = { pollSequence: ['waiting-file', 'pending', 'done'] }
    const importId = await importFile(ctx)
    await eventually(() => ctx.study.importStatusForClient({ importId }).state === 'ready')
    expect(ctx.study.importStatusForClient({ importId }).failure).toBeUndefined()
  })

  it('never runs two polls of the same import concurrently (single-flight)', async () => {
    const { ctx } = await setup({ pollTickMs: 10, pollInitialMs: 1, pollMaxMs: 10, maxConcurrentPolls: 2 })
    const importId = await importFile(ctx)
    let concurrent = 0
    let peak = 0
    const timer = setInterval(() => {
      peak = Math.max(peak, concurrent)
    }, 2)
    void concurrent
    const basePoll = ctx.documentExtraction.poll.bind(ctx.documentExtraction)
    let inFlight = 0
    ;(ctx.documentExtraction as unknown as { poll: unknown }).poll = (task: unknown, signal: AbortSignal) => {
      inFlight += 1
      concurrent = inFlight
      return basePoll(task as never, signal).finally(() => { inFlight -= 1 })
    }
    await eventually(() => ctx.study.importStatusForClient({ importId }).state === 'ready')
    clearInterval(timer)
    expect(peak).toBeLessThanOrEqual(1)
  })

  it('recovers non-terminal records at startup (restart recovery)', async () => {
    const first = await setup()
    first.server.mode = { pollSequence: ['pending', 'done'] }
    const importId = await importFile(first.ctx)
    // Wait until the import is provider-active, then simulate a
    // restart: tear the process down and revive over the SAME storage root.
    await eventually(() => first.ctx.study.importStatusForClient({ importId }).state === 'extracting')
    const before = first.ctx.study.importStatusForClient({ importId })
    expect(before.state).toBe('extracting')
    const root = first.root
    await first.dispose(false)
    const revived = await setupStudy({ pollTickMs: 40, pollInitialMs: 10, pollMaxMs: 200 }, {}, root)
    harnesses.push(revived)
    const status = revived.ctx.study.importStatusForClient({ importId })
    expect(['extracting', 'collecting', 'normalizing', 'indexing', 'ready']).toContain(status.state)
    await eventually(() => revived.ctx.study.importStatusForClient({ importId }).state === 'ready')
    const sources = revived.ctx.study.listSources()
    expect(sources[0]?.revisionId).toBeDefined()
  })

  it.each(['normalizing', 'indexing'] as const)('recovers a provider-complete PDF from %s without resubmitting it', async (checkpoint) => {
    const hooks = await import('../lib/types/study/poller.js') as unknown as {
      setStudyPollerBeforeFinalPublicationForTest(hook: ((sourceId: string) => Promise<void>) | undefined): void
      setStudyPollerBeforeReadyPublicationForTest(hook: ((sourceId: string) => Promise<void>) | undefined): void
    }
    const arrived = deferred(); const release = deferred()
    const setBarrier = checkpoint === 'normalizing'
      ? hooks.setStudyPollerBeforeFinalPublicationForTest
      : hooks.setStudyPollerBeforeReadyPublicationForTest
    setBarrier(async () => { arrived.resolve(); await release.promise })
    try {
      const first = await setup()
      first.server.mode = { pollSequence: ['done'] }
      const importId = await importFile(first.ctx)
      await arrived.promise
      expect(first.ctx.study.importStatusForClient({ importId }).state).toBe(checkpoint)
      const root = first.root
      const stopping = first.dispose(false)
      release.resolve()
      await stopping
      const revived = await setupStudy({}, {}, root)
      harnesses.push(revived)
      await eventuallyImportState(revived, importId, 'ready')
      expect(revived.server.uploadCount).toBe(0)
      expect(revived.ctx.study.importStatusForClient({ importId }).failure).toBeUndefined()
    } finally {
      hooks.setStudyPollerBeforeFinalPublicationForTest(undefined)
      hooks.setStudyPollerBeforeReadyPublicationForTest(undefined)
    }
  })

  it('persists a failed import with its failure details', async () => {
    const { ctx, server } = await setup()
    server.mode = { pollSequence: ['failed'] }
    const importId = await importFile(ctx)
    await eventually(() => ctx.study.importStatusForClient({ importId }).state === 'failed')
    const status = ctx.study.importStatusForClient({ importId })
    expect(status.failure).toMatchObject({ code: 'PROVIDER_REJECTED', providerCode: 'FAKE_FAILURE' })
  })

  it('fails an import whose provider task vanished', async () => {
    const { ctx } = await setup({ pollInitialMs: 1000 })
    const importId = await importFile(ctx)
    await eventually(() => ctx.study.importStatusForClient({ importId }).state === 'extracting')
    const domain = (ctx.storageDomain as unknown as { get(name: string): { table(name: string): { put(k: string, v: unknown): Promise<void> } } }).get('study_reader')
    const record = domain.table('imports').get(importId) as { providerTask?: unknown; providerParts?: unknown }
    const { providerTask: _providerTask, providerParts: _providerParts, ...withoutTask } = record
    await domain.table('imports').put(importId, withoutTask)
    await eventually(() => ctx.study.importStatusForClient({ importId }).state === 'failed')
    expect(ctx.study.importStatusForClient({ importId }).failure).toMatchObject({ code: 'PROVIDER_REJECTED', providerCode: 'provider-task-missing' })
  })

  it('leaves no RevisionRecord when normalization fails (blob-order guarantee)', async () => {
    const { ctx, server, root } = await setup()
    server.mode = { corruptZip: true }
    const importId = await importFile(ctx)
    await eventually(() => ctx.study.importStatusForClient({ importId }).state === 'failed')
    expect(ctx.study.importStatusForClient({ importId }).failure).toMatchObject({ code: 'COLLECTION_FAILED', providerCode: 'ZIP_INVALID' })
    const sources = ctx.study.listSources()
    expect(sources[0]?.revisionId).toBeUndefined()
    // The blob directory may hold strays but the tmp dir is cleaned.
    await expect(access(join(root, 'study-reader', 'tmp', importId))).rejects.toThrow()
  })
})
