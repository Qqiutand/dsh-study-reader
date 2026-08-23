/**
 * MinerU result-archive normalization: bounded ZIP validation and extraction,
 * content-list selection (`*_content_list_v2.json` → `*_content_list.json` →
 * `full.md`), and projection onto the normalized `StudyBlock` sequence with
 * deterministic block ids.
 *
 * Security posture: every archive limit is config; traversal, absolute,
 * drive-relative, NUL, duplicate, oversized, and symlink entries are rejected
 * before any byte is consumed; the JSON payload of the selected content list
 * must parse, or the import fails.
 * @module @deepseek-ai/dsh-study/normalize
 */

import { basename } from 'node:path'
import { stat } from 'node:fs/promises'
import yauzl from 'yauzl'
import { StudyError } from '../protocol/error.ts'
import type { BlobKey } from '../study/blob-store.ts'
import { sha256Hex } from '../study/blob-store.ts'
import type { OutlineItem, StudyBlock } from '../study/types.ts'
import { readArchive, validateEntryName, type ArchiveEntry, type ArchiveLimits } from '../extraction/archive-reader.ts'
import { canonicalizeBlockDrafts } from '../extraction/canonicalizer.ts'

/** Archive limits, all configuration-driven. */
export type { ArchiveLimits, ArchiveEntry } from '../extraction/archive-reader.ts'

/** One raw entry read from the archive before normalization. */
export interface RawStudyBlock {
  readonly type: StudyBlock['type']
  readonly page: number
  readonly providerPageIndex: number
  readonly text: string
  readonly bbox?: readonly [number, number, number, number]
  readonly sourceLocator?: StudyBlock['sourceLocator']
  readonly assetPath?: string
  /** Heading depth when the block is a title (1-based). */
  readonly headingLevel?: number
}

/** The normalization result: canonical artifacts plus derived metadata. */
export interface NormalizedDocument {
  /** sha256 of the id-free blocks projection; the RevisionRecord content hash. */
  readonly sha256: string
  readonly blocks: readonly StudyBlock[]
  readonly markdown: string
  readonly outline: readonly OutlineItem[]
  readonly pageCount?: number
  /** Blob keys of extracted image assets by archive path. */
  readonly assets: ReadonlyMap<string, BlobKey>
}

/** One entry of the archive that was accepted and read. */

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp', '.svg'])

/**
 * Validate one entry name against traversal rules and normalize it.
 * @param rawName - the raw ZIP entry name.
 * @returns the normalized slash-separated name.
 * @throws {@link StudyError} `ZIP_UNSAFE_PATH` on any violation.
 */
function legacyValidateEntryName(rawName: string): string {
  if (rawName === '') throw unsafePath('empty entry name')
  if (rawName.includes('\0')) throw unsafePath('NUL byte')
  if (rawName.startsWith('/') || rawName.startsWith('\\')) throw unsafePath('absolute path')
  if (/^[a-zA-Z]:/.test(rawName)) throw unsafePath('Windows drive path')
  if (rawName.includes('\\')) throw unsafePath('backslash path separator')
  const segments = rawName.split('/')
  for (const segment of segments) {
    if (segment === '..') throw unsafePath('parent traversal')
  }
  return segments.join('/')
}

function unsafePath(detail: string): StudyError {
  return new StudyError(`ZIP entry rejected: ${detail}`, 'ZIP_UNSAFE_PATH')
}

/** Whether an entry name denotes a symlink per its external attributes. */
function isSymlink(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xF000
  return mode === 0xA000
}

/**
 * Open and enumerate an archive with every limit enforced. Rejects the whole
 * archive on the first violation; nothing is written to disk.
 * @param zipPath - absolute path of the archive.
 * @param limits - configured archive limits.
 * @returns the accepted entries (name → bytes).
 */
