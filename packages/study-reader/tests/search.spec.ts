/**
 * Search index tests: the CJK bigram / Latin word tokenizer and bounded
 * search outcomes with truncation.
 */

import { describe, expect, it } from 'vitest'
import { cjkAwareTokenizer, buildSearchIndex, searchBlocks } from '../lib/types/study/search.js'
import type { StudyBlock } from '../src/study/types.ts'

function block(id: string, ordinal: number, text: string, page = 1): StudyBlock {
  return {
    id: id as StudyBlock['id'],
    ordinal,
    page,
    providerPageIndex: page - 1,
    type: 'paragraph',
    headingPath: [],
    text,
  }
}

const BLOCKS: StudyBlock[] = [
  block('b1', 0, '社会科学的核心问题是解释社会现象。', 1),
  block('b2', 1, '因果推断需要识别策略。', 2),
  block('b3', 2, 'The identification strategy relies on a natural experiment.', 3),
  block('b4', 3, '社会契约论讨论社会秩序的来源。', 4),
  block('b5', 4, '识别策略与因果推断共同构成研究设计。', 5),
]

describe('cjkAwareTokenizer', () => {
  it('tokenizes Latin text by word', () => {
    expect(cjkAwareTokenizer('The natural experiment works')).toEqual([
      'The', 'natural', 'experiment', 'works',
    ])
  })

  it('tokenizes CJK text into adjacent bigrams', () => {
    expect(cjkAwareTokenizer('社会契约')).toEqual(['社会', '会契', '契约'])
  })

  it('handles mixed text', () => {
    expect(cjkAwareTokenizer('因果推断 identification')).toEqual(['因果', '果推', '推断', 'identification'])
  })
})

describe('searchBlocks', () => {
  it('finds CJK matches via bigrams with page numbers', () => {
    const entry = buildSearchIndex(BLOCKS)
    const outcome = searchBlocks(entry, '社会', 10)
    expect(outcome.total).toBeGreaterThanOrEqual(1)
    expect(outcome.truncated).toBe(false)
    expect(outcome.blocks.some(block => block.id === 'b1' && block.page === 1)).toBe(true)
    expect(outcome.blocks.some(block => block.id === 'b4' && block.page === 4)).toBe(true)
  })

  it('finds Latin word matches', () => {
    const entry = buildSearchIndex(BLOCKS)
    const outcome = searchBlocks(entry, 'identification', 10)
    expect(outcome.blocks.some(block => block.id === 'b3')).toBe(true)
  })

  it('caps results and reports truncation', () => {
    const entry = buildSearchIndex(BLOCKS)
    const outcome = searchBlocks(entry, '策略', 1)
    expect(outcome.blocks.length).toBe(1)
    expect(outcome.total).toBeGreaterThan(1)
    expect(outcome.truncated).toBe(true)
  })

  it('returns zero matches for absent terms', () => {
    const entry = buildSearchIndex(BLOCKS)
    const outcome = searchBlocks(entry, '量子力学', 10)
    expect(outcome.total).toBe(0)
    expect(outcome.blocks).toEqual([])
    expect(outcome.truncated).toBe(false)
  })
})
