/**
 * MinerU cloud-v4 and official local Docker/FastAPI provider adapter.
 *
 * Contract notes (first version, polling only — no MinerU callback):
 * - local files: `POST /api/v4/file-urls/batch` yields a `batch_id` and one
 *   signed upload URL; the file PUT is performed by the study service, and
 *   the provider never submits again after the upload lands;
 * - URL documents: `POST /api/v4/extract/task`, polled by `task_id`;
 * - every response is validated with Zod; `code !== 0` is a failure even on
 *   HTTP 200;
 * - 401/403 map to credential errors, 429 respects `Retry-After` (else
 *   exponential backoff), 5xx is retried with backoff, other 4xx never is;
 * - every fetch receives an `AbortSignal`;
 * - logs never carry the API key, the Authorization header, signed upload
 *   URLs, or CDN query parameters.
 *
 * The official pages disagree on the precise page-count ceiling for the API
 * (200 vs 600); page limits are therefore never a code invariant here — the
 * provider only forwards `pageRanges` and the server's answer is final.
 * @module @deepseek-ai/dsh-document-extraction-mineru
 */

import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import zod from 'zod'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  StudyError,
  type DocumentExtractorProvider,
  type ExtractionArtifact,
  type ExtractionConnectionConfig,
  type ExtractionHealth,
  type ExtractionInput,
  type ArtifactNormalizer,
  type ExtractionProgress,
  type ExtractionProviderId,
  type PrepareUploadRequest,
  type PreparedProviderUpload,
  type ProviderTask,
  type ProviderTaskId,
  type SubmitUrlRequest,
} from '../extraction/index.ts'
import { normalizeArchive } from './normalizer.ts'
import type { ArchiveLimits } from '../extraction/archive-reader.ts'
import type { BlobKey } from '../study/blob-store.ts'
import type { NormalizedDocument } from '../extraction/canonicalizer.ts'

/** Cordis plugin name of the provider row. */
export const name = 'document-extraction-mineru'
/** Required services: the credential seam and the extraction registry. */
export const inject = ['credentials', 'documentExtraction']

/** Provider config: endpoint, credential reference, extraction options, transport policy. */
export interface MinerUConfig {
  /** Stable instance id. Local and cloud deployments must use distinct values. */
  providerId: string
  /** API origin, e.g. `https://mineru.net`. */
  baseUrl: string
  /** Transport contract exposed by the endpoint. */
  apiMode?: 'cloud-v4' | 'local-docker'
  /** Credential reference naming the API key (default `MINERU_API_KEY`). */
  apiKeyRef: string
  /** MinerU model pipeline: `pipeline`, `vlm`, or `MinerU-HTML`. */
  modelVersion: 'pipeline' | 'vlm' | 'MinerU-HTML'
  /** Official `mineru-api` backend used by local Docker deployments. */
  localBackend?: 'pipeline' | 'vlm-engine' | 'hybrid-engine'
  /** Document language code passed to the API (`ch`/`en`/...). */
  language: string
  /** Enable table structure recognition. */
  enableTable: boolean
  /** Enable formula recognition. */
  enableFormula: boolean
  /** Run OCR over scanned pages. */
  isOcr: boolean
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number
  /** Streamed result archive ceiling before it enters durable storage. */
  maxArtifactBytes: number
  /** Retry attempts for 429/5xx before failing (default 3). */
  maxRetries?: number
  /** Initial backoff in milliseconds (default 1000). */
  retryBaseMs?: number
  /** Cap on a server-provided `Retry-After`, in milliseconds (default 30000). */
  maxRetryAfterMs?: number
}

/** Schemastery config. */
export const Config: z<MinerUConfig> = z.object({
  providerId: z.string().required(),
  baseUrl: z.string().required(),
  apiMode: z.union([z.const('cloud-v4'), z.const('local-docker')]).default('cloud-v4'),
  apiKeyRef: z.string().default('MINERU_API_KEY'),
  modelVersion: z.union([z.const('pipeline'), z.const('vlm'), z.const('MinerU-HTML')]).required(),
  localBackend: z.union([z.const('pipeline'), z.const('vlm-engine'), z.const('hybrid-engine')]).default('pipeline'),
  language: z.string().required(),
  enableTable: z.boolean().required(),
  enableFormula: z.boolean().required(),
  isOcr: z.boolean().required(),
  requestTimeoutMs: z.number().min(1).required(),
  maxArtifactBytes: z.number().min(1).required(),
  maxRetries: z.number().min(0).default(3),
  retryBaseMs: z.number().min(1).default(1000),
  maxRetryAfterMs: z.number().min(1).default(30000),
})

