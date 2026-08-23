/**
 * Import poller: drives non-terminal imports through the provider state
 * machine, then downloads and normalizes the result archive.
 *
 * Guarantees:
 * - one in-flight poll Promise per ImportId (single-flight), and at most
 *   `maxConcurrentPolls` concurrent polls;
 * - every state change is persisted before the next step proceeds (the
 *   domain layer persists first, then mutates memory, then emits);
 * - `pending`/`running`/`converting` poll with exponential backoff
 *   (`pollInitialMs * 2^attempts`, capped at `pollMaxMs`);
 * - a `done` result enters downloading → normalizing → ready, with the blob
 *   write order from the persistence contract (download → validate ZIP →
 *   normalize → atomic blob rename → RevisionRecord/SourceRecord → ready), so
 *   a crash can only leave unreferenced blobs, never a RevisionRecord whose
 *   blobs are missing;
 * - non-terminal records are re-admitted at startup; `normalizing` reuses
 *   its durable Artifact Set to resume local post-processing, while
 *   `indexing` finishes the durable ready commit without replaying provider
 *   work;
 * - teardown stops admission, aborts every in-flight request, and waits for
 *   the operation tails.
 *
 * This poller is a process-local driver: it displays running state, and the
 * persisted ImportRecord is the authority.
 * @module @deepseek-ai/dsh-study/poller
 */

