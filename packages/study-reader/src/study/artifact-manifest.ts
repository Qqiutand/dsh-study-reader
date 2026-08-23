/** Deterministic Artifact Set manifests and identity derivation. */

import { sha256Hex, type BlobKey } from './blob-store.ts'
import type { ExtractionArtifactSetId } from '../extraction/index.ts'
import type { ExtractionArtifactRecord, ExtractionArtifactSetRecord, ImportId } from './types.ts'

type ManifestScope = ExtractionArtifactSetRecord['scope']

/** Stable, secret-free data represented by a persisted Artifact Set manifest. */
export interface CanonicalManifestProjection {
  readonly schemaVersion: 1
  readonly importId: string
  readonly sourceId: string
  readonly scope: ManifestScope
  readonly providerInstanceId: string
  readonly providerKind: string
  readonly providerJobId: string
  readonly providerTaskKind: 'single' | 'batch'
  readonly configFingerprint: string
  readonly adapterVersion: number
  readonly artifactSchemaVersion: number
  readonly normalizerId: string
  readonly artifacts: readonly Pick<ExtractionArtifactRecord, 'role' | 'mediaType' | 'sha256' | 'sizeBytes' | 'fileName'>[]
}

/** Return the one stable projection used both for persisted manifest bytes and its hash. */
export function canonicalManifestProjection(set: Omit<ExtractionArtifactSetRecord, 'id' | 'manifestSha256' | 'manifestBlob' | 'collectedAt'>): CanonicalManifestProjection {
  return {
    schemaVersion: 1,
    importId: set.importId,
    sourceId: set.sourceId,
    scope: set.scope.kind === 'whole' ? { kind: 'whole' } : {
      kind: 'part', index: set.scope.index,
      ...(set.scope.startPage === undefined ? {} : { startPage: set.scope.startPage }),
      ...(set.scope.endPage === undefined ? {} : { endPage: set.scope.endPage }),
    },
    providerInstanceId: set.providerInstanceId,
    providerKind: set.providerKind,
    providerJobId: set.providerJobId,
    providerTaskKind: set.providerTaskKind,
    configFingerprint: set.configFingerprint,
    adapterVersion: set.adapterVersion,
    artifactSchemaVersion: set.artifactSchemaVersion,
    normalizerId: set.normalizerId,
    artifacts: [...set.artifacts]
      .map(({ role, mediaType, sha256, sizeBytes, fileName }) => ({ role, mediaType, sha256, sizeBytes, ...(fileName === undefined ? {} : { fileName }) }))
      .sort((left, right) => compareArtifact(left, right)),
  }
}

/** Encode a value as deterministic UTF-8 JSON without relying on caller insertion order. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}

/** SHA-256 of the canonical manifest projection. */
export function manifestSha256(set: Omit<ExtractionArtifactSetRecord, 'id' | 'manifestSha256' | 'manifestBlob' | 'collectedAt'>): string {
  return sha256Hex(canonicalJsonBytes(canonicalManifestProjection(set)))
}

/** Derive the deterministic id for an immutable set. */
export function artifactSetIdFor(importId: ImportId, scope: ManifestScope, digest: string): ExtractionArtifactSetId {
  const scopeKey = scope.kind === 'whole' ? 'whole' : `part-${scope.index}`
  return `aset-${String(importId)}-${scopeKey}-${digest}` as ExtractionArtifactSetId
}

/** Verify that a content-addressed blob key agrees with its declared digest. */
export function blobKeyForSha256(sha256: string): BlobKey {
  return `sha256/${sha256}` as BlobKey
}

function compareArtifact(left: Pick<ExtractionArtifactRecord, 'role' | 'sha256' | 'fileName'>, right: Pick<ExtractionArtifactRecord, 'role' | 'sha256' | 'fileName'>): number {
  return left.role.localeCompare(right.role) || (left.fileName ?? '').localeCompare(right.fileName ?? '') || left.sha256.localeCompare(right.sha256)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new TypeError('manifest projection contains a non-JSON value')
}
