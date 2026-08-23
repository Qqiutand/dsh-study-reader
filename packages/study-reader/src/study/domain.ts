/**
 * The `study_reader` storage domain: zod-validated tables for sources,
 * revisions, imports, and argument-graph artifacts.
 * @module @deepseek-ai/dsh-study/domain
 */

import z from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DossierId } from '../protocol/ids.ts'
import type { ArtifactId, BlockId, ExtractionArtifactSetId, ImportId, ReprocessOperationId, RevisionId, SourceId } from './types.ts'
import { AGENT_GRANTS } from './management.ts'
import {
  assetFolderRecordSchema,
  injectionProfileRecordSchema,
  injectionStudioCommandReceiptSchema,
  providerConnectionCommandReceiptSchema,
  providerConnectionRecordSchema,
  promptAssetRecordSchema,
  sessionInjectionBindingSchema,
} from '../studio/domain.ts'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, 'expected a SHA-256 hex digest')
const blobKeySchema = z.string().regex(/^sha256\/[a-f0-9]{64}$/i, 'expected a content-addressed blob key')

const sourceRecordSchema = z.object({
  id: z.string(),
  displayTitle: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  originalFileName: z.string(),
  kind: z.union([z.literal('book'), z.literal('paper'), z.literal('document')]),
  format: z.union([z.literal('pdf'), z.literal('epub'), z.literal('other')]).optional(),
  currentRevisionId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
const legacySourceRecordSchema = sourceRecordSchema.omit({ displayTitle: true, authors: true, originalFileName: true })

const managementFolderSchema = z.object({ id: z.string(), kind: z.union([z.literal('library'), z.literal('skill')]), name: z.string(), parentId: z.string().optional(), version: z.number().int().positive(), createdAt: z.number(), updatedAt: z.number(), lastAppliedCommandId: z.string().optional() })
const managementGrantSchema = z.object({ sessionId: z.string(), grants: z.array(z.enum(AGENT_GRANTS as [string, ...string[]])), version: z.number().int().positive(), updatedAt: z.number(), lastAppliedCommandId: z.string().optional() })
const managementCommandSchema = z.object({ schemaVersion: z.literal(1), commandId: z.string(), sessionId: z.string(), kind: z.string(), command: z.record(z.string(), z.unknown()), canonicalPayload: z.string(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/i), state: z.union([z.literal('pending'), z.literal('committed'), z.literal('rejected')]), result: z.record(z.string(), z.unknown()).optional(), errorCode: z.string().optional(), errorMessage: z.string().optional(), createdAt: z.number(), updatedAt: z.number() })
const managementDeletionOperationSchema = z.object({ operationId: z.string(), kind: z.union([z.literal('delete-source'), z.literal('delete-folder'), z.literal('delete-skill')]), targetId: z.string(), commandId: z.string(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/i), state: z.union([z.literal('prepared'), z.literal('applied')]), result: z.record(z.string(), z.unknown()).optional(), createdAt: z.number(), updatedAt: z.number() })
const managementProposalSchema = z.object({ id: z.string(), sessionId: z.string(), kind: z.union([z.literal('delete-source'), z.literal('archive-skill')]), targetId: z.string(), title: z.string(), targetVersion: z.number(), commandPayloadHash: z.string(), requesterToolCallId: z.string().optional(), expiresAt: z.number(), createdAt: z.number(), state: z.union([z.literal('pending'), z.literal('approved'), z.literal('rejected')]), version: z.number().int().positive(), lastAppliedCommandId: z.string().optional() })
const managementSkillSchema = z.object({ id: z.string(), name: z.string(), description: z.string(), trigger: z.string().optional(), instructions: z.string(), requiredTools: z.array(z.string()).optional(), userInvocable: z.boolean().optional(), modelInvocable: z.boolean().optional(), folderId: z.string().optional(), source: z.union([z.literal('builtin'), z.literal('user')]), version: z.number().int().positive(), recordVersion: z.number().int().positive().optional(), archived: z.boolean(), revisions: z.array(z.object({ version: z.number().int().positive(), name: z.string(), description: z.string(), trigger: z.string().optional(), instructions: z.string(), requiredTools: z.array(z.string()).optional(), userInvocable: z.boolean().optional(), modelInvocable: z.boolean().optional(), updatedAt: z.number() })), createdAt: z.number(), updatedAt: z.number(), lastAppliedCommandId: z.string().optional() })
const managementSourceLocationSchema = z.object({ sourceId: z.string(), folderId: z.string().optional(), version: z.number().int().positive(), updatedAt: z.number(), lastAppliedCommandId: z.string().optional() })

const sourceAccessRecordSchema = z.object({
  sessionId: z.string(),
  sourceId: z.string(),
  grantedAt: z.number(),
})

const outlineItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  depth: z.number(),
  page: z.number(),
  startOrdinal: z.number(),
  endOrdinal: z.number(),
})

const revisionRecordSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  providerId: z.string(),
  providerKind: z.string(),
  providerModel: z.string(),
  format: z.union([z.literal('pdf'), z.literal('epub'), z.literal('other')]).optional(),
  mediaType: z.string().optional(),
  fileName: z.string().optional(),
  originalBlob: z.string().optional(),
  extractionArtifactBlob: z.string().optional(),
  extractionManifestBlob: z.string().optional(),
  extractionProvenance: z.object({
    artifactSetIds: z.array(z.string()).min(1), artifactManifestHashes: z.array(sha256Schema).min(1),
    providerKind: z.string().min(1), normalizerId: z.string().min(1), normalizerVersion: z.number().int().nonnegative(), canonicalizerVersion: z.number().int().positive(),
  }).optional(),
  spineCount: z.number().optional(),
  pageCount: z.number().optional(),
  blockCount: z.number(),
  markdownBlob: z.string(),
  blocksBlob: z.string(),
  assetBlobs: z.array(blobKeySchema).optional(),
  outline: z.array(outlineItemSchema),
  sha256: z.string(),
  createdAt: z.number(),
})

// Version-zero revisions predate provider provenance. This is an explicit
// read-only input for one startup rewrite, not an optional current schema.
const legacyRevisionRecordSchema = revisionRecordSchema.omit({ providerId: true, providerKind: true })

const reprocessOperationRecordSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), commandId: z.string().min(1), importId: z.string().min(1), sourceId: z.string().min(1),
  artifactSetIds: z.array(z.string()).min(1), artifactManifestHashes: z.array(sha256Schema).min(1), expectedCurrentRevisionId: z.string().optional(),
  normalizerId: z.string().min(1), normalizerVersion: z.number().int().nonnegative(), canonicalizerVersion: z.number().int().positive(),
  state: z.union([z.literal('pending'), z.literal('normalizing'), z.literal('writing-blobs'), z.literal('revision-prepared'), z.literal('activating'), z.literal('committed'), z.literal('completed-not-activated'), z.literal('failed'), z.literal('cancelled')]),
  preparedRevisionId: z.string().optional(), activated: z.boolean(),
  failure: z.object({ stage: z.union([z.literal('validation'), z.literal('normalizing'), z.literal('writing-blobs'), z.literal('indexing'), z.literal('activating')]), code: z.string().min(1), message: z.string(), retryable: z.boolean() }).optional(),
  attempts: z.number().int().nonnegative(), createdAt: z.number(), updatedAt: z.number(),
}).superRefine((record, ctx) => {
  const terminal = record.state === 'committed' || record.state === 'completed-not-activated' || record.state === 'failed' || record.state === 'cancelled'
  if ((record.state === 'revision-prepared' || record.state === 'activating' || record.state === 'committed' || record.state === 'completed-not-activated') && record.preparedRevisionId === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'prepared revision is required after blob writing' })
  if (record.state === 'committed' && !record.activated) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'committed operation must be activated' })
  if (record.state === 'completed-not-activated' && record.activated) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not activated operation cannot be activated' })
  if (record.state === 'failed' && record.failure === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'failed operation requires failure' })
  if (!terminal && record.failure !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'non-terminal operation cannot retain failure' })
})

