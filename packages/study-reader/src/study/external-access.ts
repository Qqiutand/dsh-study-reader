/** Durable, least-authority bearer grants for the embedded read-only MCP endpoint. */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, open as openFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { StudyError } from '../protocol/error.ts'
import type { ExternalAccessRecord, ExternalReadingSetRecord, SourceId } from './types.ts'

const TOKEN_PREFIX = 'dsr_v1'
const MASTER_KEY_FILE = 'external-mcp.key'
const COMMAND_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u
const ACCESS_ID_PATTERN = /^external-[a-f0-9]{32}$/u
const TOKEN_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u
const SET_REF_PATTERN = /^set_[A-Za-z0-9_-]{6,16}$/u
const LEGACY_MCP_SERVER_NAME = 'dsh_reader'
const LEGACY_SET_REF = 'set_default'

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

async function loadOrCreateMasterKey(storageRoot: string): Promise<Buffer> {
  const path = join(storageRoot, MASTER_KEY_FILE)
  await mkdir(dirname(path), { recursive: true })
  try {
    const handle = await openFile(path, 'wx', 0o600)
    try {
      const key = randomBytes(32)
      await handle.writeFile(`${key.toString('base64url')}\n`, 'utf8')
      await handle.sync()
      return key
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
  }
  const encoded = (await readFile(path, 'utf8')).trim()
  if (!TOKEN_SIGNATURE_PATTERN.test(encoded)) {
    throw new Error(`study: ${MASTER_KEY_FILE} is invalid; refusing to rotate external access silently`)
  }
  const key = Buffer.from(encoded, 'base64url')
  if (key.byteLength !== 32) throw new Error(`study: ${MASTER_KEY_FILE} must contain a 32-byte key`)
  // Repair an accidentally permissive mode before accepting the key. If the
  // filesystem refuses the repair, startup fails instead of serving tokens
  // from a key readable by other local users.
  await chmod(path, 0o600)
  return key
}

function payloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function normalizedLabel(value: string): string {
  const label = value.trim().normalize('NFC')
  if (label.length === 0 || label.length > 120 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new StudyError('external access label must contain 1 to 120 printable characters', 'EXTERNAL_ACCESS_LABEL_INVALID')
  }
  return label
}

function normalizedMcpServerName(value: string): string {
  const name = value.trim()
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    throw new StudyError('MCP server name must contain 1 to 64 letters, numbers, underscores, or hyphens', 'EXTERNAL_ACCESS_MCP_NAME_INVALID')
  }
  return name
}

function normalizedSetLabel(value: string): string {
  const label = value.trim().normalize('NFC')
  if (label.length === 0 || label.length > 120 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new StudyError('reading set label must contain 1 to 120 printable characters', 'EXTERNAL_SET_LABEL_INVALID')
  }
  return label
}

function normalizedSourceIds(sourceIds: readonly SourceId[]): SourceId[] {
  const normalized = [...new Set(sourceIds)].sort((left, right) => String(left).localeCompare(String(right)))
  if (normalized.length === 0 || normalized.length > 100) {
    throw new StudyError('a reading set requires 1 to 100 documents', 'EXTERNAL_SET_SCOPE_INVALID')
  }
  return normalized
}

export function externalMcpServerName(record: ExternalAccessRecord): string {
  return record.mcpServerName ?? LEGACY_MCP_SERVER_NAME
}

/** Compatibility projection for v0.7 connections that stored one flat scope. */
export function externalReadingSets(record: ExternalAccessRecord): readonly ExternalReadingSetRecord[] {
  return record.readingSets ?? [{
    setRef: LEGACY_SET_REF,
    label: record.label,
    sourceIds: record.sourceIds,
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
  }]
}

/** Stable, human-readable Codex environment key derived from one MCP name. */
export function externalTokenEnvironmentVariable(mcpServerName: string): string {
  if (mcpServerName.toLowerCase() === 'study-reader') return 'DSH_STUDY_READER_TOKEN'
  const semanticName = mcpServerName.replace(/^reader[-_]?/iu, '') || mcpServerName
  return `DSH_STUDY_READER_${semanticName.toUpperCase().replaceAll(/[^A-Z0-9]+/gu, '_')}_TOKEN`
}

