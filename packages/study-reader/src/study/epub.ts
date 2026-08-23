/**
 * EPUB 2/3 local import pipeline. EPUB is a ZIP container, so it reuses the
 * same bounded archive reader as MinerU results, resolves the OPF manifest and
 * spine, projects semantic XHTML blocks onto the shared StudyBlock model, and
 * persists referenced images as content-addressed assets.
 *
 * The reader intentionally ignores publisher JavaScript and remote resources.
 * DRM/encrypted EPUBs are rejected because their spine content cannot be
 * inspected or cited safely.
 * @module @deepseek-ai/dsh-study/epub
 */

import { basename, extname, posix } from 'node:path'
import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import { StudyError } from '../protocol/error.ts'
import type { BlobKey } from './blob-store.ts'
import {
  canonicalizeBlockDrafts,
  type BlockDraft as RawStudyBlock,
  type NormalizedDocument,
} from '../extraction/canonicalizer.ts'
import {
  readArchive,
  validateEntryName,
  type ArchiveEntry,
  type ArchiveLimits,
} from '../extraction/archive-reader.ts'

interface ManifestItem {
  readonly id: string
  /** OPF-relative href retained for epub.js Section/rendition navigation. */
  readonly readerHref: string
  /** ZIP entry path used only for bounded archive reads and asset resolution. */
  readonly path: string
  readonly mediaType: string
  readonly properties: readonly string[]
}

interface SpineItem {
  readonly idref: string
  readonly linear: boolean
}

/** Result of one EPUB import before it is committed as a revision. */
export interface NormalizedEpub extends NormalizedDocument {
  readonly title?: string
  readonly authors: readonly string[]
  readonly spineCount: number
}

/** Native EPUB spine metadata used to preview both new and legacy imports. */
export interface EpubSpinePreview {
  readonly spineIndex: number
  readonly href: string
  readonly title: string
}

/** Read only package/spine metadata without normalizing or persisting content. */
export async function inspectEpubSpine(
  epubPath: string,
  limits: ArchiveLimits,
): Promise<readonly EpubSpinePreview[]> {
  const entries = await readArchive(epubPath, limits)
  const byName = new Map(entries.map(entry => [entry.name, entry] as const))
  assertEpubContainer(byName)
  const container = requiredText(byName, 'META-INF/container.xml')
  const packagePath = attributeOfFirst(container, 'rootfile', 'full-path')
  if (packagePath === undefined) throw new StudyError('EPUB container.xml has no rootfile full-path', 'EPUB_CONTAINER_INVALID')
  const opfPath = resolveContainerPath('', packagePath)
  const opf = requiredText(byName, opfPath)
  const manifest = parseManifest(opf, posix.dirname(opfPath))
  const declaredSpine = parseSpine(opf)
  assertSpineManifestReferences(manifest, declaredSpine)
  const spine = selectReadableSpine(manifest, declaredSpine)
  assertReadableSpine(byName, manifest, spine)
  const labels = parseNavigationLabels(byName, manifest, opf)
  return spine.flatMap((entry, spineIndex) => {
    const item = manifest.get(entry.idref)
    if (item === undefined || !isXhtml(item.mediaType, item.path)) return []
    return [{
      spineIndex,
      href: item.readerHref,
      title: labels.get(item.path) ?? humanizeFileName(item.path),
    }]
  })
}

const IMAGE_MEDIA = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/svg+xml', 'image/webp',
  'image/bmp', 'image/tiff',
])

/**
 * Normalize one EPUB archive into the shared block/citation model.
 * @param epubPath - absolute path of the uploaded EPUB file.
 * @param limits - bounded ZIP policy.
 * @param putAsset - persists one image and returns its blob key.
 * @returns canonical blocks, outline, Markdown, metadata, and assets.
 */
export async function normalizeEpub(
  epubPath: string,
  limits: ArchiveLimits,
  putAsset: (data: Uint8Array, name: string) => Promise<BlobKey>,
): Promise<NormalizedEpub> {
  const entries = await readArchive(epubPath, limits)
  return await normalizeEpubEntries(entries, putAsset)
}

