/** Host-only, durable offline Artifact reprocess executor. */
import { createHash } from 'node:crypto'
import type { DocumentExtractionService } from '../extraction/index.ts'
import { StudyError } from '../protocol/error.ts'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { sha256Hex, type BlobStore } from './blob-store.ts'
import type { BlobLifecycleService } from './blob-lifecycle.ts'
import { canonicalizerVersion, RevisionAssembler } from './revision-assembler.ts'
import { transitionImport } from './import-transition.ts'
import type { ArchiveLimits } from './normalize.ts'
import type { ExtractionArtifactSetId, ExtractionArtifactSetRecord, ImportId, ImportRecord, ReprocessOperationId, ReprocessOperationRecord, RevisionId, RevisionRecord, SourceId, SourceRecord } from './types.ts'

const ACTIVE = new Set<ReprocessOperationRecord['state']>(['pending', 'normalizing', 'writing-blobs', 'revision-prepared', 'activating'])
/** Test-only barrier immediately before reprocess revision publication. */
let beforeRevisionPublicationForTest: ((sourceId: SourceId) => Promise<void>) | undefined
export function setArtifactReprocessBeforeRevisionPublicationForTest(hook: ((sourceId: SourceId) => Promise<void>) | undefined): void { beforeRevisionPublicationForTest = hook }

export interface ArtifactReprocessDeps {
  readonly imports: KvTable<ImportId, ImportRecord>
  readonly sources: KvTable<SourceId, SourceRecord>
  readonly revisions: KvTable<RevisionId, RevisionRecord>
  readonly artifactSets: KvTable<ExtractionArtifactSetId, ExtractionArtifactSetRecord>
  readonly operations: KvTable<ReprocessOperationId, ReprocessOperationRecord>
  readonly blobs: BlobStore
  readonly blobLifecycle: BlobLifecycleService
  readonly documentExtraction: DocumentExtractionService
  readonly limits: ArchiveLimits
  readonly lifecycle: AbortSignal
  /** Rechecks the durable source deletion intent before every publication. */
  readonly assertSourceWritable: (sourceId: SourceId) => void
}

/** No Remote decorator intentionally: this is admitted only by same-process code. */
export class ArtifactReprocessExecutor {
  private readonly inFlight = new Map<ImportId, Promise<ReprocessOperationRecord>>()
  private readonly controllers = new Set<AbortController>()
  private admission = true

  constructor(private readonly deps: ArtifactReprocessDeps) {}

  async recover(): Promise<void> {
    if (!this.admission) return
    for (const [, operation] of this.deps.operations.entries()) {
      if (!ACTIVE.has(operation.state)) continue
      void this.admitExisting(operation).catch(() => {})
    }
  }

  async execute(importId: ImportId, commandId: string): Promise<ReprocessOperationRecord> {
    if (!this.admission) throw new StudyError('reprocess executor is stopping', 'REPROCESS_STOPPING')
    if (commandId.trim() === '') throw new StudyError('command id is required', 'COMMAND_ID_REQUIRED')
    const sameCommand = [...this.deps.operations.entries()].map(([, value]) => value).find(value => value.commandId === commandId)
    if (sameCommand !== undefined) {
      if (sameCommand.importId !== importId) throw new StudyError('command id was already used for another import', 'COMMAND_ID_CONFLICT')
      if (ACTIVE.has(sameCommand.state)) return await this.admitExisting(sameCommand)
      if (sameCommand.state === 'failed' && sameCommand.failure?.retryable) return await this.retry(sameCommand)
      return sameCommand
    }
    const existing = [...this.deps.operations.entries()].map(([, value]) => value).find(value => value.importId === importId && ACTIVE.has(value.state))
    if (existing !== undefined) throw new StudyError(`reprocess operation ${existing.id} is already active`, 'REPROCESS_IN_PROGRESS')
    const operation = await this.create(importId, commandId)
    return await this.admitExisting(operation)
  }

  async dispose(): Promise<void> {
    this.admission = false
    for (const controller of this.controllers) controller.abort(new Error('reprocess executor stopped'))
    await Promise.allSettled([...this.inFlight.values()])
  }

