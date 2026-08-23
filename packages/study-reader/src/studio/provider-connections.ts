/** Durable non-secret provider connections with live Host application and health testing. */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { createHash } from 'node:crypto'
import type { DocumentExtractionService, ExtractionConnectionConfig, ExtractionHealth, ExtractionProviderId } from '../extraction/index.ts'
import { StudyError } from '../protocol/error.ts'
import { canonicalManagementPayload, managementPayloadHash } from '../study/management.ts'
import type { DeleteProviderConnectionRequest, ProviderConnectionCommandReceipt, ProviderConnectionRecord, ProviderConnectionTestResult, SaveProviderConnectionRequest } from './types.ts'

interface Deps {
  readonly records: KvTable<string, ProviderConnectionRecord>
  readonly receipts: KvTable<string, ProviderConnectionCommandReceipt>
  readonly extraction: DocumentExtractionService
  readonly now?: () => number
}

function displayName(kind: string): string { return kind === 'mineru' ? 'MinerU Cloud' : kind }
function connectionId(providerId: string, commandId: string): string {
  return `${providerId}:custom:${createHash('sha256').update(commandId).digest('hex').slice(0, 16)}`
}

function validateCommandId(value: string): void {
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) throw new StudyError('commandId is invalid', 'PROVIDER_CONNECTION_COMMAND_INVALID')
}

/** Secret-free persistence. Credential values continue to live only in Credential Service. */
export class ProviderConnectionRepository {
  private readonly tails = new Map<string, Promise<void>>()
  private stopProviderObservation: (() => void) | undefined
  constructor(private readonly deps: Deps) {}

  /** Begin applying durable overrides whenever a provider becomes live. */
  start(): void {
    if (this.stopProviderObservation !== undefined) return
    this.stopProviderObservation = this.deps.extraction.observeProviders(providerId => {
      const existing = [...this.deps.records.entries()].map(([, value]) => value)
        .find(value => value.providerId === String(providerId) && this.normalized(value, value.id === String(providerId)).active)
      if (existing !== undefined) {
        try { this.apply(existing) } catch (error) {
          // Test/local providers may deliberately expose no mutable connection
          // contract. Their registration must remain valid; the durable
          // connection record only applies to configurable provider instances.
          if (!(error instanceof StudyError) || error.code !== 'PROVIDER_CONNECTION_UNSUPPORTED') throw error
        }
      }
      // A deployment default is intentionally not persisted merely because
      // the provider appeared. Only an explicit browser save creates a
      // durable override; otherwise restart/config changes remain observable.
    })
  }

  dispose(): void {
    this.stopProviderObservation?.()
    this.stopProviderObservation = undefined
  }

  async initialize(): Promise<ProviderConnectionRecord> {
    const providerId = this.deps.extraction.defaultProviderId()
    const existing = this.deps.records.get(String(providerId))
    if (existing !== undefined) {
      // If the provider is already live, apply the durable override now. If
      // its sibling row is still loading, start() will apply it on registration.
      try { this.apply(existing) } catch (error) {
        if (!(error instanceof StudyError) || error.code !== 'PROVIDER_NOT_FOUND') throw error
      }
      return this.normalized(existing, existing.id === String(providerId))
    }
    const live = this.deps.extraction.connection(providerId)
    const now = this.now()
    const record: ProviderConnectionRecord = {
      schemaVersion: 1, id: String(live.providerId), providerId: String(live.providerId), providerKind: live.kind,
      displayName: displayName(live.kind), builtin: true, active: true, credentialRef: live.credentialRef ?? '', endpoint: live.endpoint,
      enabled: live.enabled, ...(live.model === undefined ? {} : { model: live.model }), nonSecretConfig: live.options,
      version: 1, createdAt: now, updatedAt: now,
    }
    return record
  }

