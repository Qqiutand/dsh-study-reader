import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { BlobStore, isBlobKey, type BlobKey } from './blob-store.ts'
import type { BlobLifecycleService } from './blob-lifecycle.ts'
import type { BlobGcCandidateRecord, BlobGcResult, ExtractionArtifactSetId, ExtractionArtifactSetRecord, ImportId, ImportRecord, RevisionId, RevisionRecord, StudyBlock } from './types.ts'

export interface BlobGcConfig { readonly graceMs: number; readonly batchSize: number }
export interface BlobGcDeps {
  readonly blobs: BlobStore
  readonly imports: KvTable<ImportId, ImportRecord>
  readonly revisions: KvTable<RevisionId, RevisionRecord>
  readonly artifactSets: KvTable<ExtractionArtifactSetId, ExtractionArtifactSetRecord>
  readonly candidates: KvTable<string, BlobGcCandidateRecord>
  readonly lifecycle: BlobLifecycleService
  readonly now?: () => number
  readonly onSafetyError?: (code: string) => void
}

type MutableResult = { -readonly [K in keyof BlobGcResult]: BlobGcResult[K] }
const empty = (): MutableResult => ({ scanned: 0, live: 0, recentSkipped: 0, candidatesMarked: 0, candidatesCleared: 0, deleted: 0, reclaimedBytes: 0, remainingCandidates: 0, failures: 0 })
const add = (set: Set<BlobKey>, value: string | undefined) => { if (value !== undefined && isBlobKey(value)) set.add(value) }

/** All durable BlobKey fields. Keep this list beside the only Live scanner. */
export const PERSISTED_BLOB_REFERENCE_FIELDS = [
  'ImportRecord.originalBlob', 'ProviderPartRecord.blocksBlob',
  'RevisionRecord.originalBlob', 'RevisionRecord.extractionArtifactBlob', 'RevisionRecord.extractionManifestBlob',
  'RevisionRecord.markdownBlob', 'RevisionRecord.blocksBlob', 'RevisionRecord.assetBlobs',
  'ExtractionArtifactSetRecord.manifestBlob', 'ExtractionArtifactRecord.blobKey',
] as const

/** The single authoritative mark source for every durable blob reference. */
export async function collectLiveBlobKeys(deps: BlobGcDeps): Promise<ReadonlySet<BlobKey>> {
  const live = new Set<BlobKey>()
  for (const [, record] of deps.imports.entries()) {
    add(live, record.originalBlob)
    for (const part of record.providerParts ?? []) add(live, part.blocksBlob)
  }
  for (const [, set] of deps.artifactSets.entries()) {
    add(live, set.manifestBlob); for (const artifact of set.artifacts) add(live, artifact.blobKey)
  }
  for (const [, revision] of deps.revisions.entries()) {
    add(live, revision.originalBlob); add(live, revision.extractionArtifactBlob); add(live, revision.extractionManifestBlob)
    add(live, revision.markdownBlob); add(live, revision.blocksBlob)
    if (revision.assetBlobs !== undefined) { for (const key of revision.assetBlobs) add(live, key); continue }
    // Legacy records are unsafe to sweep unless the blocks are fully readable and parseable.
    const bytes = await deps.blobs.readBlob(revision.blocksBlob as BlobKey)
    for (const line of new TextDecoder().decode(bytes).split('\n')) {
      if (line.trim() === '') continue
      const block = JSON.parse(line) as StudyBlock
      add(live, block.assetPath)
    }
  }
  return live
}

/** Conservative durable two-pass mark/sweep. Any mark failure makes sweep a no-op. */
export class BlobGarbageCollector {
  private running: Promise<BlobGcResult> | undefined
  private stopped = false
  constructor(private readonly deps: BlobGcDeps, private readonly config: BlobGcConfig) {}
  run(): Promise<BlobGcResult> { return this.stopped ? Promise.resolve(empty()) : this.running ??= this.runOnce().finally(() => { this.running = undefined }) }
  async dispose(): Promise<void> { this.stopped = true; await this.running }
  private async runOnce(): Promise<BlobGcResult> {
    const result = empty(); const now = this.deps.now?.() ?? Date.now()
    let live: ReadonlySet<BlobKey>
    try { live = await collectLiveBlobKeys(this.deps) } catch { result.failures++; this.deps.onSafetyError?.('BLOB_GC_MARK_FAILED'); return result }
    result.live = live.size
    const candidates = new Map<BlobKey, BlobGcCandidateRecord>()
    const newlyMarked = new Set<BlobKey>()
    for (const [key, candidate] of this.deps.candidates.entries()) if (isBlobKey(key)) candidates.set(key, candidate)
    const blobs = await this.deps.blobs.listContentBlobs(); result.scanned = blobs.length
    for (const key of live) if (candidates.has(key)) { await this.deps.candidates.delete(key); candidates.delete(key); result.candidatesCleared++ }
    for (const key of blobs) {
      if (live.has(key)) continue
      const info = await this.deps.blobs.statBlob(key); if (info === undefined) continue
      if (now - info.createdAt < this.config.graceMs) { result.recentSkipped++; continue }
      if (!candidates.has(key)) { const candidate = { schemaVersion: 1 as const, blobKey: key, firstSeenUnreferencedAt: now, lastCheckedAt: now, observedSizeBytes: info.sizeBytes }; await this.deps.candidates.put(key, candidate); candidates.set(key, candidate); newlyMarked.add(key); result.candidatesMarked++ }
      else { const candidate = { ...candidates.get(key)!, lastCheckedAt: now, observedSizeBytes: info.sizeBytes }; await this.deps.candidates.put(key, candidate); candidates.set(key, candidate) }
    }
    // Mark completed. A second complete read is mandatory before every sweep.
    let again: ReadonlySet<BlobKey>
    try { again = await collectLiveBlobKeys(this.deps) } catch { result.failures++; result.remainingCandidates = this.deps.candidates.size; return result }
    for (const [key, candidate] of [...candidates].sort(([a], [b]) => a.localeCompare(b)).slice(0, this.config.batchSize)) {
      if (this.stopped) break
      // A candidate created by this Mark is never eligible for deletion in
      // the same run, even when a test policy uses a zero grace period.
      if (newlyMarked.has(key)) continue
      if (again.has(key)) { await this.deps.candidates.delete(key); candidates.delete(key); result.candidatesCleared++; continue }
      if (now - candidate.firstSeenUnreferencedAt < this.config.graceMs) continue
      try {
        const before = await this.deps.blobs.statBlob(key)
        if (before === undefined) { await this.deps.candidates.delete(key); candidates.delete(key); result.candidatesCleared++; continue }
        const deletion = await this.deps.lifecycle.deleteCandidateIfUnreferenced(key, async () => (await collectLiveBlobKeys(this.deps)).has(key))
        if (deletion.deleted) { result.deleted++; result.reclaimedBytes += before.sizeBytes }
        if (deletion.deleted || deletion.retained || deletion.sizeChanged || await this.deps.blobs.statBlob(key) === undefined) {
          candidates.delete(key); result.candidatesCleared++
        }
        if (deletion.sizeChanged) this.deps.onSafetyError?.('BLOB_GC_SIZE_CHANGED')
      } catch {
        result.failures++
        this.deps.onSafetyError?.('BLOB_GC_DELETE_FAILED')
      }
    }
    result.remainingCandidates = [...this.deps.candidates.entries()].length
    return result
  }
}