async function legacyReadArchive(zipPath: string, limits: ArchiveLimits): Promise<ArchiveEntry[]> {
  const archiveStat = await stat(zipPath)
  if (archiveStat.size > limits.maxArchiveBytes) {
    throw new StudyError(
      `ZIP archive exceeds maxArchiveBytes (${archiveStat.size} > ${limits.maxArchiveBytes})`,
      'ZIP_TOO_LARGE',
    )
  }
  const entries: ArchiveEntry[] = []
  const seen = new Set<string>()
  let uncompressedTotal = 0
  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipfile) => {
      // yauzl v3 calls back with (null, zipfile) on success; null is not an error.
      if (openError != null || zipfile === undefined) {
        reject(new StudyError(`ZIP cannot be opened: ${openError?.message ?? 'unknown'}`, 'ZIP_INVALID', { cause: openError ?? undefined }))
        return
      }
      zipfile.on('error', error => reject(error))
      zipfile.on('end', () => resolve())
      zipfile.on('entry', (entry: yauzl.Entry) => {
        try {
          if (entries.length >= limits.maxArchiveEntries) {
            throw new StudyError(
              `ZIP exceeds maxArchiveEntries (${limits.maxArchiveEntries})`,
              'ZIP_TOO_MANY_ENTRIES',
            )
          }
          const name = validateEntryName(entry.fileName)
          if (seen.has(name)) {
            throw new StudyError(`ZIP duplicate entry name "${name}"`, 'ZIP_DUPLICATE_ENTRY')
          }
          seen.add(name)
          if (isSymlink(entry)) {
            throw new StudyError(`ZIP entry "${name}" is a symlink`, 'ZIP_SYMLINK')
          }
          if (entry.uncompressedSize === 0xFFFFFFFF) {
            throw new StudyError(`ZIP entry "${name}" has unknown size`, 'ZIP_UNSAFE_SIZE')
          }
          if (entry.uncompressedSize > limits.maxEntryBytes) {
            throw new StudyError(
              `ZIP entry "${name}" exceeds maxEntryBytes (${entry.uncompressedSize} > ${limits.maxEntryBytes})`,
              'ZIP_ENTRY_TOO_LARGE',
            )
          }
          uncompressedTotal += entry.uncompressedSize
          if (uncompressedTotal > limits.maxUncompressedBytes) {
            throw new StudyError(
              `ZIP exceeds maxUncompressedBytes (${uncompressedTotal} > ${limits.maxUncompressedBytes})`,
              'ZIP_BOMB',
            )
          }
          zipfile.openReadStream(entry, (streamError, stream) => {
            // yauzl v3 calls back with (null, stream) on success; null is not an error.
            if (streamError != null || stream === undefined) {
              reject(new StudyError(`ZIP entry "${name}" cannot be read: ${streamError?.message ?? 'unknown'}`, 'ZIP_INVALID', { cause: streamError ?? undefined }))
              return
            }
            const chunks: Uint8Array[] = []
            let size = 0
            stream.on('data', (chunk: Buffer) => {
              size += chunk.byteLength
              if (size > limits.maxEntryBytes) {
                stream.destroy()
                reject(new StudyError(
                  `ZIP entry "${name}" exceeded maxEntryBytes while streaming`,
                  'ZIP_ENTRY_TOO_LARGE',
                ))
                return
              }
              chunks.push(new Uint8Array(chunk))
            })
            stream.on('end', () => {
              if (size !== entry.uncompressedSize) {
                reject(new StudyError(
                  `ZIP entry "${name}" size mismatch (${size} != ${entry.uncompressedSize})`,
                  'ZIP_SIZE_MISMATCH',
                ))
                return
              }
              entries.push({ name, size, data: concatBytes(chunks) })
              zipfile.readEntry()
            })
            stream.on('error', error => reject(error))
          })
        } catch (error) {
          reject(error)
        }
      })
      zipfile.readEntry()
    })
  })
  return entries
}

