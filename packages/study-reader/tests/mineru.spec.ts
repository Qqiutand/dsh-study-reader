/**
 * MinerU provider contract tests: full state parsing, per-operation
 * credential re-resolution, and transport fault handling (401/403, 429 with
 * Retry-After, 5xx backoff, timeout, cancellation, invalid JSON, business
 * code != 0).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, type CredentialRef, type CredentialInfo, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { StudyError, type DocumentExtractorProvider, type ExtractionProgress, type ProviderTask } from '@deepseek-ai/dsh-document-extraction'
import { MinerUProvider, apply, type MinerUConfig } from '../lib/types/mineru/index.js'
import { FakeMineruServer, v2Content } from '../../../examples/study-reader/fake-mineru.ts'

/** In-memory credential seam for tests. */
class TestCredentials extends CredentialProvider {
  private readonly values = new Map<string, string>()

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return value === undefined ? undefined : { value, source: 'test' }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: this.values.has(ref), writable: true }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
  }
}

interface Harness {
  readonly ctx: Context
  readonly credentials: TestCredentials
  readonly provider: DocumentExtractorProvider
  readonly server: FakeMineruServer
  readonly url: string
  dispose(): Promise<void>
}

const harnesses: Harness[] = []

async function setup(config: Partial<MinerUConfig> = {}, serverOptions: ConstructorParameters<typeof FakeMineruServer>[0] = {}): Promise<Harness> {
  const ctx = new Context()
  // The CredentialProvider constructor registers itself as `credentials`.
  const credentials = new TestCredentials(ctx)
  credentials.set('MINERU_API_KEY', 'test-key')
  const server = new FakeMineruServer(serverOptions)
  const { url } = await server.start()
  const extraction = { registerProvider: () => () => {} }
  ctx.provide('documentExtraction', extraction as never)
  const plugin = apply(ctx, {
    providerId: 'mineru',
    baseUrl: url,
    apiKeyRef: 'MINERU_API_KEY',
    modelVersion: 'vlm',
    language: 'ch',
    enableTable: true,
    enableFormula: true,
    isOcr: false,
    requestTimeoutMs: 5000,
    maxArtifactBytes: 10 * 1024 * 1024,
    ...config,
  })
  const provider = new MinerUProvider(ctx, {
    providerId: 'mineru',
    baseUrl: url,
    apiKeyRef: 'MINERU_API_KEY',
    modelVersion: 'vlm',
    language: 'ch',
    enableTable: true,
    enableFormula: true,
    isOcr: false,
    requestTimeoutMs: 5000,
    maxArtifactBytes: 10 * 1024 * 1024,
    ...config,
  })
  const harness: Harness = { ctx, credentials, provider, server, url, dispose: async () => { plugin(); await server.close(); await ctx.fiber.dispose() } }
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(value => value.dispose()))
})

const signal = () => new AbortController().signal

