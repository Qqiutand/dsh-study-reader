/** Event idempotency and source-scoped revision identity regressions. */

import { describe, expect, it } from 'vitest'
import { canonicalEventJson } from '../src/study/event-json.ts'
import { revisionIdFor } from '../src/study/revision-id.ts'
import { SourceId } from '../src/protocol/ids.ts'

describe('canonicalEventJson', () => {
  it('ignores object key order but preserves array order', () => {
    const left = canonicalEventJson({ z: 1, a: { y: 2, x: [3, { b: 2, a: 1 }] } })
    const right = canonicalEventJson({ a: { x: [3, { a: 1, b: 2 }], y: 2 }, z: 1 })
    expect(left).toBe(right)
    expect(canonicalEventJson([1, 2])).not.toBe(canonicalEventJson([2, 1]))
  })
})

describe('revisionIdFor', () => {
  it('is deterministic within one source and collision-resistant across sources', () => {
    const same1 = revisionIdFor(SourceId('source-A'), 'content-sha')
    const same2 = revisionIdFor(SourceId('source-A'), 'content-sha')
    const other = revisionIdFor(SourceId('source-B'), 'content-sha')
    expect(same1).toBe(same2)
    expect(same1).not.toBe(other)
  })
})
