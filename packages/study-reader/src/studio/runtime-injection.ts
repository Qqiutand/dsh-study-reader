/** Apply one compiled, version-pinned Studio profile to the authoritative model input. */
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { CompiledInjection } from './types.ts'

export interface RuntimeInjectionOptions {
  readonly studyToolNames: ReadonlySet<string>
  readonly sectionName?: string
}

/**
 * Mutates the post-waterfall assembly exactly once. Non-Study tools are never
 * affected; Study tools are reduced to the profile's explicit allow-list.
 */
export function applyCompiledInjection(
  assembly: PromptAssembly,
  compiled: CompiledInjection,
  options: RuntimeInjectionOptions,
): PromptAssembly {
  const text = [
    compiled.systemText,
    compiled.toolGuidanceText,
  ].filter(value => value.trim() !== '').join('\n\n')
  const sectionName = options.sectionName ?? 'study:injection-profile'
  assembly.sections = assembly.sections.filter(section => section.name !== sectionName)
  if (text !== '') assembly.sections.push({ name: sectionName, text })

  const enabled = new Set(compiled.manifest.tools.map(tool => tool.name))
  assembly.tools = assembly.tools.filter(tool => !options.studyToolNames.has(tool.name) || enabled.has(tool.name))
  return assembly
}
