/**
 * Service Definition for the document-extraction capability seam
 * (`ctx.documentExtraction`): the provider-agnostic contracts an extractor
 * backend must implement, plus the registry that selects one provider per
 * operation. Business layers (study domain, tools) depend on this package and
 * never import a concrete provider's types.
 *
 * Provider selection rules enforced here:
 * - the active provider comes from explicit `Config.provider`, never from
 *   registration order;
 * - a missing provider fails loud at the first operation;
 * - the provider is re-resolved for EVERY operation and the runtime object is
 *   never cached, so a hot-swapped registration takes effect immediately.
 * @module @deepseek-ai/dsh-document-extraction
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { StudyError } from '../protocol/error.ts'
import type { BlobKey } from '../study/blob-store.ts'
import type { ArchiveLimits } from './archive-reader.ts'
import type { NormalizedDocument } from './canonicalizer.ts'
export { StudyError } from '../protocol/error.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    documentExtraction: DocumentExtractionService
  }
}

/** Nominal id of one registered extraction provider (e.g. `mineru`). */
export type ExtractionProviderId = Branded<'ExtractionProviderId'>

/** Nominal id of one provider-side extraction task. */
export type ProviderTaskId = Branded<'ProviderTaskId'>
/** Nominal durable id of an immutable collected artifact set. */
export type ExtractionArtifactSetId = Branded<'ExtractionArtifactSetId'>

/** Pure local normalizer registration, deliberately independent from provider instances. */
export interface ArtifactNormalizer {
  readonly id: string
  readonly providerKind: string
  readonly artifactSchemaVersion: number
  /** Durable protocol version; not a provider/network version. */
  readonly version: number
  normalize(artifactPath: string, limits: ArchiveLimits, putAsset: (data: Uint8Array, name: string) => Promise<BlobKey>, signal: AbortSignal): Promise<NormalizedDocument>
}

/** One provider-side task handle, opaque to the business layer. */
export type ProviderTask =
  | { readonly kind: 'batch'; readonly id: ProviderTaskId }
  | { readonly kind: 'single'; readonly id: ProviderTaskId }

/** Provider-neutral import states persisted by the study service. */
export type ImportStage = 'queued' | 'splitting' | 'awaiting-upload' | 'uploading' | 'extracting' | 'collecting' | 'normalizing' | 'indexing' | 'ready' | 'failed' | 'cancelled'

/** A safe, provider-neutral failure returned to callers and durable records. */
export interface ExtractionFailure {
  readonly code: 'provider-unavailable' | 'credential-missing' | 'credential-rejected' | 'request-rejected' | 'upstream-error' | 'invalid-response' | 'unsupported' | 'cancelled' | 'timeout' | 'collect-failed' | 'normalize-failed'
  readonly message: string
  readonly retryable: boolean
  /** Safe provider diagnostic; never a URL, header, credential, or raw response. */
  readonly providerCode?: string
}

/** Cached, safe availability result for one provider instance. */
export interface ExtractionHealth {
  readonly state: 'available' | 'degraded' | 'unavailable' | 'misconfigured'
  readonly checkedAt: number
  readonly retryable: boolean
  readonly error?: ExtractionFailure
}

/** Browser-safe, mutable connection fields. Credential values are never part of this contract. */
export interface ExtractionConnectionConfig {
  readonly endpoint: string
  readonly enabled: boolean
  readonly model?: string
  readonly options: Readonly<Record<string, string | number | boolean>>
}

/** A provider-owned artifact saved by collection. */
export interface ExtractionArtifact {
  readonly manifest: { readonly schemaVersion: 1; readonly kind: string; readonly sha256: string; readonly bytes: number }
  /** Absolute temporary path; the caller promotes it into its blob store. */
  readonly path: string
}

/** Options shared by upload preparation and URL submission. */
export interface ExtractionRequestOptions {
  /** Natural language of the source document (`ch` / `en` / ...). */
  readonly language: string
  /** 1-based inclusive page range such as `1-100`; absent means every page. */
  readonly pageRanges?: string
  /** Whether to run OCR over scanned pages. */
  readonly isOcr: boolean
  /** Whether table structure recognition is enabled. */
  readonly enableTable: boolean
  /** Whether formula recognition is enabled. */
  readonly enableFormula: boolean
}

/**
 * Ephemeral provider input reconstructed from an Original Blob for each call.
 * It is intentionally not wire-serializable: a stream factory cannot be
 * persisted and is never stored in an ImportRecord.
 */
export interface ExtractionInput {
  readonly fileName: string
  readonly sizeBytes: number
  readonly open: () => ReadableStream<Uint8Array>
}

