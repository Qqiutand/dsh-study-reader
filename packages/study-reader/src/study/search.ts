/**
 * Full-text search over normalized blocks via MiniSearch with a custom
 * tokenizer: Latin text tokenizes by word, CJK runs tokenize into adjacent
 * bigrams. The index is a rebuildable cache over the blocks blob — never
 * authoritative data.
 * @module @deepseek-ai/dsh-study/search
 */

import MiniSearch from 'minisearch'
import type { StudyBlock } from './types.ts'

/** CJK ideographs and kana ranges. */
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/**
 * Tokenize one text: Latin words plus CJK bigrams.
 * @param text - the source text.
 * @returns the token list.
 */
export function cjkAwareTokenizer(text: string): string[] {
  const tokens: string[] = []
  let last = 0
  for (const match of text.matchAll(CJK_RUN)) {
    const index = match.index
    pushLatinWords(text.slice(last, index), tokens)
    const run = match[0]
    if (run.length === 1) {
      tokens.push(run)
    } else {
      for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2))
    }
    last = index + run.length
  }
  pushLatinWords(text.slice(last), tokens)
  return tokens
}

function pushLatinWords(segment: string, out: string[]): void {
  // The segment carries no CJK (removed by the split), so script letters are
  // Latin-like words; digits join words for identifiers.
  for (const word of segment.match(/[\p{L}\p{N}]+/gu) ?? []) out.push(word)
}

/** One revision's search cache entry. */
export interface SearchCacheEntry {
  readonly blocks: readonly StudyBlock[]
  readonly index: MiniSearch<StudyBlock>
}

/** Build the search cache entry for one revision's blocks. */
export function buildSearchIndex(blocks: readonly StudyBlock[]): SearchCacheEntry {
  const index = new MiniSearch<StudyBlock>({
    fields: ['text'],
    storeFields: ['id', 'ordinal', 'page'],
    tokenize: cjkAwareTokenizer,
    searchOptions: { prefix: true, fuzzy: 0.2, boost: { text: 2 } },
  })
  index.addAll([...blocks])
  return { blocks, index }
}

/** One search result. */
export interface SearchOutcome {
  readonly total: number
  readonly truncated: boolean
  readonly blocks: readonly StudyBlock[]
}

/**
 * Search one index with a result cap.
 * @param entry - the revision's cache entry.
 * @param query - the raw query text.
 * @param limit - maximum matched blocks to return.
 * @returns total matches, truncation flag, and the matched blocks (page info included).
 */
export function searchBlocks(entry: SearchCacheEntry, query: string, limit: number): SearchOutcome {
  const results = entry.index.search(query)
  const byId = new Map<string, StudyBlock>(entry.blocks.map(block => [block.id, block]))
  const matched: StudyBlock[] = []
  for (const result of results) {
    const block = byId.get(result.id)
    if (block !== undefined) matched.push(block)
    if (matched.length >= limit) break
  }
  return {
    total: results.length,
    truncated: results.length > matched.length,
    blocks: matched,
  }
}