/**
 * Normalize already bounded EPUB entries. Keeping the container reader and
 * semantic parser separate makes the parser deterministic and independently
 * testable while all untrusted ZIP limits remain enforced by `readArchive`.
 * @param entries - entries already validated and bounded by `readArchive`.
 * @param putAsset - persists one referenced image and returns its blob key.
 * @returns canonical blocks, outline, Markdown, metadata, and assets.
 */
export async function normalizeEpubEntries(
  entries: readonly ArchiveEntry[],
  putAsset: (data: Uint8Array, name: string) => Promise<BlobKey>,
): Promise<NormalizedEpub> {
  const byName = new Map(entries.map(entry => [entry.name, entry] as const))
  assertEpubContainer(byName)

  const container = requiredText(byName, 'META-INF/container.xml')
  const packagePath = attributeOfFirst(container, 'rootfile', 'full-path')
  if (packagePath === undefined) {
    throw new StudyError('EPUB container.xml has no rootfile full-path', 'EPUB_CONTAINER_INVALID')
  }
  const opfPath = resolveContainerPath('', packagePath)
  const opf = requiredText(byName, opfPath)
  const opfDir = posix.dirname(opfPath)
  const title = textOfFirst(opf, 'dc:title') ?? textOfFirst(opf, 'title')
  const authors = textsOf(opf, 'creator')
  const manifest = parseManifest(opf, opfDir)
  const declaredSpine = parseSpine(opf)
  if (declaredSpine.length === 0) {
    throw new StudyError('EPUB package has an empty spine', 'EPUB_SPINE_EMPTY')
  }
  assertSpineManifestReferences(manifest, declaredSpine)
  const spine = selectReadableSpine(manifest, declaredSpine)
  if (spine.length === 0) {
    throw new StudyError('EPUB spine contains no readable XHTML documents', 'EPUB_SPINE_EMPTY')
  }
  assertReadableSpine(byName, manifest, spine)

  const labels = parseNavigationLabels(byName, manifest, opf)
  const raw: RawStudyBlock[] = []
  const referencedAssets = new Set<string>()

  for (let index = 0; index < spine.length; index += 1) {
    const idref = spine[index]!.idref
    const item = manifest.get(idref)
    if (item === undefined) {
      throw new StudyError(`EPUB spine references missing manifest item "${idref}"`, 'EPUB_MANIFEST_INVALID')
    }
    if (!isXhtml(item.mediaType, item.path)) continue
    const entry = byName.get(item.path)
    if (entry === undefined) {
      throw new StudyError(`EPUB spine resource is missing: ${item.path}`, 'EPUB_RESOURCE_MISSING')
    }
    const logicalPage = index + 1
    const chapterLabel = labels.get(item.path) ?? humanizeFileName(item.path)
    const chapter = parseXhtmlBlocks(
      decodeMarkup(entry.data),
      item.path,
      logicalPage,
      chapterLabel,
      item.readerHref,
    )
    for (const block of chapter) {
      if (block.assetPath !== undefined) referencedAssets.add(block.assetPath)
      raw.push(block)
    }
  }

  if (raw.length === 0) {
    throw new StudyError('EPUB spine contains no readable XHTML blocks', 'EPUB_NO_CONTENT')
  }

  const assets = new Map<string, BlobKey>()
  for (const path of referencedAssets) {
    const entry = byName.get(path)
    if (entry === undefined) continue
    const manifestItem = [...manifest.values()].find(item => item.path === path)
    if (manifestItem !== undefined && !IMAGE_MEDIA.has(manifestItem.mediaType) && !looksLikeImage(path)) continue
    assets.set(path, await putAsset(entry.data, basename(path)))
  }
  const remapped = raw.map(block => {
    if (block.assetPath === undefined) return block
    const blob = assets.get(block.assetPath)
    if (blob !== undefined) return { ...block, assetPath: blob }
    // Keep the semantic image block but omit an unresolved path rather than
    // leaking an arbitrary container path into the browser.
    const { assetPath: _omitted, ...withoutAsset } = block
    return withoutAsset
  })
  const normalized = canonicalizeBlockDrafts(remapped, assets)
  return {
    ...normalized,
    ...title !== undefined && title.trim() !== '' ? { title: decodeEntities(stripMarkup(title)) } : {},
    authors,
    spineCount: spine.length,
  }
}

