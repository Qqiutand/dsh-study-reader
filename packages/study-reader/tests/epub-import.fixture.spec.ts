/**
 * Deterministic EPUB fixture and full local-import composition regression.
 * This reaches the browser upload route; it never calls the EPUB parser alone.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yauzl from 'yauzl'
import { buildMinimalEpub } from '../fixtures/build-minimal-epub.mjs'
import { EPUB_MIMETYPE, minimalEpubEntries } from '../fixtures/minimal-epub-source.mjs'
import type { DocumentExtractorProvider } from '../src/extraction/index.ts'
import type { RevisionId, RevisionRecord, StudyBlock } from '../src/study/types.ts'
import { disposeHarnesses, eventually, eventuallyImportState, setupStudy, type StudyHarness } from './helpers.ts'

interface ZipEntryInfo {
  readonly name: string
  readonly compressionMethod: number
}

const fixtureRoots: string[] = []

async function fixturePath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-study-epub-fixture-'))
  fixtureRoots.push(root)
  const path = join(root, name)
  await buildMinimalEpub(path)
  return path
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function zipEntries(path: string): Promise<readonly ZipEntryInfo[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, archive) => {
      if (error !== null || archive === undefined) {
        reject(error ?? new Error('cannot open EPUB fixture'))
        return
      }
      const entries: ZipEntryInfo[] = []
      archive.on('entry', entry => {
        entries.push({ name: entry.fileName, compressionMethod: entry.compressionMethod })
        archive.readEntry()
      })
      archive.once('error', reject)
      archive.once('end', () => { archive.close(); resolve(entries) })
      archive.readEntry()
    })
  })
}

function zipEntryText(path: string, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, archive) => {
      if (error !== null || archive === undefined) {
        reject(error ?? new Error('cannot open EPUB fixture'))
        return
      }
      archive.on('entry', entry => {
        if (entry.fileName !== name) {
          archive.readEntry()
          return
        }
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            reject(streamError ?? new Error(`cannot read ${name}`))
            return
          }
          const chunks: Buffer[] = []
          stream.on('data', chunk => chunks.push(chunk as Buffer))
          stream.once('error', reject)
          stream.once('end', () => { archive.close(); resolve(Buffer.concat(chunks).toString('utf8')) })
        })
      })
      archive.once('error', reject)
      archive.readEntry()
    })
  })
}

function strictExtractor(calls: string[]): DocumentExtractorProvider {
  const forbidden = (name: string): never => {
    calls.push(name)
    throw new Error(`EPUB local import called forbidden extractor operation: ${name}`)
  }
  return {
    id: 'mineru' as DocumentExtractorProvider['id'],
    kind: 'mineru',
    health: async () => forbidden('health'),
    submit: async () => forbidden('submit'),
    prepareUpload: async () => forbidden('prepareUpload'),
    submitUrl: async () => forbidden('submitUrl'),
    poll: async () => forbidden('poll'),
    cancel: async () => forbidden('cancel'),
    collect: async () => forbidden('collect'),
    normalizeArtifacts: async () => forbidden('normalizeArtifacts'),
  }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await disposeHarnesses()
  await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('deterministic real EPUB fixture', () => {
  it('builds identical bytes and keeps the EPUB mimetype as the first STORE entry', async () => {
    const first = await fixturePath('first.epub')
    const second = await fixturePath('second.epub')
    const [firstBytes, secondBytes, entries] = await Promise.all([readFile(first), readFile(second), zipEntries(first)])

    expect(sha256(firstBytes)).toBe(sha256(secondBytes))
    expect(entries.map(entry => entry.name)).toEqual(minimalEpubEntries().map(entry => entry.name))
    expect(entries[0]).toEqual({ name: 'mimetype', compressionMethod: 0 })
    expect((await readFile(first)).subarray(38, 38 + EPUB_MIMETYPE.length).toString('utf8')).toBe(EPUB_MIMETYPE)
  })

  it('contains the declared OPF manifest, spine, navigation, and unique metadata', async () => {
    const path = await fixturePath('manifest.epub')
    const entries = await zipEntries(path)
    expect(entries.map(entry => entry.name)).toEqual(expect.arrayContaining([
      'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml',
      'OEBPS/text/chapter-1.xhtml', 'OEBPS/text/chapter-2.xhtml',
    ]))
    const opf = await zipEntryText(path, 'OEBPS/content.opf')
    expect(opf).toContain('urn:uuid:3f3ae3fe-65ac-4c82-a64d-c0632632d7e1')
    expect(opf).toContain('<item id="chapter-one"')
    expect(opf).toContain('<item id="chapter-two"')
    expect(opf).toContain('<spine><itemref idref="chapter-one"/><itemref idref="chapter-two"/></spine>')
  })
})

describe('real EPUB upload import', () => {
  it('reaches ready locally with native locators, searchable blocks, original asset, and no MinerU activity', async () => {
    const harness: StudyHarness = await setupStudy()
    const { ctx, credentials, server } = harness
    const calls: string[] = []
    const unregister = ctx.documentExtraction.registerProvider(strictExtractor(calls))
    const credentialResolve = vi.spyOn(credentials, 'resolve').mockImplementation(async () => {
      throw new Error('EPUB local import must not resolve MinerU credentials')
    })
    const nativeFetch = globalThis.fetch
    let forbiddenFetches = 0
    const localOrigin = `http://127.0.0.1:${ctx.webServer.port}`
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.origin !== localOrigin) {
        forbiddenFetches += 1
        throw new Error(`EPUB local import attempted remote fetch: ${url.origin}`)
      }
      return await nativeFetch(input, init)
    })

    const path = await fixturePath('import.epub')
    const fixture = await readFile(path)
    const prepared = await ctx.study.prepareUploadForClient({
      fileName: 'local-import-primer.epub', sizeBytes: fixture.byteLength, sessionId: 'epub-session',
    })
    const upload = await fetch(`${localOrigin}${prepared.uploadPath}`, {
      method: 'PUT',
      headers: { 'X-Study-Upload-Token': prepared.uploadToken, 'Content-Length': String(fixture.byteLength) },
      body: fixture,
    })
    expect(upload.status).toBe(200)
    await eventuallyImportState(harness, prepared.importId, 'ready', 4000)

    const status = ctx.study.importStatusForClient({ importId: prepared.importId })
    const source = ctx.study.listSourcesForClient({ scope: 'library' }).find(value => value.id === status.sourceId)
    expect(status.state).toBe('ready')
    expect(source).toMatchObject({ format: 'epub', pageCount: 2, sectionCount: 2 })
    expect(source?.revisionId).toBeDefined()
    // Browser preview is independent from Agent access: revoke the automatic
    // import grant before opening the book, then grant it again for Agent search.
    await ctx.study.setSourceAccessForClient({ sessionId: 'epub-session', sourceId: source!.id, granted: false })
    const revision = ctx.studyBlobLifecycle.domain.table('revisions').get(source!.revisionId as RevisionId) as RevisionRecord
    expect(revision).toMatchObject({
      format: 'epub', providerId: 'epub-local', providerKind: 'epub', providerModel: 'epub-local-v1', spineCount: 2,
      originalBlob: `sha256/${sha256(fixture)}`,
    })
    expect(revision.outline.map(item => item.title)).toEqual(expect.arrayContaining([
      '第一章：起点 / Beginnings', '第二章：验证 / Verification',
    ]))
    expect(await ctx.studyBlobLifecycle.blobs.hasBlob(revision.markdownBlob as `sha256/${string}`)).toBe(true)
    expect(await ctx.studyBlobLifecycle.blobs.hasBlob(revision.blocksBlob as `sha256/${string}`)).toBe(true)
    expect(await ctx.studyBlobLifecycle.blobs.hasBlob(revision.originalBlob as `sha256/${string}`)).toBe(true)
    expect(revision.assetBlobs).toHaveLength(1)
    expect(await ctx.studyBlobLifecycle.blobs.hasBlob(revision.assetBlobs![0] as `sha256/${string}`)).toBe(true)

    const blocks = Buffer.from(await ctx.studyBlobLifecycle.blobs.readBlob(revision.blocksBlob as `sha256/${string}`))
      .toString('utf8').trim().split('\n').map(line => JSON.parse(line) as StudyBlock)
    expect(blocks.map(block => block.page)).toEqual([...blocks.map(block => block.page)].sort((left, right) => left - right))
    expect(blocks.some(block => block.text.includes('这是第一段中文正文'))).toBe(true)
    expect(blocks.some(block => block.text.includes('the lantern protocol preserves chapter order.'))).toBe(true)
    expect(blocks.some(block => block.type === 'equation' && block.text.includes('E=mc2'))).toBe(true)
    expect(blocks.some(block => block.type === 'image' && block.text === '红色测试图示' && block.assetPath === revision.assetBlobs?.[0])).toBe(true)
    expect(blocks.some(block => block.text.includes('脚注一：内部锚点'))).toBe(true)
    for (const block of blocks.filter(block => ['title', 'paragraph', 'equation'].includes(block.type))) {
      expect(block.sourceLocator).toMatchObject({ kind: 'epub-xhtml' })
      const locator = block.sourceLocator as Extract<StudyBlock['sourceLocator'], { kind: 'epub-xhtml' }>
      expect(locator.href).toMatch(/^text\/chapter-[12]\.xhtml$/)
      expect(locator.spineIndex).toBe(block.page - 1)
      expect(locator.startOffset).toBeGreaterThanOrEqual(0)
      expect(locator.endOffset).toBeGreaterThan(locator.startOffset)
    }
    expect(source?.revisionId).toBe(revision.id)

    const firstPreview = await ctx.study.getSourcePreviewForClient({ sessionId: 'epub-session', sourceId: source!.id, revisionId: revision.id })
    expect(firstPreview.kind).toBe('epub')
    if (firstPreview.kind !== 'epub') throw new Error('expected EPUB preview')
    expect(firstPreview.sections).toHaveLength(2)
    expect(firstPreview.sections.map(section => section.title)).toEqual(['第一章：起点 / Beginnings', '第二章：验证 / Verification'])
    expect(firstPreview.sections.map(section => section.spineIndex)).toEqual([0, 1])
    expect(firstPreview.blocks.some(block => block.text.includes('这是第一段中文正文'))).toBe(true)
    const secondPreview = await ctx.study.getSourcePreviewForClient({ sessionId: 'epub-session', sourceId: source!.id, revisionId: revision.id, sectionId: firstPreview.sections[1]!.id })
    expect(secondPreview.kind === 'epub' && secondPreview.blocks.some(block => block.text.includes('the lantern protocol preserves chapter order.'))).toBe(true)

    const original = await fetch(`${localOrigin}/study-reader/assets/${source!.id}/${revision.id}/original`)
    expect(original.status).toBe(200)
    expect(Buffer.from(await original.arrayBuffer())).toEqual(fixture)
    await ctx.study.setSourceAccessForClient({ sessionId: 'epub-session', sourceId: source!.id, granted: true })
    const found = await ctx.agents.runAs('epub-session', () => ctx.study.search({
      sourceId: source!.id, revisionId: revision.id, query: 'the lantern protocol preserves chapter order', limit: 10,
    }))
    expect(found.blocks.some(block => block.page === 2 && block.text.includes('the lantern protocol preserves chapter order.'))).toBe(true)
    expect(calls).toEqual([])
    expect(credentialResolve).not.toHaveBeenCalled()
    expect(forbiddenFetches).toBe(0)
    expect(server.lastBatchId).toBeUndefined()
    expect(server.uploadCount).toBe(0)
    expect((await stat(path)).size).toBe(fixture.byteLength)
    unregister()
  })
})