function assertCommandId(commandId: string): void {
  if (!COMMAND_PATTERN.test(commandId)) throw new StudyError('external access commandId is invalid', 'EXTERNAL_ACCESS_COMMAND_ID_INVALID')
}

function tokenState(record: ExternalAccessRecord, now: number): 'active' | 'expired' | 'revoked' {
  if (record.revokedAt !== undefined) return 'revoked'
  return record.expiresAt <= now ? 'expired' : 'active'
}

export interface CreateExternalAccessInput {
  readonly commandId: string
  readonly label: string
  readonly mcpServerName: string
  readonly readingSetLabel: string
  readonly sourceIds: readonly SourceId[]
  readonly expiresInDays: number
}

export class ExternalAccessManager {
  private readonly tails = new Map<string, Promise<void>>()

  private constructor(
    private readonly records: KvTable<string, ExternalAccessRecord>,
    private readonly masterKey: Buffer,
  ) {}

  static async open(records: KvTable<string, ExternalAccessRecord>, storageRoot: string): Promise<ExternalAccessManager> {
    return new ExternalAccessManager(records, await loadOrCreateMasterKey(storageRoot))
  }

  list(): readonly ExternalAccessRecord[] {
    return [...this.records.entries()].map(([, record]) => record)
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
  }

  state(record: ExternalAccessRecord, now = Date.now()): 'active' | 'expired' | 'revoked' {
    return tokenState(record, now)
  }

