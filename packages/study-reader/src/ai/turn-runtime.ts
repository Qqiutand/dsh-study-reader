/** Per-turn Reader policy state derived from the authoritative DSH session log. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolResult } from './contracts.ts'
import {
  CORE_READER_TOOL_NAMES,
  READER_TOOL_NAMES,
  type ReaderHost,
  type ReaderToolName,
  type StudyReaderProfile,
} from './contracts.ts'
import { buildLibraryContextAddon } from './library-context.ts'
import { isReaderUnboundedUserMessage, READER_UNBOUNDED_CONTEXT_ADDON } from './reader-unbounded.ts'
import { createReaderToolSpecs } from './reader-tools.ts'
import { TurnResourceMap } from './resource-map.ts'
import {
  detectTurnIntents,
  STUDY_READER_SKILL_IDS,
  skillAllowedForTurn,
  skillManifest,
  type StudyReaderSkillId,
} from './skill-catalog.ts'
import { ReaderToolDispatcher, ReaderToolRegistry, ToolCallGuard } from './tool-runtime.ts'

export interface SerializedStudyReaderProfile {
  readonly allowedSkills?: readonly StudyReaderSkillId[]
  readonly allowedTools?: readonly ReaderToolName[]
  readonly allowLibraryWideSearch?: boolean
  readonly allowPersistentWrites?: boolean
  /** Shared discovery budget. Final evidence reads and an authorized save have separate reserves. */
  readonly maxToolCallsPerTurn?: number
  readonly maxToolAttemptsPerTurn?: number
}

const DEFAULT_PROFILE_TOOLS: readonly ReaderToolName[] = [...CORE_READER_TOOL_NAMES]

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value as number)) : fallback
}

export function normalizeStudyReaderProfile(input: SerializedStudyReaderProfile = {}): StudyReaderProfile {
  const configuredTools = (input.allowedTools ?? DEFAULT_PROFILE_TOOLS).filter(
    (name): name is ReaderToolName => READER_TOOL_NAMES.includes(name),
  )
  const allowedTools = new Set<ReaderToolName>([...CORE_READER_TOOL_NAMES, ...configuredTools])
  if (input.allowPersistentWrites !== true) allowedTools.delete('reader_save_note')
  return {
    allowedSkills: new Set(input.allowedSkills ?? STUDY_READER_SKILL_IDS),
    allowedTools,
    allowLibraryWideSearch: input.allowLibraryWideSearch ?? true,
    allowPersistentWrites: input.allowPersistentWrites ?? false,
    toolCallLimit: 'bounded',
    maxToolCallsPerTurn: boundedInteger(input.maxToolCallsPerTurn, 6, 1, 10),
    maxToolAttemptsPerTurn: boundedInteger(input.maxToolAttemptsPerTurn, 15, 1, 15),
  }
}

interface SessionLikeEvent {
  readonly type: string
  readonly data: unknown
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function currentTurnSlice(agent: Agent): { readonly turn: number; readonly events: readonly SessionLikeEvent[] } | undefined {
  const events = agent.session.events as readonly SessionLikeEvent[]
  let start = -1
  let turn: number | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/start') continue
    const candidate = plainRecord(event.data)?.turn
    if (typeof candidate !== 'number') return undefined
    start = index
    turn = candidate
    break
  }
  return start < 0 || turn === undefined ? undefined : { turn, events: events.slice(start) }
}

function messageText(data: unknown): string {
  const content = plainRecord(data)?.content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    const record = plainRecord(block)
    return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : []
  }).join('\n')
}

function directUserText(events: readonly SessionLikeEvent[]): string {
  return events.flatMap(event => {
    if (event.type !== 'user/message') return []
    const source = plainRecord(plainRecord(event.data)?.source)
    return source?.kind === 'user' ? [messageText(event.data)] : []
  }).filter(Boolean).join('\n')
}

function hasDirectUserRequest(events: readonly SessionLikeEvent[]): boolean {
  return events.some(event => {
    if (event.type !== 'user/message') return false
    return plainRecord(plainRecord(event.data)?.source)?.kind === 'user'
  })
}

function hasReaderUnboundedRequest(events: readonly SessionLikeEvent[]): boolean {
  return events.some(event => event.type === 'user/message' && isReaderUnboundedUserMessage(event.data))
}

function explicitSkillNames(events: readonly SessionLikeEvent[]): string[] {
  return events.flatMap(event => {
    if (event.type !== 'user/message') return []
    const source = plainRecord(plainRecord(event.data)?.source)
    return source?.kind === 'skill-invocation' && typeof source.name === 'string' ? [source.name] : []
  })
}