/** Concatenate byte chunks. */
function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Match one of the content-list file names: bare or with a prefix (`*_content_list_v2.json`). */
function isContentList(name: string, bare: string): boolean {
  return basename(name) === bare || name.endsWith(`_${bare}`)
}

/** Pick the content source: v2 list, v1 list, or Markdown fallback. */
function selectContent(entries: readonly ArchiveEntry[]): { kind: 'v2' | 'v1' | 'md'; entry: ArchiveEntry } {
  const v2 = entries.find(entry => isContentList(entry.name, 'content_list_v2.json'))
  if (v2 !== undefined) return { kind: 'v2', entry: v2 }
  const v1 = entries.find(entry => isContentList(entry.name, 'content_list.json'))
  if (v1 !== undefined) return { kind: 'v1', entry: v1 }
  const md = entries.find(entry => basename(entry.name) === 'full.md')
  if (md !== undefined) return { kind: 'md', entry: md }
  throw new StudyError(
    'ZIP contains neither *_content_list_v2.json, *_content_list.json, nor full.md',
    'ZIP_NO_CONTENT',
  )
}

// ── raw block parsing ──────────────────────────────────────────────────────

/** Tolerant field reader for one content item. */
interface ContentItem {
  readonly type: string
  readonly text: string
  readonly pageIndex: number
  readonly bbox?: readonly [number, number, number, number]
  readonly imagePath?: string
  readonly outlineLevel?: number
}

function readItem(item: unknown): ContentItem {
  if (typeof item !== 'object' || item === null) {
    throw new StudyError('Content list item is not an object', 'ZIP_INVALID_JSON')
  }
  const record = item as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : 'text'
  const text = stringField(record, ['text', 'content', 'markdown', 'html'], '')
  const pageIndex = numberField(record, ['page_idx', 'page', 'pageIndex'], 0)
  const bbox = readBbox(record.bbox)
  const imagePath = stringField(record, ['image_path', 'img_path', 'imagePath'], undefined)
  const outlineLevel = numberField(record, ['outline_level', 'outlineLevel', 'level'], undefined)
  return {
    type,
    text,
    pageIndex,
    ...bbox !== undefined ? { bbox } : {},
    ...imagePath !== undefined ? { imagePath } : {},
    ...outlineLevel !== undefined ? { outlineLevel } : {},
  }
}

function stringField(record: Record<string, unknown>, keys: readonly string[], fallback: string): string
function stringField(record: Record<string, unknown>, keys: readonly string[], fallback: string | undefined): string | undefined
function stringField(record: Record<string, unknown>, keys: readonly string[], fallback: string | undefined): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return fallback
}

function numberField(record: Record<string, unknown>, keys: readonly string[], fallback: number): number
function numberField(record: Record<string, unknown>, keys: readonly string[], fallback: number | undefined): number | undefined
function numberField(record: Record<string, unknown>, keys: readonly string[], fallback: number | undefined): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return fallback
}

function readBbox(value: unknown): readonly [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined
  const numbers = value.map(item => typeof item === 'number' ? item : Number.NaN)
  if (numbers.some(number => !Number.isFinite(number))) return undefined
  return [numbers[0] as number, numbers[1] as number, numbers[2] as number, numbers[3] as number]
}

/** Map a provider type string onto the normalized block type. */
function mapBlockType(type: string): StudyBlock['type'] {
  switch (type) {
    case 'title': case 'heading': case 'header': case 'h1': case 'h2': case 'h3':
    case 'h4': case 'h5': case 'h6': return 'title'
    case 'text': case 'paragraph': return 'paragraph'
    case 'list': case 'unordered_list': case 'ordered_list': case 'bulleted_list':
    case 'numbered_list': return 'list'
    case 'table': case 'chart': return 'table'
    case 'equation': case 'equation_interline': case 'formula': case 'math': return 'equation'
    case 'image': case 'figure': case 'img': return 'image'
    case 'code': case 'algorithm': case 'code_block': return 'code'
    case 'footnote': case 'page_footnote': return 'footnote'
    default: return 'other'
  }
}