  async list(): Promise<readonly ProviderConnectionRecord[]> {
    const liveDefault = await this.initialize()
    const records = [...this.deps.records.entries()].map(([, value]) => this.normalized(value, value.id === liveDefault.providerId))
    const list = records.length === 0 ? [liveDefault] : [...records]
    if (!list.some(record => record.active)) list[0] = { ...list[0]!, active: true }
    return list.sort((a, b) => Number(b.active) - Number(a.active) || Number(b.builtin) - Number(a.builtin) || a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
  }

  async save(request: SaveProviderConnectionRequest): Promise<ProviderConnectionRecord> {
    validateCommandId(request.commandId)
    return await this.lock(request.providerId, async () => {
      const initialized = await this.initialize()
      if (this.deps.records.get(initialized.id) === undefined) await this.deps.records.put(initialized.id, initialized)
      const id = request.connectionId ?? connectionId(request.providerId, request.commandId)
      const payload = { connectionId: id, providerId: request.providerId, displayName: request.displayName, expectedVersion: request.expectedVersion, endpoint: request.endpoint, enabled: request.enabled, model: request.model ?? null, nonSecretConfig: request.nonSecretConfig, activate: request.activate }
      const canonicalPayload = canonicalManagementPayload(payload)
      const payloadHash = managementPayloadHash(payload)
      const receipt = this.deps.receipts.get(request.commandId)
      if (receipt !== undefined) {
        if (receipt.providerId !== request.providerId || receipt.payloadHash !== payloadHash) throw new StudyError('commandId was reused with different provider configuration', 'PROVIDER_CONNECTION_COMMAND_CONFLICT')
        if (receipt.state === 'committed' && receipt.result !== undefined) return receipt.result
        if (receipt.state === 'rejected') throw new StudyError(receipt.errorMessage ?? 'provider connection was rejected', receipt.errorCode ?? 'PROVIDER_CONNECTION_REJECTED')
      } else {
        const now = this.now()
        await this.deps.receipts.put(request.commandId, { schemaVersion: 1, commandId: request.commandId, providerId: request.providerId, canonicalPayload, payloadHash, state: 'pending', createdAt: now, updatedAt: now })
      }
      try {
        const existing = this.deps.records.get(id)
        const current = existing === undefined
          ? request.connectionId === undefined
            ? undefined
            : id === request.providerId ? await this.initialize() : undefined
          : this.normalized(existing, id === request.providerId)
        if (request.connectionId !== undefined && current === undefined) throw new StudyError('provider connection not found', 'PROVIDER_CONNECTION_NOT_FOUND')
        if (request.connectionId === undefined && request.expectedVersion !== 0) throw new StudyError('new provider connection must use expectedVersion 0', 'PROVIDER_CONNECTION_VERSION_CONFLICT')
        if (current !== undefined && current.version !== request.expectedVersion) throw new StudyError('provider connection version conflict', 'PROVIDER_CONNECTION_VERSION_CONFLICT')
        const base = current ?? await this.initialize()
        const config: ExtractionConnectionConfig = { endpoint: request.endpoint.trim(), enabled: request.enabled, ...(request.model === undefined ? {} : { model: request.model.trim() }), options: request.nonSecretConfig }
        if (request.activate) this.deps.extraction.configureConnection(request.providerId as ExtractionProviderId, config)
        const applied = request.activate ? this.deps.extraction.connection(request.providerId as ExtractionProviderId) : undefined
        if (request.activate) {
          for (const [otherId, value] of this.deps.records.entries()) {
            if (otherId === id || value.providerId !== request.providerId) continue
            const other = this.normalized(value, otherId === request.providerId)
            if (other.active) await this.deps.records.put(otherId, { ...other, active: false, version: other.version + 1, updatedAt: this.now() })
          }
        }
        const next: ProviderConnectionRecord = {
          ...base, id, providerId: request.providerId, displayName: request.displayName.trim(), builtin: id === request.providerId,
          active: request.activate ? true : current?.active ?? false,
          endpoint: applied?.endpoint ?? config.endpoint, enabled: applied?.enabled ?? config.enabled,
          ...((applied?.model ?? config.model) === undefined ? {} : { model: applied?.model ?? config.model }),
          nonSecretConfig: applied?.options ?? config.options,
          version: (current?.version ?? 0) + 1, createdAt: current?.createdAt ?? this.now(), updatedAt: this.now(), lastCommandId: request.commandId,
        }
        await this.deps.records.put(next.id, next)
        const admitted = this.deps.receipts.get(request.commandId)
        await this.deps.receipts.put(request.commandId, { schemaVersion: 1, commandId: request.commandId, providerId: request.providerId, canonicalPayload, payloadHash, state: 'committed', result: next, createdAt: admitted?.createdAt ?? this.now(), updatedAt: this.now() })
        return next
      } catch (error) {
        if (error instanceof StudyError) {
          const admitted = this.deps.receipts.get(request.commandId)
          await this.deps.receipts.put(request.commandId, { schemaVersion: 1, commandId: request.commandId, providerId: request.providerId, canonicalPayload, payloadHash, state: 'rejected', errorCode: error.code, errorMessage: error.message, createdAt: admitted?.createdAt ?? this.now(), updatedAt: this.now() })
        }
        throw error
      }
    })
  }

  async delete(request: DeleteProviderConnectionRequest): Promise<{ readonly deleted: true }> {
    validateCommandId(request.commandId)
    return await this.lock(request.connectionId, async () => {
      const currentValue = this.deps.records.get(request.connectionId)
      if (currentValue === undefined) throw new StudyError('provider connection not found', 'PROVIDER_CONNECTION_NOT_FOUND')
      const current = this.normalized(currentValue, currentValue.id === currentValue.providerId)
      if (current.builtin) throw new StudyError('the built-in provider connection cannot be deleted', 'PROVIDER_CONNECTION_BUILTIN')
      if (current.active) throw new StudyError('activate another connection before deleting this one', 'PROVIDER_CONNECTION_ACTIVE')
      if (current.version !== request.expectedVersion) throw new StudyError('provider connection version conflict', 'PROVIDER_CONNECTION_VERSION_CONFLICT')
      await this.deps.records.delete(request.connectionId)
      return { deleted: true }
    })
  }

  async test(providerId: string): Promise<ProviderConnectionTestResult> {
    const record = this.deps.records.get(providerId) ?? await this.initialize()
    if (record.providerId !== providerId) throw new StudyError('provider connection not found', 'PROVIDER_CONNECTION_NOT_FOUND')
    const started = performance.now()
    let health: ExtractionHealth
    try { health = await this.deps.extraction.health(AbortSignal.timeout(10_000), providerId as ExtractionProviderId) } catch (error) {
      return { ok: false, latencyMs: Math.max(0, Math.round(performance.now() - started)), providerStatus: 'unavailable', errorCode: error instanceof StudyError ? error.code : 'PROVIDER_TEST_FAILED', message: error instanceof Error ? error.message : 'Provider test failed' }
    }
    return {
      ok: health.state === 'available' || health.state === 'degraded', latencyMs: Math.max(0, Math.round(performance.now() - started)), providerStatus: health.state,
      ...(health.error === undefined ? {} : { errorCode: health.error.code }), message: health.error?.message ?? (health.state === 'available' ? 'Connection available' : `Connection ${health.state}`),
    }
  }

  private apply(record: ProviderConnectionRecord): void {
    if (!this.normalized(record, record.id === record.providerId).active) return
    this.deps.extraction.configureConnection(record.providerId as ExtractionProviderId, { endpoint: record.endpoint, enabled: record.enabled, ...(record.model === undefined ? {} : { model: record.model }), options: record.nonSecretConfig })
  }

  private async lock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.catch(() => {}).then(() => gate)
    this.tails.set(key, tail)
    await previous.catch(() => {})
    try { return await operation() } finally { release(); if (this.tails.get(key) === tail) this.tails.delete(key) }
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  private normalized(record: ProviderConnectionRecord, builtin: boolean): ProviderConnectionRecord {
    return { ...record, builtin: record.builtin ?? builtin, active: record.active ?? builtin }
  }
}
