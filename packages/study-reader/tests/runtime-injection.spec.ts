import { describe, expect, it } from 'vitest'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { applyCompiledInjection } from '../src/studio/runtime-injection.ts'
import type { CompiledInjection } from '../src/studio/types.ts'

const compiled: CompiledInjection = {
  systemText: 'Immutable safety baseline.\n\nGround claims in evidence.',
  skillCatalogText: '- Proof reconstruction',
  toolGuidanceText: '- reader_search_passages: locate evidence',
  diagnostics: [],
  manifest: {
    schemaVersion: 1,
    sessionId: 'session-1',
    profile: { id: 'profile-1', version: 2 },
    promptFragments: [], skills: [],
    tools: [{ name: 'reader_search_passages', specVersion: 1, schemaHash: 'hash', enabled: true }],
    estimatedTokens: 10, promptHash: 'prompt-hash', toolSetHash: 'tool-hash', compiledAt: 1,
  },
}

function assembly(): PromptAssembly {
  return {
    sections: [{ name: 'deployment:persona', text: 'Existing persona.' }],
    contexts: [], variables: {},
    tools: [
      { name: 'reader_search_passages', description: 'search', parameters: { type: 'object' } },
      { name: 'reader_read_passage', description: 'read', parameters: { type: 'object' } },
      { name: 'web_search', description: 'web', parameters: { type: 'object' } },
    ],
  }
}

describe('Studio runtime injection', () => {
  it('adds the pinned prompt once and filters only Study tools', () => {
    const result = applyCompiledInjection(assembly(), compiled, {
      studyToolNames: new Set(['reader_search_passages', 'reader_read_passage']),
    })
    expect(result.sections.map(section => section.name)).toEqual(['deployment:persona', 'study:injection-profile'])
    expect(result.sections[1]?.text).toContain('Ground claims in evidence.')
    expect(result.sections[1]?.text).not.toContain('Proof reconstruction')
    expect(result.sections[1]?.text).not.toMatch(/source=|revision=/u)
    expect(result.tools.map(tool => tool.name)).toEqual(['reader_search_passages', 'web_search'])

    applyCompiledInjection(result, compiled, { studyToolNames: new Set(['reader_search_passages', 'reader_read_passage']) })
    expect(result.sections.filter(section => section.name === 'study:injection-profile')).toHaveLength(1)
  })
})
