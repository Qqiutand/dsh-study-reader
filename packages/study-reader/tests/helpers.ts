/**
 * Shared test harness: a real Cordis context with the storage hub/domain,
 * the timer, the webserver, a fake MinerU endpoint, the extraction registry
 * and MinerU provider, and the study plugin — all against a temp root.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import { CredentialProvider, type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import * as ExtractionModule from '../lib/types/extraction/index.js'
import * as MineruModule from '../lib/types/mineru/index.js'
import * as MemoryModule from '../lib/types/memory/index.js'
import * as MemoryDurableModule from '../lib/types/memory/durable.js'
import * as StudyAgentModule from '../lib/types/agent/index.js'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StudyModule from '../lib/types/study/index.js'
import * as BlobLifecycleModule from '../lib/types/study/blob-lifecycle.js'
import type { StudyConfig } from '../lib/types/study/index.js'
import { FakeMineruServer, type FakeMineruOptions } from '../../../examples/study-reader/fake-mineru.ts'
import { PDFDocument } from 'pdf-lib'
import type { ImportId, ImportRecord } from '../src/study/types.ts'

/** Create a small valid PDF fixture with the requested page count. */
export async function pdfFixture(pageCount = 3, metadata?: { readonly title?: string; readonly author?: string }): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  if (metadata?.title !== undefined) document.setTitle(metadata.title)
  if (metadata?.author !== undefined) document.setAuthor(metadata.author)
  for (let page = 0; page < pageCount; page += 1) document.addPage([200, 300])
  return await document.save()
}

/** In-memory credential seam for tests. */
export class TestCredentials extends CredentialProvider {
  private readonly values = new Map<string, string>()

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return value === undefined ? undefined : { value, source: 'test' }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: this.values.has(ref), writable: true }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
  }
}

/** Minimal Agent registry that captures plugin-sourced injected messages. */
export interface TestAgent {
  readonly id: string
  readonly session: {
    readonly header: {
      readonly createdAt: number
      readonly cwd?: string
      readonly parentSession?: string
      readonly origin?: 'subagent'
    }
    readonly events: readonly { readonly type: string; readonly data: Record<string, unknown> }[]
    requestHeader(): { config: { provider: string; model: string } }
  }
  inject: (message: UserMessage) => void
  followup: (message: UserMessage) => void
}

export class TestAgents extends Service {
  readonly notices = new Map<string, UserMessage[]>()
  readonly followups = new Map<string, UserMessage[]>()
  private initiatorId: string | undefined
  private readonly sessionEvents = new Map<string, Array<{ type: string; data: Record<string, unknown> }>>()
  private readonly sessionHeaders = new Map<string, TestAgent['session']['header']>()
  private readonly agentObjects = new Map<string, TestAgent>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  currentInitiator(): ReturnType<TestAgents['get']> | undefined {
    return this.initiatorId === undefined ? undefined : this.get(this.initiatorId)
  }

  requireInitiator(): ReturnType<TestAgents['get']> {
    const agent = this.currentInitiator()
    if (agent === undefined) throw new Error('no initiating agent is active')
    return agent
  }

  async runAs<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.initiatorId
    this.initiatorId = id
    try {
      return await operation()
    } finally {
      this.initiatorId = previous
    }
  }

  /** Record the tool call used to bind a cognitive context receipt to one turn. */
  recordToolCall(id: string, callId: ToolCallId, turn: number): void {
    const events = this.sessionEvents.get(id) ?? []
    events.push({ type: 'tool/call', data: { callId, turn } })
    this.sessionEvents.set(id, events)
  }

  /** Configure the live Session identity used by Workspace-scoped behavior. */
  configureSession(id: string, header: TestAgent['session']['header']): void {
    this.sessionHeaders.set(id, header)
    const existing = this.agentObjects.get(id)
    if (existing !== undefined) {
      (existing.session as { header: TestAgent['session']['header'] }).header = header
    }
  }

  get(id: string): TestAgent {
    const existing = this.agentObjects.get(id)
    if (existing !== undefined) return existing
    const events = this.sessionEvents.get(id) ?? []
    this.sessionEvents.set(id, events)
    const agent: TestAgent = {
      id,
      session: {
        header: this.sessionHeaders.get(id) ?? { createdAt: 0, cwd: '/workspace' },
        events,
        requestHeader: () => ({ config: { provider: 'selected-provider', model: 'selected-model' } }),
      },
      inject: (message) => {
        const messages = this.notices.get(id) ?? []
        messages.push(message)
        this.notices.set(id, messages)
      },
      followup: (message) => {
        events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
        const messages = this.followups.get(id) ?? []
        messages.push(message)
        this.followups.set(id, messages)
      },
    }
    this.agentObjects.set(id, agent)
    return agent
  }
}