/** Serialize a v1 `table_body` (rows of cells) into text. */
function tableText(item: Record<string, unknown>): string {
  const body = item.table_body
  if (!Array.isArray(body)) {
    const html = stringField(item, ['html', 'text', 'markdown'], '')
    if (html !== undefined && html !== '') return stripHtml(html)
    return stringField(item, ['text'], '') ?? ''
  }
  const rows: string[] = []
  for (const row of body) {
    if (!Array.isArray(row)) continue
    const cells: string[] = []
    for (const cell of row) {
      if (cell === null || cell === undefined) continue
      if (typeof cell === 'string') cells.push(cell)
      else if (typeof cell === 'object') {
        const text = stringField(cell as Record<string, unknown>, ['text', 'content'], '')
        cells.push(text ?? '')
      }
    }
    rows.push(cells.join(' | '))
  }
  return rows.join('\n')
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Flatten MinerU v2 inline spans without serializing URLs or layout metadata. */
function inlineText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(inlineText).filter(Boolean).join('')
  if (typeof value !== 'object' || value === null) return ''
  const record = value as Record<string, unknown>
  if (record.children !== undefined) return inlineText(record.children)
  return typeof record.content === 'string' ? record.content : ''
}

/** Read the type-specific payload of one page-grouped MinerU v2 block. */
function readV2Item(item: unknown, pageIndex: number): ContentItem {
  if (typeof item !== 'object' || item === null) {
    throw new StudyError('content_list_v2.json item is not an object', 'ZIP_INVALID_JSON')
  }
  const record = item as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : 'paragraph'
  const content = typeof record.content === 'object' && record.content !== null
    ? record.content as Record<string, unknown>
    : {}
  const textFields: Record<string, readonly string[]> = {
    title: ['title_content'],
    paragraph: ['paragraph_content'],
    equation_interline: ['math_content'],
    image: ['image_caption', 'image_footnote'],
    table: ['table_body', 'table_caption', 'table_footnote'],
    chart: ['chart_content', 'chart_caption', 'chart_footnote'],
    code: ['code_content', 'code_caption', 'code_footnote'],
    algorithm: ['algorithm_content', 'algorithm_caption', 'algorithm_footnote'],
    list: ['list_items'],
    index: ['list_items'],
    page_header: ['page_header_content'],
    page_footer: ['page_footer_content'],
    page_number: ['page_number_content'],
    page_aside_text: ['page_aside_text_content'],
    page_footnote: ['page_footnote_content'],
  }
  const fields = textFields[type] ?? Object.keys(content).filter(key => key.endsWith('_content'))
  const text = fields.map((field) => {
    const value = content[field]
    if (field === 'list_items' && Array.isArray(value)) {
      return value.map(inlineText).filter(Boolean).join('\n')
    }
    return inlineText(value)
  }).filter(Boolean).join('\n')
  const bbox = readBbox(record.bbox)
  const imagePath = stringField(content, ['image_path', 'img_path'], undefined)
  const outlineLevel = numberField(content, ['level'], undefined)
  return {
    type,
    text,
    pageIndex,
    ...bbox !== undefined ? { bbox } : {},
    ...imagePath !== undefined ? { imagePath } : {},
    ...outlineLevel !== undefined ? { outlineLevel } : {},
  }
}

