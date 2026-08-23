/**
 * Core domain types for Study Reader: Cognitive Ladder, Cards, and Dossiers.
 * @module dsh-study-reader/domain/types
 */

import type {
  CognitiveIntent,
  CognitiveLens,
  CognitiveProbeOptionData,
} from '../protocol/events.ts'
import type { CardId, DossierId, FrictionId, RequestId, RevisionId, SourceId } from '../protocol/ids.ts'

/** Step 1: Feynman plain-language explanation structure. */
export interface FeynmanExplanation {
  readonly intuitiveAnalogy: string
  readonly terminologyMapping: readonly { readonly term: string; readonly meaning: string }[]
  readonly contextRole: string
  readonly citations: readonly { readonly page: number; readonly blockId?: string; readonly quote: string }[]
}

/** Step 2: Toulmin argument model structure. */
export interface ToulminDecomposition {
  readonly claim: string
  readonly evidence: readonly { readonly text: string; readonly page: number; readonly blockId?: string }[]
  readonly warrant: string
  readonly backing?: string
  readonly qualifier?: string
  readonly rebuttal?: string
}

/** Step 3: Socratic challenge question and assessment. */
export interface SocraticChallenge {
  readonly questionId: string
  readonly questionText: string
  readonly targetConcept: string
  readonly evaluationCriteria: string
}

/** Spaced-repetition retrieval card model. */
export interface ReviewCard {
  readonly id: CardId
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly origin: 'friction' | 'socratic-fail' | 'bookmark' | 'concept'
  readonly question: string
  readonly answer: string
  readonly page: number
  readonly nextDueAt: number
  readonly intervalDays: number
  readonly repetitions: number
  readonly easeFactor: number
  readonly createdAt: number
}

/** Cognitive friction / comprehension difficulty record. */
export interface FrictionPoint {
  readonly id: FrictionId
  readonly sourceId: SourceId
  readonly revisionId?: RevisionId
  readonly page: number
  readonly blockIds: readonly string[]
  readonly topic: string
  readonly description: string
  readonly resolution?: string
  readonly resolved: boolean
  readonly timestamp: number
}

/** Metacognitive calibration rating record. */
export interface CalibrationRecord {
  readonly requestId: RequestId
  readonly stage: 'pre-explanation' | 'post-explanation'
  readonly rating: 'fuzzy' | 'rough' | 'clear' | 'teach'
  readonly timestamp: number
}

/** Agent-generated diagnostic shown as low-cost choices in the companion. */
export interface CognitiveProbe {
  readonly lens: CognitiveLens
  readonly intent: CognitiveIntent
  readonly question: string
  readonly purpose: string
  readonly options: readonly CognitiveProbeOptionData[]
  readonly hint: string
  readonly synthesis: string
  readonly citations: readonly { readonly page: number; readonly blockId?: string; readonly quote: string }[]
  readonly provider: string
  readonly model: string
}

/** One analysis request folded from durable study events. */
export interface StudyRequestState {
  readonly sourceId?: SourceId
  readonly revisionId?: RevisionId
  readonly page?: number
  readonly blockIds?: readonly string[]
  readonly selectedText?: string
  readonly kind?: 'passage' | 'answer'
  readonly lens?: CognitiveLens
  readonly intent?: CognitiveIntent
  readonly parentRequestId?: RequestId
  readonly userAnswer?: string
  readonly deliveryState?: 'requested' | 'enqueued' | 'context-prepared' | 'generated'
  readonly agentMessageId?: string
  readonly contextPreparedAt?: number
  readonly probe?: CognitiveProbe
  readonly selectedOptionId?: CognitiveProbeOptionData['id']
  readonly selectedOptionAt?: number
  readonly feynman?: FeynmanExplanation
  readonly toulmin?: ToulminDecomposition
  readonly socratic?: SocraticChallenge
  readonly lastAssessment?: {
    readonly passed: boolean
    readonly feedback: string
    readonly correction?: string
    readonly timestamp: number
  }
  /** Keep pre/post ratings separately so calibration bias can be reported. */
  readonly calibrations?: Partial<Record<CalibrationRecord['stage'], CalibrationRecord>>
}

/** Overall derived study session state. */
export interface StudySessionState {
  readonly currentSourceId?: SourceId
  readonly highlights: readonly {
    readonly sourceId: SourceId
    readonly revisionId?: RevisionId
    readonly page: number
    readonly blockIds: readonly string[]
    readonly text: string
    readonly color?: string
  }[]
  readonly bookmarks: readonly {
    readonly sourceId: SourceId
    readonly revisionId?: RevisionId
    readonly page: number
    readonly blockIds: readonly string[]
    readonly text: string
    readonly note?: string
  }[]
  readonly activeRequests: Record<string, StudyRequestState>
  readonly frictions: readonly FrictionPoint[]
  readonly reviewCards: readonly ReviewCard[]
  readonly dossiers: readonly {
    readonly id: DossierId
    readonly sourceId: SourceId
    readonly revisionId?: RevisionId
    readonly title: string
    readonly content: string
    readonly createdAt: number
  }[]
}