/** One composed study harness. */
export interface StudyHarness {
  readonly ctx: Context
  readonly credentials: TestCredentials
  readonly agents: TestAgents
  readonly server: FakeMineruServer
  readonly url: string
  readonly root: string
  /** @param removeRoot - whether the temp storage root is deleted (restart tests keep it). */
  dispose(removeRoot?: boolean): Promise<void>
}

const harnesses: StudyHarness[] = []

/** Compose the study stack over the real storage hub/domain/JSON backend. */
export async function setupStudy(
  overrides: Partial<StudyConfig> = {},
  serverOptions: FakeMineruOptions = {},
  rootOverride?: string,
): Promise<StudyHarness> {
  const root = rootOverride ?? await mkdtemp(join(tmpdir(), 'dsh-study-test-'))
  const ctx = new Context()
  try {
    await ctx.plugin(TimerService)
    const agents = new TestAgents(ctx)
    // The CredentialProvider constructor registers itself as `credentials`.
    const credentials = new TestCredentials(ctx)
    credentials.set('MINERU_API_KEY', 'test-key')
    const server = new FakeMineruServer(serverOptions)
    const { url } = await server.start()
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(MemoryModule, { provider: 'durable' })
    await ctx.plugin(MemoryDurableModule, {
      providerId: 'durable',
      residentLimit: 50,
      contextItems: 8,
      contextChars: 4000,
    })
    await ctx.plugin(StudyAgentModule, { provider: 'study' })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, includeRuntimeContext: true, persona: 'Test reading persona.' })
    // Module objects (not bare functions): Cordis reads `inject` off the plugin.
    await ctx.plugin(ExtractionModule, { provider: 'mineru' })
    await ctx.plugin(MineruModule, {
      providerId: 'mineru',
      baseUrl: url,
      apiKeyRef: 'MINERU_API_KEY',
      modelVersion: 'vlm',
      language: 'ch',
      enableTable: true,
      enableFormula: true,
      isOcr: false,
      requestTimeoutMs: 5000,
      maxArtifactBytes: 10 * 1024 * 1024,
    })
    const studyConfig: StudyConfig = {
      storageRoot: join(root, 'study-reader'),
      uploadRoute: '/study-reader/upload',
      uploadTicketTtlMs: 60000,
      maxFileBytes: 1024 * 1024,
      maxArchiveBytes: 10 * 1024 * 1024,
      maxUncompressedBytes: 20 * 1024 * 1024,
      maxArchiveEntries: 1000,
      maxEntryBytes: 5 * 1024 * 1024,
      pollTickMs: 40,
      pollInitialMs: 10,
      pollMaxMs: 200,
      maxConcurrentPolls: 2,
      maxReadChars: 2000,
      maxSearchResults: 10,
      maxGraphNodes: 50,
      maxGraphEdges: 100,
      ...overrides,
    }
    await ctx.plugin(BlobLifecycleModule, { storageRoot: studyConfig.storageRoot })
    await ctx.plugin(StudyModule, studyConfig)
    let runtimeDisposed = false
    let rootRemoved = false
    const harness: StudyHarness = {
      ctx,
      credentials,
      agents,
      server,
      url,
      root,
      dispose: async (removeRoot = true) => {
        if (!runtimeDisposed) {
          runtimeDisposed = true
          await ctx.fiber.dispose()
          await server.close()
        }
        if (removeRoot && !rootRemoved) {
          rootRemoved = true
          await rm(root, { recursive: true, force: true })
        }
      },
    }
    harnesses.push(harness)
    return harness
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

/** Dispose every live harness. */
export async function disposeHarnesses(): Promise<void> {
  await Promise.all(harnesses.splice(0).map(value => value.dispose()))
}

/** Wait until a predicate holds (poller ticks run on real timers). */
export async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('eventually: condition not met within timeout')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Wait for one state while preserving safe durable Import diagnostics on failure. */
export async function eventuallyImportState(
  harness: Pick<StudyHarness, 'ctx'>,
  importId: ImportId,
  expected: ImportRecord['state'],
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const record = harness.ctx.studyBlobLifecycle.domain.table('imports').get(importId) as ImportRecord | undefined
    if (record?.state === expected) return
    if (Date.now() > deadline) {
      const diagnostics = record === undefined ? { importId, missing: true } : {
        importId: record.id, state: record.state, recordVersion: record.recordVersion, nextPollAt: record.nextPollAt,
        progress: record.progress, failure: record.failure,
        provider: record.providerId === undefined ? undefined : { id: record.providerId, jobId: record.providerTask?.id },
        artifactSetId: record.artifactSetId,
        parts: record.providerParts?.map(part => ({ index: part.index, state: part.state, jobId: part.task.id, artifactSetId: part.artifactSetId })),
        transitions: record.appliedTransitionIds,
      }
      throw new Error(`import did not reach ${expected}: ${JSON.stringify(diagnostics)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
