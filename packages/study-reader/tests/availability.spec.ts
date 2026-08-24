/**
 * Interface availability smoke matrix for the study-reader plugin.
 *
 * Complements the behavior specs (upload/poller/graph/search/mineru/tools/
 * integration) by exercising the public surface that those specs do not
 * cover directly:
 * - `bootstrap` Remote + quick-action passthrough,
 * - `listSources` filtering / sorting / limit / field omission,
 * - the StudyError routing codes of every failure path,
 * - HTTP mappings of the upload route (405 / 401),
 * - `renewUpload` rejection of URL imports,
 * - BlobStore content addressing,
 * - the session-event vocabulary: the declared `study/*` types and whether
 *   the reducer consumes each,
 *   SM-2 scheduling, card creation, and dossier synthesis.
 *
 * Proof of the "declared but not wired" findings lives here as executable
 * assertions; the wired side is proven by the other specs.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import { StudyError } from '../lib/types/extraction/index.js'
import { BlobStore } from '../lib/types/study/blob-store.js'
import { disposeHarnesses, eventually, pdfFixture, setupStudy, type StudyHarness } from './helpers.ts'
import { emptyStudyState, applyStudyEvent } from '../lib/types/domain/reducer.js'
import {
  createCardFromBookmark,
  createCardFromFriction,
  scheduleNextReview,
  type ReviewQuality,
} from '../lib/types/domain/cards.js'
import { synthesizeDossier } from '../lib/types/domain/dossier.js'
import { STUDY_EVENT_TYPES, isStudyEventType } from '../lib/types/protocol/events.js'
import type { StudyBlock, StudyEventRecord, SourceId, RevisionId } from '../lib/types/study/index.js'
import { FrictionId } from '../lib/types/protocol/ids.js'
import { CallId } from '@deepseek-ai/dsh-llm'

const harnesses: StudyHarness[] = []

async function setup(): Promise<StudyHarness> {
  const value = await setupStudy()
  harnesses.push(value)
  return value
}

/** Inspect the Host-owned event table without exposing it through a browser Remote. */
function durableEvents(harness: StudyHarness, sessionId: string): readonly StudyEventRecord[] {
  const events = (harness.ctx.study as unknown as {
    deps: { events: { entries(): Iterable<readonly [string, StudyEventRecord]> } }
  }).deps.events
  return [...events.entries()]
    .map(([, record]) => record)
    .filter(record => record.sessionId === sessionId)
    .sort((left, right) => left.seq - right.seq)
}

/** Import one ready source and grant it to the named sessions. */
async function readySource(harness: StudyHarness, sessionIds: readonly string[]): Promise<ReturnType<StudyHarness['ctx']['study']['listSources']>[number]> {
  harness.server.mode = { pollSequence: ['done'] }
  const pdf = await pdfFixture()
  const prepared = await harness.ctx.study.prepareUploadForClient({ fileName: 'book.pdf', sizeBytes: pdf.byteLength })
  const response = await fetch(`http://127.0.0.1:${harness.ctx.webServer.port}${prepared.uploadPath}`, {
    method: 'PUT',
    headers: { 'X-Study-Upload-Token': prepared.uploadToken, 'Content-Length': String(pdf.byteLength) },
    body: Buffer.from(pdf),
  })
  expect(response.status).toBe(200)
  await eventually(() => harness.ctx.study.importStatusForClient({ importId: prepared.importId }).state === 'ready')
  const source = harness.ctx.study.listSources()[0]!
  for (const sessionId of sessionIds) {
    await harness.ctx.study.setSourceAccessForClient({ sessionId, sourceId: source.id, granted: true })
  }
  return source
}

afterEach(async () => {
  await disposeHarnesses()
  harnesses.splice(0)
})

/** Apply one event through the reducer with unchecked payloads. */
function apply<const T extends keyof SessionEventMap>(
  type: T,
  data: SessionEventMap[T],
  state = emptyStudyState(),
) {
  return applyStudyEvent(state, type, data as never)
}