function assertEpubContainer(entries: ReadonlyMap<string, ArchiveEntry>): void {
  const mimetype = entries.get('mimetype')
  if (mimetype !== undefined) {
    const value = Buffer.from(mimetype.data).toString('utf8').trim()
    if (value !== 'application/epub+zip') {
      throw new StudyError(`invalid EPUB mimetype: ${value}`, 'EPUB_MIMETYPE_INVALID')
    }
  }
  if (!entries.has('META-INF/container.xml')) {
    throw new StudyError('EPUB is missing META-INF/container.xml', 'EPUB_CONTAINER_INVALID')
  }
}

function assertReadableSpine(
  entries: ReadonlyMap<string, ArchiveEntry>,
  manifest: ReadonlyMap<string, ManifestItem>,
  spine: readonly SpineItem[],
): void {
  const encryption = entries.get('META-INF/encryption.xml')
  if (encryption === undefined) return
  const encryptedPaths = new Set<string>()
  const markup = decodeMarkup(encryption.data)
  for (const tag of matchingStartTags(markup, 'CipherReference')) {
    const uri = readAttribute(tag, 'URI')
    if (uri === undefined) continue
    try {
      encryptedPaths.add(resolveContainerPath('', uri))
    } catch {
      throw new StudyError('EPUB encryption.xml contains an unsafe resource path', 'EPUB_ENCRYPTED')
    }
  }
  const spinePaths = new Set(spine.map(item => manifest.get(item.idref)?.path).filter((value): value is string => value !== undefined))
  for (const path of encryptedPaths) {
    if (spinePaths.has(path)) {
      throw new StudyError('encrypted/DRM EPUB spine content is not supported', 'EPUB_ENCRYPTED')
    }
  }
}

function decodeMarkup(data: Uint8Array): string {
  const bytes = Buffer.from(data)
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return bytes.subarray(2).toString('utf16le')
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    const swapped = Buffer.allocUnsafe(bytes.length - 2)
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1]!
      swapped[index - 1] = bytes[index]!
    }
    return swapped.toString('utf16le')
  }
  return bytes.toString('utf8').replace(/^\uFEFF/, '')
}

function requiredText(entries: ReadonlyMap<string, ArchiveEntry>, path: string): string {
  const entry = entries.get(path)
  if (entry === undefined) throw new StudyError(`EPUB resource is missing: ${path}`, 'EPUB_RESOURCE_MISSING')
  return decodeMarkup(entry.data)
}

function parseManifest(opf: string, opfDir: string): Map<string, ManifestItem> {
  const items = new Map<string, ManifestItem>()
  for (const tag of matchingStartTags(opf, 'item')) {
    const id = readAttribute(tag, 'id')
    const href = readAttribute(tag, 'href')
    const mediaType = readAttribute(tag, 'media-type') ?? 'application/octet-stream'
    if (id === undefined || href === undefined) continue
    const readerHref = normalizeReaderHref(opfDir, href)
    const path = resolveContainerPath(opfDir, readerHref)
    const properties = (readAttribute(tag, 'properties') ?? '').split(/\s+/).filter(Boolean)
    items.set(id, { id, readerHref, path, mediaType, properties })
  }
  if (items.size === 0) throw new StudyError('EPUB OPF manifest is empty', 'EPUB_MANIFEST_INVALID')
  return items
}

function parseSpine(opf: string): SpineItem[] {
  const spineMatch = /<(?:[\w.-]+:)?spine\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?spine\s*>/i.exec(opf)
  const body = spineMatch?.[1] ?? opf
  const items: SpineItem[] = []
  for (const tag of matchingStartTags(body, 'itemref')) {
    const idref = readAttribute(tag, 'idref')
    const linear = readAttribute(tag, 'linear')
    if (idref !== undefined) items.push({ idref, linear: linear !== 'no' })
  }
  return items
}

/** Reject broken manifest references before applying reader-oriented spine fallback rules. */
function assertSpineManifestReferences(manifest: ReadonlyMap<string, ManifestItem>, spine: readonly SpineItem[]): void {
  for (const item of spine) {
    if (!manifest.has(item.idref)) {
      throw new StudyError(`EPUB spine references missing manifest item "${item.idref}"`, 'EPUB_MANIFEST_INVALID')
    }
  }
}

/**
 * Prefer normal linear reading order, but accept publishers that incorrectly
 * mark every chapter `linear="no"`. Navigation documents never become prose.
 */
