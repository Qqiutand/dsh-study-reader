/** Stable least-authority broker for model-visible Reader operations. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import type { ReaderHost, ToolResult } from '../ai/contracts.ts'
import type { StudyReaderSkillId } from '../ai/skill-catalog.ts'
import {
  ReaderTurnManager,
  type ReaderSkillEligibility,
  type ReaderTurnView,
  type SerializedStudyReaderProfile,
} from '../ai/turn-runtime.ts'
import { StudyError } from '../protocol/error.ts'
import { createStudyReaderHost } from '../study/reader-host.ts'
import type { StudyService } from '../study/study-service.ts'

export interface StudyAgentProvider {
  readonly id: string
  readonly schemaVersion: 2
  createReaderHost(principalId: string): ReaderHost
  readerProfile(principalId: string): SerializedStudyReaderProfile
  resolveReaderSkillId(principalId: string, loadedName: string): StudyReaderSkillId | undefined
}

declare module '@deepseek-ai/cordis' { interface Context { studyAgent: StudyAgentService } }
export interface Config { readonly provider: string }
export const Config: z<Config> = z.object({ provider: z.string().required() })
export const name = 'study-agent'

export class StudyAgentService extends Service {
  private provider: StudyAgentProvider | undefined
  private readonly turns = new ReaderTurnManager({
    createHost: principalId => this.current().createReaderHost(principalId),
    resolveProfile: principalId => Promise.resolve(this.current().readerProfile(principalId)),
    resolveSkillId: (principalId, loadedName) => this.current().resolveReaderSkillId(principalId, loadedName),
  })

  constructor(ctx: Context, private readonly config: Config) { super(ctx, 'studyAgent') }

  registerProvider(provider: StudyAgentProvider): () => Promise<void> {
    this.provider = provider
    return async () => { if (this.provider === provider) this.provider = undefined }
  }

  private current(): StudyAgentProvider {
    if (this.provider === undefined || this.provider.id !== this.config.provider) {
      throw new StudyError(`study Agent provider "${this.config.provider}" is unavailable`, 'STUDY_AGENT_PROVIDER_UNAVAILABLE')
    }
    return this.provider
  }

  providerStatus(): { configured: string; active: boolean; generation: number; inFlight: number; schemaVersion?: number } {
    return {
      configured: this.config.provider,
      active: this.provider?.id === this.config.provider,
      generation: 0,
      inFlight: 0,
      ...(this.provider === undefined ? {} : { schemaVersion: this.provider.schemaVersion }),
    }
  }

  readerTurnView(agent: Agent, signal?: AbortSignal): Promise<ReaderTurnView> {
    this.current()
    return this.turns.view(agent, signal)
  }

  authorizeReaderSkillLoad(agent: Agent, loadedName: string, signal?: AbortSignal): Promise<string | undefined> {
    this.current()
    return this.turns.authorizeSkillLoad(agent, loadedName, signal)
  }

  readerSkillEligibility(agent: Agent, loadedNames: readonly string[], signal?: AbortSignal): Promise<ReaderSkillEligibility> {
    this.current()
    return this.turns.skillEligibility(agent, loadedNames, signal)
  }

  executeReaderTool(agent: Agent, name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult<unknown>> {
    this.current()
    return this.turns.execute(agent, name, input, signal)
  }
}

export function createStudyAgentProvider(service: StudyService): StudyAgentProvider {
  return {
    id: 'study',
    schemaVersion: 2,
    createReaderHost: principalId => createStudyReaderHost(service, principalId),
    readerProfile: principalId => service.readerProfileForPrincipal(principalId),
    resolveReaderSkillId: (principalId, loadedName) => service.resolveReaderSkillIdForPrincipal(principalId, loadedName),
  }
}

export function apply(ctx: Context, config: Config): void { new StudyAgentService(ctx, config) }
