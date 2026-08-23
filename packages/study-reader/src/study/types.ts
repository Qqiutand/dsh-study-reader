/**
 * Study domain vocabulary: branded ids, durable records, normalized blocks,
 * the argument-graph artifact, and the client-facing views.
 * @module @deepseek-ai/dsh-study/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ExtractionArtifactSetId, ExtractionProviderId, ProviderTaskId } from '../extraction/index.ts'
import type { BlobKey } from './blob-store.ts'
import type { DossierId, RevisionId as ProtocolRevisionId, SourceId as ProtocolSourceId } from '../protocol/ids.ts'
import type {
  SessionSourceSelectionRecord,
  StudyMemoryId,
  StudyMemoryKind,
  StudyMemoryRecord,
  StudyMemoryScope,
} from '../memory/types.ts'
import type {
  BookmarkData, CalibrationData, CognitiveIntent, CognitiveLens, CognitiveOptionSelectedData,
  CognitiveContextPreparedData, CognitiveEnqueuedData, CognitiveProbeGeneratedData, CognitiveRequestedData, DossierGeneratedData, FeynmanRequestedData, FrictionData,
  HighlightData, ReviewAttemptedData, ReviewCardGeneratedData, SocraticGeneratedData, SocraticResponseData,
  SourceImportedData, ToulminRequestedData,
  StudyEventDataMap, StudyEventType,
} from '../protocol/events.ts'
export type { DossierId } from '../protocol/ids.ts'
export type {
  CompileInjectionPreviewRequest,
  CompiledInjection,
  ExecuteInjectionStudioCommandRequest,
  ExecuteInjectionStudioCommandResult,
  InjectionProfileRecord,
  InjectionStudioSnapshot,
  GetStudioAssetDetailRequest,
  ListStudioAssetsRequest,
  ListTreeChildrenRequest,
  PromptAssetRecord,
  ProviderConnectionRecord,
  ProviderConnectionTestResult,
  SaveProviderConnectionRequest,
  DeleteProviderConnectionRequest,
  SessionInjectionBinding,
  StudioAssetDetail,
  StudioAssetListResult,
  TreeChildrenResult,
} from '../studio/types.ts'

/** The union of all Study Reader event payloads — the wire shape of `data`. */
export type StudyEventPayload =
  | SourceImportedData
  | HighlightData
  | BookmarkData
  | FeynmanRequestedData
  | ToulminRequestedData
  | CalibrationData
  | CognitiveRequestedData
  | CognitiveEnqueuedData
  | CognitiveContextPreparedData
  | CognitiveProbeGeneratedData
  | CognitiveOptionSelectedData
  | SocraticGeneratedData
  | SocraticResponseData
  | FrictionData
  | ReviewCardGeneratedData
  | ReviewAttemptedData
  | DossierGeneratedData

/** Nominal id of one study source (a book, paper, or document). */
export type SourceId = ProtocolSourceId
/** Nominal id of one parsed revision of a source. */
export type RevisionId = ProtocolRevisionId
/** Nominal id of one import attempt (upload or URL). */
export type ImportId = Branded<'StudyImportId'>
/** Nominal id of one normalized content block. */
export type BlockId = Branded<'StudyBlockId'>
/** Nominal id of one saved argument-graph artifact. */
export type ArtifactId = Branded<'StudyArtifactId'>
export type { ExtractionArtifactSetId }
/** Durable identity for an offline artifact reprocess command. */
export type ReprocessOperationId = Branded<'ReprocessOperationId'>

/** Immutable extraction inputs retained on every generated revision. */
export interface ExtractionProvenance {
  readonly artifactSetIds: readonly ExtractionArtifactSetId[]
  readonly artifactManifestHashes: readonly string[]
  readonly providerKind: string
  readonly normalizerId: string
  readonly normalizerVersion: number
  readonly canonicalizerVersion: number
}

