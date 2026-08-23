/**
 * Branded ID types for the study-reader domain.
 * @module @deepseek-ai/dsh-study-reader/protocol/ids
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Branded identifier for a registered document source. */
export type SourceId = Branded<'SourceId'>
export function SourceId(id: string): SourceId {
  return id as SourceId
}

/** Branded identifier for a specific extraction revision of a source. */
export type RevisionId = Branded<'RevisionId'>
export function RevisionId(id: string): RevisionId {
  return id as RevisionId
}

/** Branded identifier for a spaced-repetition retrieval card. */
export type CardId = Branded<'CardId'>
export function CardId(id: string): CardId {
  return id as CardId
}

/** Branded identifier for a generated study dossier / learning report. */
export type DossierId = Branded<'DossierId'>
export function DossierId(id: string): DossierId {
  return id as DossierId
}

/** Branded identifier for an identified friction / confusion point. */
export type FrictionId = Branded<'FrictionId'>
export function FrictionId(id: string): FrictionId {
  return id as FrictionId
}

/** Branded identifier for an interactive cognitive ladder request. */
export type RequestId = Branded<'RequestId'>
export function RequestId(id: string): RequestId {
  return id as RequestId
}

/** Generate a unique branded ID with a prefix. */
export function mintId<T extends string>(prefix: string): T {
  const rand = Math.random().toString(36).slice(2, 10)
  const time = Date.now().toString(36)
  return `${prefix}_${time}_${rand}` as T
}