const providerPartRecordSchema = z.object({
  index: z.number().int().nonnegative(),
  startPage: z.number().int().positive().optional(),
  endPage: z.number().int().positive().optional(),
  task: z.object({
    kind: z.union([z.literal('single'), z.literal('batch')]),
    id: z.string().min(1),
  }),
  artifactSetId: z.string().optional(),
  state: z.union([
    z.literal('submitted'), z.literal('pending'), z.literal('running'),
    z.literal('converting'), z.literal('downloading'), z.literal('normalizing'), z.literal('ready'),
  ]),
  blocksBlob: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  nextPollAt: z.number().optional(),
}).superRefine((part, ctx) => {
  if ((part.startPage === undefined) !== (part.endPage === undefined) || (part.startPage !== undefined && part.endPage! < part.startPage)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'part page range must be complete and ordered' })
  }
})

/** Read-only migration input; opening an old durable import must never drop it. */
const legacyImportRecordSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  origin: z.union([
    z.object({ kind: z.literal('upload'), fileName: z.string(), sizeBytes: z.number() }),
    z.object({ kind: z.literal('url'), url: z.string() }),
  ]),
  format: z.union([z.literal('pdf'), z.literal('epub'), z.literal('other')]).optional(),
  mediaType: z.string().optional(),
  originalBlob: z.string().optional(),
  sessionId: z.string().optional(),
  extraction: z.object({
    language: z.string(),
    pageRanges: z.string().optional(),
    isOcr: z.boolean(),
    enableTable: z.boolean(),
    enableFormula: z.boolean(),
  }).optional(),
  providerId: z.string().optional(),
  providerTask: z.object({
    kind: z.union([z.literal('single'), z.literal('batch')]),
    id: z.string(),
  }).optional(),
  artifactSetId: z.string().optional(),
  extractionArtifactBlob: z.string().optional(),
  extractionManifestBlob: z.string().optional(),
  providerParts: z.array(providerPartRecordSchema).optional(),
  state: z.union([
    z.literal('awaiting-upload'),
    z.literal('preparing'),
    z.literal('submitted'),
    z.literal('pending'),
    z.literal('running'),
    z.literal('converting'),
    z.literal('downloading'),
    z.literal('normalizing'),
    z.literal('ready'),
    z.literal('failed'),
    z.literal('cancelled'),
  ]),
  progress: z.object({
    extractedPages: z.number().optional(),
    totalPages: z.number().optional(),
    completedParts: z.number().optional(),
    totalParts: z.number().optional(),
  }).optional(),
  failure: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
  warning: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
  nextPollAt: z.number().optional(),
  attempts: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).superRefine((record, ctx) => {
  if (record.providerParts !== undefined && record.artifactSetId !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'whole and part artifact set bindings are mutually exclusive' })
  }
  if (record.providerParts !== undefined) {
    const indexes = new Set<number>()
    for (const part of record.providerParts) {
      if (indexes.has(part.index)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provider part indexes must be unique' })
      indexes.add(part.index)
    }
  }
})

const importFailureSchema = z.object({
  stage: z.union([z.literal('awaiting-upload'), z.literal('uploading'), z.literal('queued'), z.literal('splitting'), z.literal('extracting'), z.literal('collecting'), z.literal('normalizing'), z.literal('indexing'), z.literal('unknown')]),
  code: z.union([z.literal('UPLOAD_FAILED'), z.literal('SPLIT_FAILED'), z.literal('PROVIDER_UNAVAILABLE'), z.literal('PROVIDER_MISCONFIGURED'), z.literal('PROVIDER_REJECTED'), z.literal('PROVIDER_OUTPUT_INVALID'), z.literal('TASK_TIMEOUT'), z.literal('COLLECTION_FAILED'), z.literal('NORMALIZATION_FAILED'), z.literal('INDEXING_FAILED'), z.literal('ARTIFACT_MISSING'), z.literal('CANCEL_FAILED'), z.literal('INTERNAL_ERROR')]),
  retryable: z.boolean(), providerId: z.string().optional(), providerCode: z.string().optional(), message: z.string(), occurredAt: z.number(),
})