// ── response validation ────────────────────────────────────────────────────

/** The MinerU envelope: a business `code` on every response, even with HTTP 200. */
const mineruEnvelope = zod.object({
  code: zod.number(),
  msg: zod.string().optional(),
  message: zod.string().optional(),
  data: zod.unknown().optional(),
})

/**
 * `file-urls/batch` response payload. The MinerU API returns the upload URLs
 * as a bare string array; an older shape wrapped each URL in an object
 * (`{ upload_url, file_id }`). Accept both so either contract parses.
 */
const preparedBatchData = zod.object({
  batch_id: zod.string(),
  file_urls: zod.array(zod.union([
    zod.string(),
    zod.object({
      upload_url: zod.string(),
      file_id: zod.string().optional(),
    }),
  ])).min(1),
})

const submittedTaskData = zod.object({
  task_id: zod.string(),
})

/** One extraction result returned directly or inside a batch result array. */
const pollResultData = zod.object({
  state: zod.string(),
  full_zip_url: zod.string().optional(),
  code: zod.string().optional(),
  err_msg: zod.string().optional(),
  extract_progress: zod.object({
    extracted_pages: zod.number().optional(),
    total_pages: zod.number().optional(),
  }).optional(),
})

const singlePollData = pollResultData.extend({
  task_id: zod.string(),
})

/** This provider creates exactly one file per batch preparation request. */
const batchPollData = zod.object({
  batch_id: zod.string(),
  extract_result: zod.array(pollResultData).length(1),
})

const localTaskData = zod.object({
  task_id: zod.string(),
  status: zod.string(),
  error: zod.string().nullable().optional(),
  queued_ahead: zod.number().optional(),
})

// ── provider ───────────────────────────────────────────────────────────────

/** Resolved provider policy: the transport retry budget. */
interface ResolvedTransport {
  readonly maxRetries: number
  readonly retryBaseMs: number
  readonly maxRetryAfterMs: number
}

/** The MinerU extraction backend. */
export class MinerUProvider implements DocumentExtractorProvider {
  readonly id: ExtractionProviderId
  readonly kind = 'mineru'

  private transport: ResolvedTransport
  private enabled = true

  connectionDescriptor(): ExtractionConnectionConfig & { readonly credentialRef: string } {
    return { endpoint: this.config.baseUrl, enabled: this.enabled, model: this.config.modelVersion, credentialRef: this.config.apiKeyRef, options: { apiMode: this.apiMode(), localBackend: this.config.localBackend ?? 'pipeline', language: this.config.language, enableTable: this.config.enableTable, enableFormula: this.config.enableFormula, isOcr: this.config.isOcr, requestTimeoutMs: this.config.requestTimeoutMs } }
  }

  acceptingNewJobs(): boolean { return this.enabled }

