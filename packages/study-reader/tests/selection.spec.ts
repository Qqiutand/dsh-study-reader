import { describe, expect, it, vi } from 'vitest'
import { DurableStudyMemoryProvider } from '../src/memory/durable.ts'
import type { SessionSourceSelectionRecord } from '../src/memory/types.ts'

function selectionTable(initial: readonly SessionSourceSelectionRecord[] = []) {
  const values = new Map(initial.map(record => [record.sessionId, record]))
  return {
    get: vi.fn((key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: SessionSourceSelectionRecord) => { values.set(key, value) }),
    delete: vi.fn(async (key: string) => { values.delete(key) }),
    entries: vi.fn(() => values.entries()),
  }
}

function provider(selections: ReturnType<typeof selectionTable>) {
  return new DurableStudyMemoryProvider({
    selections,
    memories: { entries: () => [][Symbol.iterator]() },
    mutations: {},
    config: { providerId: 'selection-test', contextItems: 2, contextChars: 200 },
  } as never)
}

describe('session source selection', () => {
  it('reads without any KV write and returns an empty version-zero record', async () => {
    const table = selectionTable()
    const memory = provider(table)
    expect(await memory.getSelection(' session-a ')).toEqual({
      schemaVersion: 1, sessionId: 'session-a', updatedAt: 0, version: 0,
    })
    expect(table.put).not.toHaveBeenCalled()
    expect(table.delete).not.toHaveBeenCalled()
  })

  it('uses Host version and command id for one idempotent explicit write', async () => {
    const table = selectionTable()
    const memory = provider(table)
    const input = {
      sessionId: 'session-a', sourceId: 'source-a' as never, revisionId: 'revision-a' as never,
      expectedVersion: 0, commandId: 'select-a',
    }
    const first = await memory.setSelection(input)
    const replay = await memory.setSelection(input)
    expect(first).toMatchObject({ sourceId: 'source-a', revisionId: 'revision-a', version: 1, lastCommandId: 'select-a' })
    expect(replay).toEqual(first)
    expect(table.put).toHaveBeenCalledTimes(1)
    await expect(memory.setSelection({ ...input, commandId: 'stale', sourceId: 'source-b' as never }))
      .rejects.toMatchObject({ code: 'MEMORY_SELECTION_VERSION_CONFLICT' })
  })
})
