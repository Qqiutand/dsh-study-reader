import type { UserMessage } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { filterNativeReaderSkillMessages, filterReaderSkillCatalogMessage } from '../src/study/reader-skill-catalog.ts'

describe('Reader native Skill catalog filtering', () => {
  it('removes only denied Reader entries from both native metadata and model text', () => {
    const message = {
      id: 'catalog-1', role: 'user',
      content: [{ type: 'text', text: '<available_skills>\n- `trace-argument`: trace\n- `reconstruct-proof`: proof\n- `unrelated-skill`: other\n</available_skills>' }],
      source: {
        kind: 'skill-catalog', form: 'catalog',
        entries: [
          { name: 'trace-argument', description: 'trace' },
          { name: 'reconstruct-proof', description: 'proof' },
          { name: 'unrelated-skill', description: 'other' },
        ],
      },
    } as unknown as UserMessage

    const filtered = filterReaderSkillCatalogMessage(message, new Set(['reconstruct-proof']))
    const source = filtered.source as unknown as { readonly entries: readonly { readonly name: string }[] }

    expect(source.entries.map(entry => entry.name)).toEqual(['trace-argument', 'unrelated-skill'])
    expect((filtered.content[0] as { readonly text: string }).text).not.toContain('reconstruct-proof')
    expect((filtered.content[0] as { readonly text: string }).text).toContain('unrelated-skill')
  })

  it('drops a denied native direct Reader Skill body without touching unrelated Skills', async () => {
    const readerBody = {
      id: 'reader-body', role: 'user', content: [{ type: 'text', text: 'private Reader instructions' }],
      source: { kind: 'skill-invocation', name: 'reconstruct-proof' },
    } as unknown as UserMessage
    const unrelatedBody = {
      id: 'other-body', role: 'user', content: [{ type: 'text', text: 'unrelated instructions' }],
      source: { kind: 'skill-invocation', name: 'unrelated-skill' },
    } as unknown as UserMessage

    const filtered = await filterNativeReaderSkillMessages(
      [readerBody, unrelatedBody],
      new Set(['reconstruct-proof']),
      async name => name === 'reconstruct-proof' ? 'denied' : undefined,
    )

    expect(filtered).toEqual([unrelatedBody])
  })
})
