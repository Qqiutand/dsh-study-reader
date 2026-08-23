/**
 * A fake MinerU v4 API for keyless development and tests: implements batch
 * upload preparation, signed-URL PUT, status polling with a configurable
 * state sequence, single-task URL submission, and result-archive downloads
 * served from generated STORE-format zips. Fault injection covers 401/403,
 * 429 with Retry-After, 5xx, invalid JSON, business code != 0, and unknown
 * states.
 *
 * No real credential is ever required: the provider's Authorization header is
 * accepted verbatim.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** One configured state sequence step. */
export type FakeStatus = 'waiting-file' | 'pending' | 'running' | 'converting' | 'done' | 'failed'

/** Fault injection knobs. */
export interface FakeMineruOptions {
  /** State sequence advanced on each poll; default ['pending', 'running', 'done']. */
  pollSequence?: readonly FakeStatus[]
  /** Prepare (batch or task) fault: HTTP status or envelope behavior. */
  prepareFault?: '401' | '403' | '429' | '400' | '500' | 'invalid-json' | 'code-nonzero'
  /** Poll fault, applied on the first N polls. */
  pollFault?: { readonly status?: number; readonly retryAfterSeconds?: number; readonly count?: number }
  /** Result zip content; default a v2 content list. */
  zipPayload?: { kind: 'v2' | 'v1' | 'md'; value: unknown }
  /** Emit a corrupted (non-zip) result archive instead. */
  corruptZip?: boolean
  /** Fail the result download with this HTTP status. */
  downloadFault?: number
  /** Extra delay per poll in ms (timeout tests). */
  pollDelayMs?: number
  /** Extra delay while preparing an upload task (background-admission tests). */
  prepareDelayMs?: number
  /** Emit `file_urls` as bare strings (the current MinerU contract) instead of objects. */
  batchFileUrlsAsStrings?: boolean
}

/** One prepared batch task. */
interface BatchState {
  readonly batchId: string
  readonly fileId: string
  statusIndex: number
  uploaded: boolean
  readonly options: FakeMineruOptions
}

/** One prepared single task. */
interface TaskState {
  readonly taskId: string
  statusIndex: number
  readonly options: FakeMineruOptions
}

const FAKE_UPLOADS = new Map<string, { bytes: number }>()

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Envelope writer shared by every endpoint. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Minimal STORE-format zip writer (no compression, deterministic). */
export function buildZip(entries: readonly { name: string; data: Uint8Array }[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt32LE(0, 10) // time/date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.byteLength, 18)
    local.writeUInt32LE(entry.data.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, Buffer.from(entry.data))
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt32LE(0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.byteLength, 20)
    central.writeUInt32LE(entry.data.byteLength, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += 30 + name.byteLength + entry.data.byteLength
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, ...centralParts, end])
}

/** CRC-32 (IEEE) for zip entries. */
function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/** Default v2 content-list payload. */
export function v2Content(): unknown {
  return [
    [
      { type: 'title', content: { title_content: [{ type: 'text', content: '第一章 导论' }], level: 1 } },
      { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: '社会科学的核心问题是解释社会现象。' }] } },
    ],
    [
      { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: '因果推断需要识别策略。' }] } },
      { type: 'table', content: { table_body: '方法 | 适用场景\n实验 | 随机对照' } },
    ],
    [
      { type: 'image', content: { image_caption: [{ type: 'text', content: '示意图' }], image_path: 'images/cover.png' } },
    ],
  ]
}

/** The fake MinerU server. */
export class FakeMineruServer {
  private readonly server: Server
  private readonly batches = new Map<string, BatchState>()
  private readonly tasks = new Map<string, TaskState>()
  private readonly options: FakeMineruOptions
  private readonly listeners: Array<() => void> = []
  private readonly baseOptions: FakeMineruOptions
  private listening = false

  /** Current per-request options; tests may swap this live. */
  mode: FakeMineruOptions

  /** Last prepared batch id (for assertions). */
  lastBatchId: string | undefined

  /** Total signed-URL uploads received. */
  uploadCount = 0
  /** Last multipart body received by the official local API seam. */
  localMultipartBody: string | undefined

  /**
   * @param options - initial fault/sequence configuration.
   */
  constructor(options: FakeMineruOptions = {}) {
    this.options = { pollSequence: ['pending', 'running', 'done'], ...options }
    this.mode = this.options
    this.baseOptions = this.options
    this.server = createServer((req, res) => { void this.handle(req, res) })
  }