/** Version-2 Host import record. Legacy records remain parseable only until startup migration rewrites them. */
const currentImportRecordSchema = z.object({
  id: z.string(), sourceId: z.string(), schemaVersion: z.literal(2),
  origin: z.union([z.object({ kind: z.literal('upload'), fileName: z.string(), sizeBytes: z.number() }), z.object({ kind: z.literal('url'), url: z.string() })]),
  format: z.union([z.literal('pdf'), z.literal('epub'), z.literal('other')]).optional(), mediaType: z.string().optional(), originalBlob: z.string().optional(), sessionId: z.string().optional(), targetFolderId: z.string().optional(),
  extraction: z.object({ language: z.string(), pageRanges: z.string().optional(), isOcr: z.boolean(), enableTable: z.boolean(), enableFormula: z.boolean() }).optional(),
  providerId: z.string().optional(), providerTask: z.object({ kind: z.union([z.literal('single'), z.literal('batch')]), id: z.string() }).optional(), artifactSetId: z.string().optional(),
  providerParts: z.array(providerPartRecordSchema).optional(),
  state: z.union([z.literal('awaiting-upload'), z.literal('uploading'), z.literal('queued'), z.literal('splitting'), z.literal('extracting'), z.literal('collecting'), z.literal('normalizing'), z.literal('indexing'), z.literal('ready'), z.literal('failed'), z.literal('cancelled')]),
  recordVersion: z.number().int().nonnegative(), transitionedAt: z.number(), appliedTransitionIds: z.array(z.string().min(1)).max(64),
  progress: z.object({ completedPages: z.number().nonnegative().optional(), totalPages: z.number().nonnegative().optional(), completedParts: z.number().nonnegative().optional(), totalParts: z.number().nonnegative().optional(), currentPart: z.number().int().nonnegative().optional(), updatedAt: z.number() }).optional(),
  failure: importFailureSchema.optional(), failedStage: importFailureSchema.shape.stage.optional(),
  cancelledStage: z.union([z.literal('awaiting-upload'), z.literal('uploading'), z.literal('queued'), z.literal('splitting'), z.literal('extracting'), z.literal('collecting'), z.literal('normalizing'), z.literal('indexing')]).optional(), cancelledAt: z.number().optional(), upstreamCancellation: z.union([z.literal('cancelled'), z.literal('upstream-unsupported'), z.literal('not-required'), z.literal('failed')]).optional(),
  semanticStatus: z.union([z.literal('available'), z.literal('original-only')]).optional(), revisionId: z.string().optional(),
  warning: z.object({ code: z.string(), message: z.string() }).optional(), nextPollAt: z.number().optional(), attempts: z.number().int().nonnegative(), createdAt: z.number(), updatedAt: z.number(),
}).superRefine((record, ctx) => {
  if (record.providerParts !== undefined && record.artifactSetId !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'whole and part artifact set bindings are mutually exclusive' })
  if (record.state === 'failed' && (record.failure === undefined || record.failedStage === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'failed import requires failure and failedStage' })
  if (record.state !== 'failed' && (record.failure !== undefined || record.failedStage !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'active import cannot retain failure' })
  if (record.state === 'cancelled' && (record.cancelledStage === undefined || record.cancelledAt === undefined || record.upstreamCancellation === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cancelled import requires cancellation details' })
  if (record.state !== 'cancelled' && (record.cancelledStage !== undefined || record.cancelledAt !== undefined || record.upstreamCancellation !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'non-cancelled import cannot retain cancellation details' })
  if (record.state === 'ready' && record.revisionId === undefined && record.semanticStatus !== 'original-only') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ready import requires revision or original-only semantics' })
  if (record.state !== 'failed' && record.failure?.stage === 'unknown') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unknown is only valid on migrated failures' })
})

/** Durable input accepts old records solely so deterministic migration can fail loud rather than discard them. */
const importRecordSchema = z.union([currentImportRecordSchema, legacyImportRecordSchema])

const extractionArtifactSetRecordSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), importId: z.string().min(1), sourceId: z.string().min(1),
  scope: z.union([
    z.object({ kind: z.literal('whole') }),
    z.object({ kind: z.literal('part'), index: z.number().int().nonnegative(), startPage: z.number().int().positive().optional(), endPage: z.number().int().positive().optional() }).superRefine((scope, ctx) => {
      if ((scope.startPage === undefined) !== (scope.endPage === undefined) || (scope.startPage !== undefined && scope.endPage! < scope.startPage)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'part scope page range must be complete and ordered' })
    }),
  ]),
  providerInstanceId: z.string().min(1), providerKind: z.string().min(1), providerJobId: z.string().min(1), providerTaskKind: z.union([z.literal('single'), z.literal('batch')]), configFingerprint: z.string(), adapterVersion: z.number().int().nonnegative(), artifactSchemaVersion: z.number().int().positive(), normalizerId: z.string().min(1),
  artifacts: z.array(z.object({ role: z.union([z.literal('archive'), z.literal('content-list'), z.literal('markdown'), z.literal('asset')]), mediaType: z.string().min(1), sha256: sha256Schema, sizeBytes: z.number().int().nonnegative(), blobKey: blobKeySchema, fileName: z.string().min(1).optional() })).min(1),
  manifestSha256: sha256Schema, manifestBlob: blobKeySchema, collectedAt: z.number(),
}).superRefine((set, ctx) => {
  const seen = new Set<string>()
  for (const artifact of set.artifacts) {
    const key = `${artifact.role}\u0000${artifact.fileName ?? ''}\u0000${artifact.sha256}`
    if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'artifact entries must be unique' })
    seen.add(key)
    if (artifact.blobKey.toLowerCase() !== `sha256/${artifact.sha256.toLowerCase()}`) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'artifact blob key must match its SHA-256' })
  }
  if (set.manifestBlob.toLowerCase() !== `sha256/${set.manifestSha256.toLowerCase()}`) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'manifest blob key must match manifest SHA-256' })
})

