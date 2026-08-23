/**
 * JSON/storage-domain backed provider for `ctx.studyMemory`. It owns only the
 * durable projection; the stable broker remains mounted while this component
 * is unloaded, rebuilt, or replaced during self-iteration.
 * @module @deepseek-ai/dsh-study-memory-durable
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { StudyError } from '../protocol/error.ts'
import type { SourceId } from '../protocol/ids.ts'
import { studyMemoryDomain } from './domain.ts'
import { migrateLegacySelections, type LegacyWorkspace } from './migration.ts'
import type {
  ListStudyMemoriesInput,
  RememberStudyMemoryInput,
  SetSessionSourceSelectionInput,
  SessionSourceSelectionRecord,
  StudyMemoryContext,
  StudyMemoryId,
  StudyMemoryMutationRecord,
  StudyMemoryProvider,
  StudyMemoryRecord,
} from './types.ts'
import type {} from './index.ts'
import type {} from '@deepseek-ai/dsh-storage-domain'

export const name = 'study-memory-durable'
export const inject = ['storageDomain', 'studyMemory']

export interface Config {
  readonly providerId?: string
  readonly contextItems?: number
  readonly contextChars?: number
}

export const Config: z<Config> = z.object({
  providerId: z.string().default('durable'),
  contextItems: z.number().min(1).max(100).default(8),
  contextChars: z.number().min(256).max(50000).default(4000),
})

interface DurableProviderDeps {
  readonly workspaces: KvTable<string, LegacyWorkspace>
  readonly selections: KvTable<string, SessionSourceSelectionRecord>
  readonly migrations: KvTable<string, { readonly id: string; readonly completedAt: number }>
  readonly memories: KvTable<StudyMemoryId, StudyMemoryRecord>
  readonly mutations: KvTable<string, StudyMemoryMutationRecord>
  readonly config: Required<Config>
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim()
  if (normalized === '') throw new StudyError('sessionId is required', 'MEMORY_SESSION_REQUIRED')
  return normalized
}

const MAX_MEMORY_TEXT_CHARS = 12_000
const MAX_MEMORY_NOTE_CHARS = 12_000
const MAX_MEMORY_TAG_CHARS = 80
const MEMORY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/

function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
  return [...new Set((tags ?? [])
    .map(tag => tag.trim().toLowerCase())
    .filter(tag => tag !== '')
    .map(tag => tag.slice(0, MAX_MEMORY_TAG_CHARS))
    .slice(0, 24))]
}

/** Durable provider implementation with per-aggregate serialization. */
export class DurableStudyMemoryProvider implements StudyMemoryProvider {
  readonly schemaVersion = 1 as const
  readonly id: string
  private readonly tails = new Map<string, Promise<void>>()
  /** In-process tombstones close the check/delete race during source removal. */
  private readonly deletedSources = new Set<SourceId>()

  constructor(private readonly deps: DurableProviderDeps) {
    this.id = deps.config.providerId
  }

  private async serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
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

  async getSelection(rawSessionId: string): Promise<SessionSourceSelectionRecord> {
    const sessionId = normalizeSessionId(rawSessionId)
    return this.deps.selections.get(sessionId) ?? {
      schemaVersion: 1, sessionId, updatedAt: 0, version: 0,
    }
  }

  async migrateLegacySelections(validate: import('./migration.ts').LegacySelectionValidator): Promise<import('./migration.ts').SelectionMigrationReport> {
    return await migrateLegacySelections(this.deps.workspaces, this.deps.selections, this.deps.migrations, validate)
  }