/** A restart-safe, Host-only offline artifact reprocess operation. */
export interface ReprocessOperationRecord {
  readonly schemaVersion: 1
  readonly id: ReprocessOperationId
  readonly commandId: string
  readonly importId: ImportId
  readonly sourceId: SourceId
  readonly artifactSetIds: readonly ExtractionArtifactSetId[]
  readonly artifactManifestHashes: readonly string[]
  readonly expectedCurrentRevisionId?: RevisionId
  readonly normalizerId: string
  readonly normalizerVersion: number
  readonly canonicalizerVersion: number
  readonly state: 'pending' | 'normalizing' | 'writing-blobs' | 'revision-prepared' | 'activating' | 'committed' | 'completed-not-activated' | 'failed' | 'cancelled'
  readonly preparedRevisionId?: RevisionId
  readonly activated: boolean
  readonly failure?: {
    readonly stage: 'validation' | 'normalizing' | 'writing-blobs' | 'indexing' | 'activating'
    readonly code: string
    readonly message: string
    readonly retryable: boolean
  }
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** One immutable blob in a collected extraction artifact set. */
export interface ExtractionArtifactRecord {
  readonly role: 'archive' | 'content-list' | 'markdown' | 'asset'
  readonly mediaType: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly blobKey: BlobKey
  readonly fileName?: string
}

/** Persisted, secret-free record that permits offline normalization after restart. */
export interface ExtractionArtifactSetRecord {
  readonly schemaVersion: 1
  readonly id: ExtractionArtifactSetId
  readonly importId: ImportId
  readonly sourceId: SourceId
  /** The provider job that produced this set, either the whole import or one PDF part. */
  readonly scope:
    | { readonly kind: 'whole' }
    | { readonly kind: 'part'; readonly index: number; readonly startPage?: number; readonly endPage?: number }
  readonly providerInstanceId: ExtractionProviderId
  readonly providerKind: string
  readonly providerJobId: ProviderTaskId
  readonly providerTaskKind: 'single' | 'batch'
  readonly configFingerprint: string
  readonly adapterVersion: number
  readonly artifactSchemaVersion: number
  readonly normalizerId: string
  readonly collectedAt: number
  readonly artifacts: readonly ExtractionArtifactRecord[]
  /** SHA-256 of the deterministic manifest projection; the set identity seed. */
  readonly manifestSha256: string
  /** Content-addressed UTF-8 JSON manifest. It deliberately is not an artifact. */
  readonly manifestBlob: BlobKey
}

/** Supported source formats. EPUB uses logical spine positions as pages. */
export type DocumentFormat = 'pdf' | 'epub' | 'other'

/** Durable source metadata. */
export interface SourceRecord {
  readonly id: SourceId
  /** Human-facing title extracted from document metadata when available. */
  readonly displayTitle: string
  readonly title: string
  /** Creators extracted from EPUB OPF or PDF Document Info. */
  readonly authors: readonly string[]
  /** Exact upload name, retained separately from display metadata. */
  readonly originalFileName: string
  readonly kind: 'book' | 'paper' | 'document'
  /** Original container format when known. Optional for records created before v0.2. */
  readonly format?: DocumentFormat
  /** Revision the tools currently read; absent until the first import lands. */
  readonly currentRevisionId?: RevisionId
  readonly createdAt: number
  readonly updatedAt: number
}

/** Durable grant allowing one agent session to discover and read one source. */
export interface SourceAccessRecord {
  readonly sessionId: string
  readonly sourceId: SourceId
  readonly grantedAt: number
}

/** One parsed revision of a source; heavy content lives in content-addressed blobs. */
export interface RevisionRecord {
  readonly id: RevisionId
  readonly sourceId: SourceId
  /** Provider provenance is opaque to the study core; readers retain the original file. */
  readonly providerId: string
  readonly providerKind: string
  readonly providerModel: string
  /** Original container format and media metadata, optional for legacy revisions. */
  readonly format?: DocumentFormat
  readonly mediaType?: string
  readonly fileName?: string
  /** Original uploaded file kept as a content-addressed blob for faithful rendering. */
  readonly originalBlob?: string
  /** Provider raw artifact and manifest retained for a normalizer-only retry. */
  readonly extractionArtifactBlob?: string
  readonly extractionManifestBlob?: string
  /** Immutable, provider-neutral inputs and local canonicalization protocol. */
  readonly extractionProvenance?: ExtractionProvenance
  /** EPUB spine item count; for EPUB this equals the logical page count. */
  readonly spineCount?: number
  readonly pageCount?: number
  readonly blockCount: number
  /** Content-addressed blob key of the normalized Markdown. */
  readonly markdownBlob: string
  /** Content-addressed blob key of the normalized blocks JSONL. */
  readonly blocksBlob: string
  /** Every asset used by this revision. New revisions always write this sorted, unique list. */
  readonly assetBlobs?: readonly BlobKey[]
  /** Deterministic section tree. */
  readonly outline: readonly OutlineItem[]
  /** Content hash (sha256 of the id-free blocks projection); the BlockId seed. */
  readonly sha256: string
  readonly createdAt: number
}

/** Durable, conservative two-pass deletion candidate for one content blob. */
export interface BlobGcCandidateRecord {
  readonly schemaVersion: 1
  readonly blobKey: BlobKey
  readonly firstSeenUnreferencedAt: number
  readonly lastCheckedAt: number
  readonly observedSizeBytes: number
}

export interface BlobGcResult {
  readonly scanned: number
  readonly live: number
  readonly recentSkipped: number
  readonly candidatesMarked: number
  readonly candidatesCleared: number
  readonly deleted: number
  readonly reclaimedBytes: number
  readonly remainingCandidates: number
  /** Safety failures (scan or individual deletion I/O); never ignored. */
  readonly failures: number
}

/** One import attempt. The signed upload URL and result archive URL never enter this record. */
export type ImportState =
  | 'awaiting-upload'
  | 'uploading'
  | 'queued'
  | 'splitting'
  | 'extracting'
  | 'collecting'
  | 'normalizing'
  | 'indexing'
  | 'ready'
  | 'failed'
  | 'cancelled'

/** A provider-neutral, durable import failure. */
export interface ImportFailure {
  readonly stage: Exclude<ImportState, 'ready' | 'failed' | 'cancelled'> | 'unknown'
  readonly code: 'UPLOAD_FAILED' | 'SPLIT_FAILED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_MISCONFIGURED' | 'PROVIDER_REJECTED' | 'PROVIDER_OUTPUT_INVALID' | 'TASK_TIMEOUT' | 'COLLECTION_FAILED' | 'NORMALIZATION_FAILED' | 'INDEXING_FAILED' | 'ARTIFACT_MISSING' | 'CANCEL_FAILED' | 'INTERNAL_ERROR'
  readonly retryable: boolean
  readonly providerId?: ExtractionProviderId
  readonly providerCode?: string
  readonly message: string
  readonly occurredAt: number
}

/** Stable progress projection. Provider messages and states remain diagnostics. */
export interface ImportProgress {
  readonly completedPages?: number
  readonly totalPages?: number
  readonly completedParts?: number
  readonly totalParts?: number
  readonly currentPart?: number
  readonly updatedAt: number
}

export interface ImportRecord {
  /** Monotonic import-record format. Version 2 is the public state machine. */
  readonly schemaVersion: 2
  readonly id: ImportId
  readonly sourceId: SourceId
  readonly origin:
    | { readonly kind: 'upload'; readonly fileName: string; readonly sizeBytes: number }
    | { readonly kind: 'url'; readonly url: string }
  /** Original container format and media metadata, optional for legacy imports. */
  readonly format?: DocumentFormat
  readonly mediaType?: string
  /** Original uploaded file, committed after the same-origin upload succeeds. */
  readonly originalBlob?: string
  /** Session that initiated this import; used only for durable agent notices. */
  readonly sessionId?: string
  /** Requested library placement, captured at admission and retained through restart. */
  readonly targetFolderId?: string
  /** Extraction options retained so captured uploads can be submitted after restart. */
  readonly extraction?: {
    readonly language: string
    readonly pageRanges?: string
    readonly isOcr: boolean
    readonly enableTable: boolean
    readonly enableFormula: boolean
  }
  /** Bound when the import is created; never re-resolve this after restart. */
  readonly providerId?: ExtractionProviderId
  /** Provider task created at prepare/submit time; absent for local EPUB imports. */
  readonly providerTask?: {
    readonly kind: 'single' | 'batch'
    readonly id: string
  }
  /** Immutable collected artifact set permits offline re-normalization. */
  readonly artifactSetId?: ExtractionArtifactSetId
  /** Ordered provider tasks for a locally split PDF or captured non-PDF file. */
  readonly providerParts?: readonly ProviderPartRecord[]
  readonly state: ImportState
  /** Atomic optimistic-concurrency version, increased by every transition. */
  readonly recordVersion: number
  /** The public state transition timestamp. */
  readonly transitionedAt: number
  /** Bounded transition-id history permits retries to be safely idempotent. */
  readonly appliedTransitionIds: readonly string[]
  readonly progress?: ImportProgress
  /** Present only for the `failed` terminal state. */
  readonly failure?: ImportFailure
  readonly failedStage?: ImportFailure['stage']
  /** Present only for the `cancelled` terminal state. */
  readonly cancelledStage?: Exclude<ImportState, 'ready' | 'failed' | 'cancelled'>
  readonly cancelledAt?: number
  readonly upstreamCancellation?: 'cancelled' | 'upstream-unsupported' | 'not-required' | 'failed'
  /** `original-only` makes a ready revision explicitly non-semantic. */
  readonly semanticStatus?: 'available' | 'original-only'
  /** Revision committed by this import when ready. */
  readonly revisionId?: RevisionId
  /** A non-fatal limitation. The original document remains available to read. */
  readonly warning?: {
    readonly code: string
    readonly message: string
  }
  readonly nextPollAt?: number
  /** Poll attempts so far; drives the exponential backoff. */
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Durable state of one provider submission in a multipart import. */
export interface ProviderPartRecord {
  readonly index: number
  /** Inclusive page range in the original PDF; absent for non-PDF uploads. */
  readonly startPage?: number
  readonly endPage?: number
  readonly task: {
    readonly kind: 'single' | 'batch'
    readonly id: string
  }
  /** Immutable artifact set for this exact part task. */
  readonly artifactSetId?: ExtractionArtifactSetId
  readonly state: 'submitted' | 'pending' | 'running' | 'converting' | 'downloading' | 'normalizing' | 'ready'
  readonly blocksBlob?: string
  readonly attempts: number
  readonly nextPollAt?: number
}

/** One saved argument-graph artifact (persisted copy of the validated graph). */
export interface ArtifactRecord {
  readonly id: ArtifactId
  readonly sourceId: SourceId
  readonly revisionId: RevisionId
  readonly title: string
  readonly graph: ArgumentGraph
  readonly nodeCount: number
  readonly edgeCount: number
  readonly createdAt: number
}

/** One durable study interaction event, persisted in the study domain (not the session log). */
export interface StudyEventRecord {
  /** Monotonic sequence within one session, starting at 0. */
  readonly seq: number
  /** The session that produced the event (browser sessionId or agent session id). */
  readonly sessionId: string
  /** One of the registered `study/*` event types. */
  readonly type: string
  /** Optional idempotency key supplied by the browser/agent caller. */
  readonly clientEventId?: string
  /** The event payload; one of the registered study event payload shapes. */
  readonly data: StudyEventPayload
  readonly createdAt: number
}

/** One generated study dossier, persisted host-side. */
export interface DossierRecord {
  readonly id: DossierId
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly title: string
  readonly content: string
  readonly stats: {
    readonly highlightsCount: number
    readonly bookmarksCount: number
    readonly frictionsResolvedCount: number
    readonly socraticQuestionsCount: number
    readonly cardsCount: number
  }
  readonly createdAt: number
}

/** One normalized content block of a revision. */
export interface StudyBlock {
  /** Deterministic: sha256(revisionSha256 + "\0" + ordinal + "\0" + normalizedText). */
  readonly id: BlockId
  /** Position in the revision's block sequence, 0-based. */
  readonly ordinal: number
  /** Product-level page number, 1-based; 0 means the format carries no page (Markdown fallback). */
  readonly page: number
  /** Provider-reported 0-based page index; -1 when absent. */
  readonly providerPageIndex: number
  readonly type:
    | 'title'
    | 'paragraph'
    | 'list'
    | 'table'
    | 'equation'
    | 'image'
    | 'code'
    | 'footnote'
    | 'other'
  /** Section path from the root (headings above this block). */
  readonly headingPath: readonly string[]
  readonly text: string
  readonly bbox?: readonly [number, number, number, number]
  /** Source-native semantic location when the importer can determine one. */
  readonly sourceLocator?: {
    readonly kind: 'epub-xhtml'
    readonly href: string
    /** Zero-based spine position of the XHTML resource. */
    readonly spineIndex: number
    readonly startOffset: number
    readonly endOffset: number
  }
  /** Blob key of the extracted asset (image), when the archive carried one. */
  readonly assetPath?: string
}

/** One entry of the deterministic section tree. */
export interface OutlineItem {
  /** Deterministic section id used by browser preview and Host evidence adapters. */
  readonly id: string
  readonly title: string
  /** 1-based heading depth. */
  readonly depth: number
  /** Page of the heading block (1-based; 0 when unknown). */
  readonly page: number
  /** Ordinal range [start, end) of blocks belonging to this section. */
  readonly startOrdinal: number
  readonly endOrdinal: number
}

/** One quote-anchored citation of a graph node. */
export interface Citation {
  readonly sourceId: SourceId
  readonly revisionId: RevisionId
  readonly blockId: BlockId
  readonly page: number
  readonly quote?: string
}

/** One node of an argument graph. */
export interface ArgumentGraphNode {
  readonly id: string
  readonly type:
    | 'definition'
    | 'premise'
    | 'claim'
    | 'evidence'
    | 'objection'
    | 'reply'
    | 'conclusion'
  readonly label: string
  readonly explanation: string
  /** Whether the node restates the author or is the AI's inference. */
  readonly epistemic: 'author-explicit' | 'ai-inference'
  readonly confidence: number
  readonly citations: readonly Citation[]
}

/** One edge of an argument graph. */
export interface ArgumentGraphEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly type: 'supports' | 'depends_on' | 'contradicts' | 'qualifies'
  readonly label?: string
}

/** The argument-graph artifact schema version 1. */
export interface ArgumentGraph {
  readonly schemaVersion: 1
  readonly title: string
  readonly nodes: readonly ArgumentGraphNode[]
  readonly edges: readonly ArgumentGraphEdge[]
}

/** Source summary for the picker and tool results. */
export interface SourceSummary {
  readonly id: SourceId
  readonly title: string
  readonly authors?: readonly string[]
  readonly originalFileName?: string
  /** Monotonic source-record revision token for destructive-action CAS. */
  readonly recordVersion: number
  readonly kind: 'book' | 'paper' | 'document'
  /** Explicit format avoids inferring EPUB/PDF from the broad source kind. */
  readonly format?: DocumentFormat
  readonly revisionId?: RevisionId
  readonly pageCount?: number
  /** EPUB spine resources available to the stateless chapter preview. */
  readonly sectionCount?: number
  readonly blockCount?: number
  /** Present on local-user library projections when a session is supplied. */
  readonly granted?: boolean
  /** Latest import attempt, used by the library to distinguish progress from terminal failure. */
  readonly import?: {
    readonly state: ImportRecord['state']
    readonly progress?: ImportRecord['progress']
    readonly failure?: ImportRecord['failure']
    readonly warning?: ImportRecord['warning']
    readonly updatedAt: number
  }
}

/** Canonical source/revision identity returned by every evidence operation. */
export interface EvidenceSource {
  readonly id: SourceId
  readonly revisionId: RevisionId
  readonly title: string
  readonly format: DocumentFormat
}

export interface EvidenceReadResult extends ReadResult { readonly source: EvidenceSource }
export interface EvidenceSearchResult extends SearchDocumentResult { readonly source: EvidenceSource }
export interface EvidenceOutlineResult { readonly source: EvidenceSource; readonly outline: readonly OutlineItem[] }

// ── client-facing wire views ───────────────────────────────────────────────

/** Remote result of `prepareUpload` / `renewUpload`. */
export interface PrepareUploadResult {
  readonly importId: ImportId
  /** Same-origin upload path (relative), target of the browser PUT. */
  readonly uploadPath: string
  /** One-time upload token; must be sent as `X-Study-Upload-Token`. */
  readonly uploadToken: string
  readonly expiresAt: number
}

/** Remote request of `prepareUpload`. */
export interface PrepareUploadRequest {
  readonly fileName: string
  readonly sizeBytes: number
  /** Session receiving durable Agent-visible import notices. */
  readonly sessionId?: string
  /** Library folder selected before upload; absent denotes Uncategorized. */
  readonly targetFolderId?: string
  readonly language?: string
  readonly pageRanges?: string
  readonly isOcr?: boolean
  readonly enableTable?: boolean
  readonly enableFormula?: boolean
}

/** Remote request of `submitUrl`. */
export interface SubmitUrlRequest {
  readonly url: string
  readonly language?: string
  readonly pageRanges?: string
  readonly isOcr?: boolean
  readonly enableTable?: boolean
  readonly enableFormula?: boolean
}

/** Remote view of one import's status for the client UI. */
export interface ImportStatusView {
  readonly importId: ImportId
  /** The source the import feeds; present once the import record exists. */
  readonly sourceId?: SourceId
  readonly state: ImportRecord['state']
  readonly progress?: ImportRecord['progress']
  readonly failure?: ImportRecord['failure']
  readonly warning?: ImportRecord['warning']
  /** A display-only name derived by the Host; never a provider payload. */
  readonly displayName: string
  /** The Host-computed operations currently safe for this record. */
  readonly availableActions: readonly ImportAction[]
  /** True when the in-memory signed URL is gone (process restart) and `renewUpload` is required. */
  readonly renewRequired: boolean
}

/** Provider-neutral import operations exposed by the Host capability contract. */
export type ImportAction = 'cancel' | 'retry' | 'reprocess'

/** Minimal, bounded query used by clients to restore all import projections. */
export interface ListImportStatusesRequest {
  readonly limit?: number
}

/** Client request for a Host-authorized import operation. */
export interface ImportActionRequest {
  readonly importId: ImportId
  /** Required only by the idempotent offline reprocess command. */
  readonly commandId?: string
}

/** Remote result of `bootstrap`: upload policy for the bounded library surface. */
export interface StudyBootstrapView {
  /** Same-origin prefix for original files and revision-scoped images. */
  readonly assetRoute: string
  readonly upload: {
    readonly maxFileBytes: number
    readonly acceptExtensions: readonly string[]
  }
  /** Host-configured MinerU recognition language used for a new session. */
  readonly defaultLanguage: string
  readonly cognitive: {
    readonly pollMs: number
    readonly timeoutMs: number
    /** Optional only for rolling compatibility with a pre-admission-retry Host. */
    readonly admissionAttempts?: number
    /** Optional only for rolling compatibility with a pre-admission-retry Host. */
    readonly admissionRetryMs?: number
  }
}

/** Browser-safe provider configuration and live health; secrets are status-only. */
export interface ProviderConnectionView {
  readonly id: string
  readonly providerId: string
  readonly kind: string
  readonly displayName: string
  readonly builtin: boolean
  readonly active: boolean
  readonly credentialRef: string
  readonly endpoint: string
  readonly enabled: boolean
  readonly version: number
  readonly model?: string
  readonly options: Readonly<Record<string, string | number | boolean>>
  readonly health?: {
    readonly state: 'available' | 'degraded' | 'unavailable' | 'misconfigured'
    readonly checkedAt: number
    readonly retryable: boolean
    readonly errorCode?: string
    readonly errorMessage?: string
  }
}

/** One bounded range selection shared by Host evidence and browser structure preview. */
export type ReadRange =
  | { readonly kind: 'pages'; readonly start: number; readonly end: number }
  | { readonly kind: 'section'; readonly sectionId: string }
  | { readonly kind: 'blocks'; readonly start: number; readonly end: number }

/** Read request shared by the agent tools and the browser reader. */
export interface ReadRequest {
  /** Browser session requesting the read; agent tools derive it from the current initiator. */
  readonly sessionId?: string
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly range: ReadRange
  /** Continue from this block ordinal (inclusive). */
  readonly cursor?: number
}

/** Bounded read result shared by the agent tools and the browser reader. */
export interface ReadResult {
  readonly blocks: readonly StudyBlock[]
  readonly nextCursor?: number
  readonly truncated: boolean
}

/** Browser request for full-text search across one accessible revision. */
export interface SearchDocumentRequest {
  readonly sessionId?: string
  readonly sourceId: string
  readonly revisionId?: string
  readonly query: string
  readonly limit: number
}

/** Browser full-text search results, ordered by relevance. */
export interface SearchDocumentResult {
  readonly total: number
  readonly truncated: boolean
  readonly blocks: readonly StudyBlock[]
}

/** Input for a deterministic, exhaustive literal term scan. */
export interface TermProfileRequest {
  readonly sourceId?: SourceId
  readonly revisionId?: RevisionId
  readonly terms: readonly string[]
  /** Requested evidence samples per term; the Host clamps this to three. */
  readonly sampleLimit?: number
}

/** Exhaustive literal scan result.  It is evidence about text only, not meaning or author intent. */
export interface TermProfileResult {
  readonly sourceId: SourceId
  readonly revisionId: RevisionId
  /** True only for completion of this revision-wide normalized literal scan. */
  readonly complete: true
  readonly scannedBlocks: number
  readonly terms: readonly {
    readonly input: string
    readonly normalized: string
    readonly occurrences: number
    readonly matchedBlocks: number
    readonly distinctPages: readonly number[]
    readonly distinctSections: readonly (readonly string[])[]
    readonly samples: readonly {
      readonly blockId: BlockId
      readonly page: number
      readonly headingPath: readonly string[]
      readonly context: string
      readonly sourceLocator?: StudyBlock['sourceLocator']
    }[]
    readonly samplesTruncated: boolean
  }[]
}

/** Remote request of `listSources`. */
export interface ListSourcesRequest {
  readonly query?: string
  readonly limit?: number
  /** `session` returns only explicitly granted sources; `library` returns the managed library. */
  readonly scope?: 'library' | 'session'
  readonly sessionId?: string
}

/** Remote request of `getOutline`. */
export interface GetOutlineRequest {
  readonly sessionId?: string
  readonly sourceId: string
  readonly revisionId?: string
}

/** Remote request to grant or revoke one source for an agent session. */
export interface SetSourceAccessRequest {
  readonly sessionId: string
  readonly sourceId: string
  readonly granted: boolean
}

/** Remote result of changing one session-source grant. */
export interface SetSourceAccessResult {
  readonly granted: boolean
  /** Authoritative selection after the access mutation (revocation may clear it). */
  readonly selection: SessionSourceSelectionView
}

/** Atomically grant (when needed) and select one ready source for a session. */
export interface OpenSourceForSessionRequest {
  readonly sessionId: string
  readonly sourceId: string
  readonly revisionId?: string
  readonly expectedSelectionVersion: number
  readonly commandId: string
}

export interface OpenSourceForSessionResult {
  readonly selection: SessionSourceSelectionView
  readonly source: SourceSummary
}

/** Consistent browser projection of library rows and the authoritative selection. */
export interface LibrarySnapshot {
  readonly selection: SessionSourceSelectionView
  readonly selectedSource?: SourceSummary
  readonly sources: readonly SourceSummary[]
  readonly assetRoute: string
  readonly defaultLanguage: string
  readonly folders: readonly { readonly id: string; readonly name: string }[]
  readonly activeImports: readonly ImportStatusView[]
}

export interface GetSourcePreviewRequest {
  readonly sessionId: string
  readonly sourceId: string
  readonly revisionId?: string
  readonly sectionId?: string
}

/** One stateless preview unit. EPUB units are spine documents, never headings. */
export interface PreviewSection {
  readonly id: string
  readonly title: string
  readonly startOrdinal: number
  readonly endOrdinalExclusive: number
  readonly page?: number
  readonly href?: string
  readonly spineIndex?: number
}

/** Browser-only, bounded preview contract; never exposed as an Agent tool. */
export type SourcePreview =
  | {
      readonly kind: 'pdf'
      readonly title: string
      readonly originalUrl: string
      /** Downloadable ZIP containing normalized MinerU Markdown, blocks, metadata, and images. */
      readonly semanticExportUrl?: string
      readonly pageCount?: number
      /** Stateless MinerU outline used only by the browser preview. */
      readonly sections: readonly PreviewSection[]
      readonly activeSectionId?: string
      /** MinerU-normalized semantic content; empty for original-only fallback imports. */
      readonly blocks: readonly StudyBlock[]
      readonly truncated: boolean
      readonly semanticAvailable: boolean
    }
  | {
      readonly kind: 'epub' | 'other'
      readonly title: string
      readonly originalUrl?: string
      readonly sections: readonly PreviewSection[]
      readonly activeSectionId?: string
      readonly blocks: readonly StudyBlock[]
      readonly truncated: boolean
    }

/** Remote request to permanently remove one source and its database records. */
export interface DeleteSourceRequest {
  readonly sourceId: string
  /** Exact current title; prevents deleting a stale or misidentified source. */
  readonly expectedTitle: string
  /** Session receiving the durable deletion notice, when available. */
  readonly sessionId?: string
}

/** Counts of records removed by one source deletion. */
export interface DeleteSourceResult {
  readonly deleted: true
  readonly removed: {
    readonly sourceAccess: number
    readonly revisions: number
    readonly imports: number
    readonly artifacts: number
    readonly events: number
    readonly dossiers: number
    readonly memories: number
    /** Independently durable reader locations removed with the source. */
    readonly readerPositions: number
  }
}

/** Remote request of `importStatus`. */
export interface ImportStatusRequest {
  readonly importId: string
}

/** Remote request of `renewUpload`. */
export interface RenewUploadRequest {
  readonly importId: string
}

/**
 * Start one normal Agent turn for a historical Bookroom cognitive
 * interaction.
 * @deprecated New UI must use the native Composer; this remains readable so
 * old event streams and explicit legacy callers can be diagnosed/replayed.
 */
export interface StartCognitiveRequest {
  readonly sessionId: string
  readonly requestId: string
  readonly parentRequestId?: string
  readonly sourceId: string
  readonly revisionId: string
  readonly page: number
  readonly blockIds: readonly string[]
  readonly selectedText: string
  readonly kind: 'passage' | 'answer'
  readonly lens: CognitiveLens
  readonly intent: CognitiveIntent
  readonly question?: string
  readonly userAnswer?: string
}

/** Admission result; completion arrives as a replayable Study Event. */
export interface StartCognitiveResult {
  readonly accepted: true
  readonly requestId: string
}

/** Events that an authenticated browser interaction may request. */
export type BrowserWritableStudyEventType =
  | 'study/highlight'
  | 'study/bookmark'
  | 'study/calibration'
  | 'study/cognitive-option-selected'
  | 'study/friction'
  | 'study/review-attempted'

/** Internal event append identity. Browser callers use `ExecuteStudyCommandRequest` instead. */
interface EmitStudyEventRequestBase {
  /** The browser session id; events are partitioned per session. */
  readonly sessionId: string
  /** Optional idempotency key supplied by the browser/agent caller. */
  readonly clientEventId?: string
}

/** Correlated Remote request; the literal event type selects its exact payload. */
export type EmitStudyEventRequest = {
  [Type in BrowserWritableStudyEventType]: EmitStudyEventRequestBase & {
    readonly type: Type
    readonly data: StudyEventDataMap[Type]
  }
}[BrowserWritableStudyEventType]

/**
 * Browser command vocabulary. These names describe permitted user actions;
 * the browser never chooses a durable `study/*` event type directly.
 */
export type BrowserStudyCommand =
  | { readonly kind: 'add-highlight'; readonly data: StudyEventDataMap['study/highlight'] }
  | { readonly kind: 'add-bookmark'; readonly data: StudyEventDataMap['study/bookmark'] }
  | { readonly kind: 'record-calibration'; readonly data: StudyEventDataMap['study/calibration'] }
  | { readonly kind: 'select-cognitive-option'; readonly data: StudyEventDataMap['study/cognitive-option-selected'] }
  | { readonly kind: 'record-friction'; readonly data: StudyEventDataMap['study/friction'] }
  | { readonly kind: 'attempt-review'; readonly data: StudyEventDataMap['study/review-attempted'] }

/** One typed browser command, keyed for durable idempotent replay. */
export interface ExecuteStudyCommandRequest {
  readonly sessionId: string
  readonly commandId: string
  readonly command: BrowserStudyCommand
}

/** Convert a permitted browser command into the internal event it authorizes. */
export function browserStudyCommandEvent(command: BrowserStudyCommand): {
  readonly type: BrowserWritableStudyEventType
  readonly data: StudyEventDataMap[BrowserWritableStudyEventType]
} {
  switch (command.kind) {
    case 'add-highlight': return { type: 'study/highlight', data: command.data }
    case 'add-bookmark': return { type: 'study/bookmark', data: command.data }
    case 'record-calibration': return { type: 'study/calibration', data: command.data }
    case 'select-cognitive-option': return { type: 'study/cognitive-option-selected', data: command.data }
    case 'record-friction': return { type: 'study/friction', data: command.data }
    case 'attempt-review': return { type: 'study/review-attempted', data: command.data }
    default: throw new Error(`unknown browser study command ${(command as { readonly kind?: unknown }).kind as string}`)
  }
}

/** Convert an existing client action into its explicit browser command. */
export function browserStudyCommandFromEvent(request: EmitStudyEventRequest): BrowserStudyCommand {
  switch (request.type) {
    case 'study/highlight': return { kind: 'add-highlight', data: request.data }
    case 'study/bookmark': return { kind: 'add-bookmark', data: request.data }
    case 'study/calibration': return { kind: 'record-calibration', data: request.data }
    case 'study/cognitive-option-selected': return { kind: 'select-cognitive-option', data: request.data }
    case 'study/friction': return { kind: 'record-friction', data: request.data }
    case 'study/review-attempted': return { kind: 'attempt-review', data: request.data }
    default: throw new Error('event is not a browser study command')
  }
}

/** Internal Host event append request; never exposed through the browser Remote. */
export type AppendStudyEventRequest = {
  [Type in StudyEventType]: EmitStudyEventRequestBase & {
    readonly type: Type
    readonly data: StudyEventDataMap[Type]
  }
}[StudyEventType]

/** Remote result of one browser Study command. */
export interface EmitStudyEventResult {
  /** The assigned monotonic sequence within the session. */
  readonly seq: number
}

/** Remote request of `generateDossier`: synthesize and persist a study dossier. */
export interface GenerateDossierRequest {
  /** The browser session id; its events fold into the dossier. */
  readonly sessionId: string
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly title: string
}

/** Remote result of `generateDossier`. */
export interface GenerateDossierResult {
  readonly dossierId: string
  readonly markdown: string
  readonly sectionCount: number
}

export interface GetSessionSourceSelectionRequest { readonly sessionId: string }
export interface SetSessionSourceSelectionRequest {
  readonly sessionId: string
  readonly sourceId?: string | null
  readonly revisionId?: string | null
  readonly expectedVersion: number
  readonly commandId: string
}
export type SessionSourceSelectionView = SessionSourceSelectionRecord

/** Browser-safe projection of one authoritative runtime Tool contract. */
export interface ToolDescriptorView {
  readonly name: string
  readonly title: string
  readonly category: string
  readonly description: string
  readonly whenToUse: readonly string[]
  readonly whenNotToUse: readonly string[]
  readonly nextActions: readonly string[]
  readonly risk: 'read' | 'navigate' | 'write'
  readonly sideEffects: 'none' | 'reader-navigation' | 'persistent-note-write'
  readonly requiredCapabilities: readonly string[]
  readonly sourceResolution: string
  readonly parametersJson: string
  readonly outputJson: string
  readonly limits: Readonly<Record<string, number>>
  readonly implementationChain: readonly string[]
  readonly specVersion: number
  readonly schemaHash: string
  readonly enabledInCurrentProfile: boolean
  readonly effectiveDescription: string
  readonly localized?: {
    readonly en: {
      readonly title: string
      readonly description: string
      readonly whenToUse: readonly string[]
      readonly whenNotToUse: readonly string[]
      readonly nextActions: readonly string[]
      readonly sourceResolution: string
      readonly effectiveDescription: string
    }
  }
}

/** Memory row with caller-specific deletion authority. */
export interface StudyMemoryView extends StudyMemoryRecord {
  readonly canDelete: boolean
}

/** Query memories visible in one granted source. */
export interface ListStudyMemoriesRequest {
  readonly sessionId: string
  readonly sourceId: string
  readonly revisionId?: string
  readonly scope?: StudyMemoryScope
  readonly query?: string
  readonly limit?: number
}

export interface ListStudyMemoriesResult {
  readonly memories: readonly StudyMemoryView[]
}

/** Explicit reader action that creates a session- or source-scoped memory. */
export interface RememberStudyMemoryRequest {
  readonly sessionId: string
  readonly memoryId?: string
  readonly scope: StudyMemoryScope
  readonly kind: StudyMemoryKind
  readonly sourceId: string
  readonly text: string
  readonly note?: string
  readonly tags?: readonly string[]
  readonly anchor?: {
    readonly revisionId: string
    readonly page: number
    readonly blockIds: readonly string[]
    readonly selectedText: string
  }
}

export interface RememberStudyMemoryResult {
  readonly memory: StudyMemoryView
}

/** Delete a memory owned by the calling session. */
export interface ForgetStudyMemoryRequest {
  readonly sessionId: string
  readonly memoryId: StudyMemoryId | string
}

export interface ForgetStudyMemoryResult {
  readonly deleted: boolean
}