const blobGcCandidateRecordSchema = z.object({
  schemaVersion: z.literal(1), blobKey: blobKeySchema,
  firstSeenUnreferencedAt: z.number(), lastCheckedAt: z.number(),
  observedSizeBytes: z.number().int().nonnegative(),
})

const citationSchema = z.object({
  sourceId: z.string(),
  revisionId: z.string(),
  blockId: z.string(),
  page: z.number(),
  quote: z.string().optional(),
})

const argumentGraphSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string(),
  nodes: z.array(z.object({
    id: z.string(),
    type: z.union([
      z.literal('definition'),
      z.literal('premise'),
      z.literal('claim'),
      z.literal('evidence'),
      z.literal('objection'),
      z.literal('reply'),
      z.literal('conclusion'),
    ]),
    label: z.string(),
    explanation: z.string(),
    epistemic: z.union([z.literal('author-explicit'), z.literal('ai-inference')]),
    confidence: z.number(),
    citations: z.array(citationSchema),
  })),
  edges: z.array(z.object({
    id: z.string(),
    from: z.string(),
    to: z.string(),
    type: z.union([
      z.literal('supports'),
      z.literal('depends_on'),
      z.literal('contradicts'),
      z.literal('qualifies'),
    ]),
    label: z.string().optional(),
  })),
})

const artifactRecordSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  revisionId: z.string(),
  title: z.string(),
  graph: argumentGraphSchema,
  nodeCount: z.number(),
  edgeCount: z.number(),
  createdAt: z.number(),
})

const studyEventRecordSchema = z.object({
  seq: z.number(),
  sessionId: z.string(),
  type: z.string(),
  clientEventId: z.string().optional(),
  data: z.unknown(),
  createdAt: z.number(),
})

const dossierRecordSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  revisionId: z.string().optional(),
  title: z.string(),
  content: z.string(),
  stats: z.object({
    highlightsCount: z.number(),
    bookmarksCount: z.number(),
    frictionsResolvedCount: z.number(),
    socraticQuestionsCount: z.number(),
    cardsCount: z.number(),
  }),
  createdAt: z.number(),
})