  async setSelection(input: SetSessionSourceSelectionInput): Promise<SessionSourceSelectionRecord> {
    const sessionId = normalizeSessionId(input.sessionId)
    return await this.serialized(`selection:${sessionId}`, async () => {
      const current = await this.getSelection(sessionId)
      if (current.lastCommandId === input.commandId) return current
      if (current.version !== input.expectedVersion) {
        throw new StudyError('source selection version conflict', 'MEMORY_SELECTION_VERSION_CONFLICT')
      }
      if (input.revisionId !== undefined && input.sourceId === undefined) {
        throw new StudyError('revision requires source selection', 'MEMORY_SELECTION_INVALID')
      }
      const next: SessionSourceSelectionRecord = {
        schemaVersion: 1,
        sessionId,
        ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
        ...(input.revisionId !== undefined ? { revisionId: input.revisionId } : {}),
        updatedAt: Date.now(),
        version: current.version + 1,
        lastCommandId: input.commandId,
      }
      await this.deps.selections.put(sessionId, next)
      return next
    })
  }

  async listMemories(input: ListStudyMemoriesInput): Promise<readonly StudyMemoryRecord[]> {
    const sessionId = normalizeSessionId(input.sessionId)
    const query = input.query?.trim().toLowerCase()
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 50)), 500)
    return [...this.deps.memories.entries()]
      .map(([, record]) => record)
      .filter(record => record.sourceId === input.sourceId)
      .filter(record => record.scope === 'source' || record.ownerSessionId === sessionId)
      .filter(record => input.scope === undefined || record.scope === input.scope)
      .filter(record => input.revisionId === undefined || record.anchor?.revisionId === undefined || record.anchor.revisionId === input.revisionId)
      .filter(record => query === undefined || query === '' || [record.text, record.note ?? '', ...record.tags]
        .some(value => value.toLowerCase().includes(query)))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
  }

  async remember(input: RememberStudyMemoryInput): Promise<StudyMemoryRecord> {
    const sessionId = normalizeSessionId(input.sessionId)
    const text = input.text.trim()
    if (text === '') throw new StudyError('memory text is required', 'MEMORY_TEXT_REQUIRED')
    if (text.length > MAX_MEMORY_TEXT_CHARS) {
      throw new StudyError(`memory text exceeds ${MAX_MEMORY_TEXT_CHARS} characters`, 'MEMORY_TEXT_TOO_LARGE')
    }
    if ((input.note?.length ?? 0) > MAX_MEMORY_NOTE_CHARS) {
      throw new StudyError(`memory note exceeds ${MAX_MEMORY_NOTE_CHARS} characters`, 'MEMORY_NOTE_TOO_LARGE')
    }
    const generatedId = `memory_${randomUUID()}`
    const rawMemoryId = String(input.id ?? generatedId).trim()
    if (!MEMORY_ID_PATTERN.test(rawMemoryId)) {
      throw new StudyError('memory id must be 1-160 URL-safe characters', 'MEMORY_ID_INVALID')
    }
    const memoryId = rawMemoryId as StudyMemoryId
    return await this.serialized(`source:${input.sourceId}`, async () => {
      if (this.deletedSources.has(input.sourceId)) {
        throw new StudyError(`source "${input.sourceId}" is being deleted`, 'MEMORY_SOURCE_DELETED')
      }
      return await this.serialized(`memory:${memoryId}`, async () => {
        const now = Date.now()
        const current = this.deps.memories.get(memoryId)
        if (current !== undefined && (current.ownerSessionId !== sessionId || current.sourceId !== input.sourceId)) {
          throw new StudyError(`memory id "${memoryId}" belongs to another aggregate`, 'MEMORY_ID_CONFLICT')
        }
        const note = input.note?.trim()
        const tags = normalizeTags(input.tags)
        // A browser outbox may replay after the first response was lost. Stable
        // ids make that retry a true no-op instead of another audit mutation.
        if (current !== undefined
          && current.scope === input.scope
          && current.kind === input.kind
          && current.text === text
          && current.note === (note === '' ? undefined : note)
          && JSON.stringify(current.tags) === JSON.stringify(tags)
          && JSON.stringify(current.anchor) === JSON.stringify(input.anchor)) {
          return current
        }
        const record: StudyMemoryRecord = {
          schemaVersion: 1,
          id: memoryId,
          ownerSessionId: sessionId,
          scope: input.scope,
          kind: input.kind,
          sourceId: input.sourceId,
          ...(input.anchor !== undefined ? { anchor: input.anchor } : {}),
          text,
          ...(note !== undefined && note !== '' ? { note } : {}),
          tags,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        }
        await this.deps.memories.put(memoryId, record)
        await this.audit('remember', sessionId, record)
        return record
      })
    })
  }

  async forget(rawSessionId: string, memoryId: StudyMemoryId): Promise<boolean> {
    const sessionId = normalizeSessionId(rawSessionId)
    return await this.serialized(`memory:${memoryId}`, async () => {
      const current = this.deps.memories.get(memoryId)
      if (current === undefined) return false
      if (current.ownerSessionId !== sessionId) {
        throw new StudyError('only the session that created a memory may delete it', 'MEMORY_DELETE_DENIED')
      }
      await this.deps.memories.delete(memoryId)
      await this.audit('forget', sessionId, current)
      return true
    })
  }

  async context(input: ListStudyMemoriesInput & { readonly maxChars?: number }): Promise<StudyMemoryContext> {
    const maxChars = Math.min(
      Math.max(256, Math.floor(input.maxChars ?? this.deps.config.contextChars)),
      this.deps.config.contextChars,
    )
    // `query` is a ranking hint, never a hard filter. A full selected passage
    // rarely appears verbatim inside a concise memory; hard filtering would
    // make cross-session memory disappear exactly when it is most useful.
    const visible = await this.listMemories({
      sessionId: input.sessionId,
      sourceId: input.sourceId,
      ...(input.revisionId !== undefined ? { revisionId: input.revisionId } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      limit: Math.min(
        Math.max(input.limit ?? this.deps.config.contextItems, this.deps.config.contextItems),
        this.deps.config.contextItems * 4,
      ),
    })
    const query = input.query?.trim().toLowerCase() ?? ''
    const ranked = query === '' ? visible : [...visible].sort((left, right) => {
      const score = (record: StudyMemoryRecord): number => {
        const haystack = [record.text, record.note ?? '', ...record.tags].join(' ').toLowerCase()
        if (haystack.includes(query)) return 10_000
        const compact = query.replace(/\s+/g, '')
        let overlap = 0
        const maxNgrams = Math.min(128, Math.max(0, compact.length - 1))
        for (let index = 0; index < maxNgrams; index += 1) {
          if (haystack.includes(compact.slice(index, index + 2))) overlap += 1
        }
        return overlap
      }
      return score(right) - score(left) || right.updatedAt - left.updatedAt
    })
    const visibleLimit = Math.min(input.limit ?? this.deps.config.contextItems, this.deps.config.contextItems)
    const selected = ranked.slice(0, visibleLimit)
    const items: StudyMemoryRecord[] = []
    const lines: string[] = []
    let chars = 0
    let truncated = false

    const lineFor = (item: StudyMemoryRecord, text: string, note?: string): string => JSON.stringify({
      id: item.id,
      scope: item.scope,
      kind: item.kind,
      text,
      ...(note !== undefined && note !== '' ? { note } : {}),
    })

    for (const item of selected) {
      const separator = lines.length === 0 ? 0 : 1
      const budget = maxChars - chars - separator
      if (budget <= 0) {
        truncated = true
        break
      }
      let safeText = item.text
      let safeNote = item.note
      let line = lineFor(item, safeText, safeNote)
      let clipped = false
      if (line.length > budget) {
        // Fit the first/next record exactly inside the remaining JSONL budget.
        // Binary search is used because JSON escaping makes source character
        // count differ from serialized character count. Notes are dropped
        // first; the core memory statement is retained as far as possible.
        safeNote = undefined
        let low = 0
        let high = safeText.length
        while (low < high) {
          const middle = Math.ceil((low + high) / 2)
          if (lineFor(item, safeText.slice(0, middle), undefined).length <= budget) low = middle
          else high = middle - 1
        }
        safeText = safeText.slice(0, low)
        line = lineFor(item, safeText, undefined)
        clipped = safeText.length < item.text.length || item.note !== undefined
      }
      if (line.length > budget) {
        truncated = true
        break
      }
      const safeItem: StudyMemoryRecord = {
        ...item,
        text: safeText,
        ...(safeNote !== undefined ? { note: safeNote } : {}),
      }
      if (safeNote === undefined) delete (safeItem as { note?: string }).note
      items.push(safeItem)
      lines.push(line)
      chars += separator + line.length
      if (clipped) {
        truncated = true
        break
      }
    }
    return {
      items,
      text: lines.join('\n'),
      truncated: truncated || items.length < selected.length || selected.length < ranked.length,
    }
  }

  async deleteSource(sourceId: SourceId): Promise<number> {
    return await this.serialized(`source:${sourceId}`, async () => {
      // Block source-scoped writes while the deletion is in progress. The
      // Study source-lifecycle barrier rejects later stale outbox replays, so
      // this process-local admission marker must not grow forever.
      this.deletedSources.add(sourceId)
      try {
        const matches = [...this.deps.memories.entries()].filter(([, record]) => record.sourceId === sourceId)
        let removed = 0
        for (const [id] of matches) {
          await this.serialized(`memory:${id}`, async () => {
            const current = this.deps.memories.get(id)
            if (current === undefined || current.sourceId !== sourceId) return
            await this.deps.memories.delete(id)
            await this.audit('source-delete', current.ownerSessionId, current)
            removed += 1
          })
        }

        for (const [sessionId, selection] of this.deps.selections.entries()) {
          if (selection.sourceId !== sourceId) continue
          await this.setSelection({
            sessionId,
            expectedVersion: selection.version,
            commandId: `source-delete:${sourceId}:${selection.version}`,
          })
        }
        this.deletedSources.delete(sourceId)
        return removed
      } catch (error) {
        this.deletedSources.delete(sourceId)
        throw error
      }
    })
  }

  private async audit(
    operation: StudyMemoryMutationRecord['operation'],
    actorSessionId: string,
    snapshot: StudyMemoryRecord,
  ): Promise<void> {
    const createdAt = Date.now()
    const id = `mutation_${createdAt.toString(36)}_${randomUUID()}`
    await this.deps.mutations.put(id, {
      id,
      memoryId: snapshot.id,
      actorSessionId,
      operation,
      snapshot,
      createdAt,
    })
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved: Required<Config> = {
    providerId: config.providerId ?? 'durable',
    contextItems: config.contextItems ?? 8,
    contextChars: config.contextChars ?? 4000,
  }
  const domain = await ctx.storageDomain.open(studyMemoryDomain)
  const workspaces = domain.table('workspaces') as unknown as KvTable<string,LegacyWorkspace>
  const selections = domain.table('selections') as unknown as KvTable<string, SessionSourceSelectionRecord>
  const migrations = domain.table('migrations') as unknown as KvTable<string, { readonly id: string; readonly completedAt: number }>
  const provider = new DurableStudyMemoryProvider({
    workspaces,
    selections,
    migrations,
    memories: domain.table('memories') as unknown as KvTable<StudyMemoryId, StudyMemoryRecord>,
    mutations: domain.table('mutations') as unknown as KvTable<string, StudyMemoryMutationRecord>,
    config: resolved,
  })
  // Provider availability is part of apply(), not a later effect callback.
  // Domain consumers may start concurrently once the stable broker exists;
  // publishing here gives them a precise readiness boundary when this fiber
  // resolves instead of racing Cordis effect scheduling.
  const unregister = ctx.studyMemory.registerProvider(provider)
  ctx.effect(() => async () => {
    await unregister()
    await domain.close()
  }, 'study-memory-durable: provider + domain')
}
