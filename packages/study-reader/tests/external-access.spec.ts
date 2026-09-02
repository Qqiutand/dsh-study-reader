import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalAccessManager } from '../src/study/external-access.ts'
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
  it('persists only a secret-free grant and authenticates after restart', async () => {
    const { root, records, manager } = await setup()
    const created = await manager.create({ commandId: 'create-1', label: 'Codex', sourceIds: ['source-b', 'source-a'] as SourceId[], expiresInDays: 30 })

    expect(created.token).toMatch(/^dsr_v1\.external-[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/)
    expect(created.record.sourceIds).toEqual(['source-a', 'source-b'])
    expect(JSON.stringify([...records.entries()])).not.toContain(created.token)
    expect((await stat(join(root, 'external-mcp.key'))).mode & 0o777).toBe(0o600)

    const restarted = await ExternalAccessManager.open(records, root)
    expect(restarted.authenticate(created.token)).toMatchObject({ id: created.record.id, label: 'Codex' })
  })

  it('replays create commands deterministically and rejects conflicting reuse', async () => {
    const { manager } = await setup()
    const input = { commandId: 'create-retry', label: 'Research', sourceIds: ['source-a'] as SourceId[], expiresInDays: 7 }
    const first = await manager.create(input)
    const replay = await manager.create(input)
    expect(replay).toEqual(first)
    await expect(manager.create({ ...input, sourceIds: ['source-b'] as SourceId[] })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  })

  it('serializes concurrent retries into one durable connection', async () => {
    const { manager, records } = await setup()
    const input = { commandId: 'create-concurrent', label: 'Codex', sourceIds: ['source-a'] as SourceId[], expiresInDays: 30 }
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

  it('revokes immediately and keeps revoke retries idempotent', async () => {
    const { manager } = await setup()
    const created = await manager.create({ commandId: 'create-revoke', label: 'Codex', sourceIds: ['source-a'] as SourceId[], expiresInDays: 30 })
    const revoked = await manager.revoke(created.record.id, 'revoke-1', created.record.version)
    expect(revoked).toMatchObject({ version: 2, lastCommandId: 'revoke-1', revokedAt: expect.any(Number) })
    expect(manager.authenticate(created.token)).toBeUndefined()
    expect(() => manager.requireActive(created.record.id)).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }))
    expect(await manager.revoke(created.record.id, 'revoke-1', created.record.version)).toEqual(revoked)
  })
})
