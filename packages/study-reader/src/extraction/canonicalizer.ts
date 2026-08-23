/** Provider-neutral block-draft canonicalization shared by EPUB and extractors. */
import { createHash } from 'node:crypto'
import type { BlobKey } from '../study/blob-store.ts'
import type { OutlineItem, StudyBlock } from '../study/types.ts'

/** A provider-neutral draft; adapters must not choose stable block identifiers. */
export interface BlockDraft { readonly type: StudyBlock['type']; readonly page: number; readonly providerPageIndex: number; readonly text: string; readonly bbox?: readonly [number, number, number, number]; readonly sourceLocator?: StudyBlock['sourceLocator']; readonly assetPath?: string; readonly headingLevel?: number }
/** Canonical indexing input with stable IDs, outline, and rendered Markdown. */
export interface NormalizedDocument { readonly sha256: string; readonly blocks: readonly StudyBlock[]; readonly markdown: string; readonly outline: readonly OutlineItem[]; readonly pageCount?: number; readonly assets: ReadonlyMap<string, BlobKey> }

/** Normalize drafts into deterministic blocks; no provider identifiers participate in the hash. */
export function canonicalizeBlockDrafts(drafts: readonly BlockDraft[], assets: ReadonlyMap<string, BlobKey> = new Map()): NormalizedDocument {
  const canonical = drafts.map(draft => ({ ...draft, text: normalizeBlockText(draft.type, draft.text) })).filter(draft => draft.text !== '' || draft.type === 'image')
  const sha256 = createHash('sha256').update(canonical.map((draft, ordinal) => JSON.stringify({ ...draft, ordinal })).join('\n')).digest('hex')
  const headings: { title: string; depth: number; start: number; page: number }[] = []
  const active: { title: string; depth: number }[] = []
  const blocks: StudyBlock[] = canonical.map((draft, ordinal) => {
    const isHeading = draft.type === 'title'
    const depth = Math.max(1, draft.headingLevel ?? 1)
    if (isHeading) {
      while (active.length > 0 && active.at(-1)!.depth >= depth) active.pop()
    }
    const headingPath = active.map(heading => heading.title)
    if (isHeading) {
      headings.push({ title: draft.text, depth, start: ordinal, page: draft.page })
      active.push({ title: draft.text, depth })
    }
    const { headingLevel: _headingLevel, bbox, sourceLocator, assetPath, ...required } = draft
    return { ...required, id: createHash('sha256').update(`${sha256}\0${ordinal}\0${draft.text}`).digest('hex') as StudyBlock['id'], ordinal, headingPath, ...(bbox !== undefined ? { bbox } : {}), ...(sourceLocator !== undefined ? { sourceLocator } : {}), ...(assetPath !== undefined ? { assetPath } : {}) }
  })
  const outline = headings.map((heading, index) => ({ id: createHash('sha256').update(`${sha256}\0${heading.start}\0${heading.title}`).digest('hex'), title: heading.title, depth: heading.depth, page: heading.page, startOrdinal: heading.start, endOrdinal: headings[index + 1]?.start ?? blocks.length }))
  const pages = blocks.map(block => block.page).filter(page => page > 0)
  return { sha256, blocks, markdown: blocks.map(block => block.type === 'title' ? `${'#'.repeat(Math.max(1, block.headingPath.length))} ${block.text}` : block.text).join('\n\n') + '\n', outline, ...(pages.length ? { pageCount: Math.max(...pages) } : {}), assets }
}

/** Whitespace normalization used as stable-ID input. */
export function normalizeText(text: string): string { return text.replace(/\s+/g, ' ').trim() }

/** Keep rows, list items and source lines intact for the bounded semantic preview. */
function normalizeBlockText(type: StudyBlock['type'], text: string): string {
  if (type !== 'list' && type !== 'table' && type !== 'code' && type !== 'equation') return normalizeText(text)
  return text.replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean).join('\n').trim()
}