/** Parse the current page-grouped v2 list and the older object wrapper. */
function parseV2(payload: unknown): RawStudyBlock[] {
  const content = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).content
      : undefined
  if (!Array.isArray(content)) {
    throw new StudyError('content_list_v2.json is not a page list or content wrapper', 'ZIP_INVALID_JSON')
  }
  const raw: RawStudyBlock[] = []
  const pageGrouped = content.every(Array.isArray)
  const items = pageGrouped
    ? content.flatMap((page, pageIndex) => (page as unknown[]).map(item => ({ item, pageIndex })))
    : content.map(item => ({ item, pageIndex: undefined }))
  for (const entry of items) {
    const parsed = entry.pageIndex === undefined ? readItem(entry.item) : readV2Item(entry.item, entry.pageIndex)
    const type = mapBlockType(parsed.type)
    raw.push({
      type,
      page: parsed.pageIndex + 1,
      providerPageIndex: parsed.pageIndex,
      text: parsed.text,
      ...parsed.bbox !== undefined ? { bbox: parsed.bbox } : {},
      ...parsed.imagePath !== undefined && type === 'image' ? { assetPath: parsed.imagePath } : {},
      ...parsed.outlineLevel !== undefined && type === 'title' ? { headingLevel: parsed.outlineLevel } : {},
    })
  }
  return raw
}

/** Parse a v1 content-list array into raw blocks. */
function parseV1(payload: unknown): RawStudyBlock[] {
  if (!Array.isArray(payload)) {
    throw new StudyError('content_list.json is not an array', 'ZIP_INVALID_JSON')
  }
  const raw: RawStudyBlock[] = []
  for (const item of payload) {
    if (typeof item !== 'object' || item === null) {
      throw new StudyError('content_list.json item is not an object', 'ZIP_INVALID_JSON')
    }
    const record = item as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type : 'text'
    const pageIndex = numberField(record, ['page_idx', 'page', 'pageIndex'], 0) ?? 0
    const mapped = mapBlockType(type)
    const text = mapped === 'table' ? tableText(record) : (stringField(record, ['text', 'content'], '') ?? '')
    const assetPath = stringField(record, ['image_path', 'img_path'], undefined)
    raw.push({
      type: mapped,
      page: pageIndex + 1,
      providerPageIndex: pageIndex,
      text,
      ...mapped === 'image' && assetPath !== undefined ? { assetPath } : {},
    })
  }
  return raw
}

/** Parse the Markdown fallback into coarse blocks (no page information). */
function parseMarkdown(markdown: string): RawStudyBlock[] {
  const lines = markdown.split(/\r?\n/)
  const raw: RawStudyBlock[] = []
  let paragraph: string[] = []
  let list: string[] = []
  let codeFence = false

  const flushParagraph = (): void => {
    const text = paragraph.join(' ').trim()
    if (text !== '') raw.push({ type: 'paragraph', page: 0, providerPageIndex: -1, text })
    paragraph = []
  }
  const flushList = (): void => {
    if (list.length > 0) {
      raw.push({ type: 'list', page: 0, providerPageIndex: -1, text: list.join('\n') })
      list = []
    }
  }
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      flushParagraph()
      flushList()
      codeFence = !codeFence
      continue
    }
    if (codeFence) continue
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      flushList()
      raw.push({
        type: 'title',
        page: 0,
        providerPageIndex: -1,
        text: heading[2]?.trim() ?? '',
        headingLevel: heading[1]?.length ?? 1,
      })
      continue
    }
    const listItem = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (listItem !== null) {
      flushParagraph()
      list.push(listItem[1]?.trim() ?? '')
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }
    flushList()
    paragraph.push(line.trim())
  }
  flushParagraph()
  flushList()
  return raw
}

// ── normalization ──────────────────────────────────────────────────────────