  configureConnection(connection: ExtractionConnectionConfig): void {
    let endpoint: URL
    try { endpoint = new URL(connection.endpoint) } catch { throw new StudyError('MinerU endpoint is invalid', 'PROVIDER_CONNECTION_INVALID') }
    if ((endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') || endpoint.username !== '' || endpoint.password !== '') throw new StudyError('MinerU endpoint must be an http(s) URL without credentials', 'PROVIDER_CONNECTION_INVALID')
    const model = connection.model ?? this.config.modelVersion
    if (model !== 'pipeline' && model !== 'vlm' && model !== 'MinerU-HTML') throw new StudyError('MinerU model is invalid', 'PROVIDER_CONNECTION_INVALID')
    const { language, enableTable, enableFormula, isOcr, requestTimeoutMs } = connection.options
    const apiMode = connection.options.apiMode ?? this.apiMode()
    const localBackend = connection.options.localBackend ?? this.config.localBackend ?? 'pipeline'
    if (apiMode !== 'cloud-v4' && apiMode !== 'local-docker') throw new StudyError('MinerU API mode is invalid', 'PROVIDER_CONNECTION_INVALID')
    if (localBackend !== 'pipeline' && localBackend !== 'vlm-engine' && localBackend !== 'hybrid-engine') throw new StudyError('MinerU local backend is invalid', 'PROVIDER_CONNECTION_INVALID')
    if (typeof language !== 'string' || language.trim() === '' || language.length > 32
      || typeof enableTable !== 'boolean' || typeof enableFormula !== 'boolean' || typeof isOcr !== 'boolean'
      || typeof requestTimeoutMs !== 'number' || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 300_000) {
      throw new StudyError('MinerU non-secret options are invalid', 'PROVIDER_CONNECTION_INVALID')
    }
    this.config = { ...this.config, baseUrl: endpoint.toString().replace(/\/$/u, ''), apiMode, localBackend, modelVersion: model, language: language.trim(), enableTable, enableFormula, isOcr, requestTimeoutMs }
    this.enabled = connection.enabled
    this.transport = { maxRetries: this.config.maxRetries ?? 3, retryBaseMs: this.config.retryBaseMs ?? 1000, maxRetryAfterMs: this.config.maxRetryAfterMs ?? 30000 }
  }

  /**
   * @param ctx - Cordis context carrying the credential seam.
   * @param config - validated provider config.
   */
  constructor(
    private readonly ctx: Context,
    private config: MinerUConfig,
  ) {
    this.id = config.providerId as ExtractionProviderId
    this.transport = {
      maxRetries: config.maxRetries ?? 3,
      retryBaseMs: config.retryBaseMs ?? 1000,
      maxRetryAfterMs: config.maxRetryAfterMs ?? 30000,
    }
  }

  /** MinerU is available when its credential can be resolved. */
  async health(signal: AbortSignal): Promise<ExtractionHealth> {
    if (!this.enabled) return { state: 'unavailable', checkedAt: Date.now(), retryable: true, error: { code: 'provider-unavailable', message: 'MinerU connection is disabled', retryable: true } }
    try {
      signal.throwIfAborted()
      if (this.apiMode() === 'local-docker') {
        const response = await this.fetchLocal('/health', { method: 'GET' }, signal)
        if (!response.ok) throw new StudyError(`Local MinerU health check failed (HTTP ${response.status})`, 'MINERU_LOCAL_UNAVAILABLE')
        const payload = await response.json() as { status?: unknown }
        if (payload.status !== 'healthy') throw new StudyError('Local MinerU reported an unhealthy state', 'MINERU_LOCAL_UNAVAILABLE')
      } else {
        await this.resolveKey()
      }
      return { state: 'available', checkedAt: Date.now(), retryable: true }
    } catch (error) {
      return {
        state: this.apiMode() === 'local-docker' ? 'unavailable' : 'misconfigured', checkedAt: Date.now(), retryable: true,
        error: { code: this.apiMode() === 'local-docker' ? 'provider-unavailable' : 'credential-missing', message: error instanceof Error ? error.message : 'MinerU connection is unavailable', retryable: true,
          ...error instanceof StudyError ? { providerCode: error.code } : {} },
      }
    }
  }

  /**
   * Resolve the API key fresh for every operation — a changed credential
   * reaches the next operation without a restart. Never caches the value.
   * @returns the resolved key.
   * @throws {@link StudyError} `MINERU_CREDENTIAL_MISSING` when unconfigured.
   */
  private async resolveKey(): Promise<string> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.apiKeyRef))
    if (resolved === undefined) {
      throw new StudyError('MinerU credential is not configured', 'MINERU_CREDENTIAL_MISSING')
    }
    const key = resolved.value.trim()
    if (key.length === 0 || !/^[\x21-\x7E]+$/u.test(key)) {
      throw new StudyError('MinerU credential is invalid; configure a printable ASCII MINERU_API_KEY', 'MINERU_CREDENTIAL_INVALID')
    }
    return key
  }

  /**
   * Request a signed upload URL for one file. The batch prepare is stateless
   * until the file PUT lands; the returned `batch_id` is the poll target.
   * @param request - file identity and extraction options.
   * @param signal - aborts the request.
   * @returns the batch task and signed upload URL.
   */
  async prepareUpload(request: PrepareUploadRequest, signal: AbortSignal): Promise<PreparedProviderUpload> {
    const key = await this.resolveKey()
    const body = {
      files: [{
        name: request.fileName,
        data_id: request.dataId,
        is_ocr: request.isOcr,
        ...request.pageRanges === undefined ? {} : { page_ranges: request.pageRanges },
      }],
      model_version: this.config.modelVersion,
      language: request.language,
      enable_table: request.enableTable,
      enable_formula: request.enableFormula,
    }
    const envelope = await this.requestJson('/api/v4/file-urls/batch', key, {
      method: 'POST',
      body: JSON.stringify(body),
    }, signal)
    const data = requireData('file-urls/batch', preparedBatchData, envelope)
    const file = data.file_urls[0]
    if (file === undefined) {
      throw new StudyError('MinerU batch prepare returned no upload URL', 'MINERU_INVALID_RESPONSE')
    }
    // Newer API returns the URL as a bare string; the legacy shape wraps it in
    // `{ upload_url }`. Normalize both at the boundary.
    const signedUploadUrl = typeof file === 'string' ? file : file.upload_url
    return {
      task: { kind: 'batch', id: data.batch_id as ProviderTaskId },
      signedUploadUrl,
    }
  }

  /** Upload the call-local original to MinerU and return only its opaque task. */
  async submit(input: ExtractionInput, request: PrepareUploadRequest, signal: AbortSignal): Promise<{ readonly task: ProviderTask }> {
    if (input.fileName !== request.fileName || input.sizeBytes !== request.sizeBytes) {
      throw new StudyError('extraction input does not match its submission metadata', 'MINERU_INPUT_MISMATCH')
    }
    if (this.apiMode() === 'local-docker') return await this.submitLocal(input, request, signal)
    const prepared = await this.prepareUpload(request, signal)
    const response = await fetch(prepared.signedUploadUrl, {
      method: 'PUT',
      headers: { 'Content-Length': String(input.sizeBytes) },
      body: input.open(),
      duplex: 'half',
      signal,
    } as RequestInit & { duplex: 'half' })
    if (!response.ok) throw new StudyError(`MinerU upload rejected (HTTP ${response.status})`, 'MINERU_UPLOAD_FAILED')
    return { task: prepared.task }
  }

  /**
   * Submit extraction of a remote URL document.
   * @param request - url and extraction options.
   * @param signal - aborts the request.
   * @returns the single task to poll.
   */
  async submitUrl(request: SubmitUrlRequest, signal: AbortSignal): Promise<{ readonly task: ProviderTask }> {
    if (this.apiMode() === 'local-docker') {
      throw new StudyError('Official local MinerU Docker accepts uploaded files, not URL jobs', 'MINERU_LOCAL_URL_UNSUPPORTED')
    }
    const key = await this.resolveKey()
    const body = {
      url: request.url,
      data_id: request.dataId,
      is_ocr: request.isOcr,
      ...request.pageRanges === undefined ? {} : { page_ranges: request.pageRanges },
      model_version: this.config.modelVersion,
      language: request.language,
      enable_table: request.enableTable,
      enable_formula: request.enableFormula,
    }
    const envelope = await this.requestJson('/api/v4/extract/task', key, {
      method: 'POST',
      body: JSON.stringify(body),
    }, signal)
    const data = requireData('extract/task', submittedTaskData, envelope)
    return { task: { kind: 'single', id: data.task_id as ProviderTaskId } }
  }

  /**
   * Poll one batch or single task and map the provider state onto the seam.
   * @param task - the task handle returned by prepare/submit.
   * @param signal - aborts the request.
   * @returns the mapped progress snapshot.
   */
  async poll(task: ProviderTask, signal: AbortSignal): Promise<ExtractionProgress> {
    if (this.apiMode() === 'local-docker') return await this.pollLocal(task, signal)
    const key = await this.resolveKey()
    const path = task.kind === 'batch'
      ? `/api/v4/extract-results/batch/${task.id}`
      : `/api/v4/extract/task/${task.id}`
    const envelope = await this.requestJson(path, key, { method: 'GET' }, signal)
    const result = task.kind === 'batch'
      ? requireData('batch poll', batchPollData, envelope).extract_result[0]!
      : requireData('task poll', singlePollData, envelope)
    return mapPollState(result.state, {
      ...result.extract_progress?.extracted_pages !== undefined
        ? { extractedPages: result.extract_progress.extracted_pages }
        : {},
      ...result.extract_progress?.total_pages !== undefined
        ? { totalPages: result.extract_progress.total_pages }
        : {},
      ...result.full_zip_url !== undefined ? { resultUrl: result.full_zip_url } : {},
      ...result.code !== undefined ? { code: result.code } : {},
      ...result.err_msg !== undefined ? { message: result.err_msg } : {},
    })
  }

  /** MinerU v4 has no documented task cancellation endpoint. */
  async cancel(_task: ProviderTask, signal: AbortSignal): Promise<{ readonly outcome: 'upstream-unsupported' }> {
    signal.throwIfAborted()
    return { outcome: 'upstream-unsupported' }
  }

  /** Poll, then stream the private result URL into a caller-owned artifact file. */
  async collect(task: ProviderTask, destination: string, signal: AbortSignal): Promise<ExtractionArtifact> {
    const progress = await this.poll(task, signal)
    if (progress.state !== 'done') {
      throw new StudyError('MinerU result is not ready for collection', 'MINERU_RESULT_NOT_READY')
    }
    const response = this.apiMode() === 'local-docker'
      ? await this.fetchLocal(`/tasks/${encodeURIComponent(task.id)}/result`, { method: 'GET' }, signal)
      : await fetch(progress.resultUrl, { signal })
    if (!response.ok || response.body === null) {
      throw new StudyError(`MinerU result download failed (HTTP ${response.status})`, 'MINERU_COLLECT_FAILED')
    }
    await mkdir(dirname(destination), { recursive: true })
    const hash = createHash('sha256')
    let bytes = 0
    const maxArtifactBytes = this.config.maxArtifactBytes
    const digest = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength
        if (bytes > maxArtifactBytes) {
          callback(new StudyError('MinerU result archive exceeds configured limit', 'MINERU_ARTIFACT_TOO_LARGE'))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), digest, createWriteStream(destination, { flags: 'wx' }), { signal })
    return { path: destination, manifest: { schemaVersion: 1, kind: 'mineru-zip', sha256: hash.digest('hex'), bytes } }
  }

  /** Submit one captured original to the official Docker `mineru-api`. */
  private async submitLocal(input: ExtractionInput, request: PrepareUploadRequest, signal: AbortSignal): Promise<{ readonly task: ProviderTask }> {
    const bytes = new Uint8Array(await new Response(input.open()).arrayBuffer())
    if (bytes.byteLength !== input.sizeBytes) throw new StudyError('local MinerU input size changed during submission', 'MINERU_INPUT_MISMATCH')
    const form = new FormData()
    form.append('files', new Blob([bytes]), input.fileName)
    form.append('lang_list', request.language)
    form.append('backend', this.config.localBackend ?? 'pipeline')
    form.append('parse_method', request.isOcr ? 'ocr' : 'auto')
    form.append('formula_enable', String(request.enableFormula))
    form.append('table_enable', String(request.enableTable))
    form.append('return_md', 'true')
    form.append('return_content_list', 'true')
    form.append('return_images', 'true')
    form.append('response_format_zip', 'true')
    if (request.pageRanges !== undefined) {
      const range = parseLocalPageRange(request.pageRanges)
      form.append('start_page_id', String(range.start))
      form.append('end_page_id', String(range.end))
    }
    const response = await this.fetchLocal('/tasks', { method: 'POST', body: form }, signal)
    if (!response.ok) throw new StudyError(`Local MinerU rejected the upload (HTTP ${response.status})`, 'MINERU_REQUEST_REJECTED')
    const parsed = localTaskData.safeParse(await response.json())
    if (!parsed.success) throw new StudyError('Local MinerU returned an invalid task response', 'MINERU_INVALID_RESPONSE')
    return { task: { kind: 'single', id: parsed.data.task_id as ProviderTaskId } }
  }

  /** Poll an official local Docker async task. */
  private async pollLocal(task: ProviderTask, signal: AbortSignal): Promise<ExtractionProgress> {
    const response = await this.fetchLocal(`/tasks/${encodeURIComponent(task.id)}`, { method: 'GET' }, signal)
    if (!response.ok) throw new StudyError(`Local MinerU task query failed (HTTP ${response.status})`, 'MINERU_UPSTREAM_ERROR')
    const parsed = localTaskData.safeParse(await response.json())
    if (!parsed.success) throw new StudyError('Local MinerU returned an invalid task status', 'MINERU_INVALID_RESPONSE')
    switch (parsed.data.status) {
      case 'pending': return { state: 'pending' }
      case 'processing': return { state: 'running' }
      case 'completed': return { state: 'done', resultUrl: `${this.config.baseUrl}/tasks/${encodeURIComponent(task.id)}/result` }
      case 'failed': return { state: 'failed', code: 'MINERU_LOCAL_FAILED', message: parsed.data.error ?? 'Local MinerU extraction failed' }
      default: return { state: 'failed', code: 'MINERU_UNKNOWN_STATE', message: `Local MinerU reported unknown state "${parsed.data.status}"` }
    }
  }

  /** Fetch a local endpoint with the same timeout/cancellation boundary. */
  private async fetchLocal(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('MinerU request timed out')), this.config.requestTimeoutMs)
    try { return await fetch(`${this.config.baseUrl}${path}`, { ...init, signal: controller.signal }) }
    finally { clearTimeout(timeout); signal.removeEventListener('abort', onAbort) }
  }

  private apiMode(): 'cloud-v4' | 'local-docker' { return this.config.apiMode ?? 'cloud-v4' }

  /** Parse a retained MinerU archive without contacting MinerU again. */
  async normalizeArtifacts(artifactPath: string, limits: ArchiveLimits, putAsset: (data: Uint8Array, name: string) => Promise<BlobKey>, signal: AbortSignal): Promise<NormalizedDocument> {
    signal.throwIfAborted()
    return await normalizeArchive(artifactPath, limits, putAsset)
  }

  /**
   * One authenticated JSON request with retry policy. The Authorization
   * header and any signed URL query strings never enter logs.
   * @param path - API path without origin.
   * @param key - resolved API key.
   * @param init - fetch init without headers (headers are owned here).
   * @param signal - caller cancellation; aborts in-flight work.
   * @returns the parsed JSON body.
   */
  private async requestJson(
    path: string,
    key: string,
    init: { method: 'GET' | 'POST'; body?: string },
    signal: AbortSignal,
  ): Promise<unknown> {
    let attempt = 0
    let delay = this.transport.retryBaseMs
    for (;;) {
      signal.throwIfAborted()
      const response = await this.fetchOnce(path, key, init, signal)
      if (response.status === 401 || response.status === 403) {
        throw new StudyError(
          `MinerU rejected the credential (HTTP ${response.status}); configure a new MINERU_API_KEY`,
          'MINERU_CREDENTIAL_REJECTED',
        )
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= this.transport.maxRetries) {
          throw new StudyError(
            `MinerU upstream error (HTTP ${response.status}) after ${attempt + 1} attempts`,
            'MINERU_UPSTREAM_ERROR',
          )
        }
        delay = retryDelay(response.headers.get('retry-after'), delay, this.transport.maxRetryAfterMs)
        await sleep(delay, signal)
        attempt += 1
        continue
      }
      if (response.status >= 400) {
        throw new StudyError(
          `MinerU rejected the request (HTTP ${response.status})`,
          'MINERU_REQUEST_REJECTED',
        )
      }
      try {
        return await response.json()
      } catch (error) {
        throw new StudyError('MinerU returned invalid JSON', 'MINERU_INVALID_RESPONSE', { cause: error })
      }
    }
  }

  /** One fetch with timeout and caller-signal forwarding. */
  private fetchOnce(
    path: string,
    key: string,
    init: { method: 'GET' | 'POST'; body?: string },
    signal: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('MinerU request timed out')), this.config.requestTimeoutMs)
    const url = `${this.config.baseUrl}${path}`
    this.ctx.logger.debug(`mineru: ${init.method} ${url} (attempting; key and query secrets are never logged)`)
    return fetch(url, {
      method: init.method,
      ...init.body !== undefined ? { body: init.body } : {},
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    })
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** A zod schema narrowed to its parse contract (avoids ZodType variance). */
interface Parsable<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown }
}

