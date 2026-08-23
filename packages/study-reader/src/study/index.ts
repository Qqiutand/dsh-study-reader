/**
 * Study reader host plugin (`@deepseek-ai/dsh-study`): opens the
 * `study_reader` domain, mounts the study service (domain API + Typert
 * Remote), registers the streaming upload route, and drives the import
 * poller with full teardown (stop admission, abort network work, wait
 * operation tails, close the domain).
 * @module @deepseek-ai/dsh-study
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '../memory/index.ts'
import { createStudyAgentProvider } from '../agent/index.ts'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from './blob-lifecycle.ts'
import { BlobGarbageCollector } from './blob-gc.ts'
import { StudyAssetServer } from './assets.ts'
import { StudyPoller } from './poller.ts'
import { migrateLegacyImports } from './import-migration.ts'
import type { PollerConfig } from './poller.ts'
import { StudyService, type StudyServiceConfig } from './study-service.ts'
import type { ArtifactId, ArtifactRecord, DossierId, DossierRecord, ExtractionArtifactSetId, ExtractionArtifactSetRecord, ImportId, ImportRecord, ReprocessOperationId, ReprocessOperationRecord, RevisionId, RevisionRecord, SourceAccessRecord, SourceId, SourceRecord, StudyEventRecord } from './types.ts'
import type { AgentGrant, ManagementCommandRecord, ManagementDeletionOperation, ManagementFolder, ManagementProposal, SourceLocation, StudySkill } from './management.ts'
import type { AssetFolderRecord, InjectionProfileRecord, InjectionStudioCommandReceipt, PromptAssetRecord, ProviderConnectionCommandReceipt, ProviderConnectionRecord, SessionInjectionBinding } from '../studio/types.ts'
import { applyCompiledInjection } from '../studio/runtime-injection.ts'
// Type-only: the Cordis Context merges for the injected host services.
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { STUDY_TOOL_SPECS } from '../tools/specs.ts'
import { READER_TOOL_NAMES } from '../ai/contracts.ts'
import { UploadRegistry } from './upload.ts'
import { managedProfileSkillProvider } from './managed-skill-provider.ts'
import { bundledReaderSkillProvider } from './bundled-reader-skill-provider.ts'
import { filterNativeReaderSkillMessages, readerSkillMessageSource } from './reader-skill-catalog.ts'

/** Cordis plugin name of the study row. */
export const name = 'study'
/** Required host services. */
export const inject = ['agents', 'documentExtraction', 'skills', 'studyBlobLifecycle', 'studyAgent', 'studyMemory', 'systemPrompt', 'timer', 'webServer']

