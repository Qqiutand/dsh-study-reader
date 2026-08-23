/**
 * Shared browser helpers for the study surface: the upload pipeline
 * (prepare → streaming PUT → status polling with renewal) and pure decision
 * logic shared by the bounded document importer.
 * @module @deepseek-ai/dsh-client-ui-study/client/logic
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ImportId, ImportStatusView, PrepareUploadResult } from '../study/types.ts'
import type { StudyRemote } from './remote.ts'

/** Unwrap one Remote envelope; a business failure becomes a thrown error. */
export function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) {
    const code = 'code' in result.error ? String(result.error.code) : 'remote-error'
    throw new Error(code)
  }
  return result.value
}

/** Poll one import until a terminal state, with bounded renewal of the upload. */
export async function pollImportStatus(
  remote: StudyRemote,
  importId: ImportId,
  signal: AbortSignal,
  onProgress?: (status: ImportStatusView) => void,
): Promise<ImportStatusView> {
  let delayMs = 800
  for (;;) {
    signal.throwIfAborted()
    const status = unwrap(await remote.importStatus({ importId }))
    onProgress?.(status)
    if (status.state === 'ready' || status.state === 'failed' || status.state === 'cancelled') return status
    if (status.state === 'awaiting-upload' && status.renewRequired) return status
    await sleep(delayMs, signal)
    delayMs = Math.min(delayMs * 2, 5000)
  }
}

/** Sleep honoring an abort signal. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Upload one File through the study pipeline: prepare, stream the bytes to
 * the same-origin route with the one-time token, then poll to a terminal
 * state. A host restart (renewRequired) renews the upload and retries once.
 * @param remote - the mounted study Remote namespace.
 * @param file - the selected file.
 * @param sessionId - current conversation session receiving Agent-visible notices.
 * @param signal - aborts the whole pipeline.
 * @param onProgress - status callback between polls.
 * @returns the terminal import status.
 */
export async function uploadFile(
  remote: StudyRemote,
  file: File,
  signal: AbortSignal,
  options: BeginFileUploadOptions = {},
  onProgress?: (status: ImportStatusView) => void,
): Promise<ImportStatusView> {
  const accepted = await beginFileUpload(remote, file, signal, options, onProgress)
  return await pollImportStatus(remote, accepted.importId, signal, onProgress)
}

/**
 * Capture one file on the Host and return as soon as its background import is
 * admitted. Provider preparation and polling continue independently.
 * @param remote - the mounted study Remote namespace.
 * @param file - the selected file.
 * @param sessionId - current conversation session receiving Agent-visible notices.
 * @param signal - aborts preparation and the same-origin PUT.
 * @param onProgress - receives the first durable Host status.
 * @returns the admitted import status.
 */
/** Named upload inputs keep evolving import preferences out of positional arguments. */
export interface BeginFileUploadOptions {
  readonly sessionId?: string
  readonly targetFolderId?: string
  readonly language?: string
  readonly isOcr?: boolean
  readonly enableTable?: boolean
  readonly enableFormula?: boolean
}

export async function beginFileUpload(
  remote: StudyRemote,
  file: File,
  signal: AbortSignal,
  options: BeginFileUploadOptions = {},
  onProgress?: (status: ImportStatusView) => void,
): Promise<ImportStatusView> {
  let prepared = unwrap(await remote.prepareUpload({
    fileName: file.name,
    sizeBytes: file.size,
    ...options.sessionId !== undefined ? { sessionId: options.sessionId } : {},
    ...options.targetFolderId !== undefined ? { targetFolderId: options.targetFolderId } : {},
    ...options.language !== undefined ? { language: options.language } : {},
    ...options.isOcr !== undefined ? { isOcr: options.isOcr } : {},
    ...options.enableTable !== undefined ? { enableTable: options.enableTable } : {},
    ...options.enableFormula !== undefined ? { enableFormula: options.enableFormula } : {},
  }))
  let status = await uploadOnce(remote, file, prepared, signal, onProgress)
  if (status.state === 'awaiting-upload' && status.renewRequired) {
    prepared = unwrap(await remote.renewUpload({ importId: status.importId }))
    status = await uploadOnce(remote, file, prepared, signal, onProgress)
  }
  return status
}

/** One prepare-and-PUT cycle. */
async function uploadOnce(
  remote: StudyRemote,
  file: File,
  prepared: PrepareUploadResult,
  signal: AbortSignal,
  onProgress?: (status: ImportStatusView) => void,
): Promise<ImportStatusView> {
  const response = await fetch(prepared.uploadPath, {
    method: 'PUT',
    headers: {
      'X-Study-Upload-Token': prepared.uploadToken,
      'Content-Length': String(file.size),
    },
    body: file,
    signal,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { code?: string } | null
    throw new Error(payload?.code ?? `upload failed (HTTP ${response.status})`)
  }
  const status = unwrap(await remote.importStatus({ importId: prepared.importId }))
  onProgress?.(status)
  return status
}