  async create(input: CreateExternalAccessInput): Promise<{ readonly record: ExternalAccessRecord; readonly token: string }> {
    assertCommandId(input.commandId)
    const label = normalizedLabel(input.label)
    const mcpServerName = normalizedMcpServerName(input.mcpServerName)
    const readingSetLabel = normalizedSetLabel(input.readingSetLabel)
    const sourceIds = normalizedSourceIds(input.sourceIds)
    if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 365) {
      throw new StudyError('external access expiry must be between 1 and 365 days', 'EXTERNAL_ACCESS_EXPIRY_INVALID')
    }
    const hash = payloadHash({ label, mcpServerName, readingSetLabel, sourceIds, expiresInDays: input.expiresInDays })
    // One create lock also makes the active MCP-name uniqueness check atomic
    // across different browser command ids.
    return await this.lock('create', async () => {
      const replay = this.list().find(record => record.createCommandId === input.commandId)
      if (replay !== undefined) {
        if (replay.createPayloadHash !== hash) throw new StudyError('commandId was reused with a different external access request', 'COMMAND_ID_CONFLICT')
        return { record: replay, token: this.tokenFor(replay.id) }
      }
      const now = Date.now()
      const activeRecords = this.list().filter(record => tokenState(record, now) === 'active')
      if (activeRecords.some(record => externalMcpServerName(record) === mcpServerName)) {
        throw new StudyError(`an active external connection already uses MCP name "${mcpServerName}"`, 'EXTERNAL_ACCESS_MCP_NAME_CONFLICT')
      }
      const environmentVariable = externalTokenEnvironmentVariable(mcpServerName)
      if (activeRecords.some(record => externalTokenEnvironmentVariable(externalMcpServerName(record)) === environmentVariable)) {
        throw new StudyError(`MCP name "${mcpServerName}" collides with an active connection's token environment variable`, 'EXTERNAL_ACCESS_MCP_NAME_CONFLICT')
      }
      const record: ExternalAccessRecord = {
        schemaVersion: 1,
        id: `external-${randomUUID().replaceAll('-', '')}`,
        label,
        mcpServerName,
        sourceIds,
        readingSets: [{
          setRef: this.newSetRef(),
          label: readingSetLabel,
          sourceIds,
          createdAt: now,
          updatedAt: now,
        }],
        createdAt: now,
        expiresAt: now + input.expiresInDays * 86_400_000,
        version: 1,
        createCommandId: input.commandId,
        createPayloadHash: hash,
      }
      await this.records.put(record.id, record)
      return { record, token: this.tokenFor(record.id) }
    })
  }

  listSets(accessId: string): readonly ExternalReadingSetRecord[] {
    return externalReadingSets(this.requireActive(accessId))
  }

  /** Recreate the stable bearer token for an active browser-managed authorization. */
  credentials(accessId: string): { readonly record: ExternalAccessRecord; readonly token: string } {
    const record = this.requireActive(accessId)
    return { record, token: this.tokenFor(record.id) }
  }

  resolveSet(accessId: string, setRef?: string): ExternalReadingSetRecord {
    const sets = this.listSets(accessId)
    if (setRef === undefined) {
      if (sets.length === 1) return sets[0]!
      throw new StudyError('setRef is required because this connection exposes multiple reading sets; call reader_list_sets first', 'EXTERNAL_SET_REQUIRED')
    }
    if (!SET_REF_PATTERN.test(setRef)) throw new StudyError('setRef is invalid', 'EXTERNAL_SET_NOT_FOUND')
    const set = sets.find(candidate => candidate.setRef === setRef)
    if (set === undefined) throw new StudyError('reading set is unavailable to this connection', 'EXTERNAL_SET_NOT_FOUND')
    return set
  }

  async saveSet(input: {
    readonly accessId: string
    readonly commandId: string
    readonly expectedVersion: number
    readonly setRef?: string
    readonly label: string
    readonly sourceIds: readonly SourceId[]
  }): Promise<{ readonly record: ExternalAccessRecord; readonly set: ExternalReadingSetRecord }> {
    assertCommandId(input.commandId)
    const label = normalizedSetLabel(input.label)
    const sourceIds = normalizedSourceIds(input.sourceIds)
    const hash = payloadHash({ kind: 'save-set', setRef: input.setRef, label, sourceIds })
    return await this.lock(`access:${input.accessId}`, async () => {
      const record = this.requireActive(input.accessId)
      if (record.lastCommandId === input.commandId) {
        if (record.lastCommandPayloadHash !== hash || record.lastCommandSetRef === undefined) throw new StudyError('commandId was reused with a different external access request', 'COMMAND_ID_CONFLICT')
        const replay = externalReadingSets(record).find(set => set.setRef === record.lastCommandSetRef)
        if (replay === undefined) throw new StudyError('reading set command receipt is invalid', 'COMMAND_ID_CONFLICT')
        return { record, set: replay }
      }
      if (record.version !== input.expectedVersion) throw new StudyError('external access version conflict', 'EXTERNAL_ACCESS_VERSION_CONFLICT')
      const current = [...externalReadingSets(record)]
      const existingIndex = input.setRef === undefined ? -1 : current.findIndex(set => set.setRef === input.setRef)
      if (input.setRef !== undefined && existingIndex < 0) throw new StudyError('reading set is unavailable to this connection', 'EXTERNAL_SET_NOT_FOUND')
      if (existingIndex < 0 && current.length >= 32) throw new StudyError('an external connection supports at most 32 reading sets', 'EXTERNAL_SET_LIMIT_EXCEEDED')
      if (current.some((set, index) => index !== existingIndex && set.label.normalize('NFKC').toLocaleLowerCase() === label.normalize('NFKC').toLocaleLowerCase())) {
        throw new StudyError(`reading set "${label}" already exists in this connection`, 'EXTERNAL_SET_LABEL_CONFLICT')
      }
      const now = Date.now()
      const set: ExternalReadingSetRecord = existingIndex < 0
        ? { setRef: this.newSetRef(), label, sourceIds, createdAt: now, updatedAt: now }
        : { ...current[existingIndex]!, label, sourceIds, updatedAt: now }
      if (existingIndex < 0) current.push(set)
      else current[existingIndex] = set
      const next: ExternalAccessRecord = {
        ...record,
        sourceIds: this.unionSourceIds(current),
        readingSets: current,
        version: record.version + 1,
        lastCommandId: input.commandId,
        lastCommandPayloadHash: hash,
        lastCommandSetRef: set.setRef,
      }
      await this.records.put(next.id, next)
      return { record: next, set }
    })
  }

  async deleteSet(input: {
    readonly accessId: string
    readonly commandId: string
    readonly expectedVersion: number
    readonly setRef: string
  }): Promise<ExternalAccessRecord> {
    assertCommandId(input.commandId)
    if (!SET_REF_PATTERN.test(input.setRef)) throw new StudyError('reading set is unavailable to this connection', 'EXTERNAL_SET_NOT_FOUND')
    const hash = payloadHash({ kind: 'delete-set', setRef: input.setRef })
    return await this.lock(`access:${input.accessId}`, async () => {
      const record = this.requireActive(input.accessId)
      if (record.lastCommandId === input.commandId) {
        if (record.lastCommandPayloadHash !== hash) throw new StudyError('commandId was reused with a different external access request', 'COMMAND_ID_CONFLICT')
        return record
      }
      if (record.version !== input.expectedVersion) throw new StudyError('external access version conflict', 'EXTERNAL_ACCESS_VERSION_CONFLICT')
      const current = externalReadingSets(record)
      if (!current.some(set => set.setRef === input.setRef)) throw new StudyError('reading set is unavailable to this connection', 'EXTERNAL_SET_NOT_FOUND')
      if (current.length === 1) throw new StudyError('the last reading set cannot be deleted; revoke the connection instead', 'EXTERNAL_SET_LAST_DELETE')
      const readingSets = current.filter(set => set.setRef !== input.setRef)
      const next: ExternalAccessRecord = {
        ...record,
        sourceIds: this.unionSourceIds(readingSets),
        readingSets,
        version: record.version + 1,
        lastCommandId: input.commandId,
        lastCommandPayloadHash: hash,
        lastCommandSetRef: input.setRef,
      }
      await this.records.put(next.id, next)
      return next
    })
  }

  async revoke(accessId: string, commandId: string, expectedVersion: number): Promise<ExternalAccessRecord> {
    assertCommandId(commandId)
    if (!ACCESS_ID_PATTERN.test(accessId)) throw new StudyError('external access connection not found', 'EXTERNAL_ACCESS_NOT_FOUND')
    return await this.lock(`access:${accessId}`, async () => {
      const record = this.records.get(accessId)
      if (record === undefined) throw new StudyError('external access connection not found', 'EXTERNAL_ACCESS_NOT_FOUND')
      if (record.lastCommandId === commandId && record.revokedAt !== undefined) return record
      if (record.version !== expectedVersion) throw new StudyError('external access version conflict', 'EXTERNAL_ACCESS_VERSION_CONFLICT')
      const next: ExternalAccessRecord = {
        ...record,
        revokedAt: Date.now(),
        version: record.version + 1,
        lastCommandId: commandId,
      }
      await this.records.put(next.id, next)
      return next
    })
  }

  /** Resolve an already-authenticated connection again so revocation is immediate. */
  requireActive(accessId: string): ExternalAccessRecord {
    const record = this.records.get(accessId)
    if (record === undefined || tokenState(record, Date.now()) !== 'active') {
      throw new StudyError('external access is unavailable', 'PERMISSION_DENIED')
    }
    return record
  }

  /** Authenticate without revealing whether a token was malformed, expired, or revoked. */
  authenticate(token: string): ExternalAccessRecord | undefined {
    if (token.length > 256) return undefined
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !ACCESS_ID_PATTERN.test(parts[1]!) || !TOKEN_SIGNATURE_PATTERN.test(parts[2]!)) return undefined
    const expected = this.signatureFor(parts[1]!)
    const actual = Buffer.from(parts[2]!, 'base64url')
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return undefined
    const record = this.records.get(parts[1]!)
    return record !== undefined && tokenState(record, Date.now()) === 'active' ? record : undefined
  }

  private tokenFor(accessId: string): string {
    return `${TOKEN_PREFIX}.${accessId}.${this.signatureFor(accessId).toString('base64url')}`
  }

  private newSetRef(): string {
    return `set_${randomBytes(6).toString('base64url')}`
  }

  private unionSourceIds(sets: readonly ExternalReadingSetRecord[]): SourceId[] {
    return [...new Set(sets.flatMap(set => set.sourceIds))]
      .sort((left, right) => String(left).localeCompare(String(right)))
  }

  private signatureFor(accessId: string): Buffer {
    return createHmac('sha256', this.masterKey).update(`${TOKEN_PREFIX}\u0000${accessId}`).digest()
  }

  private async lock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.catch(() => {}).then(() => gate)
    this.tails.set(key, tail)
    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}