function successfulSkillToolNames(events: readonly SessionLikeEvent[]): string[] {
  const calls = new Map<string, string>()
  const successful = new Set<string>()
  for (const event of events) {
    const data = plainRecord(event.data)
    if (event.type === 'tool/call' && data?.name === 'skill' && typeof data.callId === 'string' && typeof data.arguments === 'string') {
      try {
        const args = plainRecord(JSON.parse(data.arguments))
        if (typeof args?.name === 'string') calls.set(data.callId, args.name)
      } catch {
        // An invalid native Skill call is not an activation.
      }
      continue
    }
    if (event.type !== 'tool/result') continue
    const message = plainRecord(data?.message)
    const source = plainRecord(message?.source)
    const block = Array.isArray(message?.content) ? plainRecord(message.content[0]) : undefined
    if (source?.kind !== 'tool' || typeof source.callId !== 'string' || block?.isError === true) continue
    if (calls.has(source.callId)) successful.add(calls.get(source.callId)!)
  }
  return [...successful]
}

export interface ReaderTurnDependencies {
  readonly createHost: (principalId: string) => ReaderHost
  readonly resolveProfile: (principalId: string) => Promise<SerializedStudyReaderProfile>
  /** Map either a filesystem Skill name or a Profile-managed registry alias to a task Skill id. */
  readonly resolveSkillId: (principalId: string, loadedName: string) => StudyReaderSkillId | undefined
}

interface ReaderTurnState {
  readonly turn: number
  readonly principalId: string
  readonly userText: string
  readonly host: ReaderHost
  readonly profile: StudyReaderProfile
  readonly contextAddon: string
  readonly dispatcher: ReaderToolDispatcher
  approvedSkillId?: StudyReaderSkillId
}

export interface ReaderTurnView {
  readonly contextAddon: string
  readonly toolCallLimit: StudyReaderProfile['toolCallLimit']
  readonly activeSkillId?: StudyReaderSkillId
  readonly activeToolNames: readonly ReaderToolName[]
}

export interface ReaderSkillEligibility {
  /** Names that are not Reader task Skills are left to their owning provider. */
  readonly allowedNames: ReadonlySet<string>
  /** Reader task Skill names rejected by the current Profile, intent, or Host capabilities. */
  readonly deniedReaderNames: ReadonlySet<string>
}

export class ReaderTurnManager {
  private readonly states = new WeakMap<Agent, Promise<ReaderTurnState>>()
  private readonly stateTurns = new WeakMap<Agent, number>()
  private readonly stateHasDirectUserRequest = new WeakMap<Agent, boolean>()
  private readonly registry = new ReaderToolRegistry(createReaderToolSpecs())

  constructor(private readonly dependencies: ReaderTurnDependencies) {}

  private loadedSkillIds(agent: Agent, state: ReaderTurnState): StudyReaderSkillId[] {
    const turn = currentTurnSlice(agent)
    if (turn?.turn !== state.turn) return []
    const names = [...explicitSkillNames(turn.events), ...successfulSkillToolNames(turn.events)]
    return [...new Set(names.flatMap(name => {
      const resolved = this.dependencies.resolveSkillId(state.principalId, name)
      return resolved === undefined ? [] : [resolved]
    }))]
  }

  private activeSkill(agent: Agent, state: ReaderTurnState): StudyReaderSkillId | undefined {
    const loaded = this.loadedSkillIds(agent, state)
    if (loaded.length !== 1) return undefined
    const requested = loaded[0]
    if (requested === undefined || !state.profile.allowedSkills.has(requested)) return undefined
    const manifest = skillManifest(requested)
    if (manifest === undefined) return undefined
    const intents = detectTurnIntents(state.userText)
    return skillAllowedForTurn(manifest, intents, state.host, state.profile) ? requested : undefined
  }

