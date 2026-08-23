import { describe, expect, it, vi } from 'vitest'
import { migrateLegacySelections, type LegacyWorkspace } from '../src/memory/migration.ts'
import type { SessionSourceSelectionRecord } from '../src/memory/types.ts'

function table<K, V>(initial: readonly (readonly [K, V])[] = []) {
  const values = new Map<K, V>(initial)
  return {
    get: vi.fn((key: K) => values.get(key)),
    put: vi.fn(async (key: K, value: V) => { values.set(key, value) }),
    delete: vi.fn(async (key: K) => { values.delete(key) }),
    entries: vi.fn(() => values.entries()),
  }
}

function workspace(sessionId: string, sourceId = 'source-a', revisionId = 'revision-a'): LegacyWorkspace {
  return {
    schemaVersion: 1, sessionId, selectedSourceId: sourceId, selectedRevisionId: revisionId,
    workspaceMode: 'reader', outlineCollapsed: false, drawerOpen: false, memoryScope: 'session',
    pinned: false, clientUpdatedAt: 1, lastSeenAt: 1, updatedAt: 1, version: 1,
  }
}

describe('legacy selection migration', () => {
  it('writes only domain-validated selections and reports every skipped reason', async () => {
    const workspaces = table<string, LegacyWorkspace>([
      ['valid', workspace('valid')], ['no-source', workspace('no-source')],
      ['no-revision', workspace('no-revision')], ['mismatch', workspace('mismatch')],
      ['no-access', workspace('no-access')], ['deleting', workspace('deleting')],
      ['malformed', workspace('malformed')], ['existing', workspace('existing')],
    ])
    const existing: SessionSourceSelectionRecord = { schemaVersion: 1, sessionId: 'existing', updatedAt: 2, version: 1 }
    const selections = table<string, SessionSourceSelectionRecord>([['existing', existing]])
    const migrations = table<string, {readonly id:string;readonly completedAt:number}>()
    const reasons = new Map([
      ['no-source', 'no-source'], ['no-revision', 'no-revision'], ['mismatch', 'revision-mismatch'],
      ['no-access', 'no-access'], ['deleting', 'deleting'], ['malformed', 'malformed'],
    ] as const)
    const report = await migrateLegacySelections(workspaces as never, selections as never, migrations as never, sessionId => {
      const reason = reasons.get(sessionId as never)
      return reason === undefined
        ? { valid: true, sourceId: 'source-a' as never, revisionId: 'revision-a' as never }
        : { valid: false, reason }
    })
    expect(report).toEqual({ migrated:1, skippedNoSource:1, skippedNoRevision:1, skippedRevisionMismatch:1, skippedNoAccess:1, skippedDeleting:1, skippedMalformed:1, skippedAlreadyMigrated:1 })
    expect(selections.get('valid')).toMatchObject({ sourceId:'source-a', revisionId:'revision-a', version:1 })
    expect(migrations.get('selection-v1')).toBeDefined()
  })

  it('is restart-idempotent and writes the global marker only after a complete pass', async () => {
    const workspaces = table<string, LegacyWorkspace>([['a', workspace('a')], ['b', workspace('b')]])
    const selections = table<string, SessionSourceSelectionRecord>()
    const migrations = table<string, {readonly id:string;readonly completedAt:number}>()
    let fail = true
    const validate = (sessionId: string) => {
      if (sessionId === 'b' && fail) throw new Error('interrupted')
      return { valid:true as const, sourceId:'source-a' as never, revisionId:'revision-a' as never }
    }
    await expect(migrateLegacySelections(workspaces as never, selections as never, migrations as never, validate)).rejects.toThrow('interrupted')
    expect(selections.get('a')).toBeDefined()
    expect(migrations.get('selection-v1')).toBeUndefined()
    fail = false
    const resumed = await migrateLegacySelections(workspaces as never, selections as never, migrations as never, validate)
    expect(resumed).toMatchObject({ migrated:1, skippedAlreadyMigrated:1 })
    const replay = await migrateLegacySelections(workspaces as never, selections as never, migrations as never, validate)
    expect(replay.migrated).toBe(0)
    expect(selections.put).toHaveBeenCalledTimes(2)
  })
})
