/** Deterministic startup rewrite for revisions written before provider provenance. */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { StudyError } from '../protocol/error.ts'
import type { RevisionId, RevisionRecord } from './types.ts'

type LegacyRevision = Omit<RevisionRecord, 'providerId' | 'providerKind'>

/** Upgrade pre-provider records exactly once, retaining every content and history field. */
export async function migrateLegacyRevisions(revisions: KvTable<RevisionId, RevisionRecord>): Promise<void> {
  for (const [id, candidate] of revisions.entries()) {
    if (hasProvider(candidate)) continue
    try {
      if (hasAnyProviderField(candidate as LegacyRevision)) throw new Error('partial provider provenance')
      await revisions.put(id, migrateLegacyRevision(candidate as LegacyRevision))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new StudyError(`legacy revision ${String(id)} cannot be migrated: ${message}`, 'REVISION_MIGRATION_FAILED')
    }
  }
}

/** Derive the historical adapter identity from the persisted original format. */
export function migrateLegacyRevision(record: LegacyRevision): RevisionRecord {
  const epub = record.format === 'epub' && record.providerModel === 'epub-local-v1'
  const pdf = record.format === 'pdf' && record.providerModel === 'mineru-vlm'
  if (!epub && !pdf) throw new Error(`unknown legacy revision provenance format=${record.format ?? 'missing'} model=${record.providerModel ?? 'missing'}`)
  return {
    ...record,
    providerId: epub ? 'epub-local' : 'mineru',
    providerKind: epub ? 'epub' : 'mineru',
  }
}

function hasProvider(record: RevisionRecord | LegacyRevision): record is RevisionRecord {
  return 'providerId' in record && 'providerKind' in record && 'providerModel' in record
}

function hasAnyProviderField(record: LegacyRevision): boolean {
  return 'providerId' in record || 'providerKind' in record
}
