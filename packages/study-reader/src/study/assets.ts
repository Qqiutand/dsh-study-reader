/**
 * Same-origin original-document and extracted-asset delivery. Original PDFs
 * are served with byte-range support for the browser's native/PDF.js viewer;
 * image blobs are served only when they are referenced by the requested
 * revision, preventing the blob store from becoming an unauthenticated key
 * oracle.
 * @module @deepseek-ai/dsh-study/assets
 */

import { createReadStream, existsSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { open, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZipFile } from 'yazl'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { StudyError } from '../protocol/error.ts'
import { BlobStore, type BlobKey } from './blob-store.ts'
import type { RevisionId, RevisionRecord, SourceId, SourceRecord, StudyBlock } from './types.ts'

export interface StudyAssetDeps {
  readonly routePrefix: string
  readonly sources: KvTable<SourceId, SourceRecord>
  readonly revisions: KvTable<RevisionId, RevisionRecord>
  readonly blobs: BlobStore
}

/** Host-owned route handler for originals and revision-scoped assets. */
export class StudyAssetServer {
  private readonly references = new Map<RevisionId, ReadonlySet<string>>()

  constructor(private readonly deps: StudyAssetDeps) {}

  routeHandler() {
    return (req: IncomingMessage, res: ServerResponse): void => {
      void this.handle(req, res)
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD')
        respondJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'expected GET or HEAD' })
        return
      }
      const path = parseAssetPath(req.url, this.deps.routePrefix)
      if (path.kind === 'pdfjs-wasm') {
        await streamStaticFile(req, res, resolvePdfjsWasm(path.fileName), 'application/wasm')
        return
      }
      if (path.kind === 'pdfjs-worker') {
        await streamStaticFile(req, res, resolvePdfjsWorker(), 'text/javascript; charset=utf-8')
        return
      }
      const source = this.deps.sources.get(path.sourceId as SourceId)
      const revision = this.deps.revisions.get(path.revisionId as RevisionId)
      if (source === undefined || revision === undefined || revision.sourceId !== source.id) {
        throw new StudyError('source or revision not found', 'ASSET_NOT_FOUND')
      }

      if (path.kind === 'original') {
        if (revision.originalBlob === undefined) throw new StudyError('original file is unavailable', 'ASSET_NOT_FOUND')
        await this.streamFile(req, res, revision.originalBlob as BlobKey, revision.mediaType ?? mediaTypeForName(revision.fileName), revision.fileName)
        return
      }

      if (path.kind === 'mineru-export') {
        if (revision.providerKind !== 'mineru' || revision.blockCount === 0) {
          throw new StudyError('MinerU structured output is unavailable', 'ASSET_NOT_FOUND')
        }
        await this.streamMineruExport(req, res, source, revision)
        return
      }

      const key = `sha256/${path.sha256}` as BlobKey
      const references = await this.assetReferences(revision)
      if (!references.has(key)) throw new StudyError('asset is not referenced by this revision', 'ASSET_NOT_FOUND')
      const mediaType = await sniffMediaType(this.deps.blobs.blobPath(key))
      await this.streamFile(req, res, key, mediaType)
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined)
        return
      }
      if (error instanceof StudyError) {
        const status = error.code === 'ASSET_NOT_FOUND'
          ? 404
          : error.code === 'ASSET_RANGE_INVALID' ? 416 : 400
        if (status === 416) res.setHeader('Accept-Ranges', 'bytes')
        respondJson(res, status, { code: error.code, message: error.message })
        return
      }
      respondJson(res, 500, { code: 'ASSET_FAILED', message: error instanceof Error ? error.message : 'asset request failed' })
    }
  }

  private async assetReferences(revision: RevisionRecord): Promise<ReadonlySet<string>> {
    const cached = this.references.get(revision.id)
    if (cached !== undefined) return cached
    const bytes = await this.deps.blobs.readBlob(revision.blocksBlob as BlobKey)
    const refs = new Set<string>()
    for (const line of new TextDecoder().decode(bytes).split('\n')) {
      if (line.trim() === '') continue
      const block = JSON.parse(line) as StudyBlock
      if (block.assetPath?.startsWith('sha256/')) refs.add(block.assetPath)
    }
    this.references.set(revision.id, refs)
    return refs
  }

  private async streamMineruExport(
    req: IncomingMessage,
    res: ServerResponse,
    source: SourceRecord,
    revision: RevisionRecord,
  ): Promise<void> {
    const archiveName = `${safeFileStem(source.displayTitle)}-mineru.zip`
    res.writeHead(200, {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(archiveName)}`,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }

    const zip = new ZipFile()
    const stableTime = new Date(revision.createdAt)
    const options = { mtime: stableTime, mode: 0o100644 }
    zip.addFile(this.deps.blobs.blobPath(revision.markdownBlob as BlobKey), 'document.md', options)
    zip.addFile(this.deps.blobs.blobPath(revision.blocksBlob as BlobKey), 'blocks.jsonl', options)
    zip.addBuffer(Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      source: {
        title: source.displayTitle,
        authors: source.authors,
        originalFileName: source.originalFileName,
        format: revision.format ?? source.format ?? 'pdf',
      },
      revision: {
        provider: revision.providerKind,
        model: revision.providerModel,
        pageCount: revision.pageCount,
        blockCount: revision.blockCount,
        contentSha256: revision.sha256,
        createdAt: revision.createdAt,
      },
      outline: revision.outline,
    }, null, 2)}\n`, 'utf8'), 'manifest.json', options)

    const references = [...await this.assetReferences(revision)].sort()
    for (const [index, value] of references.entries()) {
      const key = value as BlobKey
      const mediaType = await sniffMediaType(this.deps.blobs.blobPath(key))
      zip.addFile(this.deps.blobs.blobPath(key), `assets/${String(index + 1).padStart(4, '0')}-${key.slice(7, 19)}${extensionForMediaType(mediaType)}`, options)
    }

    await new Promise<void>((resolveStream, reject) => {
      zip.outputStream.once('error', reject)
      res.once('error', reject)
      res.once('finish', resolveStream)
      zip.outputStream.pipe(res)
      zip.end()
    })
  }

  private async streamFile(
    req: IncomingMessage,
    res: ServerResponse,
    key: BlobKey,
    mediaType: string = 'application/octet-stream',
    fileName?: string,
  ): Promise<void> {
    const path = this.deps.blobs.blobPath(key)
    const file = await stat(path)
    let range: { start: number; end: number } | undefined
    try {
      range = parseRange(req.headers.range, file.size)
    } catch (error) {
      if (error instanceof StudyError && error.code === 'ASSET_RANGE_INVALID') {
        res.setHeader('Content-Range', `bytes */${file.size}`)
      }
      throw error
    }
    const start = range?.start ?? 0
    const end = range?.end ?? Math.max(0, file.size - 1)
    const length = file.size === 0 ? 0 : end - start + 1
    const headers: Record<string, string | number> = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'Content-Type': mediaType,
      'Content-Length': length,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
    }
    if (mediaType === 'image/svg+xml') {
      headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'"
    }
    if (fileName !== undefined) headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`
    if (range !== undefined) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`
    res.writeHead(range === undefined ? 200 : 206, headers)
    if (req.method === 'HEAD' || length === 0) {
      res.end()
      return
    }
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(path, { start, end })
      stream.on('error', reject)
      stream.on('end', resolve)
      stream.pipe(res)
    })
  }
}

