/** Standalone, isolated command-line probe for a real EPUB upload import. */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { RevisionId, RevisionRecord, StudyBlock } from '../src/study/types.ts'
import { disposeHarnesses, eventuallyImportState, setupStudy } from './helpers.ts'

const path = process.env.STUDY_IMPORT_PROBE_PATH

afterEach(async () => { await disposeHarnesses() })

describe.runIf(path !== undefined)('isolated EPUB import probe', () => {
  it('records the complete local-import result', async () => {
    const fixture = await readFile(path!)
    const harness = await setupStudy()
    const { ctx, server } = harness
    const origin = `http://127.0.0.1:${ctx.webServer.port}`
    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'epub-import-probe.epub', sizeBytes: fixture.byteLength, sessionId: 'epub-probe' })
    const upload = await fetch(`${origin}${prepared.uploadPath}`, {
      method: 'PUT', headers: { 'X-Study-Upload-Token': prepared.uploadToken, 'Content-Length': String(fixture.byteLength) }, body: fixture,
    })
    expect(upload.status).toBe(200)
    await eventuallyImportState(harness, prepared.importId, 'ready')
    const status = ctx.study.importStatusForClient({ importId: prepared.importId })
    const source = ctx.study.listSourcesForClient({ scope: 'library' }).find(item => item.id === status.sourceId)!
    const revision = ctx.studyBlobLifecycle.domain.table('revisions').get(source.revisionId as RevisionId) as RevisionRecord
    const blocks = Buffer.from(await ctx.studyBlobLifecycle.blobs.readBlob(revision.blocksBlob as `sha256/${string}`)).toString('utf8').trim().split('\n').map(line => JSON.parse(line) as StudyBlock)
    const result = {
      fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
      sizeBytes: (await stat(path!)).size,
      importId: prepared.importId,
      sourceId: source.id,
      revisionId: revision.id,
      spineCount: revision.spineCount,
      blockCount: revision.blockCount,
      outline: revision.outline.map(item => item.title),
      state: status.state,
      provider: revision.providerId,
      originalBlob: revision.originalBlob,
      mineruRequests: server.uploadCount,
      nativeLocatorBlocks: blocks.filter(block => block.sourceLocator?.kind === 'epub-xhtml').length,
    }
    expect(result).toMatchObject({ state: 'ready', spineCount: 2, provider: 'epub-local', mineruRequests: 0 })
    console.log(`EPUB_IMPORT_PROBE ${JSON.stringify(result)}`)
  })
})