import { rm, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { DocumentExtractionService, ExtractionProgress, ProviderTask } from '../extraction/index.ts'
import { StudyError } from '../protocol/error.ts'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { BlobStore, sha256File, type BlobKey } from './blob-store.ts'
import type { BlobLifecycleService } from './blob-lifecycle.ts'
import { artifactSetIdFor, blobKeyForSha256, canonicalJsonBytes, canonicalManifestProjection, manifestSha256 } from './artifact-manifest.ts'
import { type ArchiveLimits, type RawStudyBlock } from './normalize.ts'
import { RevisionAssembler } from './revision-assembler.ts'
import { transitionImport } from './import-transition.ts'
export { blocksJsonl, assetBlobKeys, revisionBlobKeys } from './revision-blobs.ts'
import type {
  ExtractionArtifactSetId, ExtractionArtifactSetRecord, ImportId, ImportRecord, RevisionId, RevisionRecord, SourceId, SourceRecord,
} from './types.ts'

/** Poller policy. */
export interface PollerConfig {
  readonly pollTickMs: number
  readonly pollInitialMs: number
  readonly pollMaxMs: number
  readonly maxConcurrentPolls: number
  /** Provider model label stamped onto revisions. */
  readonly providerModel: string
}

/** The domain tables and services the poller drives. */
export interface PollerDeps {
  readonly documentExtraction: DocumentExtractionService
  readonly imports: KvTable<ImportId, ImportRecord>
  readonly artifactSets: KvTable<ExtractionArtifactSetId, ExtractionArtifactSetRecord>
  readonly revisions: KvTable<RevisionId, RevisionRecord>
  readonly sources: KvTable<SourceId, SourceRecord>
  readonly blobs: BlobStore
  readonly blobLifecycle: BlobLifecycleService
  readonly limits: ArchiveLimits
  readonly config: PollerConfig
  /** Aborted when the owning plugin tears down. */
  readonly lifecycle: AbortSignal
  /** Rechecks the durable source deletion intent before source-owned writes. */
  readonly assertSourceWritable: (sourceId: SourceId) => void
  /** Grants a completed import to its initiating session without changing an existing selection. */
  readonly onReady?: (record: ImportRecord) => Promise<void>
}

/** Test-only barrier immediately before final revision publication. */
let beforeFinalPublicationForTest: ((sourceId: SourceId) => Promise<void>) | undefined
export function setStudyPollerBeforeFinalPublicationForTest(hook: ((sourceId: SourceId) => Promise<void>) | undefined): void { beforeFinalPublicationForTest = hook }

/** Test-only barrier after durable indexing entry and before the ready commit. */
let beforeReadyPublicationForTest: ((sourceId: SourceId) => Promise<void>) | undefined
export function setStudyPollerBeforeReadyPublicationForTest(hook: ((sourceId: SourceId) => Promise<void>) | undefined): void { beforeReadyPublicationForTest = hook }

/** States the poller admits. */
const POLLABLE: ReadonlySet<ImportRecord['state']> = new Set([
  'extracting', 'collecting', 'normalizing', 'indexing',
])

/** Process-local poll driver. */
export class StudyPoller {
  private readonly inFlight = new Set<ImportId>()
  private readonly controllers = new Set<AbortController>()
  private admission = true
  private stopped = false
  private readonly tails = new Set<Promise<void>>()

  /**
   * @param ctx - Cordis context carrying the timer.
   * @param deps - tables, provider, blob store, and policy.
   */
  constructor(
    private readonly ctx: Context,
    private readonly deps: PollerDeps,
  ) {}

  /** The interval disposer; call from the owning effect. */
  start(): () => void {
    return this.ctx.interval(() => { void this.tick().catch(error => this.ctx.logger.error(error)) }, this.deps.config.pollTickMs)
  }

  /**
   * Stop admission and abort all in-flight network work, then wait for every
   * operation tail. Idempotent.
   * @returns resolution after the tails settle.
   */
  async dispose(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.admission = false
    for (const controller of this.controllers) controller.abort(new Error('study poller stopped'))
    await Promise.allSettled([...this.tails])
  }

  /** One poll cycle: admit due imports up to the concurrency cap. */
  private async tick(): Promise<void> {
    if (!this.admission) return
    const now = Date.now()
    const due: ImportId[] = []
    for (const [id, record] of this.deps.imports.entries()) {
      if (this.inFlight.has(id)) continue
      if (record.format === 'epub' || !POLLABLE.has(record.state)) continue
      if (record.nextPollAt !== undefined && record.nextPollAt > now) continue
      due.push(id)
      if (due.length >= this.deps.config.maxConcurrentPolls) break
    }
    for (const id of due) {
      if (this.inFlight.size >= this.deps.config.maxConcurrentPolls) break
      const tail = this.pollOne(id)
      this.tails.add(tail)
      void tail.finally(() => { this.tails.delete(tail) })
    }
  }

  /** Poll one import to its next transition. Single-flight by construction. */
  private async pollOne(importId: ImportId): Promise<void> {
    if (this.inFlight.has(importId)) return
    this.inFlight.add(importId)
    const controller = new AbortController()
    this.controllers.add(controller)
    const onAbort = (): void => { controller.abort(this.deps.lifecycle.reason) }
    this.deps.lifecycle.addEventListener('abort', onAbort, { once: true })
    try {
      const record = this.deps.imports.get(importId)
      if (record === undefined || record.format === 'epub' || !POLLABLE.has(record.state)) return
      if (record.state === 'indexing') {
        await this.completeIndexing(record)
        return
      }
      if (record.providerParts !== undefined) {
        await this.pollMultipart(record, controller.signal)
        return
      }
      if (record.state === 'normalizing') {
        await this.downloadFlow(record, controller.signal)
        return
      }
      if (record.providerTask === undefined || record.providerId === undefined) {
        await this.fail(record, 'provider-task-missing', 'import has no bound provider task')
        return
      }
      const progress = await this.deps.documentExtraction.pollFor(record.providerId, record.providerTask as ProviderTask, controller.signal)
      await this.applyProgress(record, progress, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof StudyError && error.code === 'SOURCE_DELETION_IN_PROGRESS') return
      const record = this.deps.imports.get(importId)
      if (record !== undefined && POLLABLE.has(record.state)) {
        const code = error instanceof StudyError ? error.code : 'POLL_FAILED'
        const message = error instanceof Error ? error.message : String(error)
        await this.fail(record, code, message)
      }
    } finally {
      this.deps.lifecycle.removeEventListener('abort', onAbort)
      this.controllers.delete(controller)
      this.inFlight.delete(importId)
    }
  }

  /** Poll the first unfinished provider part and finalize after every part is ready. */
  private async pollMultipart(record: ImportRecord, signal: AbortSignal): Promise<void> {
    const part = record.providerParts?.find(candidate => candidate.state !== 'ready')
    if (part === undefined) {
      await this.finalizeMultipart(record)
      return
    }
    if (part.nextPollAt !== undefined && part.nextPollAt > Date.now()) return
    if (record.providerId === undefined) throw new StudyError('import has no bound provider instance', 'PROVIDER_NOT_FOUND')
    const progress = await this.deps.documentExtraction.pollFor(record.providerId, part.task as ProviderTask, signal)
    switch (progress.state) {
      case 'waiting-upload':
        await this.transitionPart(record, part.index, { state: 'submitted' })
        return
      case 'pending':
      case 'running':
      case 'converting':
        await this.transitionPart(record, part.index, { state: progress.state }, progress)
        return
      case 'done':
        await this.downloadPart(record, part.index, signal)
        return
      case 'failed':
        await this.fail(record, progress.code ?? 'provider-failed', `part ${part.index + 1}: ${progress.message}`)
        return
    }
  }

  /** Persist one part transition and aggregate it into the import status. */
  private async transitionPart(
    record: ImportRecord,
    partIndex: number,
    patch: Partial<NonNullable<ImportRecord['providerParts']>[number]>,
    progress?: ExtractionProgress,
  ): Promise<void> {
    this.deps.assertSourceWritable(record.sourceId)
    const current = record.providerParts?.find(part => part.index === partIndex)
    if (current === undefined) throw new StudyError(`provider part ${partIndex} is missing`, 'PROVIDER_TASK_MISSING')
    const attempts = current.attempts + 1
    const nextPollAt = Date.now() + Math.min(
      this.deps.config.pollInitialMs * 2 ** Math.min(attempts, 10),
      this.deps.config.pollMaxMs,
    )
    const parts = record.providerParts!.map(part => part.index === partIndex
      ? { ...part, ...patch, attempts, nextPollAt }
      : part)
    const completed = parts.filter(part => part.state === 'ready')
    const completePages = completed.reduce((sum, part) => sum + partPageCount(part), 0)
    const currentExtracted = progress?.state === 'running' ? (progress.extractedPages ?? 0) : 0
    // Parts are private provider checkpoints. The public import cannot enter
    // `normalizing` until every part has a durable Artifact Set; before that
    // the artifact collector remains the sole owner.
    const allArtifactsPersisted = parts.every(part => part.artifactSetId !== undefined)
    const state = patch.state === 'downloading'
      ? record.state === 'normalizing' ? 'normalizing' : 'collecting'
      : patch.state === 'normalizing' || patch.state === 'ready'
        ? allArtifactsPersisted ? 'normalizing' : 'collecting'
        : 'extracting'
    await transitionImport(this.deps.imports, record.id, {
      transitionId: `poll-part-${partIndex}-${attempts}-${patch.state ?? 'checkpoint'}`,
      to: state,
      patch: { providerParts: parts, attempts: record.attempts + 1, nextPollAt, progress: { completedPages: completePages + currentExtracted, completedParts: completed.length, totalParts: parts.length, updatedAt: Date.now() } },
    })
  }

  /** Apply one provider progress snapshot to a record. */
  private async applyProgress(record: ImportRecord, progress: ExtractionProgress, signal: AbortSignal): Promise<void> {
    switch (progress.state) {
      case 'waiting-upload':
        // MinerU may report waiting-file while its scanner admits a completed
        // signed-URL upload. Keep the import pollable under the normal backoff.
        await this.transition(record, 'extracting')
        return
      case 'pending':
      case 'running':
      case 'converting':
        await this.transition(record, 'extracting', {
          ...progress.state === 'running' && (progress.extractedPages !== undefined || progress.totalPages !== undefined)
            ? {
              progress: {
                ...progress.extractedPages !== undefined ? { completedPages: progress.extractedPages } : {},
                ...progress.totalPages !== undefined ? { totalPages: progress.totalPages } : {},
                updatedAt: Date.now(),
              },
            }
            : {},
        })
        return
      case 'done':
        await this.downloadFlow(record, signal)
        return
      case 'failed':
        await this.fail(record, progress.code ?? 'provider-failed', progress.message)
        return
    }
  }

  /** Persist one state transition with backoff only while provider polling. */
  private async transition(record: ImportRecord, to: ImportRecord['state'], patch: Partial<ImportRecord> = {}): Promise<void> {
    this.deps.assertSourceWritable(record.sourceId)
    const attempts = record.attempts + 1
    const nextPollAt = to === 'extracting'
      ? Date.now() + Math.min(
        this.deps.config.pollInitialMs * 2 ** Math.min(attempts, 10),
        this.deps.config.pollMaxMs,
      )
      : undefined
    await transitionImport(this.deps.imports, record.id, { transitionId: `poll-${record.recordVersion}-${to}`, to, patch: { ...patch, attempts, ...(nextPollAt === undefined ? {} : { nextPollAt }) } })
  }

  /** Persist a terminal failure. */
  private async fail(record: ImportRecord, code: string, message: string): Promise<void> {
    await transitionImport(this.deps.imports, record.id, { transitionId: `fail-${record.recordVersion}`, to: 'failed', patch: { attempts: record.attempts + 1 }, failure: { stage: activeFailureStage(record.state), code: failureCode(code), retryable: !code.includes('INVALID'), ...(record.providerId === undefined ? {} : { providerId: record.providerId }), providerCode: code, message, occurredAt: Date.now() } })
    await this.deps.blobs.clearTmp(record.id).catch(() => {})
  }

  /** Download and normalize one part, retaining adjusted raw blocks for final assembly. */
  private async downloadPart(record: ImportRecord, partIndex: number, signal: AbortSignal): Promise<void> {
    await this.transitionPart(record, partIndex, { state: 'downloading' })
    const zipPath = this.deps.blobs.tmpPath(record.id, `archive-${partIndex}.zip`)
    await rm(zipPath, { force: true })
    try {
      if (record.providerId === undefined) throw new StudyError('import has no bound provider instance', 'PROVIDER_NOT_FOUND')
      const part = record.providerParts?.find(candidate => candidate.index === partIndex)
      if (part === undefined) throw new StudyError(`provider part ${partIndex} is missing`, 'PROVIDER_TASK_MISSING')
      let active = this.deps.imports.get(record.id) ?? record
      let activePart = active.providerParts?.find(candidate => candidate.index === partIndex)
      if (activePart === undefined) throw new StudyError(`provider part ${partIndex} is missing`, 'PROVIDER_TASK_MISSING')
      let set: ExtractionArtifactSetRecord
      if (activePart.artifactSetId === undefined) {
        const collected = await this.deps.documentExtraction.collect(record.providerId, activePart.task as ProviderTask, zipPath, signal)
        const scope = { kind: 'part' as const, index: activePart.index, ...(activePart.startPage === undefined ? {} : { startPage: activePart.startPage }), ...(activePart.endPage === undefined ? {} : { endPage: activePart.endPage }) }
        const artifactSetId = await this.persistArtifactSet(active, activePart.task as ProviderTask, scope, collected)
        await this.bindArtifactSet(active, artifactSetId)
        active = this.deps.imports.get(record.id) ?? active
        activePart = active.providerParts?.find(candidate => candidate.index === partIndex)
        if (activePart === undefined) throw new StudyError(`provider part ${partIndex} is missing`, 'PROVIDER_TASK_MISSING')
      }
      set = this.requireArtifactSet(activePart.artifactSetId!, active, { kind: 'part', index: activePart.index, ...(activePart.startPage === undefined ? {} : { startPage: activePart.startPage }), ...(activePart.endPage === undefined ? {} : { endPage: activePart.endPage }) })
      const archive = this.requireArchive(set)
      const normalized = await this.deps.documentExtraction.normalizeArtifacts(
        record.providerId,
        this.deps.blobs.blobPath(archive.blobKey),
        this.deps.limits,
        (data, name) => this.deps.blobs.putBlob(data).then(key => {
          this.ctx.logger.debug(`study: stored asset ${name} at ${key}`)
          return key
        }),
        signal,
      )
      const latest = this.deps.imports.get(record.id) ?? active
      await this.transitionPart(latest, partIndex, { state: 'normalizing' })
      const latestPart = latest.providerParts?.find(candidate => candidate.index === partIndex)
      if (latestPart === undefined) throw new StudyError(`provider part ${partIndex} is missing`, 'PROVIDER_TASK_MISSING')
      const offset = (latestPart.startPage ?? 1) - 1
      const partPageCount = latestPart.startPage === undefined || latestPart.endPage === undefined
        ? undefined
        : latestPart.endPage - latestPart.startPage + 1
      const raw: RawStudyBlock[] = normalized.blocks
        .filter(block => partPageCount === undefined || block.page === 0 || block.page <= partPageCount)
        .map(block => ({
        type: block.type,
        page: block.page === 0 ? 0 : block.page + offset,
        providerPageIndex: block.providerPageIndex < 0 ? -1 : block.providerPageIndex + offset,
        text: block.text,
        ...block.bbox !== undefined ? { bbox: block.bbox } : {},
        ...block.sourceLocator !== undefined ? { sourceLocator: block.sourceLocator } : {},
        ...block.assetPath !== undefined ? { assetPath: block.assetPath } : {},
        ...block.type === 'title' ? { headingLevel: block.headingPath.length + 1 } : {},
        }))
      const blocksBlob = await this.deps.blobs.putBlob(new TextEncoder().encode(rawBlocksJsonl(raw)))
      const afterNormalize = this.deps.imports.get(record.id) ?? latest
      await this.deps.blobLifecycle.withBlobReferences([blocksBlob], async () => {
        await this.transitionPart(afterNormalize, partIndex, { state: 'ready', blocksBlob })
      }, signal)
      const ready = this.deps.imports.get(record.id) ?? afterNormalize
      const completed = ready.providerParts?.filter(candidate => candidate.state === 'ready').length ?? 0
      const total = ready.providerParts?.length ?? 0
      if (completed === total) await this.finalizeMultipart(ready)
    } finally {
      await rm(zipPath, { force: true }).catch(() => {})
    }
  }

  /** Combine adjusted part blocks and commit one canonical whole-document revision. */
  private async finalizeMultipart(record: ImportRecord): Promise<void> {
    await beforeFinalPublicationForTest?.(record.sourceId)
    this.deps.assertSourceWritable(record.sourceId)
    const parts = record.providerParts
    if (parts === undefined || parts.length === 0 || parts.some(part => part.state !== 'ready' || part.blocksBlob === undefined)) {
      throw new StudyError('multipart import is incomplete', 'PROVIDER_PARTS_INCOMPLETE')
    }
    const raw: RawStudyBlock[] = []
    for (const part of [...parts].sort((left, right) => left.index - right.index)) {
      const bytes = await this.deps.blobs.readBlob(part.blocksBlob as BlobKey)
      raw.push(...parseRawBlocksJsonl(new TextDecoder().decode(bytes)))
    }
    const sets = [...parts].sort((left, right) => left.index - right.index).map(part => this.requireArtifactSet(part.artifactSetId!, record, { kind: 'part', index: part.index, ...(part.startPage === undefined ? {} : { startPage: part.startPage }), ...(part.endPage === undefined ? {} : { endPage: part.endPage }) }))
    const revision = await new RevisionAssembler({ blobs: this.deps.blobs, lifecycle: this.deps.blobLifecycle, revisions: this.deps.revisions, assertSourceWritable: this.deps.assertSourceWritable }).assembleRaw(record, sets, raw, 1, this.deps.lifecycle)
    const source = this.deps.sources.get(record.sourceId)
    if (source !== undefined) {
      await this.deps.sources.put(record.sourceId, { ...source, currentRevisionId: revision.id, updatedAt: Date.now() })
    }
    const indexed = this.deps.imports.get(record.id) ?? record
    await this.transition(indexed, 'indexing', { revisionId: revision.id })
    await beforeReadyPublicationForTest?.(record.sourceId)
    await this.deps.onReady?.(this.deps.imports.get(record.id) ?? record)
    await transitionImport(this.deps.imports, record.id, { transitionId: `ready-${revision.id}`, to: 'ready', patch: { revisionId: revision.id, semanticStatus: 'available', progress: { ...(record.progress?.totalPages === undefined ? {} : { completedPages: record.progress.totalPages }), completedParts: parts.length, totalParts: parts.length, updatedAt: Date.now() } } })
    this.ctx.logger.info(`study: multipart import ${record.id} ready (${revision.blockCount} blocks)`)
  }

  /** Download → validate → normalize → persist the revision, in the fixed order. */
  private async downloadFlow(record: ImportRecord, signal: AbortSignal): Promise<void> {
    this.deps.assertSourceWritable(record.sourceId)
    const importId = record.id
    if (record.state === 'extracting') await this.transition(record, 'collecting')
    const zipPath = this.deps.blobs.tmpPath(importId, 'archive.zip')
    await this.deps.blobs.clearTmp(importId)
    try {
      if (record.providerId === undefined || record.providerTask === undefined) {
        throw new StudyError('import has no bound provider task', 'PROVIDER_TASK_MISSING')
      }
      let active = this.deps.imports.get(importId) ?? record
      if (active.artifactSetId === undefined) {
        const collected = await this.deps.documentExtraction.collect(record.providerId, record.providerTask as ProviderTask, zipPath, signal)
        const artifactSetId = await this.persistArtifactSet(active, record.providerTask as ProviderTask, { kind: 'whole' }, collected)
        await this.bindArtifactSet(active, artifactSetId)
        active = this.deps.imports.get(importId) ?? active
      }
      const set = this.requireArtifactSet(active.artifactSetId!, active, { kind: 'whole' })
      const archive = this.requireArchive(set)
      // The Artifact Set is durable now. Enter the local-normalization
      // checkpoint before invoking the normalizer so a restart has a precise
      // owner and retry boundary.
      const checkpoint = this.deps.imports.get(importId) ?? active
      if (checkpoint.state !== 'normalizing') await this.transition(checkpoint, 'normalizing')
      const normalized = await this.deps.documentExtraction.normalizeArtifacts(
        record.providerId,
        this.deps.blobs.blobPath(archive.blobKey),
        this.deps.limits,
        (data, name) => this.deps.blobs.putBlob(data).then(key => {
          this.ctx.logger.debug(`study: stored asset ${name} at ${key}`)
          return key
        }),
        signal,
      )
      await beforeFinalPublicationForTest?.(record.sourceId)
      const revision = await new RevisionAssembler({ blobs: this.deps.blobs, lifecycle: this.deps.blobLifecycle, revisions: this.deps.revisions, assertSourceWritable: this.deps.assertSourceWritable }).assemble({ record, sets: [set], documents: [normalized], normalizerVersion: 1 }, signal)
      const source = this.deps.sources.get(record.sourceId)
      if (source !== undefined) {
        await this.deps.sources.put(record.sourceId, {
          ...source,
          currentRevisionId: revision.id,
          updatedAt: Date.now(),
        })
      }
      await this.transition(this.deps.imports.get(importId) ?? active, 'indexing', { revisionId: revision.id })
      await beforeReadyPublicationForTest?.(record.sourceId)
      if (signal.aborted) return
      await this.deps.onReady?.(this.deps.imports.get(importId) ?? record)
      await transitionImport(this.deps.imports, importId, { transitionId: `ready-${revision.id}`, to: 'ready', patch: { revisionId: revision.id, semanticStatus: 'available', ...(normalized.pageCount === undefined ? {} : { progress: { totalPages: normalized.pageCount, updatedAt: Date.now() } }) } })
      this.ctx.logger.info(`study: import ${importId} ready (${normalized.blocks.length} blocks)`)
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof StudyError && error.code === 'SOURCE_DELETION_IN_PROGRESS') return
      const code = error instanceof StudyError ? error.code : 'NORMALIZE_FAILED'
      const message = error instanceof Error ? error.message : String(error)
      await this.fail(this.deps.imports.get(importId) ?? record, code, message)
    } finally {
      await this.deps.blobs.clearTmp(importId).catch(() => {})
    }
  }

  /**
   * Re-admit every non-terminal import at startup.
   * @returns resolution after the sweep.
   */
  async resumeNonTerminal(): Promise<void> {
    await this.recoverArtifactBindings()
    const now = Date.now()
    for (const [id, record] of this.deps.imports.entries()) {
      if (record.format === 'epub' || !POLLABLE.has(record.state)) continue
      const nextPollAt = record.nextPollAt === undefined ? now : Math.min(record.nextPollAt, now)
      await transitionImport(this.deps.imports, id, { transitionId: `resume-poll-${record.recordVersion}`, to: record.state, patch: { nextPollAt } })
    }
  }

  /** Complete the final durable indexing checkpoint without replaying provider work. */
  private async completeIndexing(record: ImportRecord): Promise<void> {
    if (record.revisionId === undefined) {
      throw new StudyError('indexing import has no committed revision', 'REVISION_MISSING')
    }
    await beforeReadyPublicationForTest?.(record.sourceId)
    this.deps.assertSourceWritable(record.sourceId)
    await this.deps.onReady?.(this.deps.imports.get(record.id) ?? record)
    await transitionImport(this.deps.imports, record.id, {
      transitionId: `resume-ready-${record.revisionId}`,
      to: 'ready',
      patch: { revisionId: record.revisionId, semanticStatus: 'available' },
    })
  }

  private async persistArtifactSet(record: ImportRecord, task: ProviderTask, scope: ExtractionArtifactSetRecord['scope'], collected: { readonly path: string; readonly manifest: { readonly sha256: string; readonly bytes: number } }): Promise<ExtractionArtifactSetId> {
    this.deps.assertSourceWritable(record.sourceId)
    if (record.providerId === undefined) throw new StudyError('import has no bound provider instance', 'PROVIDER_NOT_FOUND')
    const file = await stat(collected.path)
    const sha256 = await sha256File(collected.path)
    if (!/^[a-f0-9]{64}$/i.test(collected.manifest.sha256) || collected.manifest.sha256.toLowerCase() !== sha256 || collected.manifest.bytes !== file.size) {
      throw new StudyError('provider collection manifest does not match collected bytes', 'ARTIFACT_COLLECTION_INVALID')
    }
    const archive = await this.deps.blobs.putFile(collected.path, false)
    const provider = this.deps.documentExtraction.describeProvider(record.providerId)
    const draft = { schemaVersion: 1 as const, importId: record.id, sourceId: record.sourceId, scope, providerInstanceId: record.providerId, providerKind: provider.providerKind, providerJobId: task.id, providerTaskKind: task.kind, configFingerprint: provider.configFingerprint, adapterVersion: provider.adapterVersion, artifactSchemaVersion: 1, normalizerId: `${provider.providerKind}-artifact-v1`, artifacts: [{ role: 'archive' as const, mediaType: 'application/zip', sha256, sizeBytes: file.size, blobKey: archive }] }
    const digest = manifestSha256(draft)
    const id = artifactSetIdFor(record.id, scope, digest)
    const prior = this.deps.artifactSets.get(id)
    if (prior !== undefined) return prior.id
    const conflict = [...this.deps.artifactSets.entries()].find(([, candidate]) => candidate.importId === record.id && sameScope(candidate.scope, scope) && candidate.manifestSha256 !== digest)
    if (conflict !== undefined) throw new StudyError('import scope is already bound to a different artifact manifest', 'ARTIFACT_SET_CONFLICT')
    const manifestBlob = await this.deps.blobs.putBlob(canonicalJsonBytes(canonicalManifestProjection(draft)))
    if (manifestBlob !== blobKeyForSha256(digest)) throw new StudyError('manifest content-addressed key does not match its digest', 'ARTIFACT_MANIFEST_INVALID')
    await this.deps.blobLifecycle.withBlobReferences([archive, manifestBlob], async () => {
      await this.deps.artifactSets.put(id, { ...draft, id, manifestSha256: digest, manifestBlob, collectedAt: Date.now() })
    })
    return id
  }

  /** Bind only a complete set to its own whole import or exact multipart part. */
  private async bindArtifactSet(record: ImportRecord, id: ExtractionArtifactSetId): Promise<void> {
    this.deps.assertSourceWritable(record.sourceId)
    const set = this.deps.artifactSets.get(id)
    if (set === undefined || set.importId !== record.id || set.sourceId !== record.sourceId) throw new StudyError('artifact set does not belong to import', 'ARTIFACT_SET_INVALID')
    if (set.scope.kind === 'whole') {
      if (record.providerParts !== undefined) throw new StudyError('multipart import cannot bind a whole artifact set', 'ARTIFACT_SCOPE_INVALID')
      if (record.artifactSetId !== undefined && record.artifactSetId !== id) throw new StudyError('import already has a different artifact set', 'ARTIFACT_SET_CONFLICT')
      if (record.artifactSetId !== id) await transitionImport(this.deps.imports, record.id, { transitionId: `bind-artifact-${id}`, to: record.state, patch: { artifactSetId: id } })
      return
    }
    const partScope = set.scope
    if (record.artifactSetId !== undefined || record.providerParts === undefined) throw new StudyError('whole import cannot bind a part artifact set', 'ARTIFACT_SCOPE_INVALID')
    const part = record.providerParts.find(candidate => candidate.index === partScope.index)
    if (part === undefined || !sameScope(partScope, { kind: 'part', index: part.index, ...(part.startPage === undefined ? {} : { startPage: part.startPage }), ...(part.endPage === undefined ? {} : { endPage: part.endPage }) })) {
      throw new StudyError('artifact set scope does not match provider part', 'ARTIFACT_SCOPE_INVALID')
    }
    if (part.artifactSetId !== undefined && part.artifactSetId !== id) throw new StudyError('provider part already has a different artifact set', 'ARTIFACT_SET_CONFLICT')
    if (part.artifactSetId !== id) await transitionImport(this.deps.imports, record.id, { transitionId: `bind-artifact-${id}`, to: record.state, patch: { providerParts: record.providerParts.map(candidate => candidate.index === part.index ? { ...candidate, artifactSetId: id } : candidate) } })
  }

  /** Obtain a bound set after checking ownership and exact scope. */
  private requireArtifactSet(id: ExtractionArtifactSetId, record: ImportRecord, scope: ExtractionArtifactSetRecord['scope']): ExtractionArtifactSetRecord {
    const set = this.deps.artifactSets.get(id)
    if (set === undefined || set.importId !== record.id || set.sourceId !== record.sourceId || !sameScope(set.scope, scope)) throw new StudyError('bound artifact set is missing or belongs to another import scope', 'ARTIFACT_SET_INVALID')
    return set
  }

  private requireArchive(set: ExtractionArtifactSetRecord): ExtractionArtifactSetRecord['artifacts'][number] {
    const archive = set.artifacts.find(artifact => artifact.role === 'archive')
    if (archive === undefined) throw new StudyError('artifact set has no archive', 'ARTIFACT_SET_INCOMPLETE')
    return archive
  }

  /** Repair post-crash bindings and reject durable references whose data disappeared. */
  private async recoverArtifactBindings(): Promise<void> {
    for (const [, set] of this.deps.artifactSets.entries()) {
      const missing = !await this.deps.blobs.hasBlob(set.manifestBlob) || (await Promise.all(set.artifacts.map(artifact => this.deps.blobs.hasBlob(artifact.blobKey)))).some(present => !present)
      const record = this.deps.imports.get(set.importId)
      if (record === undefined) continue
      if (missing) {
        await this.fail(record, 'ARTIFACT_BLOB_MISSING', 'a referenced Artifact Set blob is missing')
        continue
      }
      try {
        await this.bindArtifactSet(record, set.id)
      } catch (error) {
        await this.fail(record, error instanceof StudyError ? error.code : 'ARTIFACT_SET_INVALID', error instanceof Error ? error.message : String(error))
      }
    }
    for (const [, record] of this.deps.imports.entries()) {
      const ids = record.providerParts === undefined ? (record.artifactSetId === undefined ? [] : [record.artifactSetId]) : record.providerParts.flatMap(part => part.artifactSetId === undefined ? [] : [part.artifactSetId])
      for (const id of ids) {
        if (this.deps.artifactSets.get(id) === undefined) {
          await this.fail(record, 'ARTIFACT_SET_MISSING', 'a bound Artifact Set record is missing')
          break
        }
      }
    }
  }
}

