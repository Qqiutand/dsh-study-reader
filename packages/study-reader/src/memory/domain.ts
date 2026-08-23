/** Durable projection and mutation audit for the replaceable memory provider. */

import z from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { StudyMemoryId } from './types.ts'
import { legacyWorkspaceSchema } from './migration.ts'

const selectionSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string(),
  sourceId: z.string().optional(),
  revisionId: z.string().optional(),
  updatedAt: z.number(),
  version: z.number(),
  lastCommandId: z.string().optional(),
})

const anchorSchema = z.object({
  revisionId: z.string(),
  page: z.number(),
  blockIds: z.array(z.string()),
  selectedText: z.string(),
})

const memorySchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  ownerSessionId: z.string(),
  scope: z.union([z.literal('session'), z.literal('source')]),
  kind: z.union([
    z.literal('quote'), z.literal('insight'), z.literal('question'),
    z.literal('preference'), z.literal('summary'),
  ]),
  sourceId: z.string(),
  anchor: anchorSchema.optional(),
  text: z.string(),
  note: z.string().optional(),
  tags: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const mutationSchema = z.object({
  id: z.string(),
  memoryId: z.string(),
  actorSessionId: z.string(),
  operation: z.union([z.literal('remember'), z.literal('forget'), z.literal('source-delete')]),
  snapshot: memorySchema,
  createdAt: z.number(),
})

const migrationSchema = z.object({ id:z.string(), completedAt:z.number() })

export const studyMemoryDomain = defineDomain({
  name: 'study_reader_memory',
  version: 1,
  tables: {
    workspaces: domainTable<string, z.infer<typeof legacyWorkspaceSchema>>(legacyWorkspaceSchema),
    selections: domainTable<string, z.infer<typeof selectionSchema>>(selectionSchema),
    memories: domainTable<StudyMemoryId, z.infer<typeof memorySchema>>(memorySchema),
    mutations: domainTable<string, z.infer<typeof mutationSchema>>(mutationSchema),
    migrations: domainTable<string, z.infer<typeof migrationSchema>>(migrationSchema),
  },
})

export { selectionSchema, memorySchema, mutationSchema }
