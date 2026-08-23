/**
 * Spaced repetition retrieval card generator and SuperMemo SM-2 scheduler.
 * @module dsh-study-reader/domain/cards
 */

import { CardId, mintId, type SourceId } from '../protocol/ids.ts'
import type { ReviewCard } from './types.ts'

/** SuperMemo SM-2 response quality rating (0: total blackout -> 5: perfect recall). */
export type ReviewQuality = 0 | 1 | 2 | 3 | 4 | 5

/** Calculate next interval and ease factor using SM-2 algorithm. */
export function scheduleNextReview(
  card: ReviewCard,
  quality: ReviewQuality,
  now: number = Date.now(),
): { nextDueAt: number; intervalDays: number; repetitions: number; easeFactor: number } {
  let { repetitions, intervalDays, easeFactor } = card

  if (quality >= 3) {
    if (repetitions === 0) {
      intervalDays = 1
    } else if (repetitions === 1) {
      intervalDays = 6
    } else {
      intervalDays = Math.round(intervalDays * easeFactor)
    }
    repetitions += 1
  } else {
    repetitions = 0
    intervalDays = 1
  }

  // SM-2 Ease Factor calculation
  easeFactor = easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
  if (easeFactor < 1.3) easeFactor = 1.3

  const oneDayMs = 24 * 60 * 60 * 1000
  const nextDueAt = now + intervalDays * oneDayMs

  return { nextDueAt, intervalDays, repetitions, easeFactor }
}

/** Create a new review card from a cognitive friction point. */
export function createCardFromFriction(
  sourceId: SourceId,
  page: number,
  _topic: string,
  question: string,
  answer: string,
  now: number = Date.now(),
): ReviewCard {
  return {
    id: mintId<CardId>('card'),
    sourceId,
    origin: 'friction',
    question,
    answer,
    page,
    nextDueAt: now + 24 * 60 * 60 * 1000, // Due in 1 day
    intervalDays: 1,
    repetitions: 0,
    easeFactor: 2.5,
    createdAt: now,
  }
}

/** Create a new review card from a bookmarked concept or formula. */
export function createCardFromBookmark(
  sourceId: SourceId,
  page: number,
  question: string,
  answer: string,
  now: number = Date.now(),
): ReviewCard {
  return {
    id: mintId<CardId>('card'),
    sourceId,
    origin: 'bookmark',
    question,
    answer,
    page,
    nextDueAt: now + 24 * 60 * 60 * 1000,
    intervalDays: 1,
    repetitions: 0,
    easeFactor: 2.5,
    createdAt: now,
  }
}
