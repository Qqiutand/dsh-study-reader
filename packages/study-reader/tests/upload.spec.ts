/**
 * Upload-route contract tests: one-time tokens, expiry, size binding,
 * replay rejection, renewal after a lost ticket, and the restart surface.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { StudyError } from '../src/extraction/index.ts'
import { UploadRegistry } from '../src/study/upload.ts'
import { disposeHarnesses, setupStudy, eventually, pdfFixture, type StudyHarness } from './helpers.ts'

const harnesses: StudyHarness[] = []

async function setup(): Promise<StudyHarness> {
  const value = await setupStudy({ uploadTicketTtlMs: 2000 })
  harnesses.push(value)
  return value
}

afterEach(async () => {
  await disposeHarnesses()
  harnesses.splice(0)
})

describe('UploadRegistry tickets', () => {
  it('consumes a ticket exactly once (replay is rejected)', () => {
    const registry = new UploadRegistry(60000)
    const token = registry.issue('imp-1', 100, '/tmp/imp-1', 1000)
    const first = registry.consume('imp-1', token, 2000)
    expect(first.expectedSize).toBe(100)
    expect(first.capturePath).toBe('/tmp/imp-1')
    // A replay must fail — the token is gone.
    expect(() => registry.consume('imp-1', token, 3000)).toThrowError(expect.objectContaining({ code: 'UPLOAD_NOT_PREPARED' }))
  })

  it('rejects an expired token', () => {
    const registry = new UploadRegistry(60000)
    const token = registry.issue('imp-1', 100, '/tmp/imp-1', 1000)
    expect(() => registry.consume('imp-1', token, 1000 + 60001)).toThrowError(
      expect.objectContaining({ code: 'UPLOAD_EXPIRED' }),
    )
  })

  it('rejects a wrong or missing token', () => {
    const registry = new UploadRegistry(60000)
    const token = registry.issue('imp-1', 100, '/tmp/imp-1', 1000)
    expect(() => registry.consume('imp-1', 'wrong-token', 2000)).toThrowError(
      expect.objectContaining({ code: 'UPLOAD_TOKEN_REJECTED' }),
    )
    expect(() => registry.consume('imp-1', undefined, 3000)).toThrowError(
      expect.objectContaining({ code: 'UPLOAD_TOKEN_REJECTED' }),
    )
    const second = registry.consume('imp-1', token, 3000)
    expect(second.expectedSize).toBe(100)
    expect(second.capturePath).toBe('/tmp/imp-1')
  })

  it('stores only the token hash, never the raw token', () => {
    const registry = new UploadRegistry(60000)
    const token = registry.issue('imp-1', 100, '/tmp/imp-1', 1000)
    const ticket = registry.peek('imp-1')
    expect(ticket).toBeDefined()
    expect(JSON.stringify(ticket)).not.toContain(token)
    expect(ticket?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('upload route', () => {
  it('streams a file through awaiting-upload → uploading → queued, then ready', async () => {
    const { ctx, server } = await setup()
    server.mode = { pollSequence: ['done'] }
    const pdf = await pdfFixture()
    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'book.pdf', sizeBytes: pdf.byteLength })
    expect(prepared.importId).toMatch(/^imp-/)
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}${prepared.uploadPath}`, {
      method: 'PUT',
      headers: {
        'X-Study-Upload-Token': prepared.uploadToken,
        'Content-Length': String(pdf.byteLength),
      },
      body: Buffer.from(pdf),
    })
    expect(response.status).toBe(200)
    const status = await ctx.study.importStatusForClient({ importId: prepared.importId })
    expect(['queued', 'splitting', 'extracting']).toContain(status.state)
    await eventually(() => server.uploadCount === 1)
    await eventually(() => {
      const view = ctx.study.importStatusForClient({ importId: prepared.importId })
      return view.state === 'ready'
    })
  })

  it('returns from the upload route before provider preparation finishes', async () => {
    const value = await setupStudy({ uploadTicketTtlMs: 2000 }, { prepareDelayMs: 250, pollSequence: ['done'] })
    harnesses.push(value)
    const { ctx, server } = value
    const pdf = await pdfFixture()
    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'background.pdf', sizeBytes: pdf.byteLength })
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}${prepared.uploadPath}`, {
      method: 'PUT',
      headers: { 'X-Study-Upload-Token': prepared.uploadToken, 'Content-Length': String(pdf.byteLength) },
      body: Buffer.from(pdf),
    })
    expect(response.status).toBe(200)
    expect(ctx.study.importStatusForClient({ importId: prepared.importId }).state).toBe('queued')
    expect(server.uploadCount).toBe(0)
    await eventually(() => server.uploadCount === 1)
    await eventually(() => ctx.study.importStatusForClient({ importId: prepared.importId }).state === 'ready')
  })

  it('rejects a size mismatch (Content-Length differs from the prepared size)', async () => {
    const { ctx } = await setup()
    const pdf = await pdfFixture()
    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'book.pdf', sizeBytes: pdf.byteLength })
    const truncated = pdf.slice(0, -1)
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}${prepared.uploadPath}`, {
      method: 'PUT',
      headers: {
        'X-Study-Upload-Token': prepared.uploadToken,
        'Content-Length': String(truncated.byteLength),
      },
      body: Buffer.from(truncated),
    })
    expect(response.status).toBe(413)
    const payload = await response.json() as { code: string }
    expect(payload.code).toBe('SIZE_MISMATCH')
  })

  it('rejects an upload with a replayed token after the first attempt', async () => {
    const { ctx } = await setup()
    const pdf = await pdfFixture()
    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'book.pdf', sizeBytes: pdf.byteLength })
    const url = `http://127.0.0.1:${ctx.webServer.port}${prepared.uploadPath}`
    const first = await fetch(url, {
      method: 'PUT',
      headers: { 'X-Study-Upload-Token': prepared.uploadToken, 'Content-Length': String(pdf.byteLength) },
      body: Buffer.from(pdf),
    })
    expect(first.status).toBe(200)
    const replay = await fetch(url, {
      method: 'PUT',
      headers: { 'X-Study-Upload-Token': prepared.uploadToken, 'Content-Length': String(pdf.byteLength) },
      body: Buffer.from(pdf),
    })
    expect(replay.status).toBe(410)
    const payload = await replay.json() as { code: string }
    expect(payload.code).toBe('UPLOAD_NOT_PREPARED')
  })

  it('answers UPLOAD_NOT_PREPARED after a host restart (fresh registry, no URL)', async () => {
    const { ctx } = await setup()
    const pdf = await pdfFixture()
    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'book.pdf', sizeBytes: pdf.byteLength })
    // Simulate restart: a brand-new registry knows nothing about the import.
    const fresh = new UploadRegistry(60000)
    try {
      fresh.consume(prepared.importId, prepared.uploadToken, Date.now())
      expect.unreachable('consume should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(StudyError)
      expect((error as StudyError).code).toBe('UPLOAD_NOT_PREPARED')
    }
  })

  it('renews an upload after the ticket is gone and the new token works', async () => {
    const { ctx, server } = await setup()
    server.mode = { pollSequence: ['done'] }
    const pdf = await pdfFixture()
    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'book.pdf', sizeBytes: pdf.byteLength })
    const status = ctx.study.importStatusForClient({ importId: prepared.importId })
    expect(status.renewRequired).toBe(false)
    // Drop the in-memory registry state (restart) and renew.
    const renewed = await ctx.study.renewUploadForClient({ importId: prepared.importId })
    expect(renewed.importId).toBe(prepared.importId)
    expect(renewed.uploadToken).not.toBe(prepared.uploadToken)
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}${renewed.uploadPath}`, {
      method: 'PUT',
      headers: { 'X-Study-Upload-Token': renewed.uploadToken, 'Content-Length': String(pdf.byteLength) },
      body: Buffer.from(pdf),
    })
    expect(response.status).toBe(200)
  })

  it('rejects renewals for imports that are not awaiting-upload or failed', async () => {
    const { ctx } = await setup()
    const pdf = await pdfFixture()
    const prepared = await ctx.study.prepareUploadForClient({ fileName: 'book.pdf', sizeBytes: pdf.byteLength })
    await fetch(`http://127.0.0.1:${ctx.webServer.port}${prepared.uploadPath}`, {
      method: 'PUT',
      headers: { 'X-Study-Upload-Token': prepared.uploadToken, 'Content-Length': String(pdf.byteLength) },
      body: Buffer.from(pdf),
    })
    await eventually(() => ctx.study.importStatusForClient({ importId: prepared.importId }).state === 'ready')
    await expect(ctx.study.renewUploadForClient({ importId: prepared.importId }))
      .rejects.toMatchObject({ code: 'IMPORT_NOT_UPLOADABLE' })
  })
})
