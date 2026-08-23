/** Deterministic compiler for version-pinned Prompt, Skill, and Tool assets. */
import { createHash } from 'node:crypto'
import { StudyError } from '../protocol/error.ts'
import type {
  CompiledInjection, InjectionProfileRecord, InjectionProfileRevision,
  InjectionSkillDescriptor, InjectionToolDescriptor, PromptAssetRecord,
  PromptRevision,
} from './types.ts'

const MAX_PROMPT_CHARS = 80_000
const FORBIDDEN_LEGACY_PROMPT = /\b(?:ReaderState|BookState|study_reading_context_pack|study_current_context|EPUB\s+CFI)\b|当前阅读位置|自动恢复页码/iu

export interface CompileInjectionInput {
  readonly sessionId: string
  readonly profile: InjectionProfileRecord
  readonly profileVersion: number
  readonly immutableBaseline: string
  readonly prompts: ReadonlyMap<string, PromptAssetRecord>
  readonly skills: ReadonlyMap<string, InjectionSkillDescriptor>
  readonly tools: ReadonlyMap<string, InjectionToolDescriptor>
  readonly now?: number
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
}

function estimateTokens(text: string): number {
  let codePoints = 0
  for (const _codePoint of text) codePoints += 1
  return Math.ceil(codePoints / 3.2)
}

function requireProfileRevision(profile: InjectionProfileRecord, version: number): InjectionProfileRevision {
  const revision = profile.revisions.find(candidate => candidate.version === version)
  if (revision === undefined) throw new StudyError('injection profile revision not found', 'INJECTION_PROFILE_VERSION_NOT_FOUND')
  return revision
}

function requirePromptRevision(asset: PromptAssetRecord, version: number): PromptRevision {
  const revision = asset.revisions.find(candidate => candidate.version === version)
  if (revision === undefined) throw new StudyError('prompt revision not found', 'INJECTION_PROMPT_VERSION_NOT_FOUND')
  if (revision.contentHash !== hash(revision.content)) throw new StudyError('prompt revision hash mismatch', 'INJECTION_PROMPT_HASH_MISMATCH')
  if (FORBIDDEN_LEGACY_PROMPT.test(revision.content)) throw new StudyError('prompt references a removed reader-state capability', 'INJECTION_PROMPT_LEGACY_CAPABILITY')
  return revision
}