/** Host plugin config: every deployment-varying value lives here. */
export interface StudyConfig {
  /** Absolute blob/scratch root (`!!js dshHomePath('study-reader')`). */
  storageRoot: string
  /** Route prefix of the streaming upload endpoint. */
  uploadRoute: string
  /** Route prefix for original PDF and revision-scoped image assets. */
  assetRoute: string
  /** Upload-token lifetime in milliseconds. */
  uploadTicketTtlMs: number
  /** Hard ceiling on one uploaded file. */
  maxFileBytes: number
  /** Maximum PDF pages sent in one provider task. */
  maxProviderPagesPerPart?: number
  /** Result archive size ceiling. */
  maxArchiveBytes: number
  /** Total uncompressed zip ceiling (zip-bomb guard). */
  maxUncompressedBytes: number
  /** Zip entry-count ceiling. */
  maxArchiveEntries: number
  /** One zip entry ceiling. */
  maxEntryBytes: number
  /** Poll loop period. */
  pollTickMs: number
  /** Initial poll backoff. */
  pollInitialMs: number
  /** Poll backoff cap. */
  pollMaxMs: number
  /** Concurrent poll ceiling. */
  maxConcurrentPolls: number
  /** Browser interval while waiting for an Agent cognitive completion event. */
  cognitivePollMs?: number
  /** Browser deadline for one Agent cognitive turn. */
  cognitiveTimeoutMs?: number
  /** Maximum admission attempts for a recoverable Agent enqueue interruption. */
  cognitiveAdmissionAttempts?: number
  /** Delay between cognitive admission attempts. */
  cognitiveAdmissionRetryMs?: number
  /** Read-output budget for the agent tool. */
  maxReadChars: number
  /** Search-result cap for the agent tool. */
  maxSearchResults: number
  /** Argument-graph node cap. */
  maxGraphNodes: number
  /** Argument-graph edge cap. */
  maxGraphEdges: number
  /** Search-index cache bound (revisions kept in memory). */
  maxSearchIndexCache?: number
  /** Default document language passed to the provider. */
  defaultLanguage?: string
  defaultIsOcr?: boolean
  defaultEnableTable?: boolean
  defaultEnableFormula?: boolean
  /** File picker accept list shipped through `bootstrap`. */
  acceptExtensions?: string[]
  blobGcEnabled?: boolean
  blobGcIntervalMs?: number
  blobGcGraceMs?: number
  blobGcBatchSize?: number
  /** Explicitly local-only Bookroom management plane; no Remote principal exists upstream. */
  managementControlMode?: 'trusted-local-user' | 'disabled'
}

/** Schemastery config. */
export const Config: z<StudyConfig> = z.object({
  storageRoot: z.string().required(),
  uploadRoute: z.string().required(),
  assetRoute: z.string().default('/study-reader/assets'),
  uploadTicketTtlMs: z.number().min(1).required(),
  maxFileBytes: z.number().min(1).required(),
  maxProviderPagesPerPart: z.number().min(1).default(200),
  maxArchiveBytes: z.number().min(1).required(),
  maxUncompressedBytes: z.number().min(1).required(),
  maxArchiveEntries: z.number().min(1).required(),
  maxEntryBytes: z.number().min(1).required(),
  pollTickMs: z.number().min(1).required(),
  pollInitialMs: z.number().min(1).required(),
  pollMaxMs: z.number().min(1).required(),
  maxConcurrentPolls: z.number().min(1).required(),
  cognitivePollMs: z.number().min(100).default(1000),
  cognitiveTimeoutMs: z.number().min(1000).default(180000),
  cognitiveAdmissionAttempts: z.number().min(1).max(10).default(3),
  cognitiveAdmissionRetryMs: z.number().min(0).max(10000).default(250),
  maxReadChars: z.number().min(1).required(),
  maxSearchResults: z.number().min(1).required(),
  maxGraphNodes: z.number().min(1).required(),
  maxGraphEdges: z.number().min(1).required(),
  maxSearchIndexCache: z.number().min(1).default(8),
  defaultLanguage: z.string().default('ch'),
  defaultIsOcr: z.boolean().default(false),
  defaultEnableTable: z.boolean().default(true),
  defaultEnableFormula: z.boolean().default(true),
  acceptExtensions: z.array(z.string()).default([
    '.pdf', '.epub', '.doc', '.docx', '.ppt', '.pptx',
    '.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.webp',
  ]),
  blobGcEnabled: z.boolean().default(false),
  blobGcIntervalMs: z.number().min(1000).default(3600000),
  blobGcGraceMs: z.number().min(1000).default(86400000),
  blobGcBatchSize: z.number().min(1).max(10000).default(100),
  managementControlMode: z.union([z.const('trusted-local-user'), z.const('disabled')]).default('trusted-local-user'),
})

