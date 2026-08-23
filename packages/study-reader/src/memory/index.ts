/**
 * Stable Study Reader memory capability seam (`ctx.studyMemory`). Concrete
 * persistence backends register behind this broker and are resolved afresh for
 * every operation, so a provider can be hot-replaced without reloading the
 * study service or its Agent tools.
 * @module @deepseek-ai/dsh-study-memory
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { StudyError } from '../protocol/error.ts'
import type {
  ListStudyMemoriesInput,
  RememberStudyMemoryInput,
  SetSessionSourceSelectionInput,
  SessionSourceSelectionRecord,
  StudyMemoryContext,
  StudyMemoryId,
  StudyMemoryProvider,
  StudyMemoryRecord,
} from './types.ts'
import type { SourceId } from '../protocol/ids.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Stable broker for workspace state and cross-session reader memory. */
    studyMemory: StudyMemoryService
  }
}

/** Explicit provider selection; registration order is never a policy. */
export interface Config {
  readonly provider: string
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
})

export const name = 'study-memory'

/**
 * Provider broker. The identity check in the disposer is intentional: during
 * HMR a new provider with the same id may register before the old fiber's
 * disposer runs; the old disposer must not remove the replacement.
 */
interface ProviderLease {
  readonly provider: StudyMemoryProvider
  readonly generation: number
  inFlight: number
  retiring: boolean
  readonly drained: Set<() => void>
}

export class StudyMemoryService extends Service {
  private readonly providers = new Map<string, ProviderLease>()
  private readonly providerWaiters = new Set<() => void>()
  private generation = 0

  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx, 'studyMemory')
  }

  registerProvider(provider: StudyMemoryProvider): () => Promise<void> {
    this.generation += 1
    const lease: ProviderLease = {
      provider,
      generation: this.generation,
      inFlight: 0,
      retiring: false,
      drained: new Set(),
    }
    this.providers.set(provider.id, lease)
    if (provider.id === this.config.provider) {
      for (const resolve of this.providerWaiters) resolve()
      this.providerWaiters.clear()
    }
    return async () => {
      lease.retiring = true
      if (this.providers.get(provider.id) === lease) this.providers.delete(provider.id)
      if (lease.inFlight === 0) return
      await new Promise<void>(resolve => lease.drained.add(resolve))
    }
  }

  /** Resolve only after the explicitly configured provider is published. */
  async waitForConfiguredProvider(signal?: AbortSignal): Promise<void> {
    if (this.providers.has(this.config.provider)) return
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        signal?.removeEventListener('abort', aborted)
        this.providerWaiters.delete(done)
        resolve()
      }
      const aborted = (): void => {
        this.providerWaiters.delete(done)
        reject(signal?.reason ?? new Error('study-memory provider wait aborted'))
      }
      this.providerWaiters.add(done)
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted === true) aborted()
      else if (this.providers.has(this.config.provider)) done()
    })
  }

  private async withProvider<T>(operation: (provider: StudyMemoryProvider) => Promise<T>): Promise<T> {
    const lease = this.providerLease()
    lease.inFlight += 1
    try {
      return await operation(lease.provider)
    } finally {
      lease.inFlight -= 1
      if (lease.retiring && lease.inFlight === 0) {
        for (const resolve of lease.drained) resolve()
        lease.drained.clear()
      }
    }
  }

  private providerLease(): ProviderLease {
    const lease = this.providers.get(this.config.provider)
    if (lease === undefined) {
      throw new StudyError(
        `study-memory: provider "${this.config.provider}" is not registered`,
        'MEMORY_PROVIDER_NOT_FOUND',
      )
    }
    return lease
  }

  providerStatus(): {
    readonly configured: string
    readonly active: boolean
    readonly schemaVersion?: number
    readonly generation: number
    readonly inFlight: number
  } {
    const lease = this.providers.get(this.config.provider)
    return {
      configured: this.config.provider,
      active: lease !== undefined,
      generation: lease?.generation ?? this.generation,
      inFlight: lease?.inFlight ?? 0,
      ...(lease !== undefined ? { schemaVersion: lease.provider.schemaVersion } : {}),
    }
  }

  getSelection(sessionId: string): Promise<SessionSourceSelectionRecord> {
    return this.withProvider(provider => provider.getSelection(sessionId))
  }

  setSelection(input: SetSessionSourceSelectionInput): Promise<SessionSourceSelectionRecord> {
    return this.withProvider(provider => provider.setSelection(input))
  }

  listMemories(input: ListStudyMemoriesInput): Promise<readonly StudyMemoryRecord[]> {
    return this.withProvider(provider => provider.listMemories(input))
  }

  remember(input: RememberStudyMemoryInput): Promise<StudyMemoryRecord> {
    return this.withProvider(provider => provider.remember(input))
  }

  forget(sessionId: string, memoryId: StudyMemoryId): Promise<boolean> {
    return this.withProvider(provider => provider.forget(sessionId, memoryId))
  }

  context(input: ListStudyMemoriesInput & { readonly maxChars?: number }): Promise<StudyMemoryContext> {
    return this.withProvider(provider => provider.context(input))
  }

  deleteSource(sourceId: SourceId): Promise<number> {
    return this.withProvider(provider => provider.deleteSource(sourceId))
  }

  migrateLegacySelections(validate: import('./migration.ts').LegacySelectionValidator): Promise<import('./migration.ts').SelectionMigrationReport> {
    return this.withProvider(provider => provider.migrateLegacySelections(validate))
  }
}

export function apply(ctx: Context, config: Config): void {
  new StudyMemoryService(ctx, config)
}