export function compileInjection(input: CompileInjectionInput): CompiledInjection {
  if (input.immutableBaseline.trim() === '') throw new StudyError('immutable injection baseline is required', 'INJECTION_BASELINE_REQUIRED')
  if (FORBIDDEN_LEGACY_PROMPT.test(input.immutableBaseline)) throw new StudyError('immutable baseline references a removed reader-state capability', 'INJECTION_PROMPT_LEGACY_CAPABILITY')
  const revision = requireProfileRevision(input.profile, input.profileVersion)
  const duplicatePrompts = new Set<string>()
  const fragments = revision.promptBindings.filter(binding => binding.enabled).map(binding => {
    const identity = binding.promptId
    if (duplicatePrompts.has(identity)) throw new StudyError('prompt revision is bound more than once', 'INJECTION_PROMPT_DUPLICATE')
    duplicatePrompts.add(identity)
    const asset = input.prompts.get(binding.promptId)
    // Archiving prevents new bindings and further edits; it must not invalidate a
    // Profile revision that already pins an immutable Prompt revision.
    if (asset === undefined) throw new StudyError('bound prompt is unavailable', 'INJECTION_PROMPT_UNAVAILABLE')
    return { binding, asset, revision: requirePromptRevision(asset, binding.promptVersion) }
  }).sort((left, right) => left.revision.priority - right.revision.priority || left.binding.order - right.binding.order || left.asset.id.localeCompare(right.asset.id))

  const enabledTools = revision.toolPolicies.filter(policy => policy.enabled).map(policy => {
    const tool = input.tools.get(policy.toolName)
    if (tool === undefined) throw new StudyError(`profile tool is unavailable: ${policy.toolName}`, 'INJECTION_TOOL_UNAVAILABLE')
    if (policy.guidanceAppendix !== undefined && (policy.guidanceAppendix.length > 4_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(policy.guidanceAppendix) || FORBIDDEN_LEGACY_PROMPT.test(policy.guidanceAppendix))) throw new StudyError('tool guidance is invalid', 'INJECTION_TOOL_GUIDANCE_INVALID')
    return { policy, tool }
  }).sort((a, b) => a.tool.name.localeCompare(b.tool.name))
  const enabledToolNames = new Set(enabledTools.map(item => item.tool.name))

  const enabledSkills = revision.skillBindings.filter(binding => binding.enabled).map(binding => {
    const skill = input.skills.get(binding.skillId)
    if (skill === undefined || skill.version !== binding.skillVersion) throw new StudyError(`profile Skill revision is unavailable: ${binding.skillId}@${binding.skillVersion}`, 'INJECTION_SKILL_UNAVAILABLE')
    const missing = skill.requiredTools.filter(tool => !enabledToolNames.has(tool))
    if (missing.length > 0) throw new StudyError(`Skill ${skill.name} requires disabled Tools: ${missing.join(', ')}`, 'INJECTION_SKILL_TOOL_MISSING')
    if (binding.invocation === 'model' || binding.invocation === 'both') {
      if (!skill.modelInvocable) throw new StudyError(`Skill ${skill.name} is not model-invocable`, 'INJECTION_SKILL_INVOCATION_INVALID')
    }
    if (binding.invocation === 'user' || binding.invocation === 'both') {
      if (!skill.userInvocable) throw new StudyError(`Skill ${skill.name} is not user-invocable`, 'INJECTION_SKILL_INVOCATION_INVALID')
    }
    return { binding, skill }
  }).sort((a, b) => a.skill.id.localeCompare(b.skill.id))

  const systemFragments = fragments.map(item => item.revision.content.trim())
  const systemText = [input.immutableBaseline.trim(), ...systemFragments].join('\n\n')
  const skillCatalogText = enabledSkills.map(({ skill, binding }) => [
    `- ${skill.name} (${binding.invocation})`,
    `  ${skill.description}`,
    `  Trigger: ${skill.trigger}`,
    `  Required Tools: ${skill.requiredTools.join(', ') || 'none'}`,
  ].join('\n')).join('\n')
  const toolGuidanceText = enabledTools.map(({ tool, policy }) => `- ${tool.name}: ${tool.description}${policy.guidanceAppendix === undefined ? '' : `\n  ${policy.guidanceAppendix.trim()}`}`).join('\n')
  // Studio compilation must never inject the current document, Source or
  // Revision identifiers. Evidence tools resolve the selected document inside
  // the Host only when the model explicitly calls them.
  // Skill discovery remains DSH-native. The compiled Skill catalog is an
  // inspection artifact only and is never duplicated into model input.
  const allText = [systemText, toolGuidanceText].filter(Boolean).join('\n\n')
  if ([...allText].length > MAX_PROMPT_CHARS) throw new StudyError('compiled injection exceeds the prompt size limit', 'INJECTION_PROMPT_TOO_LARGE')

  const promptFragments = [
    { id: 'study-reader:immutable-baseline', version: 1, layer: 'immutable-system' as const, hash: hash(input.immutableBaseline.trim()) },
    ...fragments.map(item => ({ id: item.asset.id, version: item.revision.version, layer: item.revision.layer, hash: item.revision.contentHash })),
  ]
  const tools = enabledTools.map(({ tool }) => ({ name: tool.name, specVersion: tool.specVersion, schemaHash: tool.schemaHash, enabled: true as const }))
  const skills = enabledSkills.map(({ skill, binding }) => ({ id: skill.id, version: skill.version, invocation: binding.invocation }))
  const promptHash = hash(stableJson({ promptFragments, systemText, toolGuidanceText }))
  const toolSetHash = hash(stableJson(tools))
  return {
    systemText, skillCatalogText, toolGuidanceText,
    diagnostics: [],
    manifest: {
      schemaVersion: 1,
      sessionId: input.sessionId,
      profile: { id: input.profile.id, version: revision.version },
      promptFragments,
      skills,
      tools,
      estimatedTokens: estimateTokens(allText),
      promptHash,
      toolSetHash,
      compiledAt: input.now ?? Date.now(),
    },
  }
}
