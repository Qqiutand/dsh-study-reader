/** Artifact Set manifest determinism and durable input rejection. */

import { describe, expect, it } from 'vitest'
import { extractionArtifactSetRecordSchema } from '../src/study/domain.ts'
import { artifactSetIdFor, canonicalJsonBytes, canonicalManifestProjection, manifestSha256 } from '../src/study/artifact-manifest.ts'
import type { ExtractionArtifactSetRecord } from '../src/study/types.ts'

const digest = 'a'.repeat(64)
const base = {
  schemaVersion: 1 as const,
  importId: 'import-1',
  sourceId: 'source-1',
  scope: { kind: 'whole' as const },
  providerInstanceId: 'fake',
  providerKind: 'fake',
  providerJobId: 'job-1',
  providerTaskKind: 'single' as const,
  configFingerprint: 'fake:v1',
  adapterVersion: 1,
  artifactSchemaVersion: 1,
  normalizerId: 'fake-artifact-v1',
  artifacts: [{ role: 'archive' as const, mediaType: 'application/zip', sha256: digest, sizeBytes: 7, blobKey: `sha256/${digest}` as const, fileName: 'result.zip' }],
}

describe('Artifact Set manifest', () => {
  it('is deterministic across collection timestamps, artifact input order, and object key order', () => {
    const first = { ...base, artifacts: [...base.artifacts, { role: 'asset' as const, mediaType: 'image/png', sha256: 'b'.repeat(64), sizeBytes: 2, blobKey: `sha256/${'b'.repeat(64)}` as const, fileName: 'a.png' }] }
    const second = { ...base, artifacts: [...first.artifacts].reverse() }
    expect(manifestSha256(first)).toBe(manifestSha256(second))
    expect(canonicalJsonBytes(canonicalManifestProjection(first))).toEqual(canonicalJsonBytes(canonicalManifestProjection(second)))
    expect(artifactSetIdFor('import-1' as never, { kind: 'whole' }, manifestSha256(first))).toBe(artifactSetIdFor('import-1' as never, { kind: 'whole' }, manifestSha256(second)))
  })

  it('contains only allowlisted durable provenance, never collection URLs, credentials, or headers', () => {
    const json = new TextDecoder().decode(canonicalJsonBytes(canonicalManifestProjection(base)))
    expect(json).not.toContain('https://')
    expect(json).not.toContain('Authorization')
    expect(json).not.toContain('secret')
    expect(json).not.toContain('collectedAt')
  })

  it('rejects empty artifacts, invalid digests, negative sizes, duplicate entries, and invalid part scope', () => {
    const valid: ExtractionArtifactSetRecord = { ...base, id: 'aset-1' as never, manifestSha256: digest, manifestBlob: `sha256/${digest}` as const, collectedAt: 1 }
    expect(extractionArtifactSetRecordSchema.safeParse(valid).success).toBe(true)
    expect(extractionArtifactSetRecordSchema.safeParse({ ...valid, artifacts: [] }).success).toBe(false)
    expect(extractionArtifactSetRecordSchema.safeParse({ ...valid, artifacts: [{ ...valid.artifacts[0], sha256: 'bad' }] }).success).toBe(false)
    expect(extractionArtifactSetRecordSchema.safeParse({ ...valid, artifacts: [{ ...valid.artifacts[0], sizeBytes: -1 }] }).success).toBe(false)
    expect(extractionArtifactSetRecordSchema.safeParse({ ...valid, artifacts: [valid.artifacts[0], valid.artifacts[0]] }).success).toBe(false)
    expect(extractionArtifactSetRecordSchema.safeParse({ ...valid, scope: { kind: 'part', index: 0, startPage: 3 } }).success).toBe(false)
  })
})