function selectReadableSpine(manifest: ReadonlyMap<string, ManifestItem>, spine: readonly SpineItem[]): readonly SpineItem[] {
  const readable = spine.filter(({ idref }) => {
    const item = manifest.get(idref)
    return item !== undefined && isXhtml(item.mediaType, item.path) && !item.properties.includes('nav')
  })
  const linear = readable.filter(item => item.linear)
  return linear.length > 0 ? linear : readable
}

function parseNavigationLabels(
  entries: ReadonlyMap<string, ArchiveEntry>,
  manifest: ReadonlyMap<string, ManifestItem>,
  opf: string,
): Map<string, string> {
  const labels = new Map<string, string>()
  const nav = [...manifest.values()].find(item => item.properties.includes('nav'))
  if (nav !== undefined) {
    const entry = entries.get(nav.path)
    if (entry !== undefined) collectAnchorLabels(decodeMarkup(entry.data), nav.path, labels)
  }
  const spineTag = /<(?:[\w.-]+:)?spine\b[^>]*>/i.exec(opf)?.[0]
  const tocId = spineTag === undefined ? undefined : readAttribute(spineTag, 'toc')
  const ncx = tocId === undefined ? undefined : manifest.get(tocId)
  if (ncx !== undefined) {
    const entry = entries.get(ncx.path)
    if (entry !== undefined) collectNcxLabels(decodeMarkup(entry.data), ncx.path, labels)
  }
  return labels
}

function collectAnchorLabels(markup: string, documentPath: string, labels: Map<string, string>): void {
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi
  for (const match of markup.matchAll(anchor)) {
    const href = readAttribute(match[1] ?? '', 'href')
    if (href === undefined) continue
    const path = resolveContainerPath(posix.dirname(documentPath), href)
    const label = decodeEntities(stripMarkup(match[2] ?? '')).trim()
    if (label !== '' && !labels.has(path)) labels.set(path, label)
  }
}

function collectNcxLabels(markup: string, documentPath: string, labels: Map<string, string>): void {
  const navPoint = /<(?:[\w.-]+:)?navPoint\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?navPoint\s*>/gi
  for (const match of markup.matchAll(navPoint)) {
    const body = match[1] ?? ''
    const srcTag = /<(?:[\w.-]+:)?content\b[^>]*>/i.exec(body)?.[0]
    const src = srcTag === undefined ? undefined : readAttribute(srcTag, 'src')
    const text = textOfFirst(body, 'text')
    if (src === undefined || text === undefined) continue
    const path = resolveContainerPath(posix.dirname(documentPath), src)
    const label = decodeEntities(stripMarkup(text)).trim()
    if (label !== '' && !labels.has(path)) labels.set(path, label)
  }
}

/**
 * Parse semantic block-level XHTML without executing scripts or applying
 * publisher CSS. The order of matched block elements is the document order.
 */