  private async createState(agent: Agent, turn: number, events: readonly SessionLikeEvent[], signal?: AbortSignal): Promise<ReaderTurnState> {
    const principalId = String(agent.id)
    const host = this.dependencies.createHost(principalId)
    const configuredProfile = normalizeStudyReaderProfile(await this.dependencies.resolveProfile(principalId))
    const unbounded = hasReaderUnboundedRequest(events)
    const profile: StudyReaderProfile = unbounded
      ? { ...configuredProfile, toolCallLimit: 'unbounded' }
      : configuredProfile
    const userText = directUserText(events)
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', abort, { once: true })
    try {
      const snapshot = await host.getContext({ principalId, signal: controller.signal })
      if (snapshot.private.principalId !== principalId) throw new Error('ReaderHost returned context for another principal')
      const resources = new TurnResourceMap()
      const guard = new ToolCallGuard()
      const authorization = detectTurnIntents(userText)
      const dispatcher = new ReaderToolDispatcher(
        this.registry,
        guard,
        {
          principalId,
          host,
          snapshot,
          resources,
          profile,
          authorization: {
            persistentWrite: authorization.saveNote,
          },
        },
      )
      const state: ReaderTurnState = {
        turn,
        principalId,
        userText,
        host,
        profile,
        contextAddon: [
          buildLibraryContextAddon(snapshot.library),
          ...(unbounded ? [READER_UNBOUNDED_CONTEXT_ADDON] : []),
        ].join('\n\n'),
        dispatcher,
      }
      return state
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  private state(agent: Agent, signal?: AbortSignal): Promise<ReaderTurnState> {
    const slice = currentTurnSlice(agent)
    if (slice === undefined) throw new Error('Reader runtime requires an open DSH turn')
    const existing = this.states.get(agent)
    const hasDirectRequest = hasDirectUserRequest(slice.events)
    if (existing !== undefined && this.stateTurns.get(agent) === slice.turn) {
      // DSH may ask pre-step providers for Skill eligibility after turn/start
      // but before it commits the inbox user/message. That first view is only
      // provisional: rebuild it once the direct request arrives so command
      // metadata and user intent participate in the authoritative prompt and
      // Tool policy. Never rebuild a state that has already admitted a direct
      // request, because doing so could reset its ToolCallGuard mid-turn.
      if (this.stateHasDirectUserRequest.get(agent) === true || !hasDirectRequest) return existing
    }
    const created = this.createState(agent, slice.turn, slice.events, signal)
    this.states.set(agent, created)
    this.stateTurns.set(agent, slice.turn)
    this.stateHasDirectUserRequest.set(agent, hasDirectRequest)
    return created
  }

  async view(agent: Agent, signal?: AbortSignal): Promise<ReaderTurnView> {
    const state = await this.state(agent, signal)
    const activeSkillId = this.activeSkill(agent, state)
    const intents = detectTurnIntents(state.userText)
    const requestedTools: ReaderToolName[] = [
      ...CORE_READER_TOOL_NAMES,
      ...(intents.saveNote ? ['reader_save_note' as const] : []),
    ]
    const activeToolNames = this.registry.definitions(requestedTools, state.profile, state.host).map(tool => tool.name)
    return {
      contextAddon: state.contextAddon,
      toolCallLimit: state.profile.toolCallLimit,
      ...(activeSkillId === undefined ? {} : { activeSkillId }),
      activeToolNames,
    }
  }

  async authorizeSkillLoad(agent: Agent, loadedName: string, signal?: AbortSignal): Promise<string | undefined> {
    const state = await this.state(agent, signal)
    const requested = this.dependencies.resolveSkillId(state.principalId, loadedName)
    if (requested === undefined) return undefined
    const manifest = skillManifest(requested)
    if (manifest === undefined) return `未知阅读 Skill：${loadedName}`
    const intents = detectTurnIntents(state.userText)
    if (!state.profile.allowedSkills.has(requested)) return `当前配置预设没有启用 Skill：${requested}`
    if (!skillAllowedForTurn(manifest, intents, state.host, state.profile)) return `当前用户请求或配置预设不允许加载 Skill：${requested}`
    const alreadyLoaded = this.loadedSkillIds(agent, state)
    const existing = alreadyLoaded[0] ?? state.approvedSkillId
    if (existing !== undefined && existing !== requested) return `本轮已经选择 Skill ${existing}，不能再加载 ${requested}`
    if (alreadyLoaded.length > 1) return '本轮存在多个阅读 Skill，已拒绝继续调用'
    state.approvedSkillId = requested
    return undefined
  }

  /** Filter discovery without selecting a Skill or consuming the one-Skill allowance. */
  async skillEligibility(agent: Agent, loadedNames: readonly string[], signal?: AbortSignal): Promise<ReaderSkillEligibility> {
    const state = await this.state(agent, signal)
    const intents = detectTurnIntents(state.userText)
    const allowedNames = new Set<string>()
    const deniedReaderNames = new Set<string>()
    for (const loadedName of loadedNames) {
      const requested = this.dependencies.resolveSkillId(state.principalId, loadedName)
      if (requested === undefined) {
        allowedNames.add(loadedName)
        continue
      }
      const manifest = skillManifest(requested)
      if (manifest !== undefined && state.profile.allowedSkills.has(requested)
        && skillAllowedForTurn(manifest, intents, state.host, state.profile)) {
        allowedNames.add(loadedName)
      } else {
        deniedReaderNames.add(loadedName)
      }
    }
    return { allowedNames, deniedReaderNames }
  }

  async execute(agent: Agent, toolName: string, input: unknown, signal?: AbortSignal): Promise<ToolResult<unknown>> {
    const state = await this.state(agent, signal)
    return await state.dispatcher.execute(toolName, input, signal ?? new AbortController().signal)
  }
}