/** Extract and validate the `data` payload of a MinerU envelope. */
function requireData<T>(operation: string, schema: Parsable<T>, envelope: unknown): T {
  const parsed = mineruEnvelope.safeParse(envelope)
  if (!parsed.success) {
    throw new StudyError(`MinerU ${operation} returned an invalid envelope`, 'MINERU_INVALID_RESPONSE')
  }
  const { code, msg, message, data } = parsed.data
  if (code !== 0) {
    throw new StudyError(
      `MinerU ${operation} failed: ${msg ?? message ?? `code ${code}`}`,
      'MINERU_BUSINESS_ERROR',
    )
  }
  const payload = schema.safeParse(data)
  if (!payload.success) {
    throw new StudyError(`MinerU ${operation} returned invalid data`, 'MINERU_INVALID_RESPONSE')
  }
  return payload.data
}

/** Map a MinerU status string onto the seam's progress union. */
function mapPollState(
  status: string,
  extras: {
    readonly extractedPages?: number
    readonly totalPages?: number
    readonly resultUrl?: string
    readonly code?: string
    readonly message?: string
  },
): ExtractionProgress {
  switch (status) {
    case 'waiting-file': return { state: 'waiting-upload' }
    case 'pending': return { state: 'pending' }
    case 'running': return {
      state: 'running',
      ...extras.extractedPages !== undefined ? { extractedPages: extras.extractedPages } : {},
      ...extras.totalPages !== undefined ? { totalPages: extras.totalPages } : {},
    }
    case 'converting': return { state: 'converting' }
    case 'done': {
      if (extras.resultUrl === undefined) {
        throw new StudyError('MinerU reported done without a result archive URL', 'MINERU_INVALID_RESPONSE')
      }
      return { state: 'done', resultUrl: extras.resultUrl }
    }
    case 'failed': return {
      state: 'failed',
      ...extras.code !== undefined ? { code: extras.code } : {},
      message: extras.message ?? 'MinerU extraction failed',
    }
    default: return {
      state: 'failed',
      code: 'MINERU_UNKNOWN_STATE',
      message: `MinerU reported unknown state "${status}"`,
    }
  }
}