function rawBlocksJsonl(blocks: readonly RawStudyBlock[]): string {
  return blocks.map(block => JSON.stringify(block)).join('\n') + '\n'
}

function parseRawBlocksJsonl(jsonl: string): RawStudyBlock[] {
  const blocks: RawStudyBlock[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim() !== '') blocks.push(JSON.parse(line) as RawStudyBlock)
  }
  return blocks
}

function partPageCount(part: NonNullable<ImportRecord['providerParts']>[number]): number {
  if (part.startPage === undefined || part.endPage === undefined) return 0
  return part.endPage - part.startPage + 1
}

function activeFailureStage(state: ImportRecord['state']): Exclude<ImportRecord['state'], 'ready' | 'failed' | 'cancelled'> | 'unknown' {
  return state === 'ready' || state === 'failed' || state === 'cancelled' ? 'unknown' : state
}

function failureCode(code: string): import('./types.ts').ImportFailure['code'] {
  const normalized = code.toUpperCase()
  if (normalized.includes('TIMEOUT')) return 'TASK_TIMEOUT'
  if (normalized.includes('ARTIFACT')) return 'ARTIFACT_MISSING'
  if (normalized.includes('COLLECT') || normalized.includes('ZIP')) return 'COLLECTION_FAILED'
  if (normalized.includes('NORMAL')) return 'NORMALIZATION_FAILED'
  if (normalized.includes('PROVIDER') || normalized.includes('TASK') || normalized.includes('FAKE_FAILURE')) return 'PROVIDER_REJECTED'
  return 'INTERNAL_ERROR'
}

function sameScope(left: ExtractionArtifactSetRecord['scope'], right: ExtractionArtifactSetRecord['scope']): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'whole' || right.kind === 'whole') return true
  return left.index === right.index && left.startPage === right.startPage && left.endPage === right.endPage
}
