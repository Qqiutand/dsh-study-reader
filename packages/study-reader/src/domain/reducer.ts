/**
 * Pure durable-event reducer for Study Reader. The reducer is the single
 * projection used after refresh and for optimistic UI updates, so every branch
 * is deterministic and source-aware.
 * @module @deepseek-ai/dsh-study-reader/domain/reducer
 */

import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import { scheduleNextReview } from './cards.ts'
import type {
  ReviewCard,
  SocraticChallenge,
  StudyRequestState,
  StudySessionState,
} from './types.ts'

/** Initial empty state for a study session. */
export function emptyStudyState(): StudySessionState {
  return {
    highlights: [],
    bookmarks: [],
    activeRequests: {},
    frictions: [],
    reviewCards: [],
    dossiers: [],
  }
}

function updateRequest(
  state: StudySessionState,
  requestId: string,
  update: (current: StudyRequestState) => StudyRequestState,
): StudySessionState['activeRequests'] {
  return {
    ...state.activeRequests,
    [requestId]: update(state.activeRequests[requestId] ?? {}),
  }
}

/** Apply one registered Study Event to the derived session state. */
export function applyStudyEvent<T extends keyof SessionEventMap>(
  state: StudySessionState,
  type: T,
  data: SessionEventMap[T],
): StudySessionState {
  switch (type) {
    case 'study/source-imported': {
      const d = data as SessionEventMap['study/source-imported']
      return { ...state, currentSourceId: d.sourceId }
    }

    case 'study/highlight': {
      const d = data as SessionEventMap['study/highlight']
      return {
        ...state,
        highlights: [...state.highlights, {
          sourceId: d.sourceId,
          ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
          page: d.page,
          blockIds: d.blockIds,
          text: d.selectedText,
          color: d.color ?? 'yellow',
        }],
      }
    }

    case 'study/bookmark': {
      const d = data as SessionEventMap['study/bookmark']
      return {
        ...state,
        bookmarks: [...state.bookmarks, {
          sourceId: d.sourceId,
          ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
          page: d.page,
          blockIds: d.blockIds,
          text: d.selectedText,
          ...(d.note !== undefined ? { note: d.note } : {}),
        }],
      }
    }

    case 'study/feynman-requested': {
      const d = data as SessionEventMap['study/feynman-requested']
      return {
        ...state,
        activeRequests: updateRequest(state, d.requestId, current => ({
          ...current,
          sourceId: d.sourceId,
          ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
          page: d.page,
          blockIds: d.blockIds,
          selectedText: d.selectedText,
          ...(d.explanation !== undefined && d.explanation !== '' ? {
            feynman: {
              intuitiveAnalogy: d.analogy ?? d.explanation,
              terminologyMapping: (d.simplifiedTerms ?? []).map(item => ({
                term: item.term,
                meaning: item.explanation,
              })),
              contextRole: d.contextRole ?? d.explanation,
              citations: d.citations ?? [{ page: d.page, quote: d.selectedText }],
            },
          } : {}),
        })),
      }
    }

    case 'study/toulmin-requested': {
      const d = data as SessionEventMap['study/toulmin-requested']
      return {
        ...state,
        activeRequests: updateRequest(state, d.requestId, current => ({
          ...current,
          sourceId: d.sourceId,
          ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
          page: d.page,
          blockIds: d.blockIds,
          selectedText: d.selectedText,
          ...(d.toulmin !== undefined ? {
            toulmin: {
              claim: d.toulmin.claim,
              evidence: d.toulmin.evidence,
              warrant: d.toulmin.warrant,
              ...(d.toulmin.backing !== undefined ? { backing: d.toulmin.backing } : {}),
              ...(d.toulmin.qualifier !== undefined ? { qualifier: d.toulmin.qualifier } : {}),
              ...(d.toulmin.rebuttal !== undefined ? { rebuttal: d.toulmin.rebuttal } : {}),
            },
          } : {}),
        })),
      }
    }

    case 'study/calibration': {
      const d = data as SessionEventMap['study/calibration']
      return {
        ...state,
        activeRequests: updateRequest(state, d.requestId, current => ({
          ...current,
          sourceId: d.sourceId,
          ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
          calibrations: {
            ...current.calibrations,
            [d.stage]: {
              requestId: d.requestId,
              stage: d.stage,
              rating: d.rating,
              timestamp: d.timestamp,
            },
          },
        })),
      }
    }

    case 'study/cognitive-requested': {
      const d = data as SessionEventMap['study/cognitive-requested']
      return {
        ...state,
        activeRequests: updateRequest(state, d.requestId, current => ({
          ...current,
          sourceId: d.sourceId,
          ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
          page: d.page,
          blockIds: d.blockIds,
          selectedText: d.selectedText,
          kind: d.kind,
          lens: d.lens,
          intent: d.intent,
          ...(d.parentRequestId !== undefined ? { parentRequestId: d.parentRequestId } : {}),
          ...(d.userAnswer !== undefined ? { userAnswer: d.userAnswer } : {}),
          deliveryState: 'requested',
        })),
      }
    }

    case 'study/cognitive-enqueued': {
      const d = data as SessionEventMap['study/cognitive-enqueued']
      return {
        ...state,
        activeRequests: updateRequest(state, d.requestId, current => ({
          ...current,
          sourceId: d.sourceId,
          revisionId: d.revisionId,
          deliveryState: 'enqueued',
          agentMessageId: d.messageId,
        })),
      }
    }

    case 'study/cognitive-context-prepared': {
      const d = data as SessionEventMap['study/cognitive-context-prepared']
      return {
        ...state,
        activeRequests: updateRequest(state, d.requestId, current => ({
          ...current,
          sourceId: d.sourceId,
          revisionId: d.revisionId,
          page: d.page,
          blockIds: d.blockIds,
          deliveryState: 'context-prepared',
          contextPreparedAt: d.timestamp,
        })),
      }
    }

    case 'study/cognitive-probe-generated': {
      const d = data as SessionEventMap['study/cognitive-probe-generated']
      const activeRequests = updateRequest(state, d.requestId, current => ({
          ...current,
          sourceId: d.sourceId,
          ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
          page: d.page,
          blockIds: d.blockIds,
          lens: d.lens,
          intent: d.intent,
          deliveryState: 'generated',
          probe: {
            lens: d.lens,
            intent: d.intent,
            question: d.question,
            purpose: d.purpose,
            options: d.options,
            hint: d.hint,
            synthesis: d.synthesis,
            citations: d.citations,
            provider: d.provider,
            model: d.model,
          },
          ...(d.explanation !== undefined ? {
            feynman: {
              intuitiveAnalogy: d.analogy ?? d.explanation,
              terminologyMapping: (d.simplifiedTerms ?? []).map(item => ({
                term: item.term,
                meaning: item.explanation,
              })),
              contextRole: d.explanation,
              citations: d.citations,
            },
          } : {}),
          ...(d.toulmin !== undefined ? { toulmin: d.toulmin } : {}),
          ...(d.challenge !== undefined ? { socratic: d.challenge } : {}),
          ...(d.assessment !== undefined ? {
            lastAssessment: { ...d.assessment, timestamp: d.timestamp },
          } : {}),
        }))
      if (d.assessment === undefined || d.assessment.passed) return { ...state, activeRequests }
      const cardId = `card_${d.requestId}_${d.timestamp}` as ReviewCard['id']
      if (state.reviewCards.some(card => card.id === cardId)) return { ...state, activeRequests }
      return {
        ...state,
        activeRequests,
        reviewCards: [...state.reviewCards, {
          id: cardId,
          sourceId: d.sourceId,
          ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
          origin: 'socratic-fail',
          question: d.challenge?.questionText ?? d.question,
          answer: d.assessment.correction ?? d.assessment.feedback,
          page: d.page,
          nextDueAt: d.timestamp + 24 * 60 * 60 * 1000,
          intervalDays: 1,
          repetitions: 0,
          easeFactor: 2.5,
          createdAt: d.timestamp,
        }],
      }
    }

    case 'study/cognitive-option-selected': {
      const d = data as SessionEventMap['study/cognitive-option-selected']
      return {
        ...state,
        activeRequests: updateRequest(state, d.requestId, current => ({
          ...current,
          sourceId: d.sourceId,
          ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
          selectedOptionId: current.selectedOptionId ?? d.optionId,
          selectedOptionAt: current.selectedOptionAt ?? d.timestamp,
        })),
      }
    }

    case 'study/socratic-generated': {
      const d = data as SessionEventMap['study/socratic-generated']
      return {
        ...state,
        activeRequests: updateRequest(state, d.requestId, current => ({
          ...current,
          sourceId: d.sourceId,
          ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
          page: d.page,
          blockIds: d.blockIds,
          selectedText: d.selectedText,
          socratic: d.challenge,
        })),
      }
    }

    case 'study/socratic-response': {
      const d = data as SessionEventMap['study/socratic-response']
      const socratic: SocraticChallenge = {
        questionId: d.questionId,
        questionText: d.question,
        targetConcept: d.question,
        evaluationCriteria: d.aiAssessment.feedback,
      }
      const activeRequests = updateRequest(state, d.requestId, current => ({
        ...current,
        ...(d.sourceId !== undefined ? { sourceId: d.sourceId } : {}),
        ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
        ...(d.page !== undefined ? { page: d.page } : {}),
        ...(d.blockIds !== undefined ? { blockIds: d.blockIds } : {}),
        socratic,
        lastAssessment: {
          passed: d.aiAssessment.passed,
          feedback: d.aiAssessment.feedback,
          ...(d.aiAssessment.correction !== undefined ? { correction: d.aiAssessment.correction } : {}),
          timestamp: d.timestamp,
        },
      }))
      if (d.aiAssessment.passed) return { ...state, activeRequests }

      const cardId = `card_${d.requestId}_${d.timestamp}` as ReviewCard['id']
      if (state.reviewCards.some(card => card.id === cardId)) return { ...state, activeRequests }
      return {
        ...state,
        activeRequests,
        reviewCards: [...state.reviewCards, {
          id: cardId,
          sourceId: d.sourceId ?? state.currentSourceId ?? ('' as ReviewCard['sourceId']),
          ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
          origin: 'socratic-fail',
          question: d.question,
          answer: d.aiAssessment.correction ?? d.aiAssessment.feedback,
          page: d.page ?? 0,
          nextDueAt: d.timestamp + 24 * 60 * 60 * 1000,
          intervalDays: 1,
          repetitions: 0,
          easeFactor: 2.5,
          createdAt: d.timestamp,
        }],
      }
    }

    case 'study/friction': {
      const d = data as SessionEventMap['study/friction']
      if (state.frictions.some(existing => existing.id === d.frictionId)) return state
      return {
        ...state,
        frictions: [...state.frictions, {
          id: d.frictionId,
          sourceId: d.sourceId,
          ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
          page: d.page,
          blockIds: d.blockIds,
          topic: d.topic,
          description: d.confusionDescription,
          ...(d.resolution !== undefined ? { resolution: d.resolution } : {}),
          resolved: d.resolution !== undefined && d.resolution !== '',
          timestamp: d.timestamp,
        }],
      }
    }

    case 'study/review-card-generated': {
      const d = data as SessionEventMap['study/review-card-generated']
      if (state.reviewCards.some(existing => existing.id === d.cardId)) return state
      return {
        ...state,
        reviewCards: [...state.reviewCards, {
          id: d.cardId,
          sourceId: d.sourceId,
          ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
          origin: d.origin,
          question: d.question,
          answer: d.answer,
          page: d.page,
          nextDueAt: d.nextDueAt,
          intervalDays: d.intervalDays,
          repetitions: 0,
          easeFactor: d.easeFactor,
          createdAt: d.timestamp,
        }],
      }
    }

    case 'study/review-attempted': {
      const d = data as SessionEventMap['study/review-attempted']
      return {
        ...state,
        reviewCards: state.reviewCards.map(card => {
          if (card.id !== d.cardId) return card
          const scheduled = scheduleNextReview(card, d.quality, d.timestamp)
          return {
            ...card,
            intervalDays: scheduled.intervalDays,
            repetitions: scheduled.repetitions,
            easeFactor: scheduled.easeFactor,
            // The reducer owns the SM-2 calculation. A caller-provided due
            // date must not override the interval derived from quality.
            nextDueAt: scheduled.nextDueAt,
          }
        }),
      }
    }

    case 'study/dossier-generated': {
      const d = data as SessionEventMap['study/dossier-generated']
      if (state.dossiers.some(existing => existing.id === d.dossierId)) return state
      return {
        ...state,
        dossiers: [...state.dossiers, {
          id: d.dossierId,
          sourceId: d.sourceId,
          ...(d.revisionId !== undefined ? { revisionId: d.revisionId } : {}),
          title: d.title,
          content: d.content,
          createdAt: d.timestamp,
        }],
      }
    }

    default:
      return state
  }
}
