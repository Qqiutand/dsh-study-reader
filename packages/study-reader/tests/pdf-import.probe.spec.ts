/** Isolated Fake-Provider PDF probe: always uses a fresh Harness storage root and random port. */

import { afterEach, describe, expect, it } from 'vitest'
import yauzl from 'yauzl'
import { disposeHarnesses, eventuallyImportState, pdfFixture, setupStudy } from './helpers.ts'

function zipEntryNames(bytes: Buffer): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error != null || zip === undefined) return reject(error ?? new Error('ZIP did not open'))
      const names: string[] = []
      zip.on('error', reject)
      zip.on('entry', entry => { names.push(entry.fileName); zip.readEntry() })
      zip.on('end', () => resolve(names))
      zip.readEntry()
    })
  })
}

afterEach(async () => { await disposeHarnesses() })

describe('isolated Fake PDF import probe', () => {
  it('records the complete public import result', async () => {
    const harness = await setupStudy()
    const { ctx, server } = harness
    server.mode = { pollSequence: ['pending', 'running', 'converting', 'done'] }
    const pdf = await pdfFixture(3)
    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'isolated-probe.pdf', sizeBytes: pdf.byteLength })
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}${prepared.uploadPath}`, {
      method: 'PUT', headers: { 'X-Study-Upload-Token': prepared.uploadToken, 'Content-Length': String(pdf.byteLength) }, body: Buffer.from(pdf),
    })
    expect(response.status).toBe(200)
    await eventuallyImportState(harness, prepared.importId, 'ready')
    const status = ctx.study.importStatusForClient({ importId: prepared.importId })
    const source = ctx.study.listSourcesForClient({ scope: 'library' }).find(value => value.id === status.sourceId)
    console.log(`PDF_IMPORT_PROBE ${JSON.stringify({ importId: prepared.importId, sourceId: status.sourceId, revisionId: source?.revisionId, state: status.state, providerRequests: server.uploadCount })}`)
    expect(source?.revisionId).toBeDefined()

    const exportResponse = await fetch(`http://127.0.0.1:${ctx.webServer.port}/study-reader/assets/${source!.id}/${source!.revisionId}/mineru-export`)
    expect(exportResponse.status).toBe(200)
    expect(exportResponse.headers.get('content-type')).toBe('application/zip')
    expect(exportResponse.headers.get('content-disposition')).toContain('mineru.zip')
    const entries = await zipEntryNames(Buffer.from(await exportResponse.arrayBuffer()))
    expect(entries).toEqual(expect.arrayContaining(['document.md', 'blocks.jsonl', 'manifest.json']))
  })
})
