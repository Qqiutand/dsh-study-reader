/** Zod schemas for durable injection-studio assets. */
import z from 'zod'

const promptLayer = z.literal('system-addon')
const skillInvocation = z.union([z.literal('user'), z.literal('model'), z.literal('both')])
const promptBindingSchema = z.object({ promptId: z.string(), promptVersion: z.number().int().positive(), enabled: z.boolean(), order: z.number().int() })
const profileSkillBindingSchema = z.object({ skillId: z.string(), skillVersion: z.number().int().positive(), enabled: z.boolean(), invocation: skillInvocation })
const toolPolicyBindingSchema = z.object({ toolName: z.string(), enabled: z.boolean(), guidanceAppendix: z.string().optional() })
const modelPolicySchema = z.union([
  z.object({ kind: z.literal('inherit-session') }),
  z.object({ kind: z.literal('fixed-provider'), providerId: z.string(), modelId: z.string() }),
])
const assetNamespaceSchema = z.union([z.literal('library'), z.literal('prompt'), z.literal('skill'), z.literal('profile')])
const providerOptionSchema = z.union([z.string(), z.number(), z.boolean()])
export const assetFolderRecordSchema = z.object({ id: z.string(), namespace: assetNamespaceSchema, parentId: z.string().optional(), name: z.string(), sortKey: z.string(), version: z.number().int().positive(), createdAt: z.number(), updatedAt: z.number(), lastCommandId: z.string().optional() })
const assetTreeCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create-folder'), namespace: assetNamespaceSchema, name: z.string(), parentId: z.string().optional() }),
  z.object({ kind: z.literal('rename-folder'), folderId: z.string(), name: z.string(), expectedVersion: z.number().int().positive() }),
  z.object({ kind: z.literal('move-folder'), folderId: z.string(), parentId: z.string().optional(), expectedVersion: z.number().int().positive() }),
  z.object({ kind: z.literal('delete-folder'), folderId: z.string(), expectedVersion: z.number().int().positive() }),
  z.object({ kind: z.literal('move-asset'), namespace: assetNamespaceSchema, assetId: z.string(), folderId: z.string().optional(), expectedVersion: z.number().int().positive() }),
])

export const promptAssetRecordSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), folderId: z.string().optional(),
  source: z.union([z.literal('builtin'), z.literal('user')]), readonly: z.boolean(),
  currentVersion: z.number().int().positive(), recordVersion: z.number().int().positive(), archived: z.boolean(),
  revisions: z.array(z.object({ version: z.number().int().positive(), layer: promptLayer, priority: z.number().int(), content: z.string(), contentHash: z.string().regex(/^[a-f0-9]{64}$/i), estimatedTokens: z.number().int().nonnegative(), createdAt: z.number() })).min(1),
  createdAt: z.number(), updatedAt: z.number(),
})

export const injectionProfileRecordSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), folderId: z.string().optional(),
  currentVersion: z.number().int().positive(), recordVersion: z.number().int().positive(), archived: z.boolean(),
  revisions: z.array(z.object({
    version: z.number().int().positive(), promptBindings: z.array(promptBindingSchema), skillBindings: z.array(profileSkillBindingSchema),
    toolPolicies: z.array(toolPolicyBindingSchema), modelPolicy: modelPolicySchema, createdAt: z.number(),
  })).min(1),
  createdAt: z.number(), updatedAt: z.number(),
})

export const sessionInjectionBindingSchema = z.object({
  sessionId: z.string(), profileId: z.string(), profileVersion: z.number().int().positive(),
  recordVersion: z.number().int().positive(), appliedAt: z.number(), lastCommandId: z.string().optional(),
})

export const providerConnectionRecordSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), providerId: z.string(), providerKind: z.string(), displayName: z.string(), credentialRef: z.string(),
  builtin: z.boolean().optional(), active: z.boolean().optional(),
  endpoint: z.string(), enabled: z.boolean(), model: z.string().optional(), nonSecretConfig: z.record(z.string(), providerOptionSchema),
  version: z.number().int().positive(), createdAt: z.number(), updatedAt: z.number(), lastCommandId: z.string().optional(),
})

