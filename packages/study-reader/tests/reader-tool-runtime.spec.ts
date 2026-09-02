import { describe, expect, it, vi } from 'vitest'
import type { ReaderHost, StudyReaderProfile } from '../src/ai/contracts.ts'
import { createReaderToolSpecs } from '../src/ai/reader-tools.ts'
import { TurnResourceMap } from '../src/ai/resource-map.ts'
import { ReaderToolDispatcher, ReaderToolRegistry, ToolCallGuard } from '../src/ai/tool-runtime.ts'

const allTools = new Set(createReaderToolSpecs().map(spec => spec.name))
const profile: StudyReaderProfile = {
  allowedSkills: new Set(), allowedTools: allTools,
  allowLibraryWideSearch: true, allowPersistentWrites: true,
  toolCallLimit: 'bounded',
  maxToolCallsPerTurn: 8, maxToolAttemptsPerTurn: 10,
}

function dispatcher(args: { readonly host?: ReaderHost; readonly authorization?: { persistentWrite: boolean }; readonly withPassage?: boolean; readonly profile?: StudyReaderProfile }) {
  const host = args.host ?? {
    capabilities: new Set(['documents.list', 'documents.outline', 'passages.search', 'passages.read', 'notes.save']),
    async getContext() { return { library: { readyCount: 1, processingCount: 0, documents: [{ id: 'source-1', title: 'Book', format: 'pdf' as const, readiness: 'ready' as const }] }, private: { principalId: 'principal' } } },
  }
  const resources = new TurnResourceMap()
  if (args.withPassage) resources.publishPassage({ documentId: 'source-1', documentTitle: 'Book', documentFormat: 'pdf', passageId: 'block-1', text: 'Evidence.' })
  return new ReaderToolDispatcher(
    new ReaderToolRegistry(createReaderToolSpecs()), new ToolCallGuard(),
    {
      principalId: 'principal', host,
      snapshot: { library: { readyCount: 1, processingCount: 0, documents: [{ id: 'source-1', title: 'Book', format: 'pdf', readiness: 'ready' }] }, private: { principalId: 'principal' } },
      resources, profile: args.profile ?? profile,
      authorization: args.authorization ?? { persistentWrite: false },
    },
  )
}

