import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalAccessManager, externalTokenEnvironmentVariable } from '../src/study/external-access.ts'
import type { ExternalAccessRecord, SourceId } from '../src/study/types.ts'

class Table implements KvTable<string, ExternalAccessRecord> {
  private readonly values = new Map<string, ExternalAccessRecord>()
  get(key: string): ExternalAccessRecord | undefined { return this.values.get(key) }
  entries(): IterableIterator<[string, ExternalAccessRecord]> { return this.values.entries() }
  keys(): IterableIterator<string> { return this.values.keys() }
  get size(): number { return this.values.size }
  async put(key: string, value: ExternalAccessRecord): Promise<void> { this.values.set(key, structuredClone(value)) }
  async delete(key: string): Promise<boolean> { return this.values.delete(key) }
  async update(key: string, fn: (current: ExternalAccessRecord) => ExternalAccessRecord): Promise<ExternalAccessRecord> {
    const current = this.values.get(key)
    if (current === undefined) throw new Error('missing key')
    const next = fn(current)
    this.values.set(key, structuredClone(next))
    return next
  }
}

const roots: string[] = []
afterEach(async () => await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true }))))

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'study-reader-external-'))
  roots.push(root)
  const records = new Table()
  return { root, records, manager: await ExternalAccessManager.open(records, root) }
}

