import { describe, expect, it } from 'vitest'
import { StudyError } from '../src/protocol/error.ts'
import { migrateLegacyImport } from '../src/study/import-migration.ts'
import { transitionImport } from '../src/study/import-transition.ts'
import type { ImportId, ImportRecord, RevisionId, SourceId } from '../src/study/types.ts'

class MemoryImports {
  private readonly values = new Map<ImportId, ImportRecord>()

  constructor(record: ImportRecord) { this.values.set(record.id, record) }
  get(id: ImportId): ImportRecord | undefined { return this.values.get(id) }
  async update(id: ImportId, fn: (current: ImportRecord) => ImportRecord): Promise<ImportRecord> {
    const current = this.values.get(id)
    if (current === undefined) throw new Error('missing import')
    const next = fn(current)
    this.values.set(id, next)
    return next
  }
}

const importId = 'imp-transition' as ImportId
const sourceId = 'src-transition' as SourceId
const revisionId = 'rev-transition' as RevisionId

function record(state: ImportRecord['state'] = 'awaiting-upload'): ImportRecord {
  return {
    schemaVersion: 2, id: importId, sourceId,
    origin: { kind: 'upload', fileName: 'book.pdf', sizeBytes: 100 }, format: 'pdf', mediaType: 'application/pdf',
    providerId: 'mineru' as ImportRecord['providerId'], state,
    recordVersion: 0, transitionedAt: 1, appliedTransitionIds: ['create'], attempts: 0, createdAt: 1, updatedAt: 1,
  }
}

describe('Host Import transition engine', () => {
  it('persists the unsplit PDF path through each public checkpoint', async () => {
    const imports = new MemoryImports(record())
    await transitionImport(imports as never, importId, { transitionId: 'upload', to: 'uploading', uploadAdmission: true })
    await transitionImport(imports as never, importId, { transitionId: 'queue', to: 'queued', patch: { originalBlob: 'sha256/original' } })
    await transitionImport(imports as never, importId, { transitionId: 'job', to: 'extracting', patch: { providerTask: { kind: 'batch', id: 'task-1' } } })
    await transitionImport(imports as never, importId, { transitionId: 'collect', to: 'collecting' })
    await transitionImport(imports as never, importId, { transitionId: 'artifact', to: 'collecting', patch: { artifactSetId: 'aset-1' as ImportRecord['artifactSetId'] } })
    await transitionImport(imports as never, importId, { transitionId: 'normalize', to: 'normalizing' })
    await transitionImport(imports as never, importId, { transitionId: 'index', to: 'indexing', patch: { revisionId } })
    const ready = await transitionImport(imports as never, importId, { transitionId: 'ready', to: 'ready', patch: { revisionId, semanticStatus: 'available' } })
    expect(ready.record).toMatchObject({ state: 'ready', revisionId })
    expect(ready.record.nextPollAt).toBeUndefined()
  })

  it('rejects an illegal entry and refuses unknown as a newly written failure stage', async () => {
    const imports = new MemoryImports(record())
    await expect(transitionImport(imports as never, importId, { transitionId: 'bad', to: 'queued' }))
      .rejects.toMatchObject({ code: 'IMPORT_TRANSITION_INVALID' } satisfies Partial<StudyError>)
    await expect(transitionImport(imports as never, importId, {
      transitionId: 'unknown-failure', to: 'failed',
      failure: { stage: 'unknown', code: 'INTERNAL_ERROR', retryable: false, message: 'x', occurredAt: 1 },
    })).rejects.toMatchObject({ code: 'IMPORT_TRANSITION_INVALID' } satisfies Partial<StudyError>)
  })

  it('keeps progress monotonic, distinguishes progress actions, and returns the current record on CAS conflict', async () => {
    const imports = new MemoryImports({ ...record('extracting'), providerTask: { kind: 'batch', id: 'task-1' } })
    const first = await transitionImport(imports as never, importId, { transitionId: 'poll-1', to: 'extracting', patch: { progress: { completedPages: 27, totalPages: 60, updatedAt: 1 } } })
    const second = await transitionImport(imports as never, importId, { transitionId: 'poll-2', to: 'extracting', patch: { progress: { completedPages: 0, updatedAt: 2 } } })
    expect(second.record.progress).toMatchObject({ completedPages: 27, totalPages: 60 })
    const duplicate = await transitionImport(imports as never, importId, { transitionId: 'poll-2', to: 'extracting', patch: { progress: { completedPages: 60, updatedAt: 3 } } })
    expect(duplicate.outcome).toBe('idempotent')
    const conflict = await transitionImport(imports as never, importId, { transitionId: 'stale', to: 'extracting', expectedRecordVersion: first.record.recordVersion, patch: { progress: { completedPages: 60, updatedAt: 4 } } })
    expect(conflict.outcome).toBe('conflict')
    expect(conflict.record.recordVersion).toBe(second.record.recordVersion)
  })

  it('maps ambiguous legacy failures to unknown only during migration', () => {
    const migrated = migrateLegacyImport({
      id: importId, sourceId, state: 'failed', origin: { kind: 'upload', fileName: 'old.pdf', sizeBytes: 1 },
      attempts: 0, createdAt: 1, updatedAt: 2, failure: { code: 'legacy', message: 'legacy failure' },
    }, undefined)
    expect(migrated.failure).toMatchObject({ stage: 'unknown', providerCode: 'legacy' })
  })
})
