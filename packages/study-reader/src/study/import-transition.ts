/**
 * The sole durable state transition engine for Host imports.
 * @module @deepseek-ai/dsh-study/import-transition
 */

import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { StudyError } from '../protocol/error.ts'
import type { ImportFailure, ImportId, ImportProgress, ImportRecord, ImportState } from './types.ts'

export type ImportTransitionOutcome = 'inserted' | 'idempotent' | 'conflict'

export interface ImportTransitionResult {
  readonly outcome: ImportTransitionOutcome
  readonly record: ImportRecord
}

/** Input data must already be durable before the destination is entered. */
export interface ImportTransition {
  readonly transitionId: string
  readonly to: ImportState
  readonly expectedRecordVersion?: number
  readonly patch?: Partial<Omit<ImportRecord, 'state' | 'recordVersion' | 'transitionedAt' | 'appliedTransitionIds' | 'failure' | 'failedStage' | 'cancelledStage' | 'cancelledAt' | 'upstreamCancellation'>>
  readonly failure?: ImportFailure
  readonly cancelledStage?: Exclude<ImportState, 'ready' | 'failed' | 'cancelled'>
  readonly upstreamCancellation?: ImportRecord['upstreamCancellation']
  /** Upload admission is process-local, so the caller explicitly attests it. */
  readonly uploadAdmission?: boolean
  /** A URL was validated by the submission boundary. */
  readonly urlInputValidated?: boolean
  readonly now?: number
}

const ACTIVE = new Set<ImportState>(['awaiting-upload', 'uploading', 'queued', 'splitting', 'extracting', 'collecting', 'normalizing', 'indexing'])

/**
 * The Host-side ownership contract. Provider-specific details stay in adapter
 * diagnostics and part records; every public checkpoint has one driver.
 */
export const IMPORT_STATE_OWNERS: Readonly<Record<ImportState, { readonly enteredBy: string; readonly advancedBy: string }>> = {
  'awaiting-upload': { enteredBy: 'StudyService', advancedBy: 'Upload Route' },
  uploading: { enteredBy: 'Upload Route', advancedBy: 'Upload Commit' },
  queued: { enteredBy: 'Upload/URL Admission', advancedBy: 'Import Dispatcher' },
  splitting: { enteredBy: 'PDF Splitter', advancedBy: 'Import Dispatcher' },
  extracting: { enteredBy: 'Provider Submit/Poller', advancedBy: 'Poller' },
  collecting: { enteredBy: 'Poller', advancedBy: 'Artifact Collector' },
  normalizing: { enteredBy: 'EPUB Parser/Artifact Normalizer', advancedBy: 'Revision Assembler' },
  indexing: { enteredBy: 'Revision Assembler', advancedBy: 'Index Service' },
  ready: { enteredBy: 'Index Commit', advancedBy: 'terminal' },
  failed: { enteredBy: 'Current stage owner', advancedBy: 'Retry Command' },
  cancelled: { enteredBy: 'Cancel Owner', advancedBy: 'terminal' },
}
const PATHS: Readonly<Record<ImportState, readonly ImportState[]>> = {
  'awaiting-upload': ['uploading', 'failed', 'cancelled'],
  uploading: ['awaiting-upload', 'queued', 'failed', 'cancelled'],
  queued: ['splitting', 'extracting', 'normalizing', 'indexing', 'failed', 'cancelled'],
  splitting: ['extracting', 'failed', 'cancelled'],
  extracting: ['collecting', 'failed', 'cancelled'],
  collecting: ['normalizing', 'failed', 'cancelled'],
  normalizing: ['indexing', 'failed', 'cancelled'],
  indexing: ['ready', 'failed', 'cancelled'],
  ready: ['ready'],
  failed: ['awaiting-upload', 'queued', 'extracting', 'collecting', 'normalizing', 'indexing', 'failed'],
  cancelled: [],
}

/** A state is terminal only when it is no longer eligible for Host admission. */
export function isTerminalImportState(state: ImportState): boolean {
  return !ACTIVE.has(state)
}

/** Merge progress without ever regressing a durable counter or clearing missing data. */
export function mergeImportProgress(previous: ImportProgress | undefined, incoming: Partial<ImportProgress> | undefined, now: number): ImportProgress | undefined {
  if (incoming === undefined) return previous
  const max = (left: number | undefined, right: number | undefined): number | undefined => left === undefined ? right : right === undefined ? left : Math.max(left, right)
  return stripUndefined({
    completedPages: max(previous?.completedPages, incoming.completedPages),
    totalPages: max(previous?.totalPages, incoming.totalPages),
    completedParts: max(previous?.completedParts, incoming.completedParts),
    totalParts: max(previous?.totalParts, incoming.totalParts),
    currentPart: incoming.currentPart ?? previous?.currentPart,
    updatedAt: now,
  }) as unknown as ImportProgress
}

