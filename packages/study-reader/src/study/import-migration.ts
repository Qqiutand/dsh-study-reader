/** Deterministic one-way migration of legacy Host import records. */

import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { StudyError } from '../protocol/error.ts'
import type { ImportFailure, ImportId, ImportRecord, ImportState, RevisionId, SourceId, SourceRecord } from './types.ts'

type LegacyImport = Record<string, unknown> & { readonly id: string; readonly sourceId: string; readonly state: string; readonly origin: ImportRecord['origin']; readonly attempts: number; readonly createdAt: number; readonly updatedAt: number }

/** Rewrite every version-1 record exactly once; malformed input names its Import ID. */
export async function migrateLegacyImports(
  imports: KvTable<ImportId, ImportRecord>,
  sources: KvTable<SourceId, SourceRecord>,
): Promise<void> {
  for (const [id, candidate] of imports.entries()) {
    if ((candidate as ImportRecord).schemaVersion === 2) continue
    try {
      const next = migrateLegacyImport(candidate as unknown as LegacyImport, sources.get((candidate as unknown as LegacyImport).sourceId as SourceId)?.currentRevisionId)
      await imports.put(id, next)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new StudyError(`legacy import ${String(id)} cannot be migrated: ${message}`, 'IMPORT_MIGRATION_FAILED')
    }
  }
}

/** Convert one validated legacy record; exported for migration tests. */
export function migrateLegacyImport(legacy: LegacyImport, revisionId: RevisionId | undefined): ImportRecord {
  const now = legacy.updatedAt
  const mapped = legacyState(legacy)
  const base = {
    ...legacy,
    schemaVersion: 2 as const,
    state: mapped,
    recordVersion: 0,
    transitionedAt: now,
    appliedTransitionIds: ['migration-v2'],
    progress: legacy.progress === undefined ? undefined : legacyProgress(legacy.progress),
    failure: undefined,
    failedStage: undefined,
    cancelledStage: undefined,
    cancelledAt: undefined,
    upstreamCancellation: undefined,
    revisionId: undefined,
    semanticStatus: undefined,
  }
  if (mapped === 'failed') {
    const failure = legacyFailure(legacy, now)
    return strip({ ...base, failure, failedStage: failure.stage }) as unknown as ImportRecord
  }
  if (mapped === 'cancelled') {
    return strip({ ...base, cancelledStage: legacy.providerTask !== undefined || legacy.providerParts !== undefined ? 'extracting' : 'awaiting-upload', cancelledAt: now, upstreamCancellation: 'not-required' }) as unknown as ImportRecord
  }
  if (mapped === 'ready') {
    if (revisionId === undefined) throw new Error('ready import has no source revision')
    return strip({ ...base, revisionId, semanticStatus: 'available' }) as unknown as ImportRecord
  }
  return strip(base) as unknown as ImportRecord
}

function legacyState(record: LegacyImport): ImportState {
  switch (record.state) {
    case 'awaiting-upload': return 'awaiting-upload'
    case 'downloading': return 'collecting'
    case 'normalizing': return 'normalizing'
    case 'ready': return 'ready'
    case 'cancelled': return 'cancelled'
    case 'submitted': case 'pending': case 'running': case 'converting': return 'extracting'
    case 'preparing': return record.providerTask !== undefined || record.providerParts !== undefined ? 'extracting' : record.originalBlob !== undefined ? 'queued' : 'awaiting-upload'
    case 'failed': return 'failed'
    default: throw new Error(`unknown legacy state ${record.state}`)
  }
}

function legacyProgress(value: unknown): ImportRecord['progress'] {
  const progress = value as { extractedPages?: number; totalPages?: number; completedParts?: number; totalParts?: number }
  return { ...(progress.extractedPages === undefined ? {} : { completedPages: progress.extractedPages }), ...(progress.totalPages === undefined ? {} : { totalPages: progress.totalPages }), ...(progress.completedParts === undefined ? {} : { completedParts: progress.completedParts }), ...(progress.totalParts === undefined ? {} : { totalParts: progress.totalParts }), updatedAt: Date.now() }
}

function legacyFailure(record: LegacyImport, occurredAt: number): ImportFailure {
  const old = record.failure as { code?: string; message?: string } | undefined
  return { stage: 'unknown', code: failureCode(old?.code), retryable: true, ...(record.providerId === undefined ? {} : { providerId: record.providerId as NonNullable<ImportFailure['providerId']> }), ...(old?.code === undefined ? {} : { providerCode: old.code }), message: old?.message ?? 'legacy import failed without failure details', occurredAt }
}

function failureCode(code: string | undefined): ImportFailure['code'] {
  if (code?.includes('UPLOAD')) return 'UPLOAD_FAILED'
  if (code?.includes('SPLIT')) return 'SPLIT_FAILED'
  if (code?.includes('TIMEOUT')) return 'TASK_TIMEOUT'
  if (code?.includes('ARTIFACT')) return 'ARTIFACT_MISSING'
  if (code?.includes('NORMAL')) return 'NORMALIZATION_FAILED'
  if (code?.includes('INDEX')) return 'INDEXING_FAILED'
  if (code?.includes('COLLECT') || code?.includes('ZIP')) return 'COLLECTION_FAILED'
  if (code?.includes('PROVIDER')) return 'PROVIDER_REJECTED'
  return 'INTERNAL_ERROR'
}

function strip(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined))
}
