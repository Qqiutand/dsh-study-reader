/**
 * Provider-neutral revision assembly.  It is deliberately local: callers
 * supply already-normalized documents and this module never sees an extractor
 * instance, endpoint, credential, or task handle.
 */
import { blocksJsonl, assetBlobKeys, revisionBlobKeys } from './revision-blobs.ts'
import { revisionIdFor } from './revision-id.ts'
import { buildSearchIndex } from './search.ts'
import { normalizeRawBlocks, type NormalizedDocument, type RawStudyBlock } from './normalize.ts'
import type { BlobLifecycleService } from './blob-lifecycle.ts'
import type { BlobStore } from './blob-store.ts'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ExtractionArtifactSetRecord, ExtractionProvenance, ImportRecord, RevisionId, RevisionRecord } from './types.ts'

/** Bump only when canonicalization rules intentionally change. */
export const canonicalizerVersion = 1

export interface RevisionAssemblyInput {
  readonly record: ImportRecord
  readonly sets: readonly ExtractionArtifactSetRecord[]
  readonly documents: readonly NormalizedDocument[]
  readonly normalizerVersion: number
}

/** Writes content-addressed blobs before publishing one complete RevisionRecord. */
export class RevisionAssembler {
  constructor(private readonly deps: { readonly blobs: BlobStore; readonly lifecycle: BlobLifecycleService; readonly revisions: KvTable<RevisionId, RevisionRecord>; readonly assertSourceWritable?: (sourceId: ImportRecord['sourceId']) => void }) {}

  async assemble(input: RevisionAssemblyInput, signal: AbortSignal): Promise<RevisionRecord> {
    const normalized = input.documents.length === 1 ? input.documents[0]! : normalizeRawBlocks(mergeParts(input.sets, input.documents))
    return await this.finish(input.record, input.sets, normalized, input.normalizerVersion, signal)
  }

  /** Initial multipart imports retain raw adjusted blocks; canonicalize them here too. */
  async assembleRaw(record: ImportRecord, sets: readonly ExtractionArtifactSetRecord[], raw: readonly RawStudyBlock[], normalizerVersion: number, signal: AbortSignal): Promise<RevisionRecord> {
    return await this.finish(record, sets, normalizeRawBlocks(raw), normalizerVersion, signal)
  }

  private async finish(record: ImportRecord, sets: readonly ExtractionArtifactSetRecord[], normalized: NormalizedDocument, normalizerVersion: number, signal: AbortSignal): Promise<RevisionRecord> {
    // Index construction is intentionally before durable revision publication:
    // a bad index can leave blobs, but never a selectable incomplete revision.
    buildSearchIndex(normalized.blocks)
    const blocksBlob = await this.deps.blobs.putBlob(new TextEncoder().encode(blocksJsonl(normalized.blocks)))
    const markdownBlob = await this.deps.blobs.putBlob(new TextEncoder().encode(normalized.markdown))
    const revision: RevisionRecord = {
      id: revisionIdFor(record.sourceId, normalized.sha256), sourceId: record.sourceId,
      providerId: sets[0]!.providerInstanceId, providerKind: sets[0]!.providerKind,
      providerModel: String(sets[0]!.adapterVersion),
      ...(record.format !== undefined ? { format: record.format } : {}),
      ...(record.mediaType !== undefined ? { mediaType: record.mediaType } : {}),
      ...(record.origin.kind === 'upload' ? { fileName: record.origin.fileName } : {}),
      ...(record.originalBlob !== undefined ? { originalBlob: record.originalBlob } : {}),
      ...(normalized.pageCount !== undefined ? { pageCount: normalized.pageCount } : {}),
      blockCount: normalized.blocks.length, markdownBlob, blocksBlob, assetBlobs: assetBlobKeys(normalized.blocks), outline: normalized.outline, sha256: normalized.sha256,
      extractionProvenance: provenance(sets, normalizerVersion), createdAt: Date.now(),
    }
    if (this.deps.revisions.get(revision.id) === undefined) {
      await this.deps.lifecycle.withBlobReferences(revisionBlobKeys(revision), async () => { this.deps.assertSourceWritable?.(record.sourceId); await this.deps.revisions.put(revision.id, revision) }, signal)
    }
    return this.deps.revisions.get(revision.id) ?? revision
  }
}

function provenance(sets: readonly ExtractionArtifactSetRecord[], normalizerVersion: number): ExtractionProvenance {
  return { artifactSetIds: sets.map(set => set.id), artifactManifestHashes: sets.map(set => set.manifestSha256), providerKind: sets[0]!.providerKind, normalizerId: sets[0]!.normalizerId, normalizerVersion, canonicalizerVersion }
}

function mergeParts(sets: readonly ExtractionArtifactSetRecord[], documents: readonly NormalizedDocument[]): RawStudyBlock[] {
  return sets.map((set, index) => ({ set, document: documents[index]! })).sort((a, b) => partIndex(a.set) - partIndex(b.set)).flatMap(({ set, document }) => {
    const offset = set.scope.kind === 'part' ? (set.scope.startPage ?? 1) - 1 : 0
    return document.blocks.map(block => ({ type: block.type, page: block.page === 0 ? 0 : block.page + offset, providerPageIndex: block.providerPageIndex < 0 ? -1 : block.providerPageIndex + offset, text: block.text, ...(block.bbox !== undefined ? { bbox: block.bbox } : {}), ...(block.sourceLocator !== undefined ? { sourceLocator: block.sourceLocator } : {}), ...(block.assetPath !== undefined ? { assetPath: block.assetPath } : {}), ...(block.type === 'title' ? { headingLevel: block.headingPath.length + 1 } : {}) }))
  })
}

function partIndex(set: ExtractionArtifactSetRecord): number { return set.scope.kind === 'part' ? set.scope.index : 0 }