export function parseXhtmlBlocks(
  xhtml: string,
  documentPath: string,
  logicalPage: number,
  chapterLabel: string,
  readerHref = documentPath,
): RawStudyBlock[] {
  const document = parse(xhtml, { sourceCodeLocationInfo: true })
  const body = findElement(document, 'body') ?? document
  const candidates: { readonly index: number; readonly block: RawStudyBlock }[] = []
  let hasHeading = false
  let hasDocumentRootHeading = false
  for (const element of semanticBlockElements(body)) {
    const tag = element.tagName.toLowerCase()
    const text = semanticNodeText(element)
    if (text === '') continue
    let block: RawStudyBlock
    const source = element.sourceCodeLocation
    const sourceLocator = source === undefined || source === null ? undefined : {
      kind: 'epub-xhtml' as const,
      href: readerHref,
      spineIndex: logicalPage - 1,
      startOffset: source.startOffset,
      endOffset: source.endOffset,
    }
    if (isHeadingElement(element)) {
      hasHeading = true
      // Each spine resource is an independent reading document. Its first
      // heading must restart the shared outline stack even when a publisher
      // styles it as an h2/h3 (a common Calibre export convention).
      const headingLevel = hasDocumentRootHeading
        ? (/^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : 2)
        : 1
      hasDocumentRootHeading = true
      block = {
        type: 'title',
        page: logicalPage,
        providerPageIndex: logicalPage - 1,
        text,
        headingLevel,
        ...sourceLocator !== undefined ? { sourceLocator } : {},
      }
    } else if (tag === 'ul' || tag === 'ol') {
      const items = directChildElements(element, 'li')
        .map((item, index) => `${tag === 'ol' ? `${index + 1}.` : '•'} ${semanticNodeTextExcluding(item, new Set(['ul', 'ol']))}`)
        .filter(item => !/^(?:•|\d+[.])\s*$/.test(item))
      block = { type: 'list', page: logicalPage, providerPageIndex: logicalPage - 1, text: items.join('\n') || text, ...sourceLocator !== undefined ? { sourceLocator } : {} }
    } else if (tag === 'pre') {
      block = { type: 'code', page: logicalPage, providerPageIndex: logicalPage - 1, text, ...sourceLocator !== undefined ? { sourceLocator } : {} }
    } else if (tag === 'table') {
      block = { type: 'table', page: logicalPage, providerPageIndex: logicalPage - 1, text, ...sourceLocator !== undefined ? { sourceLocator } : {} }
    } else if (tag === 'math' || /(?:^|\s)(?:math|equation|formula)(?:\s|$)/i.test(attribute(element, 'class') ?? '')) {
      block = { type: 'equation', page: logicalPage, providerPageIndex: logicalPage - 1, text, ...sourceLocator !== undefined ? { sourceLocator } : {} }
    } else if (tag === 'aside' || /(?:^|\s)(?:footnote|endnote|rearnote)(?:\s|$)/i.test(attribute(element, 'epub:type') ?? '')) {
      block = { type: 'footnote', page: logicalPage, providerPageIndex: logicalPage - 1, text, ...sourceLocator !== undefined ? { sourceLocator } : {} }
    } else if (tag === 'blockquote') {
      block = { type: 'other', page: logicalPage, providerPageIndex: logicalPage - 1, text, ...sourceLocator !== undefined ? { sourceLocator } : {} }
    } else {
      block = { type: 'paragraph', page: logicalPage, providerPageIndex: logicalPage - 1, text, ...sourceLocator !== undefined ? { sourceLocator } : {} }
    }
    candidates.push({ index: element.sourceCodeLocation?.startOffset ?? candidates.length, block })
  }

  for (const element of descendantElements(body)) {
    if (element.tagName !== 'img' && element.tagName !== 'image') continue
    const src = attribute(element, 'src') ?? attribute(element, 'href') ?? attribute(element, 'xlink:href')
    if (src === undefined || /^(?:data:|https?:|javascript:)/i.test(src)) continue
    const alt = attribute(element, 'alt') ?? attribute(element, 'aria-label') ?? ''
    const source = element.sourceCodeLocation
    const sourceLocator = source === undefined || source === null ? undefined : {
      kind: 'epub-xhtml' as const, href: readerHref, spineIndex: logicalPage - 1,
      startOffset: source.startOffset, endOffset: source.endOffset,
    }
    candidates.push({
      index: element.sourceCodeLocation?.startOffset ?? candidates.length,
      block: {
        type: 'image',
        page: logicalPage,
        providerPageIndex: logicalPage - 1,
        text: alt,
        assetPath: resolveContainerPath(posix.dirname(documentPath), src),
        ...sourceLocator !== undefined ? { sourceLocator } : {},
      },
    })
  }

  candidates.sort((left, right) => left.index - right.index)
  const blocks = candidates.map(candidate => candidate.block)
  if (!hasHeading && chapterLabel.trim() !== '') {
    blocks.unshift({
      type: 'title',
      page: logicalPage,
      providerPageIndex: logicalPage - 1,
      text: chapterLabel,
      headingLevel: 1,
    })
  }
  if (blocks.length === 0) {
    const fallback = semanticNodeText(body)
    if (fallback !== '') {
      blocks.push({
        type: 'title', page: logicalPage, providerPageIndex: logicalPage - 1,
        text: chapterLabel, headingLevel: 1,
      })
      blocks.push({ type: 'paragraph', page: logicalPage, providerPageIndex: logicalPage - 1, text: fallback })
    }
  }
  return blocks
}

type EpubNode = DefaultTreeAdapterTypes.Node
type EpubElement = DefaultTreeAdapterTypes.Element

