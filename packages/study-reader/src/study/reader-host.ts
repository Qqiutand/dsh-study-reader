/** Principal-bound adapter from the existing Study domain to the AI ReaderHost. */
import type { HostOutlineNode, HostPassage, ReaderHost } from '../ai/contracts.ts'
import { StudyError } from '../protocol/error.ts'
import type { EvidenceOutlineResult, EvidenceReadResult, EvidenceSearchResult, EvidenceSource, OutlineItem, ReadRange, SourceId, SourceSummary } from './types.ts'
import type { StudyService } from './study-service.ts'

function location(page: number, headingPath: readonly string[] = []) {
  const section = headingPath.at(-1)
  const label = [page > 0 ? `第 ${page} 页` : undefined, section].filter(Boolean).join(' · ') || '文档位置'
  return { label, ...(page > 0 ? { page } : {}), ...(section === undefined ? {} : { section }) }
}

function outlineTree(items: readonly OutlineItem[], maxDepth: number): HostOutlineNode[] {
  const roots: Array<HostOutlineNode & { children?: HostOutlineNode[] }> = []
  const stack: Array<HostOutlineNode & { children?: HostOutlineNode[] }> = []
  for (const item of items) {
    if (item.depth > maxDepth) continue
    const node: HostOutlineNode & { children?: HostOutlineNode[] } = { title: item.title, level: item.depth, location: location(item.page, [item.title]) }
    while (stack.length >= item.depth) stack.pop()
    const parent = stack.at(-1)
    if (parent === undefined) roots.push(node)
    else { parent.children ??= []; parent.children.push(node) }
    stack.push(node)
  }
  return roots
}

function asPassages(source: { readonly id: SourceId; readonly title: string; readonly format: 'pdf' | 'epub' | 'other' }, blocks: readonly { readonly ordinal: number; readonly page: number; readonly headingPath: readonly string[]; readonly text: string }[]): HostPassage[] {
  return blocks.map(block => ({
    documentId: source.id, documentTitle: source.title, documentFormat: source.format,
    passageId: `ordinal:${block.ordinal}`, text: block.text, location: location(block.page, block.headingPath),
  }))
}

function readiness(source: SourceSummary) {
  if (source.import?.state === 'failed') return 'failed' as const
  if (source.revisionId !== undefined) return 'ready' as const
  if (source.import?.state === 'indexing') return 'indexing' as const
  return 'loading' as const
}

interface ReadOnlyReaderAdapter {
  assertPrincipal(): void
  listAll(): Promise<readonly SourceSummary[]>
  list(query?: string, limit?: number): Promise<readonly SourceSummary[]>
  outline(sourceId: SourceId): Promise<EvidenceOutlineResult>
  search(input: { readonly sourceId: SourceId; readonly query: string; readonly limit: number }): Promise<EvidenceSearchResult>
  info(sourceId: SourceId): Promise<EvidenceSource>
  read(input: { readonly sourceId: SourceId; readonly range: ReadRange }, maxChars: number): Promise<EvidenceReadResult>
}

