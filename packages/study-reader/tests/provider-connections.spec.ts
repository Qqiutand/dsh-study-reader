import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  DocumentExtractionService,
  type DocumentExtractorProvider,
  type ExtractionConnectionConfig,
  type ExtractionProviderId,
} from '../src/extraction/index.ts'
import { ProviderConnectionRepository } from '../src/studio/provider-connections.ts'
import type { ProviderConnectionCommandReceipt, ProviderConnectionRecord } from '../src/studio/types.ts'

class Table<V> implements KvTable<string, V> {
  private readonly values = new Map<string, V>()
  get(key: string): V | undefined { return this.values.get(key) }
  entries(): IterableIterator<[string, V]> { return this.values.entries() }
  async put(key: string, value: V): Promise<void> { this.values.set(key, structuredClone(value)) }
  async delete(key: string): Promise<void> { this.values.delete(key) }
}

class ConfigurableProvider implements DocumentExtractorProvider {
  readonly id = 'mineru' as ExtractionProviderId
  readonly kind = 'mineru'
  config: ExtractionConnectionConfig = { endpoint: 'https://deployment.example', enabled: true, model: 'vlm', options: { language: 'ch' } }
  connectionDescriptor(): ExtractionConnectionConfig & { readonly credentialRef: string } { return { ...this.config, credentialRef: 'MINERU_API_KEY' } }
  configureConnection(config: ExtractionConnectionConfig): void { this.config = config }
  async health() { return { state: 'available' as const, checkedAt: 1, retryable: true } }
  async prepareUpload(): Promise<never> { throw new Error('not used') }
  async submitUrl(): Promise<never> { throw new Error('not used') }
  async poll(): Promise<{ readonly state: 'pending' }> { return { state: 'pending' } }
  async cancel(): Promise<{ readonly outcome: 'cancelled' }> { return { outcome: 'cancelled' } }
  async collect(): Promise<never> { throw new Error('not used') }
}

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(async context => await context.fiber.dispose())) })

describe('ProviderConnectionRepository registration ordering', () => {
  it('starts before the configured provider and captures it when the sibling row registers later', async () => {
    const context = new Context(); contexts.push(context)
    const extraction = new DocumentExtractionService(context, { provider: 'mineru' })
    const records = new Table<ProviderConnectionRecord>()
    const repository = new ProviderConnectionRepository({ records, receipts: new Table<ProviderConnectionCommandReceipt>(), extraction, now: () => 10 })
    expect(() => repository.start()).not.toThrow()
    extraction.registerProvider(new ConfigurableProvider())
    expect(records.get('mineru')).toBeUndefined()
    expect(await repository.list()).toContainEqual(expect.objectContaining({ providerId: 'mineru', endpoint: 'https://deployment.example', credentialRef: 'MINERU_API_KEY', version: 1 }))
    expect(records.get('mineru')).toBeUndefined()
    repository.dispose()
  })

  it('applies a durable non-secret override when the provider registers after Study', async () => {
    const context = new Context(); contexts.push(context)
    const extraction = new DocumentExtractionService(context, { provider: 'mineru' })
    const records = new Table<ProviderConnectionRecord>()
    await records.put('mineru', {
      schemaVersion: 1, id: 'mineru', providerId: 'mineru', providerKind: 'mineru', displayName: 'MinerU', credentialRef: 'MINERU_API_KEY',
      endpoint: 'https://saved.example', enabled: true, model: 'pipeline', nonSecretConfig: { language: 'en' }, version: 2, createdAt: 1, updatedAt: 2,
    })
    const repository = new ProviderConnectionRepository({ records, receipts: new Table<ProviderConnectionCommandReceipt>(), extraction })
    repository.start()
    const provider = new ConfigurableProvider()
    extraction.registerProvider(provider)
    expect(provider.config).toEqual({ endpoint: 'https://saved.example', enabled: true, model: 'pipeline', options: { language: 'en' } })
    repository.dispose()
  })

  it('keeps the built-in connection while creating and switching durable custom profiles', async () => {
    const context = new Context(); contexts.push(context)
    const extraction = new DocumentExtractionService(context, { provider: 'mineru' })
    const provider = new ConfigurableProvider()
    extraction.registerProvider(provider)
    const repository = new ProviderConnectionRepository({ records: new Table<ProviderConnectionRecord>(), receipts: new Table<ProviderConnectionCommandReceipt>(), extraction, now: () => 20 })

    const custom = await repository.save({
      sessionId: 'session', commandId: 'create-local', providerId: 'mineru', displayName: '本地 MinerU', expectedVersion: 0,
      endpoint: 'http://127.0.0.1:8000', enabled: true, model: 'pipeline', nonSecretConfig: { apiMode: 'local-docker' }, activate: true,
    })
    let records = await repository.list()
    expect(records).toHaveLength(2)
    expect(records.find(record => record.id === 'mineru')).toMatchObject({ builtin: true, active: false })
    expect(records.find(record => record.id === custom.id)).toMatchObject({ builtin: false, active: true, displayName: '本地 MinerU' })
    expect(provider.config.endpoint).toBe('http://127.0.0.1:8000')

    const official = records.find(record => record.id === 'mineru')!
    await repository.save({
      sessionId: 'session', commandId: 'activate-official', providerId: 'mineru', connectionId: official.id,
      displayName: official.displayName, expectedVersion: official.version, endpoint: official.endpoint, enabled: official.enabled,
      ...(official.model === undefined ? {} : { model: official.model }), nonSecretConfig: official.nonSecretConfig, activate: true,
    })
    records = await repository.list()
    expect(records.find(record => record.id === 'mineru')).toMatchObject({ active: true })
    expect(records.find(record => record.id === custom.id)).toMatchObject({ active: false })
    expect(provider.config.endpoint).toBe('https://deployment.example')
  })
})