type AssetPath =
  | { readonly kind: 'pdfjs-wasm'; readonly fileName: PdfjsWasmFile }
  | { readonly kind: 'pdfjs-worker' }
  | { readonly kind: 'original'; readonly sourceId: string; readonly revisionId: string }
  | { readonly kind: 'mineru-export'; readonly sourceId: string; readonly revisionId: string }
  | { readonly kind: 'blob'; readonly sourceId: string; readonly revisionId: string; readonly sha256: string }

const PDFJS_WASM_FILES = new Set(['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm'] as const)
type PdfjsWasmFile = 'jbig2.wasm' | 'openjpeg.wasm' | 'qcms_bg.wasm'

function resolvePdfjsWasm(fileName: PdfjsWasmFile): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // The first path is correct for compiled lib/types/study/assets.js; the
  // second keeps source-mode tests deterministic.
  const roots = [resolve(here, '../../../pdfjs-wasm'), resolve(here, '../../pdfjs-wasm')]
  const root = roots.find(candidate => existsSync(resolve(candidate, fileName)))
  if (root === undefined) throw new StudyError(`PDF decoder asset is unavailable: ${fileName}`, 'ASSET_NOT_FOUND')
  return resolve(root, fileName)
}

function resolvePdfjsWorker(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // Distribution packages copy the worker beside pdfjs-wasm. Source-mode
  // tests and local builds resolve the dependency from the package tree.
  const candidates = [
    resolve(here, '../../../pdfjs-worker/pdf.worker.mjs'),
    resolve(here, '../../node_modules/pdfjs-dist/build/pdf.worker.mjs'),
    resolve(here, '../../../node_modules/pdfjs-dist/build/pdf.worker.mjs'),
  ]
  const worker = candidates.find(candidate => existsSync(candidate))
  if (worker === undefined) throw new StudyError('PDF worker is unavailable', 'ASSET_NOT_FOUND')
  return worker
}

