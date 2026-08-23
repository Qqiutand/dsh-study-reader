/** Revision-scoped durable projection and dossier regressions. */

import { describe, expect, it } from 'vitest'
import { applyStudyEvent, emptyStudyState } from '../src/domain/reducer.ts'
import { synthesizeDossier } from '../src/domain/dossier.ts'
import { RevisionId, SourceId } from '../src/protocol/ids.ts'

describe('revision-scoped dossier', () => {
  it('keeps re-parsed revisions isolated and reports calibration bias', () => {
    const sourceId = SourceId('source-1')
    const revisionA = RevisionId('revision-A')
    const revisionB = RevisionId('revision-B')
    let state = emptyStudyState()
    const apply = (type: Parameters<typeof applyStudyEvent>[1], data: unknown): void => {
      state = applyStudyEvent(state, type, data as never)
    }

    apply('study/source-imported', {
      sourceId, revisionId: revisionA, format: 'epub', title: '测试书', fileName: 'book.epub',
      pageCount: 2, blockCount: 10, timestamp: 1,
    })
    apply('study/feynman-requested', {
      requestId: 'req-A', sourceId, revisionId: revisionA, page: 1, blockIds: ['block-A'],
      selectedText: 'A 原文', explanation: 'A 解释', analogy: 'A 类比', contextRole: 'A 作用',
      citations: [{ page: 1, blockId: 'block-A', quote: 'A 原文' }], timestamp: 2,
    })
    apply('study/feynman-requested', {
      requestId: 'req-B', sourceId, revisionId: revisionB, page: 2, blockIds: ['block-B'],
      selectedText: 'B 原文', explanation: 'B 解释', analogy: 'B 类比', contextRole: 'B 作用',
      citations: [{ page: 2, blockId: 'block-B', quote: 'B 原文' }], timestamp: 3,
    })
    apply('study/calibration', {
      requestId: 'req-A', sourceId, revisionId: revisionA,
      stage: 'pre-explanation', rating: 'rough', timestamp: 4,
    })
    apply('study/calibration', {
      requestId: 'req-A', sourceId, revisionId: revisionA,
      stage: 'post-explanation', rating: 'teach', timestamp: 5,
    })
    apply('study/socratic-response', {
      requestId: 'req-A', sourceId, revisionId: revisionA, page: 1, blockIds: ['block-A'],
      questionId: 'q-A', question: 'A 问题', userAnswer: '错误回答',
      aiAssessment: { passed: false, feedback: '仍需巩固', correction: 'A 修正' }, timestamp: 6,
    })
    apply('study/bookmark', {
      sourceId, revisionId: revisionA, page: 1, blockIds: ['block-A'], selectedText: 'A 收藏', timestamp: 7,
    })
    apply('study/bookmark', {
      sourceId, revisionId: revisionB, page: 2, blockIds: ['block-B'], selectedText: 'B 收藏', timestamp: 8,
    })

    const report = synthesizeDossier('测试书', state, 1_700_000_000_000, sourceId, revisionA)
    expect(report.revisionId).toBe(revisionA)
    expect(report.content).toContain('A 类比')
    expect(report.content).toContain('A 收藏')
    expect(report.content).toContain('可能过度自信')
    expect(report.content).not.toContain('B 类比')
    expect(report.content).not.toContain('B 收藏')
    expect(state.reviewCards.filter(card => card.revisionId === revisionA)).toHaveLength(1)
  })
})