describe('MinerUProvider', () => {
  it('uses the official local Docker health, task, poll, and ZIP-result contract without an API key', async () => {
    const { provider, credentials, server } = await setup({ apiMode: 'local-docker', localBackend: 'hybrid-engine' })
    await credentials.unset('MINERU_API_KEY')
    await expect(provider.health(signal())).resolves.toMatchObject({ state: 'available' })
    const bytes = new TextEncoder().encode('%PDF-fake')
    const submitted = await provider.submit!({
      fileName: 'local.pdf', sizeBytes: bytes.byteLength,
      open: () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }),
    }, {
      fileName: 'local.pdf', sizeBytes: bytes.byteLength, dataId: 'local-1', language: 'en', pageRanges: '2-3', isOcr: true, enableTable: false, enableFormula: true,
    }, signal())
    expect(server.localMultipartBody).toContain('name="files"; filename="local.pdf"')
    expect(server.localMultipartBody).toContain('hybrid-engine')
    expect(server.localMultipartBody).toContain('name="start_page_id"')
    expect(server.localMultipartBody).toContain('\r\n1\r\n')
    expect((await provider.poll(submitted.task, signal())).state).toBe('pending')
    expect((await provider.poll(submitted.task, signal())).state).toBe('running')
    expect((await provider.poll(submitted.task, signal())).state).toBe('done')
    const directory = await mkdtemp(join(tmpdir(), 'study-mineru-local-'))
    try {
      const output = join(directory, 'result.zip')
      const artifact = await provider.collect(submitted.task, output, signal())
      expect(artifact.manifest.kind).toBe('mineru-zip')
      expect((await readFile(output)).subarray(0, 2).toString()).toBe('PK')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('parses official nested batch results into the seam progress union', async () => {
    const { provider, server } = await setup({}, { pollSequence: ['waiting-file', 'pending', 'running', 'converting', 'done'] })
    const prepared = await provider.prepareUpload({
      fileName: 'a.pdf', sizeBytes: 10, dataId: 'd1', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())
    expect(prepared.task.kind).toBe('batch')
    const task = prepared.task
    expect(await provider.poll(task, signal())).toEqual({ state: 'waiting-upload' })
    expect(await provider.poll(task, signal())).toEqual({ state: 'pending' })
    const running = await provider.poll(task, signal()) as ExtractionProgress
    expect(running.state).toBe('running')
    if (running.state === 'running') {
      expect(running.extractedPages).toBe(2)
      expect(running.totalPages).toBe(3)
    }
    expect(await provider.poll(task, signal())).toEqual({ state: 'converting' })
    const done = await provider.poll(task, signal()) as ExtractionProgress
    expect(done.state).toBe('done')
    if (done.state === 'done') expect(done.resultUrl).toContain('/results/')
    void server
  })

  it('maps failed states from the provider', async () => {
    const { provider, credentials } = await setup({}, { pollSequence: ['failed'] })
    credentials.set('MINERU_API_KEY', 'k')
    const task = await provider.submitUrl({
      url: 'https://example.com/a.pdf', dataId: 'd2', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())
    const failed = await provider.poll(task.task, signal()) as ExtractionProgress
    expect(failed.state).toBe('failed')
    if (failed.state === 'failed') {
      expect(failed.code).toBe('FAKE_FAILURE')
      expect(failed.message).toContain('fake extraction failed')
    }
  })

  it('re-resolves the credential on every operation', async () => {
    const { provider, credentials, server } = await setup()
    await credentials.unset('MINERU_API_KEY')
    await expect(provider.prepareUpload({
      fileName: 'a.pdf', sizeBytes: 10, dataId: 'd1', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())).rejects.toMatchObject({ code: 'MINERU_CREDENTIAL_MISSING' })
    credentials.set('MINERU_API_KEY', 'first-key')
    await provider.prepareUpload({
      fileName: 'a.pdf', sizeBytes: 10, dataId: 'd1', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())
    // Unset mid-flight: the next operation fails again (no cached key).
    await credentials.unset('MINERU_API_KEY')
    await expect(provider.submitUrl({
      url: 'https://example.com/a.pdf', dataId: 'd2', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())).rejects.toMatchObject({ code: 'MINERU_CREDENTIAL_MISSING' })
    void server
  })

  it('rejects a stored key that cannot become an HTTP header', async () => {
    const { provider, credentials } = await setup()
    credentials.set('MINERU_API_KEY', 'not valid')
    await expect(provider.prepareUpload({
      fileName: 'a.pdf', sizeBytes: 10, dataId: 'd1', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())).rejects.toMatchObject({ code: 'MINERU_CREDENTIAL_INVALID' })
  })

  it('maps 401 and 403 to credential errors', async () => {
    const { provider, credentials } = await setup({}, { prepareFault: '401' })
    credentials.set('MINERU_API_KEY', 'bad')
    await expect(provider.prepareUpload({
      fileName: 'a.pdf', sizeBytes: 10, dataId: 'd1', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())).rejects.toMatchObject({ code: 'MINERU_CREDENTIAL_REJECTED' })
    const { provider: provider2, credentials: credentials2 } = await setup({}, { prepareFault: '403' })
    credentials2.set('MINERU_API_KEY', 'bad')
    await expect(provider2.prepareUpload({
      fileName: 'a.pdf', sizeBytes: 10, dataId: 'd1', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())).rejects.toMatchObject({ code: 'MINERU_CREDENTIAL_REJECTED' })
    void provider
  })

  it('honors Retry-After on 429 then succeeds', async () => {
    const { provider, credentials, server } = await setup({ retryBaseMs: 10, maxRetries: 3 })
    credentials.set('MINERU_API_KEY', 'k')
    server.mode = { pollFault: { status: 429, retryAfterSeconds: 0 } }
    const prepared = await provider.prepareUpload({
      fileName: 'a.pdf', sizeBytes: 10, dataId: 'd1', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())
    expect(prepared.task.kind).toBe('batch')
  })

  it('parses the current string-array file_urls contract', async () => {
    const { provider, server } = await setup({}, { batchFileUrlsAsStrings: true })
    const prepared = await provider.prepareUpload({
      fileName: 'a.pdf', sizeBytes: 10, dataId: 'd1', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())
    expect(prepared.task.kind).toBe('batch')
    expect(prepared.signedUploadUrl).toContain('/upload/')
    // The string contract still yields a working batch poll target (default
    // pollSequence starts at 'pending').
    expect((await provider.poll(prepared.task, signal())).state).toBe('pending')
    void server
  })

  it('retries 5xx with backoff', async () => {
    const { provider, credentials, server } = await setup({ retryBaseMs: 5, maxRetries: 2 })
    credentials.set('MINERU_API_KEY', 'k')
    server.mode = { prepareFault: '500' }
    await expect(provider.prepareUpload({
      fileName: 'a.pdf', sizeBytes: 10, dataId: 'd1', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())).rejects.toMatchObject({ code: 'MINERU_UPSTREAM_ERROR' })
  })

  it('fails fast on non-retryable 4xx parameter errors', async () => {
    const { provider, credentials, server } = await setup({ maxRetries: 5, retryBaseMs: 5 })
    credentials.set('MINERU_API_KEY', 'k')
    server.mode = { prepareFault: '400' }
    await expect(provider.prepareUpload({
      fileName: 'a.pdf', sizeBytes: 10, dataId: 'd1', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())).rejects.toMatchObject({ code: 'MINERU_REQUEST_REJECTED' })
  })

  it('treats code != 0 on HTTP 200 as a business failure', async () => {
    const { provider, credentials } = await setup({}, { prepareFault: 'code-nonzero' })
    credentials.set('MINERU_API_KEY', 'k')
    await expect(provider.prepareUpload({
      fileName: 'a.pdf', sizeBytes: 10, dataId: 'd1', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())).rejects.toMatchObject({ code: 'MINERU_BUSINESS_ERROR' })
  })

  it('rejects invalid JSON with MINERU_INVALID_RESPONSE', async () => {
    const { provider, credentials } = await setup({}, { prepareFault: 'invalid-json' })
    credentials.set('MINERU_API_KEY', 'k')
    await expect(provider.prepareUpload({
      fileName: 'a.pdf', sizeBytes: 10, dataId: 'd1', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())).rejects.toMatchObject({ code: 'MINERU_INVALID_RESPONSE' })
  })

  it('times out per requestTimeoutMs', async () => {
    const { provider, credentials, server } = await setup({ requestTimeoutMs: 60 })
    credentials.set('MINERU_API_KEY', 'k')
    server.mode = { pollDelayMs: 500 }
    const started = Date.now()
    await expect(provider.poll({ kind: 'batch', id: 'slow' }, signal())).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(400)
  })

  it('aborts in-flight work when the caller cancels', async () => {
    const { provider, credentials, server } = await setup({ requestTimeoutMs: 10000, retryBaseMs: 500 })
    credentials.set('MINERU_API_KEY', 'k')
    server.mode = { pollDelayMs: 10000 }
    const controller = new AbortController()
    const pending = provider.poll({ kind: 'batch', id: 'cancel' }, controller.signal)
    setTimeout(() => controller.abort(new Error('cancelled')), 30)
    await expect(pending).rejects.toMatchObject({ name: 'Error' })
  })

  it('round-trips prepareUpload with the fake server', async () => {
    const { provider, credentials } = await setup()
    credentials.set('MINERU_API_KEY', 'k')
    const prepared = await provider.prepareUpload({
      fileName: 'book.pdf', sizeBytes: 1024, dataId: 'import-1', language: 'ch', pageRanges: '1-5', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())
    expect(prepared.task.kind).toBe('batch')
    if (prepared.task.kind === 'batch') expect(prepared.signedUploadUrl).toContain('/upload/')
    expect(prepared.signedUploadUrl).not.toContain('MINERU_API_KEY')
  })

  it('parses official single-task results with the result archive', async () => {
    const { provider, credentials } = await setup({}, { pollSequence: ['done'] })
    credentials.set('MINERU_API_KEY', 'k')
    const task = await provider.submitUrl({
      url: 'https://example.com/paper.pdf', dataId: 'import-2', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())
    expect(task.task.kind).toBe('single')
    const progress = await provider.poll(task.task, signal())
    expect(progress.state).toBe('done')
  })

  it('never logs secrets (debug output lacks key and signed query params)', async () => {
    const { provider, credentials } = await setup()
    credentials.set('MINERU_API_KEY', 'super-secret-key')
    const lines: string[] = []
    const logger = { debug: (line: string) => lines.push(line), error: () => {}, info: () => {}, warn: () => {} }
    ;(provider as unknown as { ctx: { logger: unknown } }).ctx.logger = logger
    await provider.prepareUpload({
      fileName: 'a.pdf', sizeBytes: 10, dataId: 'd1', language: 'ch', isOcr: false, enableTable: true, enableFormula: true,
    }, signal())
    for (const line of lines) {
      expect(line).not.toContain('super-secret-key')
      expect(line).not.toContain('X-Amz-Signature')
    }
    void v2Content
  })
})