/** Resolve validated config into the service policy shape. */
function resolveConfig(config: StudyConfig): { service: StudyServiceConfig; poller: PollerConfig } {
  const service: StudyServiceConfig = {
    uploadRoute: config.uploadRoute,
    assetRoute: config.assetRoute,
    uploadTicketTtlMs: config.uploadTicketTtlMs,
    maxFileBytes: config.maxFileBytes,
    maxProviderPagesPerPart: config.maxProviderPagesPerPart ?? 200,
    maxGraphNodes: config.maxGraphNodes,
    maxGraphEdges: config.maxGraphEdges,
    cognitivePollMs: config.cognitivePollMs ?? 1000,
    cognitiveTimeoutMs: config.cognitiveTimeoutMs ?? 180000,
    cognitiveAdmissionAttempts: config.cognitiveAdmissionAttempts ?? 3,
    cognitiveAdmissionRetryMs: config.cognitiveAdmissionRetryMs ?? 250,
    maxReadChars: config.maxReadChars,
    maxSearchResults: config.maxSearchResults,
    maxSearchIndexCache: config.maxSearchIndexCache ?? 8,
    defaultLanguage: config.defaultLanguage ?? 'ch',
    defaultIsOcr: config.defaultIsOcr ?? false,
    defaultEnableTable: config.defaultEnableTable ?? true,
    defaultEnableFormula: config.defaultEnableFormula ?? true,
    acceptExtensions: config.acceptExtensions ?? [],
    managementControlMode: config.managementControlMode ?? 'trusted-local-user',
  }
  const poller: PollerConfig = {
    pollTickMs: config.pollTickMs,
    pollInitialMs: config.pollInitialMs,
    pollMaxMs: config.pollMaxMs,
    maxConcurrentPolls: config.maxConcurrentPolls,
    providerModel: 'mineru-vlm',
  }
  return { service, poller }
}

export type * from './types.ts'
export type {
  CognitiveProbeSubmission, ImportDiagnostics, PublishGraphResult,
  ExecuteSkillCommandRequest, SearchRequest, SearchResult, SkillManagementCommand, StudyService, StudyServiceConfig,
} from './study-service.ts'
export type {
  AgentGrant,
  FolderKind,
  ManagedManagementFolderView,
  ManagedStudySkillView,
  ManagementCommand,
  ManagementFolder,
  ManagementFolderCapabilities,
  ManagementFolderView,
  ManagementProposal,
  ManagementSkillCapabilities,
  ManagementSkillView,
  RegistryManagementFolderView,
  RegistrySkillCatalogStatus,
  RegistryStudySkillOrigin,
  RegistryStudySkillSourceCategory,
  RegistryStudySkillView,
  SourceLocation,
  StudySkill,
} from './management.ts'
export { StudyError } from '../protocol/error.ts'

/**
 * Mount the study plugin: domain, service, upload route, and poller.
 * @param ctx - Cordis context carrying the injected services.
 * @param config - validated plugin config.
 * @returns resolution after the domain opens and the poller resumes.
 */