export const providerConnectionCommandReceiptSchema = z.object({
  schemaVersion: z.literal(1), commandId: z.string(), providerId: z.string(), canonicalPayload: z.string(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/i),
  state: z.union([z.literal('pending'), z.literal('committed'), z.literal('rejected')]), result: providerConnectionRecordSchema.optional(),
  errorCode: z.string().optional(), errorMessage: z.string().optional(), createdAt: z.number(), updatedAt: z.number(),
})

const studioCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create-prompt'), name: z.string(), description: z.string(), folderId: z.string().optional(), layer: promptLayer, priority: z.number().int(), content: z.string() }),
  z.object({ kind: z.literal('revise-prompt'), promptId: z.string(), expectedRecordVersion: z.number().int().positive(), name: z.string(), description: z.string(), layer: promptLayer, priority: z.number().int(), content: z.string() }),
  z.object({ kind: z.literal('archive-prompt'), promptId: z.string(), expectedRecordVersion: z.number().int().positive(), archived: z.boolean() }),
  z.object({ kind: z.literal('delete-prompt'), promptId: z.string(), expectedRecordVersion: z.number().int().positive() }),
  z.object({ kind: z.literal('create-profile'), name: z.string(), description: z.string(), folderId: z.string().optional(), promptBindings: z.array(promptBindingSchema), skillBindings: z.array(profileSkillBindingSchema), toolPolicies: z.array(toolPolicyBindingSchema), modelPolicy: modelPolicySchema }),
  z.object({ kind: z.literal('revise-profile'), profileId: z.string(), expectedRecordVersion: z.number().int().positive(), name: z.string(), description: z.string(), promptBindings: z.array(promptBindingSchema), skillBindings: z.array(profileSkillBindingSchema), toolPolicies: z.array(toolPolicyBindingSchema), modelPolicy: modelPolicySchema }),
  z.object({ kind: z.literal('archive-profile'), profileId: z.string(), expectedRecordVersion: z.number().int().positive(), archived: z.boolean() }),
  z.object({ kind: z.literal('delete-profile'), profileId: z.string(), expectedRecordVersion: z.number().int().positive() }),
  z.object({ kind: z.literal('activate-profile'), profileId: z.string(), profileVersion: z.number().int().positive(), expectedBindingVersion: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('deactivate-profile'), expectedBindingVersion: z.number().int().positive() }),
  z.object({ kind: z.literal('apply-asset-tree'), treeCommand: assetTreeCommandSchema }),
])
const studioCommandKindSchema = z.union([
  z.literal('create-prompt'), z.literal('revise-prompt'), z.literal('archive-prompt'), z.literal('delete-prompt'),
  z.literal('create-profile'), z.literal('revise-profile'), z.literal('archive-profile'), z.literal('delete-profile'), z.literal('activate-profile'), z.literal('deactivate-profile'),
  z.literal('apply-asset-tree'),
])

const commandResultSchema = z.object({
  accepted: z.literal(true), prompt: promptAssetRecordSchema.optional(), promptDeleted: z.literal(true).optional(), profile: injectionProfileRecordSchema.optional(), profileDeleted: z.literal(true).optional(), binding: sessionInjectionBindingSchema.optional(), bindingCleared: z.literal(true).optional(), folder: assetFolderRecordSchema.optional(),
})

export const injectionStudioCommandReceiptSchema = z.object({
  schemaVersion: z.literal(1), commandId: z.string(), sessionId: z.string(), kind: studioCommandKindSchema,
  command: studioCommandSchema, canonicalPayload: z.string(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/i),
  state: z.union([z.literal('pending'), z.literal('committed'), z.literal('rejected')]), result: commandResultSchema.optional(),
  errorCode: z.string().optional(), errorMessage: z.string().optional(), createdAt: z.number(), updatedAt: z.number(),
})