/** Compute the next backoff: `Retry-After` (seconds or HTTP date) or doubling. */
function retryDelay(retryAfter: string | null, fallback: number, capMs: number): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, capMs)
    }
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) {
      return Math.min(Math.max(date - Date.now(), 0), capMs)
    }
  }
  return Math.min(fallback * 2, capMs)
}

/** Convert the seam's 1-based inclusive single range to MinerU's 0-based range. */
function parseLocalPageRange(value: string): { readonly start: number; readonly end: number } {
  const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/u.exec(value)
  if (match === null) throw new StudyError('Local MinerU supports one contiguous page range such as 1-20', 'MINERU_LOCAL_PAGE_RANGE_UNSUPPORTED')
  const start = Number(match[1])
  const end = Number(match[2] ?? match[1])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw new StudyError('Local MinerU page range is invalid', 'MINERU_LOCAL_PAGE_RANGE_UNSUPPORTED')
  }
  return { start: start - 1, end: end - 1 }
}

/** Sleep that honors caller cancellation. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Mount the provider: register it on the extraction registry (effect-based;
 * the disposer unwinds on unload).
 * @param ctx - Cordis context carrying `documentExtraction`.
 * @param config - validated provider config.
 * @returns the registration disposer.
 */
export function apply(ctx: Context, config: MinerUConfig): () => void {
  const provider = new MinerUProvider(ctx, config)
  const normalizer: ArtifactNormalizer = {
    id: 'mineru-artifact-v1', providerKind: 'mineru', artifactSchemaVersion: 1, version: 1,
    normalize: (path, limits, putAsset, signal) => provider.normalizeArtifacts(path, limits, putAsset, signal),
  }
  const unregisterProvider = ctx.documentExtraction.registerProvider(provider)
  // Contract-test harnesses may intentionally provide only the provider half.
  const registerNormalizer = (ctx.documentExtraction as unknown as { registerArtifactNormalizer?: (value: ArtifactNormalizer) => () => void }).registerArtifactNormalizer
  const unregisterNormalizer = registerNormalizer?.call(ctx.documentExtraction, normalizer) ?? (() => {})
  return () => { unregisterNormalizer(); unregisterProvider() }
}