export async function apply(ctx: Context, config: StudyConfig): Promise<void> {
  const { service: serviceConfig, poller: pollerConfig } = resolveConfig(config)
  const lifecycle = new AbortController()
  const domain = ctx.studyBlobLifecycle.domain
  const sourceTable = domain.table('sources') as unknown as KvTable<SourceId, SourceRecord>
  const revisionTable = domain.table('revisions') as unknown as KvTable<RevisionId, RevisionRecord>
  let sourceMetadataBackfills = 0
  for (const [sourceId, source] of sourceTable.entries()) {
    const legacy = source as SourceRecord & { readonly displayTitle?: string; readonly authors?: readonly string[]; readonly originalFileName?: string }
    if (legacy.displayTitle !== undefined && legacy.authors !== undefined && legacy.originalFileName !== undefined) continue
    const revision = legacy.currentRevisionId === undefined ? undefined : revisionTable.get(legacy.currentRevisionId)
    await sourceTable.put(sourceId, { ...source, displayTitle: legacy.displayTitle ?? legacy.title, authors: legacy.authors ?? [], originalFileName: legacy.originalFileName ?? revision?.fileName ?? legacy.title })
    sourceMetadataBackfills += 1
  }
  if (sourceMetadataBackfills > 0) ctx.logger.info(`study: backfilled metadata for ${String(sourceMetadataBackfills)} sources`)
  await migrateLegacyImports(
    domain.table('imports') as unknown as KvTable<ImportId, ImportRecord>,
    sourceTable,
  )
  ctx.effect(() => async () => {
    lifecycle.abort(new Error('study plugin stopped'))
  }, 'study: lifecycle')

  // Physical GC is intentionally disabled at this checkpoint.  The stable
  // lifecycle service retains the future deletion lock API, but no timer,
  // Remote, Agent or Tool path invokes it.
  const blobs = ctx.studyBlobLifecycle.blobs
  const gc = new BlobGarbageCollector({
    blobs,
    lifecycle: ctx.studyBlobLifecycle,
    imports: domain.table('imports') as unknown as KvTable<ImportId, ImportRecord>,
    revisions: domain.table('revisions') as unknown as KvTable<RevisionId, RevisionRecord>,
    artifactSets: domain.table('extraction_artifact_sets') as unknown as KvTable<ExtractionArtifactSetId, ExtractionArtifactSetRecord>,
    candidates: ctx.studyBlobLifecycle.candidates,
    onSafetyError: code => ctx.logger.warn(`study: blob GC safety error ${code}`),
  }, { graceMs: config.blobGcGraceMs ?? 86400000, batchSize: config.blobGcBatchSize ?? 100 })
  if (config.blobGcEnabled === true) {
    ctx.effect(() => {
      const stop = ctx.interval(() => { void gc.run().then(result => ctx.logger.info(`study: blob GC scanned=${result.scanned} live=${result.live} deleted=${result.deleted} failures=${result.failures}`)) }, config.blobGcIntervalMs ?? 3600000)
      return async () => { stop(); await gc.dispose() }
    }, 'study: blob GC timer')
  }
  const uploads = new UploadRegistry(config.uploadTicketTtlMs)
  // The constructor registers the `study` service and its Remote binding.
  // The domain tables store zod-projected plain strings; the branded record
  // view is a same-process type projection at this boundary.
  const service = new StudyService(ctx, {
    agents: ctx.agents,
    memory: ctx.studyMemory,
    sources: domain.table('sources') as unknown as KvTable<SourceId, SourceRecord>,
    sourceAccess: domain.table('source_access') as unknown as KvTable<string, SourceAccessRecord>,
    revisions: domain.table('revisions') as unknown as KvTable<RevisionId, RevisionRecord>,
    imports: domain.table('imports') as unknown as KvTable<ImportId, ImportRecord>,
    artifactSets: domain.table('extraction_artifact_sets') as unknown as KvTable<ExtractionArtifactSetId, ExtractionArtifactSetRecord>,
    reprocessOperations: domain.table('reprocess_operations') as unknown as KvTable<ReprocessOperationId, ReprocessOperationRecord>,
    artifacts: domain.table('artifacts') as unknown as KvTable<ArtifactId, ArtifactRecord>,
    events: domain.table('events') as unknown as KvTable<string, StudyEventRecord>,
    dossiers: domain.table('dossiers') as unknown as KvTable<DossierId, DossierRecord>,
    managementFolders: domain.table('management_folders') as unknown as KvTable<string, ManagementFolder>,
    managementGrants: domain.table('management_grants') as unknown as KvTable<string, { readonly sessionId: string; readonly grants: readonly AgentGrant[]; readonly version: number; readonly updatedAt: number; readonly lastAppliedCommandId?: string }>,
    managementCommands: domain.table('management_commands') as unknown as KvTable<string, ManagementCommandRecord>,
    managementDeletionOperations: domain.table('management_deletion_operations') as unknown as KvTable<string, ManagementDeletionOperation>,
    managementProposals: domain.table('management_proposals') as unknown as KvTable<string, ManagementProposal>,
    managementSkills: domain.table('management_skills') as unknown as KvTable<string, StudySkill>,
    managementSourceLocations: domain.table('management_source_locations') as unknown as KvTable<string, SourceLocation>,
    studioPrompts: domain.table('studio_prompts') as unknown as KvTable<string, PromptAssetRecord>,
    studioProfiles: domain.table('studio_profiles') as unknown as KvTable<string, InjectionProfileRecord>,
    studioInjectionBindings: domain.table('studio_injection_bindings') as unknown as KvTable<string, SessionInjectionBinding>,
    studioCommandReceipts: domain.table('studio_command_receipts') as unknown as KvTable<string, InjectionStudioCommandReceipt>,
    studioAssetFolders: domain.table('studio_asset_folders') as unknown as KvTable<string, AssetFolderRecord>,
    studioProviderConnections: domain.table('studio_provider_connections') as unknown as KvTable<string, ProviderConnectionRecord>,
    studioProviderConnectionReceipts: domain.table('studio_provider_connection_receipts') as unknown as KvTable<string, ProviderConnectionCommandReceipt>,
    uploads,
    blobs,
    blobLifecycle: ctx.studyBlobLifecycle,
    documentExtraction: ctx.documentExtraction,
    config: serviceConfig,
    limits: {
      maxArchiveBytes: config.maxArchiveBytes,
      maxUncompressedBytes: config.maxUncompressedBytes,
      maxArchiveEntries: config.maxArchiveEntries,
      maxEntryBytes: config.maxEntryBytes,
    },
    lifecycle: lifecycle.signal,
  })
  service.initializeProviderConnections()

  // Keep DSH's native Skill catalog and direct `/skill` injection, but apply
  // the same Reader Profile/intent policy before either reaches the model.
  // Non-Reader Skills remain wholly owned by their native providers.
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision

    const catalogNames = decision.messages.flatMap(message => {
      const source = readerSkillMessageSource(message)
      if (source.kind !== 'skill-catalog' || !Array.isArray(source.entries)) return []
      return source.entries.flatMap(entry => {
        if (entry === null || typeof entry !== 'object') return []
        const name = (entry as Readonly<Record<string, unknown>>).name
        return typeof name === 'string' ? [name] : []
      })
    })
    const catalogEligibility = await ctx.studyAgent.readerSkillEligibility(agent, catalogNames, signal)

    const messages: UserMessage[] = await filterNativeReaderSkillMessages(
      decision.messages,
      catalogEligibility.deniedReaderNames,
      async name => await ctx.studyAgent.authorizeReaderSkillLoad(agent, name, signal),
    )
    return { kind: 'enter', messages }
  })

  // Apply only an explicitly pinned Profile at the authoritative prompt/tool
  // assembly boundary. Sessions without a binding retain their preset exactly.
  ctx.on('system-prompt/assemble', async (_assembly: PromptAssembly, context, next) => {
    let assembly = await next()
    const sessionId = String(ctx.agents.currentInitiator()?.id ?? '')
    const agent = context.agent
    if (agent === undefined || sessionId === '') {
      assembly.tools = assembly.tools.filter(tool => !READER_TOOL_NAMES.includes(tool.name as never))
      return assembly
    }

    // Inject only the complete catalogue explicitly granted to this
    // conversation. No document text, UI preview selection or reading state is
    // included. Core read-only tools are independent of Skill loading.
    const view = await ctx.studyAgent.readerTurnView(agent, context.signal)
    const contextName = 'study:library-context'
    assembly.contexts = assembly.contexts.filter(item => item.name !== contextName)
    assembly.contexts.push({ name: contextName, text: view.contextAddon })
    const active = new Set(view.activeToolNames)
    assembly.tools = assembly.tools.filter(tool => !READER_TOOL_NAMES.includes(tool.name as never) || active.has(tool.name as never))

    let compiled
    try {
      compiled = await service.compileInjectionProfileForClient({ sessionId })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'INJECTION_PROFILE_REQUIRED') return assembly
      throw error
    }
    return applyCompiledInjection(assembly, compiled, {
      studyToolNames: new Set(STUDY_TOOL_SPECS.map(spec => spec.name)),
    })
  })
  // Register the provider after the local-service disposer effect. Cordis
  // recovers effects in reverse order, so unload first withdraws/drains the
  // Agent-facing provider and only then disposes the concrete StudyService.
  ctx.effect(() => async () => {
    await service.dispose()
  }, 'study: local import jobs')
  ctx.effect(() => {
    const dispose = ctx.skills.registerProvider(control => {
      service.setManagedSkillCatalogInvalidator(control.invalidate)
      return managedProfileSkillProvider(service)
    })
    return () => {
      service.setManagedSkillCatalogInvalidator(undefined)
      dispose()
    }
  }, 'study: profile-managed Skill provider')
  ctx.effect(
    () => ctx.skills.registerProvider(() => bundledReaderSkillProvider()),
    'study: bundled Reader Skill provider',
  )
  ctx.effect(
    () => ctx.studyAgent.registerProvider(createStudyAgentProvider(service)),
    'study: agent capability provider',
  )
  uploads.setOnUploaded((rawImportId, capturePath) =>
    service.completeUploadedFile(rawImportId as ImportId, capturePath))

  const poller = new StudyPoller(ctx, {
    documentExtraction: ctx.documentExtraction,
    imports: domain.table('imports') as unknown as KvTable<ImportId, ImportRecord>,
    artifactSets: domain.table('extraction_artifact_sets') as unknown as KvTable<ExtractionArtifactSetId, ExtractionArtifactSetRecord>,
    revisions: domain.table('revisions') as unknown as KvTable<RevisionId, RevisionRecord>,
    sources: domain.table('sources') as unknown as KvTable<SourceId, SourceRecord>,
    blobs,
    blobLifecycle: ctx.studyBlobLifecycle,
    limits: {
      maxArchiveBytes: config.maxArchiveBytes,
      maxUncompressedBytes: config.maxUncompressedBytes,
      maxArchiveEntries: config.maxArchiveEntries,
      maxEntryBytes: config.maxEntryBytes,
    },
    config: pollerConfig,
    lifecycle: lifecycle.signal,
    assertSourceWritable: sourceId => service.assertSourceDeletionNotAdmitted(sourceId),
    onReady: record => service.grantCompletedImportToInitiator(record),
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: config.uploadRoute,
    handler: uploads.routeHandler(config.maxFileBytes, lifecycle.signal),
  }), 'study.uploadRoute')

  const assets = new StudyAssetServer({
    routePrefix: config.assetRoute,
    sources: domain.table('sources') as unknown as KvTable<SourceId, SourceRecord>,
    revisions: domain.table('revisions') as unknown as KvTable<RevisionId, RevisionRecord>,
    blobs,
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: config.assetRoute,
    handler: assets.routeHandler(),
  }), 'study.assetRoute')

  ctx.effect(() => {
    const stop = poller.start()
    return async () => {
      stop()
      await poller.dispose()
    }
  }, 'study: poller')

  await ctx.studyMemory.waitForConfiguredProvider(lifecycle.signal)
  const selectionMigration = await service.migrateLegacySourceSelections()
  ctx.logger.info(`study: selection migration migrated=${selectionMigration.migrated} skipped=${Object.entries(selectionMigration).filter(([key]) => key !== 'migrated').reduce((sum, [, value]) => sum + value, 0)}`)

  // Re-admit imports stranded mid-flight by a previous process. Local EPUB
  // recovery is independent of the MinerU poller.
  await service.recoverPendingManagementCommands()
  await service.resumeLocalImports()
  void service.resumeArtifactReprocessOperations()
  await poller.resumeNonTerminal()
}