/** Prepare an upload of one local file. */
export interface PrepareUploadRequest extends ExtractionRequestOptions {
  /** File name as the user chose it (extension drives the provider's format detection). */
  readonly fileName: string
  /** Exact byte size of the file, verified by the upload route against Content-Length. */
  readonly sizeBytes: number
  /** Business-layer import identity attached to the provider task. */
  readonly dataId: string
}

/** Result of {@link DocumentExtractorProvider.prepareUpload}. */
export interface PreparedProviderUpload {
  /** The provider task that polling must use once the upload lands. */
  readonly task: ProviderTask
  /** One-shot signed upload URL; must never be persisted by the caller. */
  readonly signedUploadUrl: string
  /** Absolute expiry of the signed URL, when the provider reports one. */
  readonly expiresAt?: number
}

/** Submit an extraction for a remote URL document. */
export interface SubmitUrlRequest extends ExtractionRequestOptions {
  /** Absolute http(s) URL of the document. */
  readonly url: string
  /** Business-layer import identity attached to the provider task. */
  readonly dataId: string
}

/**
 * Provider-reported extraction progress. `waiting-upload` means the provider
 * has not received the file yet; `done` carries the result archive URL.
 */
export type ExtractionProgress =
  | { readonly state: 'waiting-upload' }
  | { readonly state: 'pending' }
  | {
    readonly state: 'running'
    readonly extractedPages?: number
    readonly totalPages?: number
  }
  | { readonly state: 'converting' }
  | { readonly state: 'done'; readonly resultUrl: string }
  | {
    readonly state: 'failed'
    readonly code?: string
    readonly message: string
  }

/**
 * One document-extraction backend. Implementations own transport, retry
 * policy, response validation, and credential resolution; the business layer
 * sees only these contracts.
 */
export interface DocumentExtractorProvider {
  /** Stable provider id, matched against `Config.provider`. */
  readonly id: ExtractionProviderId

  /** Product family name for display only; business routing uses {@link id}. */
  readonly kind: string

  /** Browser-safe runtime connection metadata; never includes credential values. */
  connectionDescriptor?(): ExtractionConnectionConfig & { readonly credentialRef?: string }

  /** Apply validated non-secret configuration to the live provider instance. */
  configureConnection?(config: ExtractionConnectionConfig): void

  /** Disabled providers may finish durable jobs but must reject new admission. */
  acceptingNewJobs?(): boolean

  /** Return a safe health snapshot without exposing credentials or transport details. */
  health(signal: AbortSignal): Promise<ExtractionHealth>

  /**
   * Submit one browser-captured original.  The adapter owns any signed URL,
   * Authorization header, upload, and upstream task creation.
   */
  submit?(input: ExtractionInput, request: PrepareUploadRequest, signal: AbortSignal): Promise<{ readonly task: ProviderTask }>

  /**
   * Request a signed upload URL for one file. The caller performs the actual
   * file upload against {@link PreparedProviderUpload.signedUploadUrl}; the
   * provider must not require an extra submission call afterwards.
   * @param request - file identity, options, and business data id.
   * @param signal - aborts the provider's own network work.
   * @returns the upload URL and the task to poll once uploaded.
   */
  prepareUpload(request: PrepareUploadRequest, signal: AbortSignal): Promise<PreparedProviderUpload>

  /**
   * Submit extraction for a remote URL document.
   * @param request - url, options, and business data id.
   * @param signal - aborts the provider's own network work.
   * @returns the single task to poll.
   */
  submitUrl(request: SubmitUrlRequest, signal: AbortSignal): Promise<{ readonly task: ProviderTask }>

  /**
   * Poll one previously created task.
   * @param task - the task handle returned by prepare/submit.
   * @param signal - aborts the provider's own network work.
   * @returns the current progress snapshot.
   */
  poll(task: ProviderTask, signal: AbortSignal): Promise<ExtractionProgress>

  /** Request cancellation. `upstream-unsupported` means only local work stopped. */
  cancel(task: ProviderTask, signal: AbortSignal): Promise<{ readonly outcome: 'cancelled' | 'already-finished' | 'upstream-unsupported' }>

  /** Download and validate the provider result into a caller-owned temporary path. */
  collect(task: ProviderTask, destination: string, signal: AbortSignal): Promise<ExtractionArtifact>

  /** Interpret saved provider artifacts without polling or network access. */
  normalizeArtifacts?(artifactPath: string, limits: ArchiveLimits, putAsset: (data: Uint8Array, name: string) => Promise<BlobKey>, signal: AbortSignal): Promise<NormalizedDocument>
}

/** Provider registry plugin config: the explicit provider selection. */
export interface Config {
  /** Id of the provider to use; must match a `registerProvider` id. */
  provider: string
}

/** Schemastery config: provider is mandatory — there is no default backend. */
export const Config: z<Config> = z.object({
  provider: z.string().required(),
})

/** Cordis plugin name of the Service Definition row. */
export const name = 'document-extraction'