/** Collapse whitespace runs to single spaces and trim — the canonical text form. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Assign heading paths from title depth and build the outline. */
function buildStructure(
  raw: readonly RawStudyBlock[],
  contentSha: string,
): { blocks: StudyBlock[]; outline: OutlineItem[]; pageCount?: number } {
  const blocks: StudyBlock[] = []
  const outline: OutlineItem[] = []
  const headingStack: Array<{ depth: number; title: string; ordinal: number }> = []
  let maxPage = 0
  let activeSection: OutlineItem | undefined
  raw.forEach((entry, ordinal) => {
    let headingPath = headingStack.map(heading => heading.title)
    if (entry.type === 'title') {
      const depth = entry.headingLevel ?? (headingStack.length > 0 ? headingStack[headingStack.length - 1]!.depth + 1 : 1)
      // Close any deeper headings before pushing this one.
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.depth >= depth) {
        headingStack.pop()
      }
      // A title belongs beneath the headings that remain after sibling and
      // ancestor closure. Computing this before the pop made a new h1 look
      // like a child of the preceding document's h1.
      headingPath = headingStack.map(heading => heading.title)
      headingStack.push({ depth, title: entry.text, ordinal })
      if (activeSection !== undefined) {
        activeSection = { ...activeSection, endOrdinal: ordinal }
        outline.push(activeSection)
      }
      activeSection = {
        id: sectionId(contentSha, ordinal, entry.text),
        title: entry.text,
        depth,
        page: entry.page,
        startOrdinal: ordinal,
        endOrdinal: raw.length,
      }
    }
    const id = blockId(contentSha, ordinal, entry.text) as StudyBlock['id']
    blocks.push({
      id,
      ordinal,
      page: entry.page,
      providerPageIndex: entry.providerPageIndex,
      type: entry.type,
      headingPath,
      text: entry.text,
      ...entry.bbox !== undefined ? { bbox: entry.bbox } : {},
      ...entry.sourceLocator !== undefined ? { sourceLocator: entry.sourceLocator } : {},
      ...entry.assetPath !== undefined ? { assetPath: entry.assetPath } : {},
    })
    maxPage = Math.max(maxPage, entry.page)
  })
  if (activeSection !== undefined) outline.push(activeSection)
  // Merge adjacent sections with identical titles into one? No — keep 1:1 with headings.
  return {
    blocks,
    outline,
    ...maxPage > 0 ? { pageCount: maxPage } : {},
  }
}

/** Deterministic section id. */
export function sectionId(contentSha: string, startOrdinal: number, title: string): string {
  return sha256Hex(Buffer.from(`${contentSha}\0section\0${startOrdinal}\0${normalizeText(title)}`, 'utf8'))
}

/** Deterministic block id: sha256(revisionSha + "\0" + ordinal + "\0" + normalizedText). */
export function blockId(contentSha: string, ordinal: number, text: string): string {
  return sha256Hex(Buffer.from(`${contentSha}\0${ordinal}\0${normalizeText(text)}`, 'utf8'))
}

/** Serialize the id-free canonical projection of one block. */
function idFreeProjection(block: RawStudyBlock, ordinal: number): string {
  return JSON.stringify({
    ordinal,
    type: block.type,
    page: block.page,
    providerPageIndex: block.providerPageIndex,
    headingPath: block.headingLevel !== undefined ? [block.headingLevel] : [],
    text: block.text,
    ...block.bbox !== undefined ? { bbox: block.bbox } : {},
    ...block.sourceLocator !== undefined ? { sourceLocator: block.sourceLocator } : {},
    ...block.assetPath !== undefined ? { assetPath: block.assetPath } : {},
  })
}