function createReadOnlyReaderHost(principalId: string, adapter: ReadOnlyReaderAdapter): ReaderHost {
  return {
    capabilities: new Set(['documents.list', 'documents.outline', 'passages.search', 'passages.read']),
    async getContext({ principalId: requested, signal }) {
      signal.throwIfAborted(); if (requested !== principalId) throw new StudyError('reader principal mismatch', 'PERMISSION_DENIED'); adapter.assertPrincipal()
      const sources = await adapter.listAll()
      const documents = sources.map(source => ({ id: source.id, title: source.title, format: source.format ?? 'other', readiness: readiness(source) }))
      return {
        library: {
          readyCount: documents.filter(document => document.readiness === 'ready').length,
          processingCount: documents.filter(document => document.readiness === 'loading' || document.readiness === 'indexing').length,
          documents,
        },
        private: { principalId },
      }
    },
    async listDocuments({ principalId: requested, query, limit, signal }) {
      signal.throwIfAborted(); if (requested !== principalId) throw new StudyError('reader principal mismatch', 'PERMISSION_DENIED'); adapter.assertPrincipal()
      const sources = await adapter.list(query, limit)
      return sources.map(source => ({ id: source.id, title: source.title, format: source.format ?? 'other', readiness: readiness(source) }))
    },
    async getOutline({ principalId: requested, documentId, maxDepth, signal }) {
      signal.throwIfAborted(); if (requested !== principalId) throw new StudyError('reader principal mismatch', 'PERMISSION_DENIED'); adapter.assertPrincipal()
      const result = await adapter.outline(documentId as SourceId)
      return outlineTree(result.outline, maxDepth)
    },
    async searchPassages({ principalId: requested, query, documentIds, limit, signal }) {
      signal.throwIfAborted(); if (requested !== principalId) throw new StudyError('reader principal mismatch', 'PERMISSION_DENIED'); adapter.assertPrincipal()
      const ids = documentIds ?? (await adapter.listAll()).flatMap(source => source.revisionId === undefined ? [] : [source.id])
      const passages: HostPassage[] = []
      let truncated = false
      for (const id of ids) {
        signal.throwIfAborted()
        const result = await adapter.search({ sourceId: id as SourceId, query, limit })
        passages.push(...asPassages(result.source, result.blocks))
        truncated ||= result.truncated
        if (passages.length >= limit) { truncated ||= passages.length > limit || ids.length > 1; break }
      }
      return { passages: passages.slice(0, limit), truncated }
    },
    async readPassage({ principalId: requested, documentId, anchor, window, signal }) {
      signal.throwIfAborted(); if (requested !== principalId) throw new StudyError('reader principal mismatch', 'PERMISSION_DENIED'); adapter.assertPrincipal()
      const sourceId = documentId as SourceId
      const info = await adapter.info(sourceId)
      let range
      if (anchor.kind === 'passage') {
        const match = /^ordinal:(\d+)$/.exec(anchor.passageId)
        if (match === null) throw new StudyError('passage reference is invalid', 'EVIDENCE_RANGE_INVALID')
        const ordinal = Number(match[1]); range = { kind: 'blocks' as const, start: Math.max(0, ordinal - window), end: ordinal + window + 1 }
      } else if (anchor.kind === 'page') range = { kind: 'pages' as const, start: Math.max(1, anchor.page - window), end: anchor.page + window }
      else {
        const outline = await adapter.outline(sourceId)
        const normalized = anchor.section.normalize('NFKC').trim().toLocaleLowerCase()
        const matches = outline.outline.filter(item => item.id === anchor.section || item.title.normalize('NFKC').trim().toLocaleLowerCase() === normalized)
        if (matches.length === 0) throw new StudyError('section not found', 'EVIDENCE_RANGE_INVALID')
        if (matches.length > 1) throw new StudyError('section title is ambiguous', 'EVIDENCE_RANGE_INVALID')
        range = { kind: 'section' as const, sectionId: matches[0]!.id }
      }
      const result = await adapter.read({ sourceId, range }, 20_000)
      const first = result.blocks[0]
      return {
        documentId: info.id, documentTitle: info.title, documentFormat: info.format,
        ...(first === undefined ? {} : { passageId: `ordinal:${first.ordinal}`, location: location(first.page, first.headingPath) }),
        text: result.blocks.map(block => block.text).join('\n\n'), ...(result.truncated ? { warnings: ['正文超过单次读取范围，结果已截断'] } : {}),
      }
    },
  }
}

export function createStudyReaderHost(service: StudyService, principalId: string): ReaderHost {
  const assertPrincipal = (): void => service.assertReaderPrincipal(principalId)
  const host = createReadOnlyReaderHost(principalId, {
    assertPrincipal,
    listAll: async () => await service.listAllSourcesForCurrentInitiator(),
    list: async (query, limit) => await service.listSourcesForCurrentInitiator(query, limit),
    outline: async sourceId => await service.outlineForCurrentInitiator(sourceId),
    search: async input => await service.searchForCurrentInitiator(input),
    info: async sourceId => await service.sourceInfoForCurrentInitiator(sourceId),
    read: async (input, maxChars) => await service.readForCurrentInitiator(input, maxChars),
  })
  return {
    ...host,
    capabilities: new Set([...host.capabilities, 'notes.save' as const]),
    async saveNote({ principalId: requested, title, content, sourcePassages, signal }) {
      signal.throwIfAborted(); if (requested !== principalId) throw new StudyError('reader principal mismatch', 'PERMISSION_DENIED'); assertPrincipal()
      const sourceId = sourcePassages[0]?.documentId
      if (sourceId === undefined) throw new StudyError('saving a note requires at least one cited passage', 'EVIDENCE_SOURCE_REQUIRED')
      const source = await service.sourceInfoForCurrentInitiator(sourceId as SourceId)
      const memory = await service.rememberStudyMemoryForCurrentInitiator({
        scope: 'session', kind: 'summary', sourceId: source.id, text: content,
        ...(title === undefined ? {} : { note: title }), tags: ['reader-note'],
      })
      return {
        accepted: true, persisted: true, noteId: String(memory.id),
        ...(title === undefined ? {} : { title }), persistedAt: new Date(memory.updatedAt).toISOString(),
      }
    },
  }
}

/** Reading-set-scoped, read-only host used by the embedded MCP endpoint. */
export function createExternalStudyReaderHost(service: StudyService, principalId: string, setRef: string): ReaderHost {
  return createReadOnlyReaderHost(principalId, {
    assertPrincipal: () => { service.assertExternalReaderPrincipal(principalId) },
    listAll: async () => await service.listAllSourcesForExternalPrincipal(principalId, setRef),
    list: async (query, limit) => await service.listSourcesForExternalPrincipal(principalId, setRef, query, limit),
    outline: async sourceId => await service.outlineForExternalPrincipal(principalId, setRef, sourceId),
    search: async input => await service.searchForExternalPrincipal(principalId, setRef, input),
    info: async sourceId => await service.sourceInfoForExternalPrincipal(principalId, setRef, sourceId),
    read: async (input, maxChars) => await service.readForExternalPrincipal(principalId, setRef, input, maxChars),
  })
}
