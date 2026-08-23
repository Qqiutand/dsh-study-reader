/**
 * Browser file upload: one-time ticket issuance and a same-origin PUT route.
 * The route only captures browser input into bounded scratch storage. The
 * Study service commits it as the Original Blob; adapters later upload a fresh
 * read-only stream and keep signed URLs entirely within provider code.
 *
 * Security posture:
 * - tokens are 32 random bytes; only their sha256 hashes are stored;
 * - each token is single-use, TTL-bound, and bound to ImportId + exact size;
 * - Content-Length and streamed byte counts must both equal the prepared size;
 * - the upstream URL is provider-issued and process-local;
 * - scratch files are removed on rejection and committed by the owning study
 *   service only after the upload (and optional upstream PUT) succeeds.
 * @module @deepseek-ai/dsh-study/upload
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StudyError } from '../protocol/error.ts'
import type { ImportId } from './types.ts'

/** One issued upload ticket (in-memory only). */
export interface UploadTicket {
  /** sha256 of the one-time token; the raw token is never stored. */
  readonly tokenHash: string
  readonly importId: ImportId
  readonly expectedSize: number
  readonly expiresAt: number
}

/** In-memory preparation for one upload. */
interface PendingUpload {
  /** Absolute scratch path selected by the host, never accepted from client input. */
  readonly capturePath: string
}

/** The upload-ticket and signed-URL registry, process-local by design. */
export class UploadRegistry {
  private readonly tickets = new Map<string, UploadTicket>()
  private readonly pending = new Map<string, PendingUpload>()
  private onUploaded: ((importId: string, capturePath: string) => Promise<void>) | undefined

  /** @param ticketTtlMs - token lifetime in milliseconds. */
  constructor(private readonly ticketTtlMs: number) {}

  /**
   * Issue one upload ticket.
   * @param importId - the owning import.
   * @param expectedSize - exact request body size.
   * @param capturePath - trusted host scratch path.
   * @param now - wall clock for TTL.
   * @returns the raw one-time token.
   */
  issue(
    importId: ImportId,
    expectedSize: number,
    capturePath: string,
    now: number = Date.now(),
  ): string {
    const token = randomBytes(32).toString('hex')
    this.tickets.set(importId, {
      tokenHash: sha256(token),
      importId,
      expectedSize,
      expiresAt: now + this.ticketTtlMs,
    })
    this.pending.set(importId, {
      capturePath,
    })
    return token
  }

  /** Install the post-upload commit/normalization hook. */
  setOnUploaded(fn: (importId: string, capturePath: string) => Promise<void>): void {
    this.onUploaded = fn
  }

  /** Remove one import's live ticket and preparation. */
  clear(importId: string): void {
    this.tickets.delete(importId)
    this.pending.delete(importId)
  }

  /** Revoke only the one-time ticket before issuing another. */
  revokeTicket(importId: string): void {
    this.tickets.delete(importId)
  }

  /** Whether enough process-local preparation remains to accept an upload. */
  hasPrepared(importId: string): boolean {
    return this.pending.has(importId)
  }

  /** Backward-compatible readiness probe; no provider URL is retained. */
  hasSignedUrl(importId: string): boolean {
    return this.hasPrepared(importId)
  }

  /** Diagnostics/tests: inspect one ticket without exposing the raw token. */
  peek(importId: string): UploadTicket | undefined {
    return this.tickets.get(importId)
  }

  /** Validate and atomically consume a one-time ticket. */
  consume(
    importId: string,
    token: string | undefined,
    now: number = Date.now(),
  ): { expectedSize: number; capturePath: string } {
    const ticket = this.tickets.get(importId)
    if (ticket === undefined) {
      throw new StudyError('upload not prepared or already consumed', 'UPLOAD_NOT_PREPARED')
    }
    if (now > ticket.expiresAt) {
      this.pending.delete(importId)
      throw new StudyError('upload token expired', 'UPLOAD_EXPIRED')
    }
    if (token === undefined) {
      throw new StudyError('upload token rejected', 'UPLOAD_TOKEN_REJECTED')
    }
    if (!timingSafeEqualHex(ticket.tokenHash, sha256(token))) {
      throw new StudyError('upload token rejected', 'UPLOAD_TOKEN_REJECTED')
    }
    const upload = this.pending.get(importId)
    if (upload === undefined) {
      throw new StudyError('upload preparation was lost (host restarted?)', 'UPLOAD_NOT_PREPARED')
    }
    this.tickets.delete(importId)
    return { expectedSize: ticket.expectedSize, ...upload }
  }