/**
 * Atomically transition a persisted ImportRecord. All status writes call this
 * function, including same-state diagnostic/progress checkpoints.
 */
export async function transitionImport(
  imports: KvTable<ImportId, ImportRecord>,
  importId: ImportId,
  transition: ImportTransition,
): Promise<ImportTransitionResult> {
  let outcome: ImportTransitionOutcome = 'inserted'
  const record = await imports.update(importId, current => {
    if (current.appliedTransitionIds.includes(transition.transitionId)) {
      outcome = 'idempotent'
      return current
    }
    if (transition.expectedRecordVersion !== undefined && current.recordVersion !== transition.expectedRecordVersion) {
      outcome = 'conflict'
      return current
    }
    if (transition.to !== current.state && !PATHS[current.state].includes(transition.to)) {
      invalid(`cannot transition ${current.state} to ${transition.to}`)
    }
    const now = transition.now ?? Date.now()
    const patched = { ...current, ...transition.patch, state: transition.to }
    validateEntry(current, patched, transition)
    const clearTerminal = transition.to !== 'failed' && transition.to !== 'cancelled'
    const history = [...current.appliedTransitionIds, transition.transitionId].slice(-64)
    const next = {
      ...patched,
      ...(clearTerminal ? { failure: undefined, failedStage: undefined, cancelledStage: undefined, cancelledAt: undefined, upstreamCancellation: undefined } : {}),
      ...(transition.to === 'failed' ? { failure: transition.failure!, failedStage: transition.failure!.stage } : {}),
      ...(transition.to === 'cancelled' ? { cancelledStage: transition.cancelledStage!, cancelledAt: now, upstreamCancellation: transition.upstreamCancellation! } : {}),
      ...((transition.to === 'failed' || transition.to === 'cancelled') ? { progress: current.progress } : { progress: mergeImportProgress(current.progress, transition.patch?.progress, now) }),
      // Scheduling belongs only to provider polling. A completed collection or
      // any local assembly checkpoint must never inherit a stale poll deadline.
      ...(transition.to === 'extracting' ? {} : { nextPollAt: undefined }),
      recordVersion: current.recordVersion + 1,
      transitionedAt: now,
      appliedTransitionIds: history,
      updatedAt: now,
    }
    return stripUndefined(next) as unknown as ImportRecord
  })
  return { outcome, record }
}

/** Insert a newly-created record through the same state-machine module. */
export async function insertImport(imports: KvTable<ImportId, ImportRecord>, record: ImportRecord): Promise<ImportTransitionResult> {
  const existing = imports.get(record.id)
  if (existing !== undefined) return { outcome: 'idempotent', record: existing }
  await imports.put(record.id, record)
  return { outcome: 'inserted', record }
}

function validateEntry(current: ImportRecord, next: ImportRecord, transition: ImportTransition): void {
  if (transition.to === 'uploading' && transition.uploadAdmission !== true) invalid('uploading requires a valid upload admission')
  if (transition.to === 'queued' && next.originalBlob === undefined && !(next.origin.kind === 'url' && transition.urlInputValidated === true)) invalid('queued requires an original blob or a validated URL')
  if (transition.to === 'splitting' && (next.format !== 'pdf' || next.originalBlob === undefined)) invalid('splitting requires an original PDF blob')
  if (transition.to === 'extracting' && next.providerTask === undefined && next.providerParts === undefined) invalid('extracting requires a persisted provider job')
  if (transition.to === 'collecting' && next.providerTask === undefined && next.providerParts === undefined) invalid('collecting requires a persisted provider job')
  // Same-state writes bind durable collection output after the import has
  // entered `collecting`; they must not be mistaken for a second state entry.
  if (transition.to === 'collecting' && transition.to !== current.state && current.state !== 'extracting') invalid('collecting requires a completed provider job')
  if (transition.to === 'normalizing' && next.format !== 'epub' && next.artifactSetId === undefined && !(next.providerParts?.every(part => part.artifactSetId !== undefined) ?? false)) invalid('normalizing requires a persisted complete artifact set')
  if (transition.to === 'indexing' && next.revisionId === undefined) invalid('indexing requires a committed normalized revision')
  if (transition.to === 'ready' && next.revisionId === undefined && next.semanticStatus !== 'original-only') invalid('ready requires a revision or explicit original-only semantic status')
  if (transition.to === 'failed' && current.state !== 'failed') {
    if (transition.failure === undefined || transition.failure.stage === 'unknown') invalid('failed requires a concrete failure stage')
    if (transition.failure.stage !== current.state) invalid('failure stage must name the active state')
  }
  if (transition.to === 'cancelled' && current.state !== 'cancelled' && (transition.cancelledStage === undefined || transition.upstreamCancellation === undefined)) invalid('cancelled requires a stopped admission and upstream cancellation outcome')
}

function invalid(message: string): never {
  throw new StudyError(message, 'IMPORT_TRANSITION_INVALID')
}

function stripUndefined(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined))
}
