/**
 * Provider-agnostic contracts for Study Reader workspace persistence and
 * durable reader memory. These types deliberately do not depend on the study
 * service so the memory provider can be replaced without reloading it.
 * @module @deepseek-ai/dsh-study-memory/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { RevisionId, SourceId } from '../protocol/ids.ts'

/** Nominal id of one durable reader memory. */
export type StudyMemoryId = Branded<'StudyMemoryId'>

/** How far a memory is visible. */
export type StudyMemoryScope = 'session' | 'source'

/** Semantic role of one memory item. */
export type StudyMemoryKind = 'quote' | 'insight' | 'question' | 'preference' | 'summary'

/** The only durable Bookroom state: the document explicitly selected by a user. */
export interface SessionSourceSelectionRecord {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly sourceId?: SourceId
  readonly revisionId?: RevisionId
  readonly updatedAt: number
  readonly version: number
  readonly lastCommandId?: string
}

/** Versioned, idempotent mutation of one session's selected document. */
export interface SetSessionSourceSelectionInput {
  readonly sessionId: string
  readonly sourceId?: SourceId
  readonly revisionId?: RevisionId
  readonly expectedVersion: number
  readonly commandId: string
}


/** Immutable source anchor attached to a memory when one is available. */
export interface StudyMemoryAnchor {
  readonly revisionId: RevisionId
  readonly page: number
  readonly blockIds: readonly string[]
  readonly selectedText: string
}

/** One durable memory. Source-scoped memories are visible across sessions. */
export interface StudyMemoryRecord {
  readonly schemaVersion: 1
  readonly id: StudyMemoryId
  readonly ownerSessionId: string
  readonly scope: StudyMemoryScope
  readonly kind: StudyMemoryKind
  readonly sourceId: SourceId
  readonly anchor?: StudyMemoryAnchor
  readonly text: string
  readonly note?: string
  readonly tags: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** Create or idempotently update one memory. */
export interface RememberStudyMemoryInput {
  readonly id?: StudyMemoryId
  readonly sessionId: string
  readonly scope: StudyMemoryScope
  readonly kind: StudyMemoryKind
  readonly sourceId: SourceId
  readonly anchor?: StudyMemoryAnchor
  readonly text: string
  readonly note?: string
  readonly tags?: readonly string[]
}

/** Query memories visible to a session. */
export interface ListStudyMemoriesInput {
  readonly sessionId: string
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly scope?: StudyMemoryScope
  readonly query?: string
  readonly limit?: number
}

/** One prompt-safe memory context pack. */
export interface StudyMemoryContext {
  readonly items: readonly StudyMemoryRecord[]
  readonly text: string
  readonly truncated: boolean
}

/** Mutation audit retained independently of the current projection. */
export interface StudyMemoryMutationRecord {
  readonly id: string
  readonly memoryId: StudyMemoryId
  readonly actorSessionId: string
  readonly operation: 'remember' | 'forget' | 'source-delete'
  readonly snapshot: StudyMemoryRecord
  readonly createdAt: number
}

/** Runtime provider behind the stable `ctx.studyMemory` broker. */
export interface StudyMemoryProvider {
  readonly id: string
  readonly schemaVersion: 1
  getSelection(sessionId: string): Promise<SessionSourceSelectionRecord>
  setSelection(input: SetSessionSourceSelectionInput): Promise<SessionSourceSelectionRecord>
  listMemories(input: ListStudyMemoriesInput): Promise<readonly StudyMemoryRecord[]>
  remember(input: RememberStudyMemoryInput): Promise<StudyMemoryRecord>
  forget(sessionId: string, memoryId: StudyMemoryId): Promise<boolean>
  context(input: ListStudyMemoriesInput & { readonly maxChars?: number }): Promise<StudyMemoryContext>
  deleteSource(sourceId: SourceId): Promise<number>
  migrateLegacySelections(validate: import('./migration.ts').LegacySelectionValidator): Promise<import('./migration.ts').SelectionMigrationReport>
}