  /** Bind the same-origin upload route handler. */
  routeHandler(maxFileBytes: number, lifecycle: AbortSignal) {
    return (req: IncomingMessage, res: ServerResponse): void => {
      void this.handle(req, res, maxFileBytes, lifecycle)
    }
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    maxFileBytes: number,
    lifecycle: AbortSignal,
  ): Promise<void> {
    let capturePath: string | undefined
    let importId: string | undefined
    try {
      if (req.method !== 'PUT') {
        json(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'expected PUT' })
        return
      }
      importId = importIdFromUrl(req.url)
      const prepared = this.consume(importId, req.headers['x-study-upload-token'] as string | undefined)
      capturePath = prepared.capturePath
      if (prepared.expectedSize > maxFileBytes) {
        throw new StudyError(`file exceeds maxFileBytes (${maxFileBytes})`, 'FILE_TOO_LARGE')
      }
      const contentLength = parseContentLength(req.headers['content-length'])
      if (contentLength !== prepared.expectedSize) {
        throw new StudyError(
          `Content-Length ${String(contentLength)} does not match prepared size ${prepared.expectedSize}`,
          'SIZE_MISMATCH',
        )
      }

      await mkdir(dirname(capturePath), { recursive: true })
      let streamed = 0
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          streamed += chunk.byteLength
          if (streamed > prepared.expectedSize) {
            callback(new StudyError('upload exceeded prepared size', 'SIZE_MISMATCH'))
            return
          }
          callback(null, chunk)
        },
      })
      await pipeline(req, counter, createWriteStream(capturePath, { flags: 'w' }), { signal: lifecycle })
      if (streamed !== prepared.expectedSize) {
        throw new StudyError(
          `upload ended at ${streamed} bytes; expected ${prepared.expectedSize}`,
          'SIZE_MISMATCH',
        )
      }

      if (this.onUploaded !== undefined) await this.onUploaded(importId, capturePath)
      this.clear(importId)
      json(res, 200, { ok: true })
    } catch (error) {
      if (capturePath !== undefined) await rm(capturePath, { force: true }).catch(() => {})
      // A rejected token must not invalidate an otherwise valid preparation:
      // the browser may retry with the original ticket after a stale tab or
      // extension injected a bad request. Once capture started, or the ticket
      // expired, the preparation cannot be safely reused.
      if (importId !== undefined && (capturePath !== undefined
        || (error instanceof StudyError && error.code === 'UPLOAD_EXPIRED'))) {
        this.pending.delete(importId)
      }
      if (error instanceof StudyError) {
        const status = uploadStatus(error.code)
        json(res, status, { code: error.code, message: error.message })
        return
      }
      const message = error instanceof Error ? error.message : 'upload failed'
      json(res, lifecycle.aborted ? 503 : 500, { code: 'UPLOAD_FAILED', message })
    }
  }
}

function uploadStatus(code: string): number {
  switch (code) {
    case 'UPLOAD_EXPIRED': case 'UPLOAD_NOT_PREPARED': return 410
    case 'UPLOAD_TOKEN_REJECTED': return 401
    case 'FILE_TOO_LARGE': case 'SIZE_MISMATCH': return 413
    case 'UPLOAD_UPSTREAM_FAILED': return 502
    default: return 500
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** Extract the import id segment from a route URL. */
function importIdFromUrl(rawUrl: string | undefined): string {
  if (rawUrl === undefined) throw new StudyError('missing upload path', 'UPLOAD_NOT_PREPARED')
  const pathname = new URL(rawUrl, 'http://study.local').pathname
  const importId = pathname.split('/').filter(Boolean).at(-1)
  if (importId === undefined || importId === '') {
    throw new StudyError('missing upload path', 'UPLOAD_NOT_PREPARED')
  }
  return importId
}

function parseContentLength(header: string | string[] | undefined): number | undefined {
  const value = Array.isArray(header) ? header[0] : header
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}