  private async retry(operation: ReprocessOperationRecord): Promise<ReprocessOperationRecord> {
    this.deps.assertSourceWritable(operation.sourceId)
    const { failure: _failure, preparedRevisionId: _preparedRevisionId, ...base } = operation
    const retrying: ReprocessOperationRecord = { ...base, state: 'pending', activated: false, updatedAt: Date.now() }
    await this.deps.operations.put(retrying.id, retrying)
    return await this.admitExisting(retrying)
  }

  private async create(importId: ImportId, commandId: string): Promise<ReprocessOperationRecord> {
    const record = this.deps.imports.get(importId)
    if (record === undefined) throw new StudyError('import not found', 'IMPORT_NOT_FOUND')
    this.deps.assertSourceWritable(record.sourceId)
    if (record.state !== 'failed' && record.state !== 'ready') throw new StudyError(`import is in state ${record.state}`, 'IMPORT_NOT_REPROCESSABLE')
    const sets = await this.validateSets(record)
    const metadata = this.deps.documentExtraction.artifactNormalizer(sets[0]!.normalizerId)
    if (metadata === undefined) throw new StudyError(`normalizer "${sets[0]!.normalizerId}" is not registered`, 'NORMALIZER_NOT_REGISTERED')
    if (metadata.artifactSchemaVersion !== sets[0]!.artifactSchemaVersion) throw new StudyError(`artifact schema ${sets[0]!.artifactSchemaVersion} is unsupported`, 'ARTIFACT_SCHEMA_UNSUPPORTED')
    const now = Date.now()
    const id = `reprocess-${createHash('sha256').update(commandId).update('\0').update(String(importId)).digest('hex')}` as ReprocessOperationId
    const operation: ReprocessOperationRecord = {
      schemaVersion: 1, id, commandId, importId, sourceId: record.sourceId,
      artifactSetIds: sets.map(set => set.id), artifactManifestHashes: sets.map(set => set.manifestSha256),
      ...(this.deps.sources.get(record.sourceId)?.currentRevisionId !== undefined ? { expectedCurrentRevisionId: this.deps.sources.get(record.sourceId)!.currentRevisionId } : {}),
      normalizerId: metadata.id, normalizerVersion: metadata.version, canonicalizerVersion,
      state: 'pending', activated: false, attempts: 0, createdAt: now, updatedAt: now,
    }
    await this.deps.operations.put(id, operation)
    return operation
  }

  private admitExisting(operation: ReprocessOperationRecord): Promise<ReprocessOperationRecord> {
    this.deps.assertSourceWritable(operation.sourceId)
    const current = this.inFlight.get(operation.importId)
    if (current !== undefined) return current
    const controller = new AbortController()
    this.controllers.add(controller)
    const tail = this.run(operation.id, controller.signal).finally(() => { this.inFlight.delete(operation.importId); this.controllers.delete(controller) })
    this.inFlight.set(operation.importId, tail)
    return tail
  }

