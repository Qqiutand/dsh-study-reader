/**
 * Study interaction event vocabulary for the Study Reader plugin.
 * Current reader-context checkpoints and state commands, together with legacy
 * interactive events, are durable Study Events. The browser enters only
 * named Host commands and replays them through Host-internal domain helpers.
 * Legacy cognitive events
 * remain readable for replay but are not created by the current Bookroom UI.
 *
 * These events deliberately do NOT enter the harness session log: that log's
 * persistence read path only accepts event types it knows plus explicitly
 * ignorable records, and `Session.append` cannot mark an event ignorable.
 * The study domain owns its own event store instead.
 *
 * @module @deepseek-ai/dsh-study-reader/protocol/events
 */

import type { SourceId, RevisionId, CardId, DossierId, FrictionId, RequestId } from './ids.ts'

/** Document source imported and indexed. */
export interface SourceImportedData {
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly format?: 'pdf' | 'epub' | 'other'
  readonly title: string
  readonly fileName: string
  readonly pageCount: number
  readonly blockCount: number
  readonly timestamp: number
}

/** User highlighted / selected text on the original PDF. */
export interface HighlightData {
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly page: number
  readonly blockIds: readonly string[]
  readonly selectedText: string
  readonly color?: 'yellow' | 'blue' | 'green' | 'pink'
  readonly timestamp: number
}

/** User bookmarked a core insight / equation / concept. */
export interface BookmarkData {
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly page: number
  readonly blockIds: readonly string[]
  readonly selectedText: string
  readonly note?: string
  readonly timestamp: number
}

/** User requested a Step 1: Feynman plain-language explanation. */
export interface FeynmanRequestedData {
  readonly requestId: RequestId
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly page: number
  readonly blockIds: readonly string[]
  readonly selectedText: string
  readonly explanation?: string
  readonly analogy?: string
  readonly simplifiedTerms?: readonly { readonly term: string; readonly explanation: string }[]
  readonly contextRole?: string
  readonly citations?: readonly { readonly page: number; readonly blockId?: string; readonly quote: string }[]
  readonly timestamp: number
}

/** User requested a Step 2: Toulmin argument decomposition. */
export interface ToulminRequestedData {
  readonly requestId: RequestId
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly page: number
  readonly blockIds: readonly string[]
  readonly selectedText: string
  readonly toulmin?: {
    readonly claim: string
    readonly evidence: readonly { readonly text: string; readonly page: number; readonly blockId?: string }[]
    readonly warrant: string
    readonly backing?: string
    readonly qualifier?: string
    readonly rebuttal?: string
  }
  readonly timestamp: number
}

/** Metacognitive confidence calibration rating before/after explanation. */
export interface CalibrationData {
  readonly requestId: RequestId
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly stage: 'pre-explanation' | 'post-explanation'
  readonly rating: 'fuzzy' | 'rough' | 'clear' | 'teach'
  readonly timestamp: number
}

/** Reader-selected reason for opening one cognitive diagnostic. */
export type CognitiveIntent = 'concept' | 'inference' | 'evidence' | 'boundary' | 'other' | 'hint'

/** Cognitive analysis lens requested from the selection toolbar. */
export type CognitiveLens = 'feynman' | 'toulmin' | 'socratic'

/** One Agent turn requested from the Bookroom UI. */
export interface CognitiveRequestedData {
  readonly requestId: RequestId
  readonly parentRequestId?: RequestId
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly page: number
  readonly blockIds: readonly string[]
  readonly selectedText: string
  readonly kind: 'passage' | 'answer'
  readonly lens: CognitiveLens
  readonly intent: CognitiveIntent
  readonly question?: string
  readonly userAnswer?: string
  readonly timestamp: number
}

/** Host confirmation that the request's stable Agent message entered its durable inbox. */
export interface CognitiveEnqueuedData {
  readonly requestId: RequestId
  readonly sourceId: SourceId
  readonly revisionId: RevisionId
  readonly messageId: string
  readonly timestamp: number
}

/** Exact context receipt issued after an Agent tool validates and reads one immutable anchor. */
export interface CognitiveContextPreparedData {
  readonly requestId: RequestId
  readonly sourceId: SourceId
  readonly revisionId: RevisionId
  readonly page: number
  readonly blockIds: readonly string[]
  readonly receipt: string
  readonly turn: number
  readonly toolCallId: string
  readonly timestamp: number
}

/** One misconception-bearing choice in an Agent-generated diagnostic. */
export interface CognitiveProbeOptionData {
  readonly id: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
  readonly text: string
  readonly diagnosis: string
  readonly feedback: string
  readonly best: boolean
}