function parseAssetPath(rawUrl: string | undefined, prefix: string): AssetPath {
  if (rawUrl === undefined) throw new StudyError('missing asset path', 'ASSET_NOT_FOUND')
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://study.local').pathname)
  } catch {
    throw new StudyError('malformed asset path', 'ASSET_NOT_FOUND')
  }
  const normalizedPrefix = `/${prefix.split('/').filter(Boolean).join('/')}`
  if (pathname !== normalizedPrefix && !pathname.startsWith(`${normalizedPrefix}/`)) {
    throw new StudyError('asset path is outside the configured prefix', 'ASSET_NOT_FOUND')
  }
  const segments = pathname.slice(normalizedPrefix.length).split('/').filter(Boolean)
  if (segments.length === 3 && segments[0] === '_pdfjs' && segments[1] === 'wasm' && PDFJS_WASM_FILES.has(segments[2] as PdfjsWasmFile)) {
    return { kind: 'pdfjs-wasm', fileName: segments[2] as PdfjsWasmFile }
  }
  if (segments.length === 3 && segments[0] === '_pdfjs' && segments[1] === 'worker' && segments[2] === 'pdf.worker.mjs') {
    return { kind: 'pdfjs-worker' }
  }
  const [sourceId, revisionId, kind, value] = segments
  if (sourceId === undefined || revisionId === undefined) throw new StudyError('incomplete asset path', 'ASSET_NOT_FOUND')
  if (kind === 'original' && segments.length === 3) return { kind: 'original', sourceId, revisionId }
  if (kind === 'mineru-export' && segments.length === 3) return { kind: 'mineru-export', sourceId, revisionId }
  if (kind === 'blob' && value !== undefined && /^[a-f0-9]{64}$/i.test(value) && segments.length === 4) {
    return { kind: 'blob', sourceId, revisionId, sha256: value.toLowerCase() }
  }
  throw new StudyError('unrecognized asset path', 'ASSET_NOT_FOUND')
}

function safeFileStem(value: string): string {
  const normalized = value.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').trim().slice(0, 120)
  return normalized === '' ? 'document' : normalized
}

function extensionForMediaType(mediaType: string): string {
  if (mediaType === 'image/png') return '.png'
  if (mediaType === 'image/jpeg') return '.jpg'
  if (mediaType === 'image/gif') return '.gif'
  if (mediaType === 'image/webp') return '.webp'
  if (mediaType === 'image/svg+xml') return '.svg'
  return '.bin'
}

async function streamStaticFile(req: IncomingMessage, res: ServerResponse, path: string, mediaType: string): Promise<void> {
  const file = await stat(path)
  res.writeHead(200, {
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Type': mediaType,
    'Content-Length': file.size,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('end', resolveStream)
    stream.pipe(res)
  })
}

function parseRange(raw: string | undefined, size: number): { start: number; end: number } | undefined {
  if (raw === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim())
  if (match === null || size <= 0) throw new StudyError('invalid byte range', 'ASSET_RANGE_INVALID')
  const left = match[1] ?? ''
  const right = match[2] ?? ''
  let start: number
  let end: number
  if (left === '') {
    const suffix = Number(right)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new StudyError('invalid suffix range', 'ASSET_RANGE_INVALID')
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(left)
    end = right === '' ? size - 1 : Number(right)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    throw new StudyError('byte range is not satisfiable', 'ASSET_RANGE_INVALID')
  }
  return { start, end: Math.min(end, size - 1) }
}

function mediaTypeForName(name: string | undefined): string {
  const lower = name?.toLowerCase() ?? ''
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.epub')) return 'application/epub+zip'
  return 'application/octet-stream'
}

async function sniffMediaType(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, bytesRead)
    if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
    if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg'
    if (head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
    if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    const text = head.toString('utf8').trimStart().toLowerCase()
    if (text.startsWith('<svg') || text.startsWith('<?xml') && text.includes('<svg')) return 'image/svg+xml'
    return 'application/octet-stream'
  } finally {
    await handle.close()
  }
}

function respondJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}