describe('external MCP access manager', () => {
  it('uses a concise environment variable for the default stable connection', () => {
    expect(externalTokenEnvironmentVariable('study-reader')).toBe('DSH_STUDY_READER_TOKEN')
    expect(externalTokenEnvironmentVariable('reader-probability')).toBe('DSH_STUDY_READER_PROBABILITY_TOKEN')
  })

  it('persists only a secret-free grant and authenticates after restart', async () => {
    const { root, records, manager } = await setup()
    const created = await manager.create({ commandId: 'create-1', label: 'Codex', mcpServerName: 'study-reader', readingSetLabel: 'Probability books', sourceIds: ['source-b', 'source-a'] as SourceId[], expiresInDays: 30 })

    expect(created.token).toMatch(/^dsr_v1\.external-[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/)
    expect(created.record.sourceIds).toEqual(['source-a', 'source-b'])
    expect(JSON.stringify([...records.entries()])).not.toContain(created.token)
    expect((await stat(join(root, 'external-mcp.key'))).mode & 0o777).toBe(0o600)

    const restarted = await ExternalAccessManager.open(records, root)
    expect(restarted.authenticate(created.token)).toMatchObject({ id: created.record.id, label: 'Codex', mcpServerName: 'study-reader' })
    expect(restarted.listSets(created.record.id)).toMatchObject([{ label: 'Probability books', sourceIds: ['source-a', 'source-b'] }])
  })

  it('replays create commands deterministically and rejects conflicting reuse', async () => {
    const { manager } = await setup()
    const input = { commandId: 'create-retry', label: 'Codex', mcpServerName: 'reader-research', readingSetLabel: 'Research', sourceIds: ['source-a'] as SourceId[], expiresInDays: 7 }
    const first = await manager.create(input)
    const replay = await manager.create(input)
    expect(replay).toEqual(first)
    await expect(manager.create({ ...input, sourceIds: ['source-b'] as SourceId[] })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  })

  it('serializes concurrent retries into one durable connection', async () => {
    const { manager, records } = await setup()
    const input = { commandId: 'create-concurrent', label: 'Codex', mcpServerName: 'reader-library', readingSetLabel: 'Library', sourceIds: ['source-a'] as SourceId[], expiresInDays: 30 }
    const [first, second] = await Promise.all([manager.create(input), manager.create(input)])
    expect(first).toEqual(second)
    expect(records.size).toBe(1)
  })

  it('repairs an existing master key to owner-only permissions', async () => {
    const { root, records } = await setup()
    const keyPath = join(root, 'external-mcp.key')
    await chmod(keyPath, 0o644)
    await ExternalAccessManager.open(records, root)
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
  })

  it('keeps active named document sets distinct and permits name reuse after revocation', async () => {
    const { manager } = await setup()
    const probability = await manager.create({ commandId: 'create-probability', label: 'Codex A', mcpServerName: 'reader-probability', readingSetLabel: 'Probability', sourceIds: ['source-a'] as SourceId[], expiresInDays: 30 })
    await manager.create({ commandId: 'create-optics', label: 'Codex B', mcpServerName: 'reader-optics', readingSetLabel: 'Optics', sourceIds: ['source-b'] as SourceId[], expiresInDays: 30 })
    await expect(manager.create({ commandId: 'create-duplicate', label: 'Other', mcpServerName: 'reader-probability', readingSetLabel: 'Other', sourceIds: ['source-c'] as SourceId[], expiresInDays: 30 })).rejects.toMatchObject({ code: 'EXTERNAL_ACCESS_MCP_NAME_CONFLICT' })
    await manager.revoke(probability.record.id, 'revoke-probability', probability.record.version)
    await expect(manager.create({ commandId: 'reuse-probability', label: 'Codex C', mcpServerName: 'reader-probability', readingSetLabel: 'Probability v2', sourceIds: ['source-c'] as SourceId[], expiresInDays: 30 })).resolves.toMatchObject({ record: { mcpServerName: 'reader-probability' } })
  })

  it('adds, edits, and deletes reading sets without rotating the connection token', async () => {
    const { manager } = await setup()
    const created = await manager.create({ commandId: 'create-catalog', label: 'Codex', mcpServerName: 'study-reader', readingSetLabel: 'Probability', sourceIds: ['source-a'] as SourceId[], expiresInDays: 30 })
    const token = created.token
    const added = await manager.saveSet({ accessId: created.record.id, commandId: 'add-optics', expectedVersion: 1, label: 'Optics', sourceIds: ['source-b'] as SourceId[] })
    expect(added.record.readingSets).toHaveLength(2)
    expect(manager.authenticate(token)?.id).toBe(created.record.id)
    expect(() => manager.resolveSet(created.record.id)).toThrowError(expect.objectContaining({ code: 'EXTERNAL_SET_REQUIRED' }))
    expect(manager.resolveSet(created.record.id, added.set.setRef).sourceIds).toEqual(['source-b'])

    const edited = await manager.saveSet({ accessId: created.record.id, commandId: 'edit-optics', expectedVersion: 2, setRef: added.set.setRef, label: 'Optics and imaging', sourceIds: ['source-b', 'source-c'] as SourceId[] })
    expect(edited.set).toMatchObject({ setRef: added.set.setRef, label: 'Optics and imaging', sourceIds: ['source-b', 'source-c'] })
    const firstSetRef = edited.record.readingSets![0]!.setRef
    const afterDelete = await manager.deleteSet({ accessId: created.record.id, commandId: 'delete-probability', expectedVersion: 3, setRef: firstSetRef })
    expect(afterDelete.readingSets).toMatchObject([{ setRef: added.set.setRef }])
    expect(manager.resolveSet(created.record.id).setRef).toBe(added.set.setRef)
    expect(manager.authenticate(token)?.id).toBe(created.record.id)
  })

  it('projects an existing v0.7 connection as one default set and migrates it on edit', async () => {
    const { records, manager } = await setup()
    const created = await manager.create({ commandId: 'create-legacy', label: 'Legacy books', mcpServerName: 'study-reader', readingSetLabel: 'Temporary', sourceIds: ['source-a'] as SourceId[], expiresInDays: 30 })
    const { readingSets: _readingSets, lastCommandPayloadHash: _lastHash, lastCommandSetRef: _lastSetRef, ...legacy } = created.record
    await records.put(legacy.id, legacy)

    expect(manager.resolveSet(legacy.id)).toMatchObject({ setRef: 'set_default', label: 'Legacy books', sourceIds: ['source-a'] })
    const migrated = await manager.saveSet({ accessId: legacy.id, commandId: 'edit-legacy', expectedVersion: legacy.version, setRef: 'set_default', label: 'Probability', sourceIds: ['source-a', 'source-b'] as SourceId[] })
    expect(migrated.record.readingSets).toMatchObject([{ setRef: 'set_default', label: 'Probability', sourceIds: ['source-a', 'source-b'] }])
    expect(manager.authenticate(created.token)?.id).toBe(legacy.id)
  })

  it('revokes immediately and keeps revoke retries idempotent', async () => {
    const { manager } = await setup()
    const created = await manager.create({ commandId: 'create-revoke', label: 'Codex', mcpServerName: 'reader-library', readingSetLabel: 'Library', sourceIds: ['source-a'] as SourceId[], expiresInDays: 30 })
    const revoked = await manager.revoke(created.record.id, 'revoke-1', created.record.version)
    expect(revoked).toMatchObject({ version: 2, lastCommandId: 'revoke-1', revokedAt: expect.any(Number) })
    expect(manager.authenticate(created.token)).toBeUndefined()
    expect(() => manager.requireActive(created.record.id)).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }))
    expect(await manager.revoke(created.record.id, 'revoke-1', created.record.version)).toEqual(revoked)
  })
})
