import { describe, expect, it } from 'vitest'
import { migrateLegacyRevision, migrateLegacyRevisions } from '../src/study/revision-migration.ts'

describe('legacy revision migration', () => {
  it('derives the historic EPUB provider without changing retained fields', () => {
    const old = { id: 'r', sourceId: 's', format: 'epub', providerModel: 'epub-local-v1', blockCount: 0, markdownBlob: 'm', blocksBlob: 'b', outline: [], sha256: 'h', createdAt: 1 }
    expect(migrateLegacyRevision(old as never)).toMatchObject({ ...old, providerId: 'epub-local', providerKind: 'epub' })
  })

  it('rejects ambiguous legacy provenance rather than guessing', () => {
    expect(() => migrateLegacyRevision({ format: 'other', providerModel: 'unknown' } as never)).toThrow('unknown legacy revision provenance')
  })

  it('derives MinerU only from the retained PDF model', () => {
    expect(migrateLegacyRevision({ format: 'pdf', providerModel: 'mineru-vlm' } as never)).toMatchObject({ providerId: 'mineru', providerKind: 'mineru' })
  })

  it('leaves current records untouched and makes the second migration a no-op', async () => {
    const current = { id: 'r', sourceId: 's', format: 'pdf', providerId: 'mineru', providerKind: 'mineru', providerModel: 'mineru-vlm', blockCount: 0, markdownBlob: 'm', blocksBlob: 'b', outline: [], sha256: 'h', createdAt: 1 }
    const puts: unknown[] = []
    const table = { entries: () => [['r', current]], put: async (_id: unknown, value: unknown) => { puts.push(value) } }
    await migrateLegacyRevisions(table as never)
    await migrateLegacyRevisions(table as never)
    expect(puts).toEqual([])
  })

  it('rejects partial provider fields rather than classifying them as legacy', async () => {
    const partial = { id: 'r', providerId: 'mineru', format: 'pdf', providerModel: 'mineru-vlm' }
    const table = { entries: () => [['r', partial]], put: async () => {} }
    await expect(migrateLegacyRevisions(table as never)).rejects.toThrow('cannot be migrated')
  })
})
