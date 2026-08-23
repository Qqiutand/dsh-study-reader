/** One-way pre-release migration from the discarded shell workspace model. */
import z from 'zod'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionSourceSelectionRecord } from './types.ts'

export const legacyWorkspaceSchema = z.object({
  schemaVersion: z.literal(1), sessionId: z.string(), selectedSourceId: z.string().optional(), selectedRevisionId: z.string().optional(),
  workspaceMode: z.union([z.literal('library'), z.literal('reader')]), outlineCollapsed: z.boolean(), drawerOpen: z.boolean(),
  memoryScope: z.union([z.literal('session'), z.literal('source')]), pinned: z.boolean(), extractionLanguage: z.string().optional(),
  clientUpdatedAt: z.number(), lastSeenAt: z.number(), updatedAt: z.number(), version: z.number(),
})
export type LegacyWorkspace = z.infer<typeof legacyWorkspaceSchema>

export type LegacySelectionValidation =
  | { readonly valid: true; readonly sourceId: NonNullable<SessionSourceSelectionRecord['sourceId']>; readonly revisionId?: SessionSourceSelectionRecord['revisionId'] }
  | { readonly valid: false; readonly reason: 'no-source' | 'no-revision' | 'revision-mismatch' | 'no-access' | 'deleting' | 'malformed' }
export type LegacySelectionValidator = (sessionId: string, workspace: LegacyWorkspace) => LegacySelectionValidation

export interface SelectionMigrationReport {
  migrated: number
  skippedNoSource: number
  skippedNoRevision: number
  skippedRevisionMismatch: number
  skippedNoAccess: number
  skippedDeleting: number
  skippedMalformed: number
  skippedAlreadyMigrated: number
}

export async function migrateLegacySelections(
  workspaces: KvTable<string, LegacyWorkspace>,
  selections: KvTable<string, SessionSourceSelectionRecord>,
  migrations: KvTable<string, { readonly id: string; readonly completedAt: number }>,
  validate: LegacySelectionValidator,
): Promise<SelectionMigrationReport> {
  const report: SelectionMigrationReport = {
    migrated: 0, skippedNoSource: 0, skippedNoRevision: 0, skippedRevisionMismatch: 0,
    skippedNoAccess: 0, skippedDeleting: 0, skippedMalformed: 0, skippedAlreadyMigrated: 0,
  }
  if (migrations.get('selection-v1') !== undefined) return report
  for (const [sessionId, workspace] of workspaces.entries()) {
    if (selections.get(sessionId) !== undefined) {
      report.skippedAlreadyMigrated += 1
      continue
    }
    const result = validate(sessionId, workspace)
    if (!result.valid) {
      const key = ({
        'no-source': 'skippedNoSource', 'no-revision': 'skippedNoRevision',
        'revision-mismatch': 'skippedRevisionMismatch', 'no-access': 'skippedNoAccess',
        deleting: 'skippedDeleting', malformed: 'skippedMalformed',
      } as const)[result.reason]
      report[key] += 1
      continue
    }
    await selections.put(sessionId, {
      schemaVersion: 1, sessionId, sourceId: result.sourceId,
      ...(result.revisionId === undefined ? {} : { revisionId: result.revisionId }),
      updatedAt: workspace.updatedAt, version: 1, lastCommandId: 'migration:workspace-v1',
    })
    report.migrated += 1
  }
  await migrations.put('selection-v1', { id: 'selection-v1', completedAt: Date.now() })
  return report
}