  private async run(id: ReprocessOperationId, signal: AbortSignal): Promise<ReprocessOperationRecord> {
    let operation = this.require(id)
    try {
      const record = this.deps.imports.get(operation.importId)
      if (record === undefined) throw new StudyError('import not found', 'IMPORT_NOT_FOUND')
      this.deps.assertSourceWritable(operation.sourceId)
      const sets = await this.validateFrozen(operation, record)
      if (operation.state === 'pending' || operation.state === 'normalizing') {
        operation = await this.transition(operation, 'normalizing')
        const documents = []
        for (const set of sets) {
          const archive = set.artifacts.find(value => value.role === 'archive')
          if (archive === undefined) throw new StudyError('artifact set has no archive', 'ARTIFACT_SET_INCOMPLETE')
          documents.push(await this.deps.documentExtraction.normalizeArtifactSet(operation.normalizerId, set.artifactSchemaVersion, this.deps.blobs.blobPath(archive.blobKey), this.deps.limits, data => this.deps.blobs.putBlob(data), signal))
        }
        operation = await this.transition(operation, 'writing-blobs')
        await beforeRevisionPublicationForTest?.(operation.sourceId)
        const assembler = new RevisionAssembler({ blobs: this.deps.blobs, lifecycle: this.deps.blobLifecycle, revisions: this.deps.revisions, assertSourceWritable: this.deps.assertSourceWritable })
        const revision = await assembler.assemble({ record, sets, documents, normalizerVersion: operation.normalizerVersion }, signal)
        operation = await this.transition(operation, 'revision-prepared', { preparedRevisionId: revision.id })
      }
      if (operation.state === 'writing-blobs') {
        // A crash before revision-prepared has no serialized normalized data;
        // content-addressed writes are safe to redo from retained artifacts.
        operation = await this.transition(operation, 'normalizing')
        return await this.run(id, signal)
      }
      if (operation.state === 'revision-prepared' || operation.state === 'activating') {
        const revisionId = operation.preparedRevisionId!
        const revision = this.deps.revisions.get(revisionId)
        if (revision === undefined || !(await this.revisionBlobsExist(revision))) throw new StudyError('prepared revision is incomplete', 'REVISION_PREPARED_INVALID')
        operation = await this.transition(operation, 'activating')
        const source = this.deps.sources.get(operation.sourceId)
        if (source === undefined) throw new StudyError('source not found', 'SOURCE_NOT_FOUND')
        if (source.currentRevisionId === revisionId) {
          await this.restoreFailedImport(record, revisionId)
          return await this.transition(operation, 'committed', { activated: true })
        }
        if (source.currentRevisionId !== operation.expectedCurrentRevisionId) return await this.transition(operation, 'completed-not-activated', { activated: false })
        if (signal.aborted) throw signal.reason
        this.deps.assertSourceWritable(operation.sourceId)
        await this.deps.sources.put(source.id, { ...source, currentRevisionId: revisionId, updatedAt: Date.now() })
        await this.restoreFailedImport(record, revisionId)
        return await this.transition(operation, 'committed', { activated: true })
      }
      return operation
    } catch (error) {
      if (signal.aborted || this.deps.lifecycle.aborted) {
        this.deps.assertSourceWritable(operation.sourceId)
        const cancelled = { ...this.require(id), state: 'cancelled' as const, activated: false, updatedAt: Date.now() }
        await this.deps.operations.put(id, cancelled)
        return cancelled
      }
      const study = error instanceof StudyError ? error : undefined
      this.deps.assertSourceWritable(operation.sourceId)
      const failed: ReprocessOperationRecord = { ...this.require(id), state: 'failed', activated: false, failure: { stage: failureStage(study?.code), code: study?.code ?? 'REPROCESS_FAILED', message: error instanceof Error ? error.message : String(error), retryable: !isValidationCode(study?.code) }, attempts: this.require(id).attempts + 1, updatedAt: Date.now() }
      await this.deps.operations.put(id, failed)
      return failed
    }
  }

  private async transition(operation: ReprocessOperationRecord, state: ReprocessOperationRecord['state'], patch: Partial<ReprocessOperationRecord> = {}): Promise<ReprocessOperationRecord> {
    this.deps.assertSourceWritable(operation.sourceId)
    const next: ReprocessOperationRecord = { ...operation, ...patch, state, attempts: operation.attempts + (state === 'normalizing' ? 1 : 0), updatedAt: Date.now() }
    await this.deps.operations.put(next.id, next)
    return next
  }

  private require(id: ReprocessOperationId): ReprocessOperationRecord { const value = this.deps.operations.get(id); if (value === undefined) throw new StudyError('reprocess operation not found', 'REPROCESS_OPERATION_NOT_FOUND'); return value }

  /** Ready imports stay ready; only failed normalization/indexing imports resume through public states. */
  private async restoreFailedImport(record: ImportRecord, revisionId: RevisionId): Promise<void> {
    this.deps.assertSourceWritable(record.sourceId)
    if (record.state !== 'failed' || (record.failedStage !== 'normalizing' && record.failedStage !== 'indexing')) return
    await transitionImport(this.deps.imports, record.id, { transitionId: `reprocess-normalizing-${revisionId}`, to: 'normalizing' })
    const indexing = (await transitionImport(this.deps.imports, record.id, { transitionId: `reprocess-indexing-${revisionId}`, to: 'indexing', patch: { revisionId } })).record
    await transitionImport(this.deps.imports, record.id, { transitionId: `reprocess-ready-${revisionId}`, to: 'ready', expectedRecordVersion: indexing.recordVersion, patch: { revisionId, semanticStatus: 'available' } })
  }

