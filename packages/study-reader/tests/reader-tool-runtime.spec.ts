import { describe, expect, it, vi } from 'vitest'
import type { ReaderHost, StudyReaderProfile } from '../src/ai/contracts.ts'
import { createReaderToolSpecs } from '../src/ai/reader-tools.ts'
import { TurnResourceMap } from '../src/ai/resource-map.ts'
import { ReaderToolDispatcher, ReaderToolRegistry, ToolCallGuard } from '../src/ai/tool-runtime.ts'

const allTools = new Set(createReaderToolSpecs().map(spec => spec.name))
const profile: StudyReaderProfile = {
  allowedSkills: new Set(), allowedTools: allTools,
  allowLibraryWideSearch: true, allowPersistentWrites: true,
  maxToolCallsPerTurn: 8, maxToolAttemptsPerTurn: 10,
}

function dispatcher(args: { readonly host?: ReaderHost; readonly authorization?: { navigation: boolean; persistentWrite: boolean }; readonly withPassage?: boolean }) {
  const host = args.host ?? {
    capabilities: new Set(['documents.list', 'documents.outline', 'passages.search', 'passages.read', 'navigation.open', 'notes.save']),
    async getContext() { return { library: { readyCount: 1, processingCount: 0, documents: [{ id: 'source-1', title: 'Book', format: 'pdf' as const, readiness: 'ready' as const }] }, private: { principalId: 'principal' } } },
  }
  const resources = new TurnResourceMap()
  if (args.withPassage) resources.publishPassage({ documentId: 'source-1', documentTitle: 'Book', documentFormat: 'pdf', passageId: 'block-1', text: 'Evidence.' })
  return new ReaderToolDispatcher(
    new ReaderToolRegistry(createReaderToolSpecs()), new ToolCallGuard(),
    {
      principalId: 'principal', host,
      snapshot: { library: { readyCount: 1, processingCount: 0, documents: [{ id: 'source-1', title: 'Book', format: 'pdf', readiness: 'ready' }] }, private: { principalId: 'principal' } },
      resources, profile,
      authorization: args.authorization ?? { navigation: false, persistentWrite: false },
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

  it('requires explicit navigation authorization and rejects duplicate calls', async () => {
    const openLocation = vi.fn(async () => ({ confirmed: true, documentId: 'source-1' }))
    const listDocuments = vi.fn(async () => [{ id: 'source-1', title: 'Book', format: 'pdf' as const, readiness: 'ready' as const }])
    const host = { capabilities: new Set(['documents.list', 'navigation.open']), getContext: vi.fn(), listDocuments, openLocation } as unknown as ReaderHost
    const input = { target: { kind: 'page', document: { kind: 'document_title', title: 'Book' }, page: 3 } }
    expect(await dispatcher({ host }).execute('reader_open_location', input, new AbortController().signal)).toMatchObject({ status: 'error', error: { code: 'SIDE_EFFECT_NOT_AUTHORIZED' } })

    const allowed = dispatcher({ host, authorization: { navigation: true, persistentWrite: false } })
    expect(await allowed.execute('reader_open_location', input, new AbortController().signal)).toMatchObject({ status: 'success', data: { confirmed: true } })
    expect(await allowed.execute('reader_open_location', input, new AbortController().signal)).toMatchObject({ status: 'error', error: { code: 'DUPLICATE_CALL' } })
    expect(openLocation).toHaveBeenCalledTimes(1)
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

  it('requires an explicit write request and at least one cited passage', async () => {
    const saveNote = vi.fn(async () => ({ accepted: true, persisted: true, noteId: 'private-note' }))
    const host = { capabilities: new Set(['notes.save']), getContext: vi.fn(), saveNote } as unknown as ReaderHost
    const input = { content: 'A concise note.', destination: 'study_space', sourcePassageRefs: ['passage_1'] }

    expect(await dispatcher({ host, withPassage: true }).execute('reader_save_note', input, new AbortController().signal))
      .toMatchObject({ status: 'error', error: { code: 'SIDE_EFFECT_NOT_AUTHORIZED' } })
    const result = await dispatcher({ host, withPassage: true, authorization: { navigation: false, persistentWrite: true } }).execute('reader_save_note', input, new AbortController().signal)
    expect(result).toMatchObject({ status: 'success', data: { persisted: true, destination: 'study_space' } })
    expect(JSON.stringify(result)).not.toContain('private-note')
    expect(saveNote).toHaveBeenCalledTimes(1)
  })
})