describe('Reader Tool runtime policy', () => {
  it('makes read tools callable without a Skill and rejects unknown fields', async () => {
    const searchPassages = vi.fn(async () => ({ passages: [], truncated: false }))
    const host = { capabilities: new Set(['passages.search']), getContext: vi.fn(), searchPassages } as unknown as ReaderHost
    const runtime = dispatcher({ host })
    expect((await runtime.execute('reader_search_passages', { query: 'term', scope: { kind: 'conversation' } }, new AbortController().signal)).status).toBe('empty')
    expect(await runtime.execute('reader_search_passages', { query: 'other', scope: { kind: 'conversation' }, hidden: true }, new AbortController().signal)).toMatchObject({ status: 'error', error: { code: 'INVALID_ARGUMENT' } })
    expect(searchPassages).toHaveBeenCalledTimes(1)
  })

  it('stops searching one scope after the original query and one empty reformulation', async () => {
    const searchPassages = vi.fn(async () => ({ passages: [], truncated: false }))
    const host = { capabilities: new Set(['passages.search']), getContext: vi.fn(), searchPassages } as unknown as ReaderHost
    const runtime = dispatcher({ host })
    const scope = { kind: 'conversation' }
    expect((await runtime.execute('reader_search_passages', { query: 'first', scope }, new AbortController().signal)).status).toBe('empty')
    expect((await runtime.execute('reader_search_passages', { query: 'second', scope }, new AbortController().signal)).status).toBe('empty')
    expect(await runtime.execute('reader_search_passages', { query: 'third', scope }, new AbortController().signal)).toMatchObject({ status: 'error', error: { code: 'SEARCH_STOPPED' } })
    expect(searchPassages).toHaveBeenCalledTimes(2)
  })

  it('removes count limits in unbounded mode but still rejects an exact duplicate', async () => {
    const searchPassages = vi.fn(async () => ({ passages: [], truncated: false }))
    const host = { capabilities: new Set(['passages.search']), getContext: vi.fn(), searchPassages } as unknown as ReaderHost
    const runtime = dispatcher({
      host,
      profile: {
        ...profile,
        toolCallLimit: 'unbounded',
        maxToolCallsPerTurn: 1,
        maxToolAttemptsPerTurn: 1,
      },
    })
    const signal = new AbortController().signal

    for (let index = 0; index < 20; index += 1) {
      expect(await runtime.execute('reader_search_passages', {
        query: `distinct query ${String(index)}`,
        scope: { kind: 'conversation' },
      }, signal)).toMatchObject({ status: 'empty' })
    }
    expect(await runtime.execute('reader_search_passages', {
      query: 'distinct query 0',
      scope: { kind: 'conversation' },
    }, signal)).toMatchObject({ status: 'error', error: { code: 'DUPLICATE_CALL' } })
    expect(searchPassages).toHaveBeenCalledTimes(20)
  })

  it('reserves final evidence reads and one authorized save after the shared discovery budget', async () => {
    const saveNote = vi.fn(async () => ({ accepted: true, persisted: true, noteId: 'private-note' }))
    const host = {
      capabilities: new Set(['documents.list', 'passages.search', 'passages.read', 'notes.save']),
      async getContext() { return { library: { readyCount: 1, processingCount: 0, documents: [{ id: 'source-1', title: 'Book', format: 'pdf' as const, readiness: 'ready' as const }] }, private: { principalId: 'principal' } } },
      async listDocuments() { return [{ id: 'source-1', title: 'Book', format: 'pdf' as const, readiness: 'ready' as const }] },
      async searchPassages() { return { passages: [], truncated: false } },
      async readPassage() { return { documentId: 'source-1', documentTitle: 'Book', documentFormat: 'pdf' as const, passageId: 'block-1', text: 'Final evidence.' } },
      saveNote,
    } as ReaderHost
    const runtime = dispatcher({
      host, withPassage: true,
      profile: { ...profile, maxToolCallsPerTurn: 3, maxToolAttemptsPerTurn: 10 },
      authorization: { persistentWrite: true },
    })
    const signal = new AbortController().signal
    expect((await runtime.execute('reader_get_context', {}, signal)).status).toBe('success')
    expect((await runtime.execute('reader_list_documents', { query: 'Book' }, signal)).status).toBe('success')
    expect((await runtime.execute('reader_search_passages', { query: 'first', scope: { kind: 'conversation' } }, signal)).status).toBe('empty')
    expect(await runtime.execute('reader_search_passages', { query: 'blocked discovery', scope: { kind: 'conversation' } }, signal))
      .toMatchObject({ status: 'error', error: {
        code: 'CALL_BUDGET_EXCEEDED',
        message: expect.stringContaining('正文读取也有保留次数限制'),
      } })
    expect((await runtime.execute('reader_read_passage', { target: { kind: 'passage_ref', passageRef: 'passage_1' }, window: 0 }, signal)).status).toBe('success')
    expect((await runtime.execute('reader_read_passage', { target: { kind: 'passage_ref', passageRef: 'passage_1' }, window: 1 }, signal)).status).toBe('success')
    expect(await runtime.execute('reader_read_passage', { target: { kind: 'passage_ref', passageRef: 'passage_1' }, window: 2 }, signal))
      .toMatchObject({ status: 'error', error: { code: 'CALL_BUDGET_EXCEEDED', message: expect.stringContaining('两次正文读取') } })
    expect(await runtime.execute('reader_save_note', { content: 'Final note.', destination: 'study_space', sourcePassageRefs: ['passage_1'] }, signal))
      .toMatchObject({ status: 'success', data: { persisted: true } })
    expect(await runtime.execute('reader_save_note', { content: 'Another note.', destination: 'study_space', sourcePassageRefs: ['passage_1'] }, signal))
      .toMatchObject({ status: 'error', error: { code: 'CALL_BUDGET_EXCEEDED', message: expect.stringContaining('一次笔记保存') } })
    expect(saveNote).toHaveBeenCalledTimes(1)
  })

  it('requires an explicit write request and at least one cited passage', async () => {
    const saveNote = vi.fn(async () => ({ accepted: true, persisted: true, noteId: 'private-note' }))
    const host = { capabilities: new Set(['notes.save']), getContext: vi.fn(), saveNote } as unknown as ReaderHost
    const input = { content: 'A concise note.', destination: 'study_space', sourcePassageRefs: ['passage_1'] }

    expect(await dispatcher({ host, withPassage: true }).execute('reader_save_note', input, new AbortController().signal))
      .toMatchObject({ status: 'error', error: { code: 'SIDE_EFFECT_NOT_AUTHORIZED' } })
    const result = await dispatcher({ host, withPassage: true, authorization: { persistentWrite: true } }).execute('reader_save_note', input, new AbortController().signal)
    expect(result).toMatchObject({ status: 'success', data: { persisted: true, destination: 'study_space' } })
    expect(JSON.stringify(result)).not.toContain('private-note')
    expect(saveNote).toHaveBeenCalledTimes(1)
  })

  it('returns a precise validation error for an empty save-note evidence list', async () => {
    const host = { capabilities: new Set(['notes.save']), getContext: vi.fn(), saveNote: vi.fn() } as unknown as ReaderHost
    const result = await dispatcher({ host, authorization: { persistentWrite: true } }).execute('reader_save_note', {
      content: 'A concise note.', destination: 'study_space', sourcePassageRefs: [],
    }, new AbortController().signal)
    expect(result).toMatchObject({ status: 'error', error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('input.sourcePassageRefs') } })
  })
})