/** The study reader's durable domain. */
export const studyDomain = defineDomain({
  name: 'study_reader',
  version: 1,
  tables: {
    sources: domainTable<SourceId, z.infer<typeof sourceRecordSchema>>(z.union([sourceRecordSchema, legacySourceRecordSchema]) as unknown as z.ZodType<z.infer<typeof sourceRecordSchema>>),
    source_access: domainTable<string, z.infer<typeof sourceAccessRecordSchema>>(sourceAccessRecordSchema),
    revisions: domainTable<RevisionId, z.infer<typeof revisionRecordSchema>>(z.union([revisionRecordSchema, legacyRevisionRecordSchema]) as unknown as z.ZodType<z.infer<typeof revisionRecordSchema>>),
    imports: domainTable<ImportId, z.infer<typeof importRecordSchema>>(importRecordSchema),
    extraction_artifact_sets: domainTable<ExtractionArtifactSetId, z.infer<typeof extractionArtifactSetRecordSchema>>(extractionArtifactSetRecordSchema),
    reprocess_operations: domainTable<ReprocessOperationId, z.infer<typeof reprocessOperationRecordSchema>>(reprocessOperationRecordSchema),
    blob_gc_candidates: domainTable<string, z.infer<typeof blobGcCandidateRecordSchema>>(blobGcCandidateRecordSchema),
    artifacts: domainTable<ArtifactId, z.infer<typeof artifactRecordSchema>>(artifactRecordSchema),
    events: domainTable<string, z.infer<typeof studyEventRecordSchema>>(studyEventRecordSchema),
    dossiers: domainTable<DossierId, z.infer<typeof dossierRecordSchema>>(dossierRecordSchema),
    management_folders: domainTable<string, z.infer<typeof managementFolderSchema>>(managementFolderSchema),
    management_grants: domainTable<string, z.infer<typeof managementGrantSchema>>(managementGrantSchema),
    management_commands: domainTable<string, z.infer<typeof managementCommandSchema>>(managementCommandSchema),
    management_deletion_operations: domainTable<string, z.infer<typeof managementDeletionOperationSchema>>(managementDeletionOperationSchema),
    management_proposals: domainTable<string, z.infer<typeof managementProposalSchema>>(managementProposalSchema),
    management_skills: domainTable<string, z.infer<typeof managementSkillSchema>>(managementSkillSchema),
    management_source_locations: domainTable<string, z.infer<typeof managementSourceLocationSchema>>(managementSourceLocationSchema),
    studio_prompts: domainTable<string, z.infer<typeof promptAssetRecordSchema>>(promptAssetRecordSchema),
    studio_profiles: domainTable<string, z.infer<typeof injectionProfileRecordSchema>>(injectionProfileRecordSchema),
    studio_injection_bindings: domainTable<string, z.infer<typeof sessionInjectionBindingSchema>>(sessionInjectionBindingSchema),
    studio_command_receipts: domainTable<string, z.infer<typeof injectionStudioCommandReceiptSchema>>(injectionStudioCommandReceiptSchema),
    studio_asset_folders: domainTable<string, z.infer<typeof assetFolderRecordSchema>>(assetFolderRecordSchema),
    studio_provider_connections: domainTable<string, z.infer<typeof providerConnectionRecordSchema>>(providerConnectionRecordSchema),
    studio_provider_connection_receipts: domainTable<string, z.infer<typeof providerConnectionCommandReceiptSchema>>(providerConnectionCommandReceiptSchema),
  },
})

export {
  artifactRecordSchema,
  argumentGraphSchema,
  citationSchema,
  dossierRecordSchema,
  importRecordSchema,
  extractionArtifactSetRecordSchema,
  reprocessOperationRecordSchema,
  blobGcCandidateRecordSchema,
  outlineItemSchema,
  revisionRecordSchema,
  sourceRecordSchema,
  sourceAccessRecordSchema,
  studyEventRecordSchema,
  managementFolderSchema,
  managementGrantSchema,
  managementCommandSchema,
  managementProposalSchema,
  managementSkillSchema,
  managementSourceLocationSchema,
  promptAssetRecordSchema,
  injectionProfileRecordSchema,
  sessionInjectionBindingSchema,
  injectionStudioCommandReceiptSchema,
}
export type { BlockId }
