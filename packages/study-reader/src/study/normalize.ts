/**
 * Provider-neutral normalization compatibility exports.
 * Provider artifact parsers live with their adapters; Study only canonicalizes
 * already-neutral drafts.
 */
export { canonicalizeBlockDrafts as normalizeRawBlocks, normalizeText, type BlockDraft as RawStudyBlock, type NormalizedDocument } from '../extraction/canonicalizer.ts'
export { readArchive, validateEntryName, type ArchiveEntry, type ArchiveLimits } from '../extraction/archive-reader.ts'