/** Render the normalized Markdown from ordered blocks. */
function renderMarkdown(blocks: readonly StudyBlock[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'title': {
        const depth = Math.min(6, block.headingPath.length + 1)
        lines.push(`${'#'.repeat(depth)} ${block.text}`, '')
        break
      }
      case 'paragraph': lines.push(block.text, ''); break
      case 'list': {
        for (const item of block.text.split('\n')) lines.push(`- ${item}`)
        lines.push('')
        break
      }
      case 'table': lines.push(block.text, ''); break
      case 'equation': lines.push('$$', block.text, '$$', ''); break
      case 'image': {
        const target = block.assetPath ?? ''
        lines.push(`![${block.text || 'image'}](${target})`, '')
        break
      }
      case 'code': lines.push('```', block.text, '```', ''); break
      default: lines.push(block.text, '')
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/**
 * Normalize an already-parsed raw block sequence. PDF/MinerU and EPUB both
 * enter through this function, which gives them the same deterministic BlockId,
 * outline, Markdown, and citation semantics.
 * @param raw - ordered raw blocks.
 * @param assets - persisted assets keyed by their original container path.
 * @returns the canonical normalized document.
 */
function normalizeBlockText(block: RawStudyBlock): string {
  if (block.type === 'code') return block.text.replace(/\r\n?/g, '\n').trim()
  if (block.type === 'list' || block.type === 'table') {
    return block.text
      .split(/\r?\n/)
      .map(line => normalizeText(line))
      .filter(Boolean)
      .join('\n')
  }
  return normalizeText(block.text)
}

export function normalizeRawBlocks(
  raw: readonly RawStudyBlock[],
  assets: ReadonlyMap<string, BlobKey> = new Map(),
): NormalizedDocument {
  const canonical = raw
    .map(block => ({ ...block, text: normalizeBlockText(block) }))
    .filter(block => block.text !== '' || block.type === 'image')
  const contentSha = sha256Hex(Buffer.from(
    canonical.map((block, ordinal) => idFreeProjection(block, ordinal)).join('\n'),
    'utf8',
  ))
  const { blocks, outline, pageCount } = buildStructure(canonical, contentSha)
  return {
    sha256: contentSha,
    blocks,
    markdown: renderMarkdown(blocks),
    outline,
    ...pageCount !== undefined ? { pageCount } : {},
    assets,
  }
}

/** The selection of content plus the assets copied from the archive. */
export interface NormalizationSource {
  readonly entries: readonly ArchiveEntry[]
  readonly content: ArchiveEntry
  readonly kind: 'v2' | 'v1' | 'md'
  readonly assets: ReadonlyMap<string, BlobKey>
}

/**
 * Normalize one validated archive into canonical blocks, Markdown, and outline.
 * @param zipPath - absolute archive path.
 * @param limits - configured archive limits.
 * @param putAsset - persists one extracted image asset and returns its blob key.
 * @returns the normalized document.
 */
export async function normalizeArchive(
  zipPath: string,
  limits: ArchiveLimits,
  putAsset: (data: Uint8Array, name: string) => Promise<BlobKey>,
): Promise<NormalizedDocument> {
  const entries = await readArchive(zipPath, limits)
  const selected = selectContent(entries)
  let raw: RawStudyBlock[]
  if (selected.kind === 'md') {
    const text = Buffer.from(selected.entry.data).toString('utf8')
    raw = parseMarkdown(text)
  } else {
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.from(selected.entry.data).toString('utf8'))
    } catch (error) {
      throw new StudyError(`Content list is not valid JSON: ${selected.entry.name}`, 'ZIP_INVALID_JSON', { cause: error })
    }
    raw = selected.kind === 'v2' ? parseV2(payload) : parseV1(payload)
  }

  // Copy image assets referenced by blocks (and image entries generally).
  const assets = new Map<string, BlobKey>()
  const referenced = new Set(raw.map(block => block.assetPath).filter((path): path is string => path !== undefined))
  for (const entry of entries) {
    const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
    if (!IMAGE_EXTENSIONS.has(ext)) continue
    if (referenced.size > 0 && !referenced.has(entry.name)) continue
    assets.set(entry.name, await putAsset(entry.data, basename(entry.name)))
  }
  // Remap asset paths onto blob keys.
  const remapped = raw.map(block => {
    if (block.assetPath === undefined) return block
    const key = assets.get(block.assetPath)
    return key === undefined ? block : { ...block, assetPath: key }
  })

  return canonicalizeBlockDrafts(remapped, assets)
}

// These legacy-local reader helpers remain only while archive-reader migration
// is validated against historic fixtures; all live calls use extraction/archive-reader.
void legacyValidateEntryName
void legacyReadArchive