const EXPLICIT_BLOCK_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'blockquote', 'pre', 'table', 'math', 'dd', 'dt', 'aside',
])
const FALLBACK_BLOCK_TAGS = new Set(['div', 'section', 'article', 'aside'])
const IGNORED_CONTENT_TAGS = new Set(['script', 'style', 'noscript', 'audio', 'video', 'form', 'svg'])

function isElement(node: EpubNode): node is EpubElement {
  return 'tagName' in node
}

function childNodes(node: EpubNode): readonly EpubNode[] {
  return 'childNodes' in node ? node.childNodes : []
}

function findElement(node: EpubNode, tagName: string): EpubElement | undefined {
  if (isElement(node) && node.tagName === tagName) return node
  for (const child of childNodes(node)) {
    const found = findElement(child, tagName)
    if (found !== undefined) return found
  }
  return undefined
}

function descendantElements(node: EpubNode): EpubElement[] {
  const elements: EpubElement[] = []
  for (const child of childNodes(node)) {
    if (isElement(child)) elements.push(child)
    elements.push(...descendantElements(child))
  }
  return elements
}

function directChildElements(node: EpubElement, tagName: string): EpubElement[] {
  return node.childNodes.filter((child): child is EpubElement => isElement(child) && child.tagName.toLowerCase() === tagName)
}

function semanticBlockElements(root: EpubNode): EpubElement[] {
  const blocks: EpubElement[] = []
  const visit = (node: EpubNode): void => {
    if (!isElement(node)) return
    const tag = node.tagName.toLowerCase()
    if (IGNORED_CONTENT_TAGS.has(tag)) return
    if (EXPLICIT_BLOCK_TAGS.has(tag)) {
      blocks.push(node)
      return
    }
    if (FALLBACK_BLOCK_TAGS.has(tag) && !hasDescendantBlock(node)) {
      if (semanticNodeText(node) !== '') blocks.push(node)
      return
    }
    for (const child of node.childNodes) visit(child)
  }
  for (const child of childNodes(root)) visit(child)
  return blocks
}

function hasDescendantBlock(element: EpubElement): boolean {
  for (const child of element.childNodes) {
    if (!isElement(child)) continue
    const tag = child.tagName.toLowerCase()
    if (EXPLICIT_BLOCK_TAGS.has(tag) || FALLBACK_BLOCK_TAGS.has(tag)) return true
    if (hasDescendantBlock(child)) return true
  }
  return false
}

function isHeadingElement(element: EpubElement): boolean {
  if (/^h[1-6]$/.test(element.tagName)) return true
  if (attribute(element, 'role')?.toLowerCase() === 'heading') return true
  const epubType = attribute(element, 'epub:type') ?? attribute(element, 'type') ?? ''
  if (/(?:^|\s)(?:chapter|part|title|subtitle)(?:\s|$)/i.test(epubType)) return true
  const className = attribute(element, 'class') ?? ''
  return /(?:^|\s)(?:fmtit|niv\d+tit|chapter[-_]?title|section[-_]?title|heading)(?:\s|$)/i.test(className)
}

function attribute(element: EpubElement, name: string): string | undefined {
  return element.attrs.find(candidate => candidate.name.toLowerCase() === name.toLowerCase())?.value
}

function semanticNodeText(node: EpubNode): string {
  if (isElement(node) && node.tagName === 'table') {
    const rows = descendantElements(node)
      .filter(element => element.tagName === 'tr')
      .map(row => descendantElements(row)
        .filter(cell => cell.tagName === 'td' || cell.tagName === 'th')
        .map(cell => normalizeExtractedText(textContent(cell)))
        .filter(Boolean)
        .join(' | '))
      .filter(Boolean)
    if (rows.length > 0) return rows.join('\n')
  }
  return normalizeExtractedText(textContent(node))
}

function semanticNodeTextExcluding(node: EpubNode, excluded: ReadonlySet<string>): string {
  const collect = (current: EpubNode): string => {
    if (isElement(current) && excluded.has(current.tagName.toLowerCase())) return ''
    if ('value' in current && typeof current.value === 'string') return current.value
    if (isElement(current) && current.tagName.toLowerCase() === 'br') return '\n'
    return childNodes(current).map(collect).join('')
  }
  return normalizeExtractedText(collect(node))
}

