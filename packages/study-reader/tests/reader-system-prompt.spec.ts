import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeHarnesses, setupStudy } from './helpers.ts'

afterEach(async () => { await disposeHarnesses() })

function turnAgent(skillNames: readonly string[]): Agent {
  return { id: 'reader-turn', session: { events: [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请解释这个概念。' }] } },
    ...skillNames.map(name => ({ type: 'user/message', data: { source: { kind: 'skill-invocation', name }, content: [{ type: 'text', text: `/${name}` }] } })),
  ] } } as unknown as Agent
}

describe('Reader system-prompt assembly', () => {
  it('filters downstream native catalog and direct Skill messages at the real pre-step boundary', async () => {
    const harness = await setupStudy()
    const current = turnAgent([])
    const catalog = {
      id: 'catalog', role: 'user',
      content: [{ type: 'text', text: '<available_skills>\n- `trace-argument`: trace\n- `reconstruct-proof`: proof\n- `unrelated-skill`: other\n</available_skills>' }],
      source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'trace-argument', description: 'trace' }, { name: 'reconstruct-proof', description: 'proof' }, { name: 'unrelated-skill', description: 'other' }] },
    } as unknown as UserMessage
    const deniedBody = {
      id: 'denied-body', role: 'user', content: [{ type: 'text', text: 'proof body' }],
      source: { kind: 'skill-invocation', name: 'reconstruct-proof' },
    } as unknown as UserMessage
    harness.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      return decision.kind === 'reject' ? decision : { kind: 'enter' as const, messages: [...decision.messages, catalog, deniedBody] }
    })

    const decision = await harness.agents.runAs('reader-turn', async () => await agentEvents(harness.ctx, current).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    ))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages.some(message => (message.source as { name?: string }).name === 'reconstruct-proof')).toBe(false)
    const filteredCatalog = decision.messages.find(message => (message.source as { kind?: string }).kind === 'skill-catalog')!
    expect(JSON.stringify(filteredCatalog)).toContain('unrelated-skill')
    expect(JSON.stringify(filteredCatalog)).not.toContain('trace-argument')
    expect(JSON.stringify(filteredCatalog)).not.toContain('reconstruct-proof')
  })

  it('keeps core read schemas visible before and after a specialized Skill loads', async () => {
    const harness = await setupStudy()
    harness.ctx.systemPrompt.tools(() => ({ schemas: [
      { name: 'reader_get_context', description: 'context', parameters: { type: 'object' } },
      { name: 'reader_list_documents', description: 'list', parameters: { type: 'object' } },
      { name: 'reader_get_outline', description: 'outline', parameters: { type: 'object' } },
      { name: 'reader_search_passages', description: 'search', parameters: { type: 'object' } },
      { name: 'reader_read_passage', description: 'read', parameters: { type: 'object' } },
      { name: 'reader_open_location', description: 'open', parameters: { type: 'object' } },
      { name: 'reader_save_note', description: 'save', parameters: { type: 'object' } },
      { name: 'web_search', description: 'web', parameters: { type: 'object' } },
    ] }))

    const before = await harness.agents.runAs('reader-turn', async () => await harness.ctx.systemPrompt.assemble({ agent: turnAgent([]) }))
    expect(before.tools.map(tool => tool.name)).toEqual(['reader_get_context', 'reader_get_outline', 'reader_list_documents', 'reader_read_passage', 'reader_search_passages', 'web_search'])

    const after = await harness.agents.runAs('reader-turn', async () => await harness.ctx.systemPrompt.assemble({ agent: turnAgent(['trace-argument']) }))
    expect(after.tools.map(tool => tool.name)).toEqual(['reader_get_context', 'reader_get_outline', 'reader_list_documents', 'reader_read_passage', 'reader_search_passages', 'web_search'])
    expect(after.contexts.some(item => item.name === 'study:reader-context')).toBe(false)
    expect(after.contexts.map(item => item.text).join('\n')).not.toContain('<study_reader_context>')
    expect(after.contexts.some(item => item.name === 'study:library-context')).toBe(true)
    expect(after.contexts.map(item => item.text).join('\n')).toContain('<study_library_context>')
  })

  it('does not hide core Reader schemas when more than one specialized Skill appears in history', async () => {
    const harness = await setupStudy()
    harness.ctx.systemPrompt.tools(() => ({ schemas: [
      { name: 'reader_search_passages', description: 'search', parameters: { type: 'object' } },
      { name: 'reader_read_passage', description: 'read', parameters: { type: 'object' } },
    ] }))
    const assembly = await harness.agents.runAs('reader-turn', async () => await harness.ctx.systemPrompt.assemble({ agent: turnAgent(['trace-argument', 'reconstruct-proof']) }))
    expect(assembly.tools.map(tool => tool.name)).toEqual(['reader_read_passage', 'reader_search_passages'])
  })
})