/**
 * The document-extraction registry service. Providers register through
 * {@link registerProvider}; every operation resolves the configured provider
 * fresh from the registration table.
 */
export class DocumentExtractionService extends Service {
  private readonly providers = new Map<ExtractionProviderId, DocumentExtractorProvider>()
  private readonly normalizers = new Map<string, ArtifactNormalizer>()
  private readonly providerListeners = new Set<(providerId: ExtractionProviderId) => void>()

  /**
   * @param ctx - Cordis context; the service registers as `documentExtraction`.
   * @param config - validated plugin config carrying the explicit provider id.
   */
  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx, 'documentExtraction')
  }

  /**
   * Register one provider. Registration is an effect: the returned disposer
   * removes it again, and the provider is selected per operation by id, never
   * by registration order.
   * @param provider - the provider implementation.
   * @returns the disposer unregistering it.
   */
  registerProvider(provider: DocumentExtractorProvider): () => void {
    this.providers.set(provider.id, provider)
    for (const listener of this.providerListeners) listener(provider.id)
    return () => {
      // A replacement may register under the same id before the old fiber is
      // disposed during HMR. The old disposer must not delete the new provider.
      if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id)
    }
  }

  /**
   * Observe live provider registration without imposing plugin-row ordering.
   * Cordis may initialize sibling rows concurrently; consumers that project
   * provider metadata must therefore react to availability instead of
   * assuming registration has already happened during their own apply().
   */
  observeProviders(listener: (providerId: ExtractionProviderId) => void): () => void {
    this.providerListeners.add(listener)
    for (const providerId of this.providers.keys()) listener(providerId)
    return () => { this.providerListeners.delete(listener) }
  }

  /** Register a pure artifact normalizer. It has no endpoint or credential dependency. */
  registerArtifactNormalizer(normalizer: ArtifactNormalizer): () => void {
    this.normalizers.set(normalizer.id, normalizer)
    return () => { if (this.normalizers.get(normalizer.id) === normalizer) this.normalizers.delete(normalizer.id) }
  }

  /** Read local normalizer metadata without resolving a provider or credentials. */
  artifactNormalizer(normalizerId: string): Pick<ArtifactNormalizer, 'id' | 'providerKind' | 'artifactSchemaVersion' | 'version'> | undefined {
    const normalizer = this.normalizers.get(normalizerId)
    return normalizer === undefined ? undefined : {
      id: normalizer.id, providerKind: normalizer.providerKind,
      artifactSchemaVersion: normalizer.artifactSchemaVersion, version: normalizer.version,
    }
  }

  /**
   * Resolve the configured provider for one operation. Loud fail when the
   * configured id is absent — silent fallback would hide a misconfigured
   * deployment.
   * @returns the live provider instance.
   */
  private provider(providerId?: ExtractionProviderId): DocumentExtractorProvider {
    const id = providerId ?? this.config.provider as ExtractionProviderId
    const provider = this.providers.get(id)
    if (provider === undefined) {
      throw new StudyError(
        `document-extraction: provider "${String(id)}" is not registered`,
        'PROVIDER_NOT_FOUND',
      )
    }
    return provider
  }

  private defaultProviderForNewJob(): DocumentExtractorProvider {
    const provider = this.provider()
    if (provider.acceptingNewJobs?.() === false) throw new StudyError('configured extraction provider is disabled', 'PROVIDER_DISABLED')
    return provider
  }

  /** Id selected for newly created jobs; existing jobs persist an explicit id. */
  defaultProviderId(): ExtractionProviderId {
    return this.config.provider as ExtractionProviderId
  }

  /** Safe durable provenance for a collected artifact. */
  describeProvider(providerId: ExtractionProviderId): { readonly providerKind: string; readonly configFingerprint: string; readonly adapterVersion: number } {
    const provider = this.provider(providerId)
    return { providerKind: provider.kind, configFingerprint: `${provider.id}:${provider.kind}`, adapterVersion: 1 }
  }

  /**
   * Prepare an upload through the currently configured provider.
   * @param request - file identity, options, and business data id.
   * @param signal - aborts the provider's network work.
   * @returns the signed upload URL and task handle.
   */
  prepareUpload(request: PrepareUploadRequest, signal: AbortSignal): Promise<PreparedProviderUpload> {
    return this.defaultProviderForNewJob().prepareUpload(request, signal)
  }

  /** Submit an original through the selected provider without exposing transport URLs. */
  async submit(input: ExtractionInput, request: PrepareUploadRequest, signal: AbortSignal): Promise<{ readonly task: ProviderTask }> {
    const provider = this.defaultProviderForNewJob()
    if (provider.submit === undefined) throw new StudyError('configured provider does not support browser uploads', 'PROVIDER_UPLOAD_UNSUPPORTED')
    return await provider.submit(input, request, signal)
  }

  /**
   * Submit a URL extraction through the currently configured provider.
   * @param request - url, options, and business data id.
   * @param signal - aborts the provider's network work.
   * @returns the single task handle to poll.
   */
  submitUrl(request: SubmitUrlRequest, signal: AbortSignal): Promise<{ readonly task: ProviderTask }> {
    return this.defaultProviderForNewJob().submitUrl(request, signal)
  }

  /**
   * Poll a task through the currently configured provider.
   * @param task - the task handle from prepare/submit.
   * @param signal - aborts the provider's network work.
   * @returns the current progress snapshot.
   */
  poll(task: ProviderTask, signal: AbortSignal): Promise<ExtractionProgress> {
    return this.provider().poll(task, signal)
  }

  /** Resolve an explicit durable provider id, or the configured default for a new job. */
  pollFor(providerId: ExtractionProviderId, task: ProviderTask, signal: AbortSignal): Promise<ExtractionProgress> {
    return this.provider(providerId).poll(task, signal)
  }

  /** Collect an existing task through its durable provider instance. */
  collect(providerId: ExtractionProviderId, task: ProviderTask, destination: string, signal: AbortSignal): Promise<ExtractionArtifact> {
    return this.provider(providerId).collect(task, destination, signal)
  }

  /** Re-normalize a saved artifact with its original provider instance only. */
  async normalizeArtifacts(providerId: ExtractionProviderId, artifactPath: string, limits: ArchiveLimits, putAsset: (data: Uint8Array, name: string) => Promise<BlobKey>, signal: AbortSignal): Promise<NormalizedDocument> {
    const provider = this.provider(providerId)
    if (provider.normalizeArtifacts === undefined) throw new StudyError('provider cannot normalize saved artifacts', 'PROVIDER_NORMALIZER_UNAVAILABLE')
    signal.throwIfAborted()
    return await provider.normalizeArtifacts(artifactPath, limits, putAsset, signal)
  }

  /** Normalize a retained artifact solely by its persisted normalizer identity. */
  async normalizeArtifactSet(normalizerId: string, artifactSchemaVersion: number, artifactPath: string, limits: ArchiveLimits, putAsset: (data: Uint8Array, name: string) => Promise<BlobKey>, signal: AbortSignal): Promise<NormalizedDocument> {
    const normalizer = this.normalizers.get(normalizerId)
    if (normalizer === undefined) throw new StudyError(`normalizer "${normalizerId}" is not registered`, 'NORMALIZER_NOT_REGISTERED')
    if (normalizer.artifactSchemaVersion !== artifactSchemaVersion) throw new StudyError(`artifact schema ${artifactSchemaVersion} is unsupported`, 'ARTIFACT_SCHEMA_UNSUPPORTED')
    signal.throwIfAborted()
    return await normalizer.normalize(artifactPath, limits, putAsset, signal)
  }

  /** Cancel an existing task through its durable provider instance. */
  cancel(providerId: ExtractionProviderId, task: ProviderTask, signal: AbortSignal): Promise<{ readonly outcome: 'cancelled' | 'already-finished' | 'upstream-unsupported' }> {
    return this.provider(providerId).cancel(task, signal)
  }

  /** Check the current default provider or a durable provider instance. */
  health(signal: AbortSignal, providerId?: ExtractionProviderId): Promise<ExtractionHealth> {
    return this.provider(providerId).health(signal)
  }

  /** Project one provider's non-secret runtime connection metadata. */
  connection(providerId?: ExtractionProviderId): { readonly providerId: ExtractionProviderId; readonly kind: string; readonly endpoint: string; readonly enabled: boolean; readonly model?: string; readonly credentialRef?: string; readonly options: Readonly<Record<string, string | number | boolean>> } {
    const provider = this.provider(providerId)
    const descriptor = provider.connectionDescriptor?.()
    if (descriptor === undefined) throw new StudyError('provider does not expose a configurable connection', 'PROVIDER_CONNECTION_UNSUPPORTED')
    return { providerId: provider.id, kind: provider.kind, ...descriptor }
  }

  /** Reconfigure only non-secret fields on a live provider. */
  configureConnection(providerId: ExtractionProviderId, config: ExtractionConnectionConfig): void {
    const provider = this.provider(providerId)
    if (provider.configureConnection === undefined) throw new StudyError('provider does not support runtime connection changes', 'PROVIDER_CONNECTION_UNSUPPORTED')
    provider.configureConnection(config)
  }
}

/**
 * Mount the Service Definition: construct the registry over validated config.
 * @param ctx - Cordis context.
 * @param config - validated plugin config.
 * @returns resolution after the service is provided.
 */
export function apply(ctx: Context, config: Config): void {
  new DocumentExtractionService(ctx, config)
}