/** A jet of sample events with minimal valid payloads. */
function sample(type: keyof SessionEventMap): SessionEventMap[keyof SessionEventMap] {
  switch (type) {
    case 'study/source-imported':
      return { sourceId: 'src-1', title: 't', fileName: 'f', pageCount: 1, blockCount: 1, timestamp: 0 }
    case 'study/highlight':
      return { sourceId: 'src-1', page: 1, blockIds: [], selectedText: 's', timestamp: 0 }
    case 'study/bookmark':
      return { sourceId: 'src-1', page: 1, blockIds: [], selectedText: 's', timestamp: 0 }
    case 'study/feynman-requested':
      return { requestId: 'req-1', sourceId: 'src-1', page: 1, blockIds: [], selectedText: 's', explanation: 'e', timestamp: 0 }
    case 'study/toulmin-requested':
      return { requestId: 'req-1', sourceId: 'src-1', page: 1, blockIds: [], selectedText: 's', toulmin: { claim: 'c', evidence: [{ text: 'e', page: 1 }], warrant: 'w' }, timestamp: 0 }
    case 'study/calibration':
      return { requestId: 'req-1', sourceId: 'src-1', stage: 'post-explanation', rating: 'clear', timestamp: 0 }
    case 'study/cognitive-requested':
      return { requestId: 'req-1', sourceId: 'src-1', page: 1, blockIds: ['b1'], selectedText: 's', kind: 'passage', lens: 'feynman', intent: 'concept', timestamp: 0 }
    case 'study/cognitive-enqueued':
      return { requestId: 'req-1', sourceId: 'src-1', revisionId: 'rev-1', messageId: 'msg-1', timestamp: 0 }
    case 'study/cognitive-context-prepared':
      return { requestId: 'req-1', sourceId: 'src-1', revisionId: 'rev-1', page: 1, blockIds: ['b1'], receipt: 'receipt-1', turn: 1, toolCallId: 'call-1', timestamp: 0 }
    case 'study/cognitive-probe-generated':
      return {
        requestId: 'req-1', sourceId: 'src-1', page: 1, blockIds: ['b1'], lens: 'feynman', intent: 'concept',
        question: 'q?', purpose: 'p', hint: 'h', synthesis: 's', provider: 'p', model: 'm', timestamp: 0,
        options: (['A', 'B', 'C', 'D', 'E', 'F'] as const).map((id, index) => ({ id, text: id, diagnosis: id, feedback: id, best: index === 0 })),
        citations: [{ page: 1, blockId: 'b1', quote: 's' }],
      }
    case 'study/cognitive-option-selected':
      return { requestId: 'req-1', sourceId: 'src-1', optionId: 'A', timestamp: 0 }
    case 'study/socratic-generated':
      return { requestId: 'req-1', sourceId: 'src-1', page: 1, blockIds: [], selectedText: 's', challenge: { questionId: 'q', questionText: 'q?', targetConcept: 'c', evaluationCriteria: 'e' }, timestamp: 0 }
    case 'study/socratic-response':
      return { requestId: 'req-1', questionId: 'q', question: 'q?', userAnswer: 'a', aiAssessment: { passed: true, feedback: 'ok' }, timestamp: 0 }
    case 'study/friction':
      return { frictionId: FrictionId('fric-1'), sourceId: 'src-1', page: 1, blockIds: [], topic: 't', confusionDescription: 'd', timestamp: 0 }
    case 'study/review-card-generated':
      return { cardId: 'card-1', sourceId: 'src-1', origin: 'bookmark', question: 'q', answer: 'a', page: 1, nextDueAt: 0, intervalDays: 1, easeFactor: 2.5, timestamp: 0 }
    case 'study/review-attempted':
      return { cardId: 'card-1', quality: 4, nextDueAt: 0, timestamp: 0 }
    case 'study/dossier-generated':
      return { dossierId: 'dos-1', sourceId: 'src-1', title: 't', content: 'c', stats: { highlightsCount: 0, bookmarksCount: 0, frictionsResolvedCount: 0, socraticQuestionsCount: 0, cardsCount: 0 }, timestamp: 0 }
  }
}

