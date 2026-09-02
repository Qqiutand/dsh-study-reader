import type { ReaderCapability, ReaderContextSnapshot, ReaderHost, ReaderToolEffect, ReaderToolName, StudyReaderProfile, ToolResult, TurnAuthorization } from './contracts.ts'
import { toolResult } from './contracts.ts'
import { ResourceResolutionError, TurnResourceMap } from './resource-map.ts'
import { isPlainObject, ToolInputError } from './strict-input.ts'

export interface ToolExecutionContext {
  readonly principalId: string
  readonly host: ReaderHost
  readonly snapshot: ReaderContextSnapshot
  readonly resources: TurnResourceMap
  readonly profile: StudyReaderProfile
  readonly authorization: TurnAuthorization
}

export interface ReaderToolSpec<Input = unknown, Output = unknown> {
  readonly name: ReaderToolName
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly outputSchema: Readonly<Record<string, unknown>>
  readonly effect: ReaderToolEffect
  readonly requiredCapabilities: readonly ReaderCapability[]
  readonly timeoutMs: number
  parseInput(value: unknown): Input
  execute(context: ToolExecutionContext, input: Input, signal: AbortSignal): Promise<ToolResult<Output>>
}
export type AnyReaderToolSpec = ReaderToolSpec<unknown, unknown>

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function searchScope(input: unknown): string | undefined {
  return isPlainObject(input) && isPlainObject(input.scope) ? stableStringify(input.scope) : undefined
}

const FINALIZATION_RESERVE: Readonly<Partial<Record<ReaderToolName, number>>> = {
  reader_read_passage: 2,
  reader_save_note: 1,
}

export class ToolCallGuard {
  private attempts = 0
  private completedCalls = 0
  private readonly signatures = new Set<string>()
  private readonly callsByTool = new Map<ReaderToolName, number>()
  private readonly emptySearchesByScope = new Map<string, number>()

  beginAttempt(profile: StudyReaderProfile): ToolResult<never> | undefined {
    if (profile.toolCallLimit === 'unbounded') return undefined
    this.attempts += 1
    return this.attempts > profile.maxToolAttemptsPerTurn ? toolResult.error('CALL_BUDGET_EXCEEDED', '本轮工具尝试次数已经达到上限') : undefined
  }

  authorize(args: { readonly spec: AnyReaderToolSpec; readonly input: unknown; readonly context: ToolExecutionContext }): ToolResult<never> | undefined {
    const { spec, input, context } = args
    if (!context.profile.allowedTools.has(spec.name)) return toolResult.error('TOOL_NOT_ALLOWED', `当前配置预设不允许调用 ${spec.name}`)
    const missing = spec.requiredCapabilities.find(capability => !context.host.capabilities.has(capability))
    if (missing !== undefined) return toolResult.error('CAPABILITY_UNAVAILABLE', `当前运行时缺少能力：${missing}`)
    if (spec.effect === 'write' && (!context.authorization.persistentWrite || !context.profile.allowPersistentWrites)) return toolResult.error('SIDE_EFFECT_NOT_AUTHORIZED', '用户没有明确授权持久化写入')
    const current = this.callsByTool.get(spec.name) ?? 0
    const signature = `${spec.name}:${stableStringify(input)}`
    if (this.signatures.has(signature)) return toolResult.error('DUPLICATE_CALL', '禁止在同一轮中使用完全相同的参数重复调用工具')
    if (context.profile.toolCallLimit === 'bounded' && spec.name === 'reader_search_passages') {
      const scope = searchScope(input)
      if (scope !== undefined && (this.emptySearchesByScope.get(scope) ?? 0) >= 2) return toolResult.error('SEARCH_STOPPED', '该检索范围已经经历原查询和一次合理改写，必须停止继续检索')
    }
    const maximum = context.profile.maxToolCallsPerTurn
    if (context.profile.toolCallLimit === 'bounded'
      && this.completedCalls >= maximum
      && current >= (FINALIZATION_RESERVE[spec.name] ?? 0)) {
      const message = spec.name === 'reader_read_passage'
        ? '本轮已经完成两次正文读取，请使用已返回的正文作答'
        : spec.name === 'reader_save_note'
          ? '本轮已经执行一次笔记保存，不再重复写入'
          : '本轮 Reader 共享调用预算已经达到上限；正文读取也有保留次数限制。请使用已有目录、检索片段和正文作答，不要继续调用检索等发现工具'
      return toolResult.error('CALL_BUDGET_EXCEEDED', message)
    }
    this.signatures.add(signature); this.completedCalls += 1; this.callsByTool.set(spec.name, current + 1)
    return undefined
  }

  recordResult(toolName: ReaderToolName, input: unknown, result: ToolResult<unknown>): void {
    if (toolName !== 'reader_search_passages' || result.status !== 'empty') return
    const scope = searchScope(input)
    if (scope !== undefined) this.emptySearchesByScope.set(scope, (this.emptySearchesByScope.get(scope) ?? 0) + 1)
  }
}

export class ReaderToolRegistry {
  private readonly tools = new Map<ReaderToolName, AnyReaderToolSpec>()
  constructor(specs: readonly AnyReaderToolSpec[]) {
    for (const spec of specs) { if (this.tools.has(spec.name)) throw new Error(`重复的工具名称：${spec.name}`); this.tools.set(spec.name, spec) }
  }
  get(name: string): AnyReaderToolSpec | undefined { return this.tools.get(name as ReaderToolName) }
  definitions(names: Iterable<ReaderToolName>, profile: StudyReaderProfile, host: ReaderHost): AnyReaderToolSpec[] {
    return [...new Set(names)].map(name => this.tools.get(name)).filter((spec): spec is AnyReaderToolSpec => spec !== undefined && profile.allowedTools.has(spec.name) && spec.requiredCapabilities.every(capability => host.capabilities.has(capability)))
  }
}

export class ReaderToolDispatcher {
  constructor(private readonly registry: ReaderToolRegistry, private readonly guard: ToolCallGuard, private readonly context: ToolExecutionContext) {}

  async execute(name: string, rawInput: unknown, signal: AbortSignal): Promise<ToolResult<unknown>> {
    const attempt = this.guard.beginAttempt(this.context.profile)
    if (attempt !== undefined) return attempt
    const spec = this.registry.get(name)
    if (spec === undefined) return toolResult.error('UNKNOWN_TOOL', `未知工具：${name}`)
    let input: unknown
    try { input = spec.parseInput(rawInput) } catch (error) { return toolResult.error('INVALID_ARGUMENT', error instanceof ToolInputError ? error.message : '工具参数无法解析') }
    const denial = this.guard.authorize({ spec, input, context: this.context })
    if (denial !== undefined) return denial
    const timeout = AbortSignal.timeout(spec.timeoutMs)
    const fused = AbortSignal.any([signal, timeout])
    let result: ToolResult<unknown>
    try { result = await spec.execute(this.context, input, fused) }
    catch (error) {
      if (error instanceof ResourceResolutionError) result = toolResult.error(error.code, error.message, error.retryable)
      else if (signal.aborted) result = toolResult.error('ABORTED', `${name} 已被中止`, true)
      else if (timeout.aborted) result = toolResult.error('TIMEOUT', `${name} 执行超时`, true)
      else result = toolResult.error('HOST_ERROR', `${name} 执行失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
    this.guard.recordResult(spec.name, input, result)
    return result
  }
}