  private async validateFrozen(operation: ReprocessOperationRecord, record: ImportRecord): Promise<ExtractionArtifactSetRecord[]> {
    if (record.sourceId !== operation.sourceId) throw new StudyError('import source changed', 'ARTIFACT_SET_INVALID')
    const sets = await this.validateSets(record)
    if (sets.length !== operation.artifactSetIds.length || sets.some((set, index) => set.id !== operation.artifactSetIds[index] || set.manifestSha256 !== operation.artifactManifestHashes[index])) throw new StudyError('frozen artifact inputs no longer match', 'ARTIFACT_SET_INVALID')
    return sets
  }

  private async validateSets(record: ImportRecord): Promise<ExtractionArtifactSetRecord[]> {
    const ids = record.providerParts === undefined ? (record.artifactSetId === undefined ? [] : [record.artifactSetId]) : [...record.providerParts].sort((a, b) => a.index - b.index).map(part => part.artifactSetId)
    if (ids.length === 0 || ids.some((id): id is undefined => id === undefined)) throw new StudyError('complete artifact set is required', 'ARTIFACT_SET_REQUIRED')
    const sets = ids.map(id => this.deps.artifactSets.get(id!))
    if (sets.some((set): set is undefined => set === undefined)) throw new StudyError('artifact set is missing', 'ARTIFACT_SET_MISSING')
    const values = sets as ExtractionArtifactSetRecord[]
    if (values.some(set => set.importId !== record.id || set.sourceId !== record.sourceId)) throw new StudyError('artifact set does not belong to import', 'ARTIFACT_SET_INVALID')
    if (values.some(set => set.normalizerId !== values[0]!.normalizerId || set.providerKind !== values[0]!.providerKind || set.artifactSchemaVersion !== values[0]!.artifactSchemaVersion)) throw new StudyError('artifact sets cannot mix provider inputs', 'ARTIFACT_SET_INVALID')
    if (record.providerParts === undefined) { if (values.length !== 1 || values[0]!.scope.kind !== 'whole') throw new StudyError('whole import artifact scope is invalid', 'ARTIFACT_SCOPE_INVALID') }
    else {
      const parts = [...record.providerParts].sort((a, b) => a.index - b.index)
      if (parts.some((part, index) => part.index !== index || values[index]!.scope.kind !== 'part' || values[index]!.scope.index !== part.index)) throw new StudyError('multipart artifact set is incomplete', 'PROVIDER_PARTS_INCOMPLETE')
    }
    for (const set of values) {
      if (!(await this.deps.blobs.hasBlob(set.manifestBlob)) || sha256Hex(await this.deps.blobs.readBlob(set.manifestBlob)) !== set.manifestSha256) throw new StudyError('artifact manifest blob is missing or corrupt', 'ARTIFACT_MANIFEST_MISSING')
      for (const artifact of set.artifacts) if (!(await this.deps.blobs.hasBlob(artifact.blobKey))) throw new StudyError('artifact blob is missing', 'ARTIFACT_BLOB_MISSING')
    }
    return values
  }

  private async revisionBlobsExist(revision: RevisionRecord): Promise<boolean> { return (await Promise.all([revision.markdownBlob, revision.blocksBlob, ...(revision.assetBlobs ?? [])].map(key => this.deps.blobs.hasBlob(key as `sha256/${string}`)))).every(Boolean) }
}

function isValidationCode(code?: string): boolean { return code?.startsWith('ARTIFACT_') === true || code === 'IMPORT_NOT_FOUND' || code === 'SOURCE_NOT_FOUND' || code === 'PROVIDER_PARTS_INCOMPLETE' }
function failureStage(code?: string): NonNullable<ReprocessOperationRecord['failure']>['stage'] { return isValidationCode(code) ? 'validation' : code === 'REVISION_PREPARED_INVALID' ? 'activating' : 'normalizing' }