function textContent(node: EpubNode): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value
  if (isElement(node)) {
    const tag = node.tagName.toLowerCase()
    if (IGNORED_CONTENT_TAGS.has(tag) || tag === 'rp') return ''
    if (tag === 'br' || tag === 'hr') return '\n'
    if (tag === 'rt') return ` (${node.childNodes.map(textContent).join('')}) `
  }
  return childNodes(node).map(textContent).join('')
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function matchingStartTags(markup: string, localName: string): string[] {
  const expression = new RegExp(`<(?:[\\w.-]+:)?${localName}\\b[^>]*>`, 'gi')
  return [...markup.matchAll(expression)].map(match => match[0])
}

function attributeOfFirst(markup: string, localName: string, attribute: string): string | undefined {
  const tag = matchingStartTags(markup, localName)[0]
  return tag === undefined ? undefined : readAttribute(tag, attribute)
}

function readAttribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const quoted = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)
  if (quoted !== null) return decodeEntities(quoted[2] ?? '')
  const bare = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*([^\\s>]+)`, 'i').exec(tag)
  return bare === null ? undefined : decodeEntities(bare[1] ?? '')
}

function textOfFirst(markup: string, localName: string): string | undefined {
  const expression = new RegExp(
    `<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}\\s*>`,
    'i',
  )
  return expression.exec(markup)?.[1]
}

function textsOf(markup: string, localName: string): readonly string[] {
  const expression = new RegExp(
    `<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}\\s*>`,
    'gi',
  )
  return [...new Set([...markup.matchAll(expression)]
    .map(match => decodeEntities(stripMarkup(match[1] ?? '')).trim())
    .filter(value => value !== ''))]
}

function resolveContainerPath(baseDir: string, rawHref: string): string {
  const withoutFragment = rawHref.split('#', 1)[0]?.split('?', 1)[0] ?? ''
  let decoded: string
  try {
    decoded = decodeURIComponent(withoutFragment)
  } catch {
    decoded = withoutFragment
  }
  const normalized = posix.normalize(posix.join(baseDir, decoded)).replace(/^\.\//, '')
  return validateEntryName(normalized)
}

/** Keep a safe OPF-relative href for epub.js while separately resolving ZIP lookup paths. */
function normalizeReaderHref(opfDir: string, rawHref: string): string {
  const withoutSuffix = rawHref.split('#', 1)[0]?.split('?', 1)[0] ?? ''
  let decoded: string
  try { decoded = decodeURIComponent(withoutSuffix) } catch { decoded = withoutSuffix }
  if (decoded === '' || decoded.startsWith('/') || decoded.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) {
    throw new StudyError('EPUB manifest href is unsafe', 'EPUB_MANIFEST_INVALID')
  }
  const normalized = posix.normalize(decoded).replace(/^\.\//, '')
  // Resolve once solely to prove that a legal OPF-relative ../ path remains
  // inside the archive; the returned reader href deliberately stays relative.
  resolveContainerPath(opfDir, normalized)
  return normalized
}

function stripMarkup(markup: string): string {
  return markup
    .replace(/<rp\b[^>]*>[\s\S]*?<\/rp\s*>/gi, '')
    .replace(/<rt\b[^>]*>([\s\S]*?)<\/rt\s*>/gi, ' ($1) ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
}

/** Decode XML/HTML character references needed by EPUB metadata and XHTML. */
export function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®',
  }
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return safeCodePoint(Number.parseInt(entity.slice(2), 16), whole)
    }
    if (entity.startsWith('#')) {
      return safeCodePoint(Number.parseInt(entity.slice(1), 10), whole)
    }
    return named[entity.toLowerCase()] ?? whole
  })
}


function safeCodePoint(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) {
    return fallback
  }
  return String.fromCodePoint(code)
}

function isXhtml(mediaType: string, path: string): boolean {
  return mediaType === 'application/xhtml+xml' || mediaType === 'text/html' || /\.x?html?$/i.test(path)
}

function looksLikeImage(path: string): boolean {
  return ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp', '.tif', '.tiff'].includes(extname(path).toLowerCase())
}

function humanizeFileName(path: string): string {
  const name = basename(path, extname(path)).replace(/[_-]+/g, ' ').trim()
  return name === '' ? '未命名章节' : name
}
