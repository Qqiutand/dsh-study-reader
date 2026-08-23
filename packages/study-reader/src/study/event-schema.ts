/**
 * Runtime validation for the durable study event vocabulary. Remote input is
 * untrusted even when the TypeScript face is typed, so every event is parsed
 * before it enters the append-only store or the deterministic reducer.
 * @module @deepseek-ai/dsh-study/event-schema
 */

import z from 'zod'
import { StudyError } from '../protocol/error.ts'
import type { StudyEventPayload } from './types.ts'
import type { StudyEventType } from '../protocol/events.ts'
export { canonicalEventJson } from './event-json.ts'

const id = z.string().min(1).max(256)
const revisionId = id.optional()
const page = z.number().int().min(0).max(10_000_000)
const anchorPage = z.number().int().min(1).max(10_000_000)
const timestamp = z.number().int().nonnegative()
const text = z.string().max(1_000_000)
const anchorText = z.string().min(1).max(1_000_000)
const shortText = z.string().max(100_000)
const blockIds = z.array(z.string().min(1).max(256)).max(512)
const anchorBlockIds = z.array(z.string().min(1).max(256)).min(1).max(512)
const citation = z.object({
  page,
  blockId: z.string().min(1).max(256).optional(),
  quote: text,
})
const stats = z.object({
  highlightsCount: z.number().int().nonnegative(),
  bookmarksCount: z.number().int().nonnegative(),
  frictionsResolvedCount: z.number().int().nonnegative(),
  socraticQuestionsCount: z.number().int().nonnegative(),
  cardsCount: z.number().int().nonnegative(),
})
const cognitiveIntent = z.enum(['concept', 'inference', 'evidence', 'boundary', 'other', 'hint'])
const cognitiveLens = z.enum(['feynman', 'toulmin', 'socratic'])
const cognitiveOption = z.object({
  id: z.enum(['A', 'B', 'C', 'D', 'E', 'F']),
  text: shortText,
  diagnosis: shortText,
  feedback: text,
  best: z.boolean(),
})
const payloadSchemas = {
  'study/source-imported': z.object({
    sourceId: id,
    revisionId,
    format: z.enum(['pdf', 'epub', 'other']).optional(),
    title: shortText,
    fileName: shortText,
    pageCount: z.number().int().nonnegative(),
    blockCount: z.number().int().nonnegative(),
    timestamp,
  }),
  'study/highlight': z.object({
    sourceId: id,
    revisionId,
    page: anchorPage,
    blockIds: anchorBlockIds,
    selectedText: anchorText,
    color: z.enum(['yellow', 'blue', 'green', 'pink']).optional(),
    timestamp,
  }),
  'study/bookmark': z.object({
    sourceId: id,
    revisionId,
    page: anchorPage,
    blockIds: anchorBlockIds,
    selectedText: anchorText,
    note: shortText.optional(),
    timestamp,
  }),
  'study/feynman-requested': z.object({
    requestId: id,
    sourceId: id,
    revisionId,
    page: anchorPage,
    blockIds: anchorBlockIds,
    selectedText: anchorText,
    explanation: text.optional(),
    analogy: text.optional(),
    simplifiedTerms: z.array(z.object({ term: shortText, explanation: text })).max(256).optional(),
    contextRole: text.optional(),
    citations: z.array(citation).max(512).optional(),
    timestamp,
  }),
  'study/toulmin-requested': z.object({
    requestId: id,
    sourceId: id,
    revisionId,
    page: anchorPage,
    blockIds: anchorBlockIds,
    selectedText: anchorText,
    toulmin: z.object({
      claim: text,
      evidence: z.array(z.object({
        text,
        page,
        blockId: z.string().min(1).max(256).optional(),
      })).max(512),
      warrant: text,
      backing: text.optional(),
      qualifier: text.optional(),
      rebuttal: text.optional(),
    }).optional(),
    timestamp,
  }),
  'study/calibration': z.object({
    requestId: id,
    sourceId: id,
    revisionId,
    stage: z.enum(['pre-explanation', 'post-explanation']),
    rating: z.enum(['fuzzy', 'rough', 'clear', 'teach']),
    timestamp,
  }),
  'study/cognitive-requested': z.object({
    requestId: id,
    parentRequestId: id.optional(),
    sourceId: id,
    revisionId,
    page: anchorPage,
    blockIds: anchorBlockIds,
    selectedText: anchorText,
    kind: z.enum(['passage', 'answer']),
    lens: cognitiveLens,
    intent: cognitiveIntent,
    question: text.optional(),
    userAnswer: text.optional(),
    timestamp,
  }),
  'study/cognitive-enqueued': z.object({
    requestId: id,
    sourceId: id,
    revisionId: id,
    messageId: id,
    timestamp,
  }),
  'study/cognitive-context-prepared': z.object({
    requestId: id,
    sourceId: id,
    revisionId: id,
    page: z.number().int().min(1).max(10_000_000),
    blockIds: z.array(id).min(1).max(512),
    receipt: id,
    turn: z.number().int().min(1),
    toolCallId: id,
    timestamp,
  }),
  'study/cognitive-probe-generated': z.object({
    requestId: id,
    sourceId: id,
    revisionId,
    page: anchorPage,
    blockIds: anchorBlockIds,
    lens: cognitiveLens,
    intent: cognitiveIntent,
    question: text,
    purpose: shortText,
    options: z.array(cognitiveOption).min(6).max(6),
    hint: text,
    synthesis: text,
    explanation: text.optional(),
    analogy: text.optional(),
    simplifiedTerms: z.array(z.object({ term: shortText, explanation: text })).max(256).optional(),
    toulmin: z.object({
      claim: text,
      evidence: z.array(z.object({
        text,
        page,
        blockId: z.string().min(1).max(256).optional(),
      })).max(512),
      warrant: text,
      backing: text.optional(),
      qualifier: text.optional(),
      rebuttal: text.optional(),
    }).optional(),
    challenge: z.object({
      questionId: id,
      questionText: text,
      targetConcept: text,
      evaluationCriteria: text,
    }).optional(),
    assessment: z.object({
      passed: z.boolean(),
      feedback: text,
      correction: text.optional(),
    }).optional(),
    citations: z.array(citation).min(1).max(512),
    provider: id,
    model: id,
    timestamp,
  }),
  'study/cognitive-option-selected': z.object({
    requestId: id,
    sourceId: id,
    revisionId,
    optionId: z.enum(['A', 'B', 'C', 'D', 'E', 'F']),
    timestamp,
  }),
  'study/socratic-generated': z.object({
    requestId: id,
    sourceId: id,
    revisionId,
    page: anchorPage,
    blockIds: anchorBlockIds,
    selectedText: anchorText,
    challenge: z.object({
      questionId: id,
      questionText: text,
      targetConcept: text,
      evaluationCriteria: text,
    }),
    timestamp,
  }),
  'study/socratic-response': z.object({
    requestId: id,
    sourceId: id.optional(),
    revisionId,
    page: page.optional(),
    blockIds: blockIds.optional(),
    questionId: id,
    question: text,
    userAnswer: text,
    aiAssessment: z.object({
      passed: z.boolean(),
      feedback: text,
      correction: text.optional(),
    }),
    timestamp,
  }),
  'study/friction': z.object({
    frictionId: id,
    sourceId: id,
    revisionId,
    page: anchorPage,
    blockIds: anchorBlockIds,
    topic: shortText,
    confusionDescription: text,
    resolution: text.optional(),
    timestamp,
  }),
  'study/review-card-generated': z.object({
    cardId: id,
    sourceId: id,
    revisionId,
    origin: z.enum(['friction', 'socratic-fail', 'bookmark', 'concept']),
    question: text,
    answer: text,
    page,
    nextDueAt: timestamp,
    intervalDays: z.number().nonnegative().max(365_000),
    easeFactor: z.number().min(1.3).max(10),
    timestamp,
  }),
  'study/review-attempted': z.object({
    cardId: id,
    quality: z.union([
      z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
    ]),
    nextDueAt: timestamp,
    timestamp,
  }),
  'study/dossier-generated': z.object({
    dossierId: id,
    sourceId: id,
    revisionId,
    title: shortText,
    content: z.string().max(5_000_000),
    stats,
    timestamp,
  }),
} satisfies Record<StudyEventType, { safeParse(value: unknown): { success: boolean; data?: unknown; error?: unknown } }>

/** Parse and normalize one event payload or reject it before persistence. */
export function parseStudyEventPayload(type: StudyEventType, value: unknown): StudyEventPayload {
  const result = payloadSchemas[type].safeParse(value)
  if (!result.success) {
    throw new StudyError(`invalid payload for ${type}: ${formatIssue(result.error)}`, 'EVENT_PAYLOAD_INVALID')
  }
  return result.data as StudyEventPayload
}

function formatIssue(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error)
  const issues = (error as { issues?: readonly { path?: readonly PropertyKey[]; message?: string }[] }).issues
  if (!Array.isArray(issues) || issues.length === 0) return 'schema validation failed'
  return issues.slice(0, 4).map(issue => {
    const path = issue.path?.map(String).join('.') ?? ''
    return `${path === '' ? '<root>' : path}: ${issue.message ?? 'invalid value'}`
  }).join('; ')
}
