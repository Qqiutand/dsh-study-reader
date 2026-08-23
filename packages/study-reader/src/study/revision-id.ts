/**
 * Revision identity helper. A content digest alone is not a globally unique
 * revision key because two independent sources may contain identical bytes.
 * Namespace the digest by SourceId while keeping the id deterministic for
 * re-imports of the same source.
 * @module @deepseek-ai/dsh-study/revision-id
 */

import { createHash } from 'node:crypto'
import type { RevisionId, SourceId } from './types.ts'

/** Build a deterministic, source-scoped revision id. */
export function revisionIdFor(sourceId: SourceId, contentSha256: string): RevisionId {
  const digest = createHash('sha256')
    .update(sourceId)
    .update('\0')
    .update(contentSha256)
    .digest('hex')
  return `rev-${digest}` as RevisionId
}