  /** Start listening. */
  start(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.server.off('error', onError)
        this.listening = true
        const address = this.server.address()
        const actualPort = typeof address === 'object' && address !== null ? address.port : port
        const url = `http://127.0.0.1:${actualPort}`
        this.listeners.push(() => { void this.close() })
        resolve({ url, close: () => this.close() })
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(port, '127.0.0.1')
    })
  }

  /** Stop the server. */
  async close(): Promise<void> {
    this.listeners.pop()
    if (!this.listening) return
    this.listening = false
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  /** Whether a signed URL for the given batch id has been PUT. */
  wasUploaded(batchId: string): boolean {
    return this.batches.get(batchId)?.uploaded ?? false
  }

  /** Force-advance one batch to done (restart-recovery tests). */
  forceDone(batchId: string): void {
    const batch = this.batches.get(batchId)
    if (batch !== undefined) batch.statusIndex = 99
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake')
    const path = url.pathname
    const options = this.mode

    if (req.method === 'GET' && path === '/health') {
      json(res, 200, { status: 'healthy', version: 'fake', protocol_version: '1' })
      return
    }

    if (req.method === 'POST' && path === '/tasks') {
      this.localMultipartBody = (await readBody(req)).toString('latin1')
      const taskId = `local-${Math.random().toString(36).slice(2, 10)}`
      this.tasks.set(taskId, { taskId, statusIndex: 0, options: { ...this.baseOptions, ...options } })
      json(res, 202, { task_id: taskId, status: 'pending' })
      return
    }

    if (req.method === 'GET' && /^\/tasks\/[^/]+$/u.test(path)) {
      const taskId = path.slice('/tasks/'.length)
      const task = this.tasks.get(taskId)
      if (task === undefined) { json(res, 404, { detail: 'Task not found' }); return }
      const sequence = task.options.pollSequence ?? ['pending', 'running', 'done']
      const state = sequence[Math.min(task.statusIndex, sequence.length - 1)] ?? 'pending'
      task.statusIndex += 1
      const status = state === 'done' ? 'completed' : state === 'failed' ? 'failed' : state === 'running' || state === 'converting' ? 'processing' : 'pending'
      json(res, 200, { task_id: taskId, status, error: status === 'failed' ? 'fake extraction failed' : null })
      return
    }

    if (req.method === 'GET' && /^\/tasks\/[^/]+\/result$/u.test(path)) {
      const zip = fakeResultZip(options)
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(zip.byteLength) })
      res.end(zip)
      return
    }

    if (req.method === 'PUT' && path.startsWith('/upload/')) {
      const batchId = path.slice('/upload/'.length)
      await drain(req)
      FAKE_UPLOADS.set(batchId, { bytes: 0 })
      this.uploadCount += 1
      const batch = this.batches.get(batchId)
      if (batch !== undefined) batch.uploaded = true
      json(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && path === '/api/v4/file-urls/batch') {
      if (options.prepareDelayMs !== undefined) await delay(options.prepareDelayMs)
      if (options.prepareFault !== undefined) {
        this.fault(res, options.prepareFault)
        return
      }
      const body = JSON.parse((await readBody(req)).toString('utf8')) as { files?: Array<{ name?: string }> }
      const batchId = `batch-${Math.random().toString(36).slice(2, 10)}`
      const fileId = `file-${Math.random().toString(36).slice(2, 10)}`
      this.batches.set(batchId, {
        batchId,
        fileId,
        statusIndex: 0,
        uploaded: false,
        options: { ...this.baseOptions, ...options },
      })
      this.lastBatchId = batchId
      const uploadUrl = `${originOf(req)}/upload/${batchId}?X-Amz-Signature=fake-signature`
      json(res, 200, {
        code: 0,
        data: {
          batch_id: batchId,
          file_urls: options.batchFileUrlsAsStrings === true
            ? [uploadUrl]
            : [{ upload_url: uploadUrl, file_id: fileId }],
          file_name: body.files?.[0]?.name ?? 'upload.pdf',
        },
      })
      return
    }

    if (req.method === 'POST' && path === '/api/v4/extract/task') {
      if (options.prepareFault !== undefined) {
        this.fault(res, options.prepareFault)
        return
      }
      const taskId = `task-${Math.random().toString(36).slice(2, 10)}`
      this.tasks.set(taskId, { taskId, statusIndex: 0, options: { ...this.baseOptions, ...options } })
      json(res, 200, { code: 0, data: { task_id: taskId } })
      return
    }

    const batchPoll = /^\/api\/v4\/extract-results\/batch\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && batchPoll !== null) {
      if (options.pollDelayMs !== undefined) await sleep(options.pollDelayMs)
      const batch = this.batches.get(batchPoll[1])
      if (batch === undefined) {
        // Unknown batch (e.g. polled from a restarted harness): the provider
        // keeps results for processed tasks, so answer done with a result URL.
        this.pollResult(res, 'done', options, batchPoll[1], 'batch')
        return
      }
      const status = this.pollStatus(batch.options, batch.statusIndex)
      batch.statusIndex += 1
      this.pollResult(res, status, options, batchPoll[1], 'batch')
      return
    }

    const taskPoll = /^\/api\/v4\/extract\/task\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && taskPoll !== null) {
      const task = this.tasks.get(taskPoll[1])
      if (task === undefined) {
        json(res, 200, { code: 1001, msg: 'task not found' })
        return
      }
      if (options.pollDelayMs !== undefined) await sleep(options.pollDelayMs)
      const status = this.pollStatus(task.options, task.statusIndex)
      task.statusIndex += 1
      this.pollResult(res, status, options, taskPoll[1], 'single')
      return
    }

    const resultZip = /^\/results\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && resultZip !== null) {
      if (options.downloadFault !== undefined) {
        res.writeHead(options.downloadFault)
        res.end('download failed')
        return
      }
      if (options.corruptZip === true) {
        res.writeHead(200, { 'Content-Type': 'application/zip' })
        res.end('this is not a zip')
        return
      }
      const payload = options.zipPayload ?? { kind: 'v2' as const, value: v2Content() }
      const entries = zipEntriesFor(payload)
      res.writeHead(200, { 'Content-Type': 'application/zip' })
      res.end(buildZip(entries))
      return
    }

    json(res, 404, { code: 404, message: `no fake route for ${req.method} ${path}` })
  }

  private pollStatus(options: FakeMineruOptions, index: number): FakeStatus {
    const sequence = options.pollSequence ?? ['pending', 'running', 'done']
    const status = sequence[Math.min(index, sequence.length - 1)] ?? 'done'
    return status
  }

  private pollResult(
    res: ServerResponse,
    status: FakeStatus,
    options: FakeMineruOptions,
    id: string,
    kind: 'batch' | 'single',
  ): void {
    const fault = options.pollFault
    if (fault !== undefined && (fault.count ?? 1) > 0) {
      if (fault.status !== undefined) {
        fault.count = (fault.count ?? 1) - 1
        if (fault.status === 429 && fault.retryAfterSeconds !== undefined) {
          res.writeHead(429, { 'Retry-After': String(fault.retryAfterSeconds) })
        } else {
          res.writeHead(fault.status)
        }
        res.end('poll fault')
        return
      }
    }
    const result = {
      state: status,
      ...status === 'done' ? { full_zip_url: `${originOf(res.req)}/results/${id}` } : {},
      ...status === 'running'
        ? { extract_progress: { extracted_pages: 2, total_pages: 3 } }
        : {},
      ...status === 'failed' ? { err_msg: 'fake extraction failed', code: 'FAKE_FAILURE' } : {},
    }
    json(res, 200, {
      code: 0,
      msg: 'ok',
      data: kind === 'batch'
        ? { batch_id: id, extract_result: [result] }
        : { task_id: id, ...result },
    })
  }

  private fault(res: ServerResponse, fault: NonNullable<FakeMineruOptions['prepareFault']>): void {
    switch (fault) {
      case '401': res.writeHead(401); res.end('unauthorized'); return
      case '403': res.writeHead(403); res.end('forbidden'); return
      case '429': res.writeHead(429, { 'Retry-After': '1' }); res.end('too many requests'); return
      case '400': res.writeHead(400); res.end('bad request'); return
      case '500': res.writeHead(500); res.end('boom'); return
      case 'invalid-json': res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{not json'); return
      case 'code-nonzero':
        json(res, 200, { code: 4002, msg: 'business rejection' })
        return
    }
  }
}

function zipEntriesFor(payload: { kind: 'v2' | 'v1' | 'md'; value: unknown }): Array<{ name: string; data: Uint8Array }> {
  if (payload.kind === 'md') {
    return [{ name: 'content/full.md', data: new TextEncoder().encode(String(payload.value)) }]
  }
  const fileName = payload.kind === 'v2' ? 'content_list_v2.json' : 'content_list.json'
  return [
    { name: `content/${fileName}`, data: new TextEncoder().encode(JSON.stringify(payload.value)) },
    { name: 'images/cover.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  ]
}

function fakeResultZip(options: FakeMineruOptions): Buffer {
  if (options.corruptZip === true) return Buffer.from('this is not a zip')
  return buildZip(zipEntriesFor(options.zipPayload ?? { kind: 'v2', value: v2Content() }))
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1'
  return `http://${host}`
}

function drain(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.resume()
    req.on('end', () => resolve())
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
