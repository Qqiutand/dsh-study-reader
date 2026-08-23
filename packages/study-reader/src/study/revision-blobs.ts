/** Canonical blob serialization and ownership helpers shared by assemblers. */
import type { BlobKey } from './blob-store.ts'
import type { RevisionRecord, StudyBlock } from './types.ts'

export function blocksJsonl(blocks: readonly { readonly id: string }[]): string {
  return blocks.map(block => JSON.stringify(block)).join('\n') + '\n'
}

export function assetBlobKeys(blocks: readonly StudyBlock[]): readonly BlobKey[] {
  return [...new Set(blocks.map(block => block.assetPath).filter((key): key is BlobKey => /^sha256\/[a-f0-9]{64}$/i.test(key ?? '')))].sort()
}

export function revisionBlobKeys(revision: RevisionRecord): readonly BlobKey[] {
  return [
    ...(revision.originalBlob !== undefined && /^sha256\/[a-f0-9]{64}$/i.test(revision.originalBlob) ? [revision.originalBlob as BlobKey] : []),
    revision.markdownBlob as BlobKey,
    revision.blocksBlob as BlobKey,
    ...(revision.assetBlobs ?? []),
  ]
}