/** Structured result committed by the Agent through `study_submit_cognitive_probe`. */
export interface CognitiveProbeGeneratedData {
  readonly requestId: RequestId
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly page: number
  readonly blockIds: readonly string[]
  readonly lens: CognitiveLens
  readonly intent: CognitiveIntent
  readonly question: string
  readonly purpose: string
  readonly options: readonly CognitiveProbeOptionData[]
  readonly hint: string
  readonly synthesis: string
  readonly explanation?: string
  readonly analogy?: string
  readonly simplifiedTerms?: readonly { readonly term: string; readonly explanation: string }[]
  readonly toulmin?: {
    readonly claim: string
    readonly evidence: readonly { readonly text: string; readonly page: number; readonly blockId?: string }[]
    readonly warrant: string
    readonly backing?: string
    readonly qualifier?: string
    readonly rebuttal?: string
  }
  readonly challenge?: {
    readonly questionId: string
    readonly questionText: string
    readonly targetConcept: string
    readonly evaluationCriteria: string
  }
  readonly assessment?: {
    readonly passed: boolean
    readonly feedback: string
    readonly correction?: string
  }
  readonly citations: readonly { readonly page: number; readonly blockId?: string; readonly quote: string }[]
  /** Exact route recorded by the Agent request header that produced the tool call. */
  readonly provider: string
  readonly model: string
  readonly timestamp: number
}

/** Human answer to one generated diagnostic option. */
export interface CognitiveOptionSelectedData {
  readonly requestId: RequestId
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly optionId: CognitiveProbeOptionData['id']
  readonly timestamp: number
}


/** AI generated a Step 3 Socratic challenge for the selected passage. */
export interface SocraticGeneratedData {
  readonly requestId: RequestId
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly page: number
  readonly blockIds: readonly string[]
  readonly selectedText: string
  readonly challenge: {
    readonly questionId: string
    readonly questionText: string
    readonly targetConcept: string
    readonly evaluationCriteria: string
  }
  readonly timestamp: number
}

/** User answered a Step 3: Socratic challenge question. */
export interface SocraticResponseData {
  readonly requestId: RequestId
  readonly sourceId?: SourceId
  readonly revisionId?: RevisionId
  readonly page?: number
  readonly blockIds?: readonly string[]
  readonly questionId: string
  readonly question: string
  readonly userAnswer: string
  readonly aiAssessment: {
    readonly passed: boolean
    readonly feedback: string
    readonly correction?: string
  }
  readonly timestamp: number
}

/** Cognitive friction / comprehension difficulty recorded during study. */
export interface FrictionData {
  readonly frictionId: FrictionId
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly page: number
  readonly blockIds: readonly string[]
  readonly topic: string
  readonly confusionDescription: string
  readonly resolution?: string
  readonly timestamp: number
}

/** A spaced-repetition retrieval practice card generated from study activity. */
export interface ReviewCardGeneratedData {
  readonly cardId: CardId
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly origin: 'friction' | 'socratic-fail' | 'bookmark' | 'concept'
  readonly question: string
  readonly answer: string
  readonly page: number
  readonly nextDueAt: number
  readonly intervalDays: number
  readonly easeFactor: number
  readonly timestamp: number
}

/** User attempted a retrieval practice review card. */
export interface ReviewAttemptedData {
  readonly cardId: CardId
  readonly quality: 0 | 1 | 2 | 3 | 4 | 5
  readonly nextDueAt: number
  readonly timestamp: number
}

/** A comprehensive metacognitive study dossier generated from session events. */
export interface DossierGeneratedData {
  readonly dossierId: DossierId
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly title: string
  readonly content: string
  readonly stats: {
    readonly highlightsCount: number
    readonly bookmarksCount: number
    readonly frictionsResolvedCount: number
    readonly socraticQuestionsCount: number
    readonly cardsCount: number
  }
  readonly timestamp: number
}

/** Exact event-to-payload correlation used by reducers and Remote requests. */
export interface StudyEventDataMap {
  'study/source-imported': SourceImportedData
  'study/highlight': HighlightData
  'study/bookmark': BookmarkData
  'study/feynman-requested': FeynmanRequestedData
  'study/toulmin-requested': ToulminRequestedData
  'study/calibration': CalibrationData
  'study/cognitive-requested': CognitiveRequestedData
  'study/cognitive-enqueued': CognitiveEnqueuedData
  'study/cognitive-context-prepared': CognitiveContextPreparedData
  'study/cognitive-probe-generated': CognitiveProbeGeneratedData
  'study/cognitive-option-selected': CognitiveOptionSelectedData
  'study/socratic-generated': SocraticGeneratedData
  'study/socratic-response': SocraticResponseData
  'study/friction': FrictionData
  'study/review-card-generated': ReviewCardGeneratedData
  'study/review-attempted': ReviewAttemptedData
  'study/dossier-generated': DossierGeneratedData
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap extends StudyEventDataMap {}
}

export const STUDY_EVENT_TYPES = [
  'study/source-imported',
  'study/highlight',
  'study/bookmark',
  'study/feynman-requested',
  'study/toulmin-requested',
  'study/calibration',
  'study/cognitive-requested',
  'study/cognitive-enqueued',
  'study/cognitive-context-prepared',
  'study/cognitive-probe-generated',
  'study/cognitive-option-selected',
  'study/socratic-generated',
  'study/socratic-response',
  'study/friction',
  'study/review-card-generated',
  'study/review-attempted',
  'study/dossier-generated',
] as const

export type StudyEventType = keyof StudyEventDataMap

export function isStudyEventType(type: string): type is StudyEventType {
  return (STUDY_EVENT_TYPES as readonly string[]).includes(type)
}
