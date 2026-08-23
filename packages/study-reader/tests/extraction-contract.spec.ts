/** Provider-contract regression tests for registration, durable routing, and teardown. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  DocumentExtractionService,
  type DocumentExtractorProvider,
  type ExtractionProviderId,
  type ProviderTask,
} from '../src/extraction/index.ts'

const signal = (): AbortSignal => new AbortController().signal

class FakeProvider implements DocumentExtractorProvider {
  readonly kind = 'fake'
  readonly calls: string[] = []

  constructor(readonly id: ExtractionProviderId) {}

  async health(): Promise<{ readonly state: 'available'; readonly checkedAt: number; readonly retryable: true }> {
    return { state: 'available', checkedAt: 1, retryable: true }
  }

  async prepareUpload(): Promise<never> { throw new Error('not used') }
  async submitUrl(): Promise<never> { throw new Error('not used') }
  async poll(task: ProviderTask): Promise<{ readonly state: 'pending' }> {
    this.calls.push(`poll:${task.id}`)
    return { state: 'pending' }
  }
  async cancel(task: ProviderTask): Promise<{ readonly outcome: 'cancelled' }> {
    this.calls.push(`cancel:${task.id}`)
    return { outcome: 'cancelled' }
  }
  async collect(task: ProviderTask, destination: string): Promise<{ readonly path: string; readonly manifest: { readonly schemaVersion: 1; readonly kind: string; readonly sha256: string; readonly bytes: number } }> {
    this.calls.push(`collect:${task.id}`)
    return { path: destination, manifest: { schemaVersion: 1, kind: 'fake', sha256: '0'.repeat(64), bytes: 0 } }
  }
}

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

describe('document extraction provider contract', () => {
  it('routes a restored task by its durable provider id and unregisters safely during HMR', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const registry = new DocumentExtractionService(ctx, { provider: 'new' })
    const oldProvider = new FakeProvider('old' as ExtractionProviderId)
    const newProvider = new FakeProvider('new' as ExtractionProviderId)
    const unregisterOld = registry.registerProvider(oldProvider)
    const unregisterNew = registry.registerProvider(newProvider)
    const task = { kind: 'single' as const, id: 'persisted-job' as ProviderTask['id'] }

    await registry.pollFor('old' as ExtractionProviderId, task, signal())
    await registry.collect('old' as ExtractionProviderId, task, '/tmp/fake-artifact', signal())
    expect(oldProvider.calls).toEqual(['poll:persisted-job', 'collect:persisted-job'])
    expect(newProvider.calls).toEqual([])
    expect(await registry.cancel('old' as ExtractionProviderId, task, signal())).toEqual({ outcome: 'cancelled' })
    expect((await registry.health(signal())).state).toBe('available')

    unregisterOld()
    await expect(Promise.resolve().then(() => registry.pollFor('old' as ExtractionProviderId, task, signal()))).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' })
    unregisterNew()
  })
})
