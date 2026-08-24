/** DSH-native registrations for the six least-authority Reader tools. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { READER_TOOL_NAMES } from '../ai/contracts.ts'
import { createReaderToolSpecs } from '../ai/reader-tools.ts'

export { DEFAULT_STUDY_TOOL_NAMES } from './specs.ts'

export const name = 'tool-study'
export const inject = ['tools', 'studyAgent']
export interface Config {}
export const Config: z<Config> = z.object({})

type SchemaRecord = Readonly<Record<string, unknown>>
const SCHEMA_ANNOTATIONS = ['description', 'title', 'default', 'examples'] as const

function schemaAnnotations(input: SchemaRecord): SchemaRecord {
  return Object.fromEntries(SCHEMA_ANNOTATIONS.flatMap(key => Object.hasOwn(input, key) ? [[key, input[key]]] : []))
}

function valueSpec(node: unknown, required = false): SchemaRecord {
  const input = node !== null && typeof node === 'object' && !Array.isArray(node)
    ? node as Readonly<Record<string, unknown>>
    : {}
  const base = input.oneOf !== undefined
    ? { oneOf: (input.oneOf as readonly unknown[]).map(branch => valueSpec(branch)) }
    : input.type === 'object'
      ? {
          type: 'object',
          additionalProperties: input.additionalProperties === true,
          properties: parameterSpec(input),
        }
      : input.type === 'array'
        ? { type: 'array', ...(input.items === undefined ? {} : { items: valueSpec(input.items) }) }
        : input.const !== undefined
          ? { type: typeof input.const === 'number' ? 'number' : 'string', const: input.const }
          : {
              type: typeof input.type === 'string' && ['string', 'number', 'integer', 'boolean', 'null'].includes(input.type)
                ? input.type
                : 'json',
              ...(Array.isArray(input.enum) ? { enum: input.enum } : {}),
            }
  return { ...base, ...schemaAnnotations(input), ...(required ? { required: true } : {}) }
}

function parameterSpec(root: SchemaRecord): Record<string, SchemaRecord> {
  const properties = root.properties !== null && typeof root.properties === 'object' && !Array.isArray(root.properties)
    ? root.properties as Readonly<Record<string, unknown>>
    : {}
  const required = new Set(Array.isArray(root.required) ? root.required.filter((key): key is string => typeof key === 'string') : [])
  return Object.fromEntries(Object.entries(properties).map(([key, node]) => [key, valueSpec(node, required.has(key))]))
}

const render = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]

export function apply(ctx: Context): void {
  for (const spec of createReaderToolSpecs()) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: parameterSpec(spec.inputSchema) as never,
      output: { schema: { type: 'json' }, render },
      timeoutMs: spec.timeoutMs,
      async execute(args, exec) {
        if (exec.agent === undefined) {
          return { status: 'error', error: { code: 'PERMISSION_DENIED', message: 'Reader Tool 必须由一个 DSH Agent 会话发起', retryable: false } }
        }
        return await ctx.studyAgent.executeReaderTool(exec.agent, spec.name, args, exec.signal) as unknown as JsonValue
      },
      presentCall: () => ({ card: 'generic' as const, title: spec.name, kind: spec.effect === 'read' ? 'read' as const : 'edit' as const }),
    }))
  }

  // The native `skill` tool remains owned by Harness.  We only veto Reader
  // task Skills that are not valid for this exact user turn/Profile.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = await next()
    if (decision.kind !== 'allow' || exec.name !== 'skill' || exec.agent === undefined) return decision
    const input = exec.arguments !== null && typeof exec.arguments === 'object' && !Array.isArray(exec.arguments)
      ? exec.arguments as Record<string, unknown>
      : undefined
    if (typeof input?.name !== 'string') return decision
    const denial = await ctx.studyAgent.authorizeReaderSkillLoad(exec.agent, input.name, exec.signal)
    return denial === undefined ? decision : { kind: 'deny', reason: denial }
  })

  // A direct model call to a Reader name that escaped presentation filtering
  // still reaches the dispatch guard and cannot bypass Skill/Profile policy.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = await next()
    if (decision.kind !== 'allow' || !READER_TOOL_NAMES.includes(exec.name as never)) return decision
    return exec.agent === undefined ? { kind: 'deny', reason: 'Reader Tool requires an Agent session' } : decision
  })
}