describe('study-reader interface availability', () => {
  it('projects the authoritative six-tool catalog through a browser-safe Remote view', async () => {
    const { ctx } = await setup()
    const catalog = ctx.study.listToolCatalogForClient({ sessionId: 'catalog-session' })
    expect(catalog.map(tool => tool.name)).toEqual([
      'reader_get_context', 'reader_list_documents', 'reader_get_outline', 'reader_search_passages',
      'reader_read_passage', 'reader_save_note',
    ])
    expect(catalog.filter(tool => tool.risk === 'read').every(tool => tool.sideEffects === 'none')).toBe(true)
    expect(catalog.find(tool => tool.name === 'reader_save_note')).toMatchObject({ risk: 'write', sideEffects: 'persistent-note-write' })
    expect(catalog.every(tool => /^[a-f0-9]{64}$/u.test(tool.schemaHash))).toBe(true)
    expect(() => JSON.parse(catalog[0]!.parametersJson)).not.toThrow()
    expect(() => JSON.parse(catalog[0]!.outputJson)).not.toThrow()
  })

  // ── Remote bootstrap + listSources semantics ──────────────────────────────

  it('bootstrap exposes only the bounded library upload policy', async () => {
    const { ctx } = await setup()
    const view = ctx.study.bootstrapForClient()
    expect(view.upload.maxFileBytes).toBe(1024 * 1024)
    expect(view.upload.acceptExtensions).toContain('.pdf')
    expect(view.upload.acceptExtensions).toContain('.png')
    expect(view.defaultLanguage).toBe('ch')
    expect(view).not.toHaveProperty('quickActions')
  })

  it('listSources filters case-insensitively, sorts descending, and omits absent revision fields', async () => {
    const { ctx } = await setup()
    await ctx.study.prepareUploadForClient({ fileName: 'Alpha PDF.pdf', sizeBytes: 4 })
    await ctx.study.prepareUploadForClient({ fileName: 'Beta Book.pdf', sizeBytes: 4 })

    const all = ctx.study.listSources()
    expect(all).toHaveLength(2)
    expect(all[0]!.title).toBe('Beta Book') // descending title
    expect(all[1]!.title).toBe('Alpha PDF')
    for (const source of all) {
      expect(source.revisionId).toBeUndefined()
      expect(source.pageCount).toBeUndefined()
      expect(source.blockCount).toBeUndefined()
    }

    const filtered = ctx.study.listSources('alpha')
    expect(filtered.map(source => source.title)).toEqual(['Alpha PDF'])

    const limited = ctx.study.listSources(undefined, 1)
    expect(limited).toHaveLength(1)
    expect(limited[0]!.title).toBe('Beta Book')
  })

  // ── Failure paths and their machine-routable codes ───────────────────────

  it('routes every service failure through StudyError codes', async () => {
    const { ctx } = await setup()
    const assertCode = (error: unknown, code: string): void => {
      expect(error).toBeInstanceOf(StudyError)
      expect(error).toBeInstanceOf(Error)
      expect((error as StudyError).name).toBe('StudyError')
      expect((error as StudyError).code).toBe(code)
    }

    expect(() => ctx.study.getOutline('src-nope' as SourceId)).toThrowError(
      expect.objectContaining({ code: 'SOURCE_NOT_FOUND' }),
    )

    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'x.pdf', sizeBytes: 4 })
    const sourceId = ctx.study.listSources()[0]!.id
    await ctx.study.read({
      sourceId,
      revisionId: 'rev-nope' as RevisionId,
      range: { kind: 'pages', start: 1, end: 1 },
    }, 1000).catch(error => assertCode(error, 'REVISION_NOT_FOUND'))

    await ctx.study.submitUrlForClient({ url: 'ftp://not-http' }).catch(error => assertCode(error, 'URL_INVALID'))
    await ctx.study.renewUploadForClient({ importId: 'imp-nope' }).catch(error => assertCode(error, 'IMPORT_NOT_FOUND'))
    await ctx.study.publishArgumentGraph({ schemaVersion: 1, title: 'g', nodes: [], edges: [] })
      .catch(error => assertCode(error, 'GRAPH_EMPTY'))
    await ctx.study.publishArgumentGraph({
      schemaVersion: 2,
      title: 'g',
      nodes: [{ id: 'n1', type: 'claim', label: 'l', explanation: 'e', epistemic: 'author-explicit', confidence: 0.5, citations: [] }],
      edges: [],
    }).catch(error => assertCode(error, 'GRAPH_INVALID'))
  })

  it('rejects renewals of URL imports', async () => {
    const { ctx } = await setup()
    const submitted = await ctx.study.submitUrlForClient({ url: 'https://example.com/paper.pdf' })
    await expect(ctx.study.renewUploadForClient({ importId: submitted.importId })).rejects.toMatchObject({
      name: 'StudyError',
      code: 'IMPORT_NOT_UPLOADABLE',
    })
  })

  it('importStatus reports the live view and rejects unknown imports', async () => {
    const { ctx } = await setup()
    // importStatus is a synchronous Remote: the miss throws inline.
    expect(() => ctx.study.importStatusForClient({ importId: 'imp-nope' })).toThrowError(
      expect.objectContaining({ code: 'IMPORT_NOT_FOUND' }),
    )

    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'x.pdf', sizeBytes: 4 })
    const view = ctx.study.importStatusForClient({ importId: prepared.importId })
    expect(view.state).toBe('awaiting-upload')
    expect(view.renewRequired).toBe(false)
  })

  it('rejects a section range that does not exist after a full import', async () => {
    const { ctx, server } = await setup()
    server.mode = { pollSequence: ['done'] }
    const pdf = await pdfFixture()
    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'book.pdf', sizeBytes: pdf.byteLength })
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}${prepared.uploadPath}`, {
      method: 'PUT',
      headers: { 'X-Study-Upload-Token': prepared.uploadToken, 'Content-Length': String(pdf.byteLength) },
      body: Buffer.from(pdf),
    })
    expect(response.status).toBe(200)
    await eventually(() => ctx.study.importStatusForClient({ importId: prepared.importId }).state === 'ready')
    const source = ctx.study.listSources()[0]!
    await expect(ctx.study.read({
      sourceId: source.id,
      revisionId: source.revisionId,
      range: { kind: 'section', sectionId: 'no-such-section' },
    }, 2000)).rejects.toMatchObject({ code: 'SECTION_NOT_FOUND' })
  })

  // ── upload route HTTP mapping ─────────────────────────────────────────────

  it('maps non-PUT and bad-token uploads to 405 and 401', async () => {
    const { ctx } = await setup()
    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'x.pdf', sizeBytes: 4 })
    const url = `http://127.0.0.1:${ctx.webServer.port}${prepared.uploadPath}`

    const get = await fetch(url)
    expect(get.status).toBe(405)
    await expect(get.json()).resolves.toMatchObject({ code: 'METHOD_NOT_ALLOWED' })

    // Prepare again: the first prepare's ticket was never consumed, but a
    // wrong-token PUT consumes the ticket then rejects (single-use).
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'X-Study-Upload-Token': 'deadbeef'.repeat(8), 'Content-Length': '4' },
      body: 'data',
    })
    expect(put.status).toBe(401)
    await expect(put.json()).resolves.toMatchObject({ code: 'UPLOAD_TOKEN_REJECTED' })
  })

  // ── blob store ────────────────────────────────────────────────────────────

  it('content-addresses blobs idempotently and manages scratch files', async () => {
    const { root } = await setup()
    const store = new BlobStore(join(root, 'avail-blobs'))
    const bytes = new TextEncoder().encode('同一份数据')

    const first = await store.putBlob(bytes)
    const second = await store.putBlob(bytes)
    expect(first).toBe(second)
    expect(first).toMatch(/^sha256\/[0-9a-f]{64}$/)
    expect(Buffer.from(await store.readBlob(first)).toString()).toBe('同一份数据')

    const different = await store.putBlob(new TextEncoder().encode('另一份数据'))
    expect(different).not.toBe(first)

    await store.writeTmp('imp-x', 'a.txt', bytes)
    await expect(import('node:fs/promises').then(fs => fs.access(store.tmpPath('imp-x', 'a.txt')))).resolves.toBeUndefined()
    await store.clearTmp('imp-x')
    await expect(import('node:fs/promises').then(fs => fs.access(store.tmpPath('imp-x', 'a.txt')))).rejects.toThrow()
  })

  // ── session-event vocabulary and consumers ────────────────────────────────

  it('declares exactly the 17 domain event types, all unique and prefixed', () => {
    expect(STUDY_EVENT_TYPES).toHaveLength(17)
    expect(new Set(STUDY_EVENT_TYPES).size).toBe(17)
    for (const type of STUDY_EVENT_TYPES) expect(type.startsWith('study/')).toBe(true)
    expect(isStudyEventType('study/highlight')).toBe(true)
    expect(isStudyEventType('other/event')).toBe(false)
  })

  it('the reducer consumes every event', () => {
    const progressed: Array<keyof SessionEventMap> = [
      'study/source-imported',
      'study/highlight',
      'study/bookmark',
      'study/feynman-requested',
      'study/toulmin-requested',
      'study/calibration',
      'study/cognitive-requested',
      'study/cognitive-enqueued',
      'study/cognitive-context-prepared',
      'study/cognitive-probe-generated',
      'study/cognitive-option-selected',
      'study/socratic-generated',
      'study/socratic-response',
      'study/friction',
      'study/review-card-generated',
      'study/review-attempted',
      'study/dossier-generated',
    ]
    const base = emptyStudyState()
    let state = base
    for (const type of progressed) {
      const next = apply(type, sample(type) as never, state)
      expect(next).not.toBe(state)
      expect(next).not.toBe(base)
      state = next
    }
  })

  it('the reducer folds every event type into the study state', () => {
    let state = emptyStudyState()
    state = apply('study/source-imported', sample('study/source-imported') as never, state)
    expect(state.currentSourceId).toBe('src-1')

    state = apply('study/highlight', sample('study/highlight') as never, state)
    expect(state.highlights).toHaveLength(1)

    state = apply('study/bookmark', sample('study/bookmark') as never, state)
    expect(state.bookmarks).toHaveLength(1)

    state = apply('study/feynman-requested', sample('study/feynman-requested') as never, state)
    expect(state.activeRequests['req-1']?.feynman?.intuitiveAnalogy).toBe('e')

    state = apply('study/toulmin-requested', sample('study/toulmin-requested') as never, state)
    expect(state.activeRequests['req-1']?.toulmin?.claim).toBe('c')

    state = apply('study/calibration', sample('study/calibration') as never, state)
    expect(state.activeRequests['req-1']?.calibrations?.['post-explanation']?.rating).toBe('clear')

    state = apply('study/cognitive-requested', sample('study/cognitive-requested') as never, state)
    state = apply('study/cognitive-probe-generated', sample('study/cognitive-probe-generated') as never, state)
    state = apply('study/cognitive-option-selected', sample('study/cognitive-option-selected') as never, state)
    expect(state.activeRequests['req-1']?.probe?.model).toBe('m')
    expect(state.activeRequests['req-1']?.selectedOptionId).toBe('A')

    state = apply('study/socratic-response', sample('study/socratic-response') as never, state)
    expect(state.activeRequests['req-1']?.socratic?.questionId).toBe('q')

    state = apply('study/friction', sample('study/friction') as never, state)
    expect(state.frictions).toHaveLength(1)
    expect(state.frictions[0]?.resolved).toBe(false)

    state = apply('study/review-card-generated', sample('study/review-card-generated') as never, state)
    expect(state.reviewCards).toHaveLength(1)

    state = apply('study/review-attempted', sample('study/review-attempted') as never, state)
    expect(state.reviewCards[0]?.repetitions).toBe(1)
    expect(state.reviewCards[0]?.nextDueAt).toBe(24 * 60 * 60 * 1000)

    state = apply('study/dossier-generated', sample('study/dossier-generated') as never, state)
    expect(state.dossiers).toHaveLength(1)
  })

  it('SM-2 scheduling and card creation behave per contract', () => {
    const card = createCardFromFriction('src-1' as SourceId, 3, 'topic', 'q', 'a', 1_000_000)
    expect(card.origin).toBe('friction')
    expect(card.id).toMatch(/^card_/)
    expect(card.nextDueAt).toBe(1_000_000 + 24 * 60 * 60 * 1000)

    const first = scheduleNextReview(card, 4, 2_000_000)
    expect(first.intervalDays).toBe(1)
    expect(first.repetitions).toBe(1)

    const second = scheduleNextReview({ ...card, ...first }, 4, 3_000_000)
    expect(second.intervalDays).toBe(6)
    expect(second.repetitions).toBe(2)

    const reset = scheduleNextReview({ ...card, ...second }, 2 as ReviewQuality, 4_000_000)
    expect(reset.repetitions).toBe(0)
    expect(reset.intervalDays).toBe(1)

    const bookmarkCard = createCardFromBookmark('src-1' as SourceId, 5, 'q', 'a')
    expect(bookmarkCard.origin).toBe('bookmark')
  })

  it('synthesizeDossier folds folded state into a structured report', () => {
    const withToulmin = apply('study/toulmin-requested', sample('study/toulmin-requested') as never)
    const withFriction = apply('study/friction', sample('study/friction') as never, withToulmin)
    const dossier = synthesizeDossier('《测试》', withFriction, 1_000_000)
    expect(dossier.title).toBe('《测试》 - 研读复盘手记')
    expect(dossier.content).toContain('深度研读复盘手记')
    expect(dossier.content).toContain('论证结构')
    expect(dossier.content).toContain('认知卡点与突破')
    expect(dossier.id).toMatch(/^dossier_/)
  })

  it('reads a bounded window through the Remote read surface', async () => {
    const { ctx, server } = await setup()
    server.mode = { pollSequence: ['done'] }
    const pdf = await pdfFixture()
    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'book.pdf', sizeBytes: pdf.byteLength })
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}${prepared.uploadPath}`, {
      method: 'PUT',
      headers: { 'X-Study-Upload-Token': prepared.uploadToken, 'Content-Length': String(pdf.byteLength) },
      body: Buffer.from(pdf),
    })
    expect(response.status).toBe(200)
    await eventually(() => ctx.study.importStatusForClient({ importId: prepared.importId }).state === 'ready')
    const source = ctx.study.listSources()[0]!
    const result = await ctx.study.readForClient({
      sourceId: source.id,
      revisionId: source.revisionId,
      range: { kind: 'pages', start: 1, end: 1 },
    })
    expect(result.truncated).toBe(false)
    expect(result.blocks.length).toBeGreaterThan(0)
    const block: StudyBlock = result.blocks[0]!
    expect(block.page).toBe(1)
    expect(block.id).toBeDefined()
    expect(Array.isArray(block.headingPath)).toBe(true)
  })

  // ── durable study events (browser mirror + replay) ───────────────────────

  it('emitStudyEvent rejects non-study types and empty sessions', async () => {
    const { ctx } = await setup()
    await expect(ctx.study.emitStudyEventForClient({ sessionId: 's1', type: 'other/event', data: {} }))
      .rejects.toMatchObject({ name: 'StudyError', code: 'EVENT_TYPE_REJECTED' })
    await expect(ctx.study.emitStudyEventForClient({ sessionId: '', type: 'study/highlight', data: sample('study/highlight') }))
      .rejects.toMatchObject({ name: 'StudyError', code: 'EVENT_SESSION_REQUIRED' })
  })

  it('rejects browser attempts to forge Host or Agent-owned study events', async () => {
    const { ctx } = await setup()
    await expect(ctx.study.emitStudyEventForClient({
      sessionId: 's1',
      type: 'study/cognitive-probe-generated',
      data: sample('study/cognitive-probe-generated'),
    } as never)).rejects.toMatchObject({ name: 'StudyError', code: 'EVENT_TYPE_REJECTED' })
  })

  it('does not duplicate evidence tool execution into the Host-owned Study Event table', async () => {
    const harness = await setup()
    const source = await readySource(harness, ['s1'])
    await harness.ctx.study.setSessionSourceSelectionForClient({ sessionId:'s1', sourceId:source.id, revisionId:source.revisionId, expectedVersion:0, commandId:'evidence-select' })
    const before = durableEvents(harness, 's1')
    await harness.agents.runAs('s1', () => harness.ctx.study.searchForCurrentInitiator({ sourceId:source.id, revisionId:source.revisionId, query:'page', limit:2 }))
    await expect(harness.agents.runAs('s1', () => harness.ctx.study.searchForCurrentInitiator({ sourceId:source.id, revisionId:source.revisionId, query:'', limit:2 }))).rejects.toMatchObject({ code:'SEARCH_QUERY_INVALID' })
    await expect(harness.agents.runAs('s2', () => harness.ctx.study.searchForCurrentInitiator({ sourceId:source.id, revisionId:source.revisionId, query:'page', limit:2 }))).rejects.toMatchObject({ code:'SOURCE_ACCESS_DENIED' })
    expect(durableEvents(harness, 's1')).toEqual(before)
    expect(durableEvents(harness, 's2')).toEqual([])
  })

  it('maps a typed browser command to its Host-owned event and rejects an unknown command', async () => {
    const harness = await setup()
    const source = await readySource(harness, ['s1'])
    const block = (await harness.ctx.study.read({
      sourceId: source.id, revisionId: source.revisionId, range: { kind: 'pages', start: 1, end: 1 },
    }, 10_000)).blocks[0]!
    const result = await harness.ctx.study.executeStudyCommandForClient({
      sessionId: 's1', commandId: 'command-highlight-1',
      command: {
        kind: 'add-highlight',
        data: {
          sourceId: source.id, revisionId: source.revisionId!, page: block.page,
          blockIds: [block.id], selectedText: block.text, color: 'yellow', timestamp: 1,
        },
      },
    })
    expect(result.seq).toBe(1)
    expect(durableEvents(harness, 's1').at(-1)).toMatchObject({
      type: 'study/highlight', clientEventId: 'command-highlight-1',
    })
    await expect(harness.ctx.study.executeStudyCommandForClient({
      sessionId: 's1', commandId: 'command-invalid', command: { kind: 'forge-result', data: {} },
    } as never)).rejects.toMatchObject({ name: 'StudyError', code: 'EVENT_TYPE_REJECTED' })
  })

  it('rejects cross-source revisions and blocks outside an immutable anchor', async () => {
    const harness = await setup()
    const first = await readySource(harness, ['s1'])
    await readySource(harness, ['s1'])
    const second = harness.ctx.study.listSources().find(source => source.id !== first.id)!
    await expect(harness.ctx.study.readForClient({
      sessionId: 's1',
      sourceId: first.id,
      revisionId: second.revisionId,
      range: { kind: 'pages', start: 1, end: 1 },
    })).rejects.toMatchObject({ code: 'REVISION_SOURCE_MISMATCH' })
    await expect(harness.ctx.study.startCognitiveForClient({
      sessionId: 's1',
      requestId: 'bad-anchor',
      sourceId: first.id,
      revisionId: first.revisionId!,
      page: 1,
      blockIds: ['missing-block'],
      selectedText: 'not in the revision',
      kind: 'passage',
      lens: 'feynman',
      intent: 'concept',
    })).rejects.toMatchObject({ code: 'COGNITIVE_ANCHOR_INVALID' })
  })

  it('emitStudyEvent assigns monotonic per-session seqs in the Host-owned event store', async () => {
    const harness = await setup()
    const { ctx } = harness
    const source = await readySource(harness, ['s1', 's2'])
    const read = await ctx.study.read({
      sourceId: source.id,
      revisionId: source.revisionId,
      range: { kind: 'pages', start: 1, end: 1 },
    }, 10_000)
    const block = read.blocks[0]!
    const anchor = {
      sourceId: source.id,
      revisionId: source.revisionId!,
      page: block.page,
      blockIds: [block.id],
      selectedText: block.text,
      timestamp: Date.now(),
    }
    const first = await ctx.study.emitStudyEventForClient({ sessionId: 's1', type: 'study/highlight', data: anchor })
    expect(first.seq).toBe(1)
    const second = await ctx.study.emitStudyEventForClient({ sessionId: 's1', type: 'study/bookmark', data: anchor })
    expect(second.seq).toBe(2)
    // A different session starts its own sequence.
    const other = await ctx.study.emitStudyEventForClient({ sessionId: 's2', type: 'study/highlight', data: anchor })
    expect(other.seq).toBe(1)

    const replayed = durableEvents(harness, 's1')
    expect(replayed.map(record => record.type)).toEqual(['study/source-imported', 'study/highlight', 'study/bookmark', 'study/review-card-generated'])
    expect(replayed.map(record => record.seq)).toEqual([0, 1, 2, 3])
    expect(durableEvents(harness, 's2')).toHaveLength(2)
    expect(durableEvents(harness, 's3')).toHaveLength(0)
  })

  it('starts an idempotent Agent cognitive turn and records its exact model-selected completion', async () => {
    const harness = await setup()
    const source = await readySource(harness, ['s1'])
    const read = await harness.ctx.study.read({
      sourceId: source.id,
      revisionId: source.revisionId,
      range: { kind: 'pages', start: 1, end: 1 },
    }, 10_000)
    const block = read.blocks[0]!
    const request = {
      sessionId: 's1',
      requestId: 'req-agent-1',
      sourceId: source.id,
      revisionId: source.revisionId!,
      page: block.page,
      blockIds: [block.id],
      selectedText: block.text,
      kind: 'passage' as const,
      lens: 'feynman' as const,
      intent: 'concept' as const,
    }
    await harness.ctx.study.startCognitiveForClient(request)
    await harness.ctx.study.startCognitiveForClient(request)
    expect(harness.agents.followups.get('s1')).toHaveLength(1)
    expect(harness.agents.followups.get('s1')?.[0]?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('study_submit_cognitive_probe'),
    })

    const analyzeCallId = CallId('analyze-1')
    const submitCallId = CallId('submit-1')
    harness.agents.recordToolCall('s1', analyzeCallId, 1)
    const prepared = await harness.agents.runAs('s1', async () =>
      await harness.ctx.study.prepareCognitiveContextForCurrentInitiator({
        requestId: request.requestId,
        sourceId: source.id,
        revisionId: source.revisionId!,
        page: block.page,
        blockIds: [block.id],
        selectedText: block.text,
        mode: 'feynman',
        toolCallId: analyzeCallId,
      }))
    harness.agents.recordToolCall('s1', submitCallId, 1)
    await expect(harness.agents.runAs('s1', async () =>
      await harness.ctx.study.completeCognitiveProbeForCurrentInitiator({
        requestId: request.requestId,
        analysisReceipt: prepared.analysisReceipt,
        question: '这段最准确的解释是什么？',
        purpose: '区分概念模型',
        options: (['A', 'B', 'C', 'D', 'E', 'F'] as const).map((id, index) => ({
          id, text: id, diagnosis: id, feedback: id, best: index === 0,
        })),
        hint: '查看作者使用的定义。',
        synthesis: 'A 保留了原文的必要限定。',
        explanation: '不应在第一次选择前展示的讲解。',
        citations: [{ page: block.page, blockId: block.id, quote: block.text }],
      }, submitCallId))).rejects.toMatchObject({ code: 'COGNITIVE_PROBE_INVALID' })
    const completed = await harness.agents.runAs('s1', async () =>
      await harness.ctx.study.completeCognitiveProbeForCurrentInitiator({
        requestId: request.requestId,
        analysisReceipt: prepared.analysisReceipt,
        question: '这段最准确的解释是什么？',
        purpose: '区分概念模型',
        options: (['A', 'B', 'C', 'D', 'E', 'F'] as const).map((id, index) => ({
          id, text: id, diagnosis: id, feedback: id, best: index === 0,
        })),
        hint: '查看作者使用的定义。',
        synthesis: 'A 保留了原文的必要限定。',
        citations: [{ page: block.page, blockId: block.id, quote: block.text }],
      }, submitCallId))
    expect(completed).toMatchObject({ provider: 'selected-provider', model: 'selected-model' })
    const retried = await harness.agents.runAs('s1', async () =>
      await harness.ctx.study.completeCognitiveProbeForCurrentInitiator({
        requestId: request.requestId,
        analysisReceipt: prepared.analysisReceipt,
        question: 'ignored after durable completion',
        purpose: 'ignored',
        options: [],
        hint: '',
        synthesis: '',
        citations: [],
      }, CallId('retry-call')))
    expect(retried).toEqual(completed)
    const event = durableEvents(harness, 's1').at(-1)!
    expect(event.type).toBe('study/cognitive-probe-generated')
    expect(event.data).toMatchObject({ requestId: 'req-agent-1', provider: 'selected-provider', model: 'selected-model' })
    expect(event.data).not.toHaveProperty('explanation')
    expect(event.data).not.toHaveProperty('challenge')
  })

  it('generateDossier folds the session events into a persisted dossier and records the event', async () => {
    const harness = await setup()
    const { ctx } = harness
    const source = await readySource(harness, ['s1'])
    const read = await ctx.study.read({ sourceId: source.id, revisionId: source.revisionId, range: { kind: 'pages', start: 1, end: 1 } }, 10_000)
    const block = read.blocks[0]!
    await ctx.study.emitStudyEventForClient({
      sessionId: 's1',
      type: 'study/bookmark',
      data: {
        sourceId: source.id,
        revisionId: source.revisionId!,
        page: block.page,
        blockIds: [block.id],
        selectedText: block.text,
        timestamp: Date.now(),
      },
    })

    const result = await ctx.study.generateDossierForClient({ sessionId: 's1', sourceId: source.id, title: '《测试》' })
    expect(result.dossierId).toMatch(/^dossier_/)
    expect(result.markdown).toContain('深度研读复盘手记')
    expect(result.sectionCount).toBeGreaterThan(0)

    // The dossier-generation event is itself durable and replayable.
    const events = durableEvents(harness, 's1')
    expect(events.at(-1)!.type).toBe('study/dossier-generated')
    expect((events.at(-1)!.data as { dossierId: string }).dossierId).toBe(result.dossierId)
  })

  it('publishDossier (agent side) persists a dossier and writes the event under the session', async () => {
    const harness = await setup()
    const { ctx } = harness
    const source = await readySource(harness, ['s-agent'])
    const outcome = await ctx.study.publishDossier({
      sessionId: 's-agent',
      sourceId: source.id,
      title: '《Agent 手记》',
      content: '# 复盘\n\n内容',
      stats: { highlightsCount: 0, bookmarksCount: 1, frictionsResolvedCount: 0, socraticQuestionsCount: 0, cardsCount: 2 },
    })
    expect(outcome.dossierId).toMatch(/^dossier_/)
    expect(outcome.eventSeq).toBe(1)
    const events = durableEvents(harness, 's-agent')
    expect(events).toHaveLength(2)
    expect(events[1]!.type).toBe('study/dossier-generated')
    // Without any session (no initiator, no explicit id) the write fails loud.
    await expect(ctx.study.publishDossier({
      sourceId: source.id,
      title: 't',
      content: 'c',
      stats: { highlightsCount: 0, bookmarksCount: 0, frictionsResolvedCount: 0, socraticQuestionsCount: 0, cardsCount: 0 },
    })).rejects.toMatchObject({ name: 'StudyError', code: 'EVENT_SESSION_REQUIRED' })
  })
})
