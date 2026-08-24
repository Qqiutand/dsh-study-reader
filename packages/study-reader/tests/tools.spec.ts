import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import * as AgentBroker from '../src/agent/index.ts'
import type { StudyAgentProvider } from '../src/agent/index.ts'
import * as Tools from '../src/tools/index.ts'

class Registry extends Service {
  readonly captured: any[] = []
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(tool: any) { this.captured.push(tool); return () => {} }
}

function currentAgent(): Agent {
  return { id: 'principal-1', session: { events: [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请解释这段材料。' }] } },
  ] } } as unknown as Agent
}

function provider(): StudyAgentProvider {
  return {
    id: 'study',
    schemaVersion: 2,
    createReaderHost: principalId => ({
      capabilities: new Set(['documents.list', 'passages.search', 'passages.read']),
      async getContext() { return { library: { readyCount: 2, processingCount: 0, documents: [{ id: 'source-private', title: 'Book', format: 'pdf', readiness: 'ready' }, { id: 'source-second-private', title: 'Second Book', format: 'epub', readiness: 'ready' }] }, private: { principalId } } },
      async searchPassages() { return { passages: [{ documentId: 'source-private', documentTitle: 'Book', documentFormat: 'pdf', passageId: 'block-private', text: 'Bounded evidence.' }], truncated: false } },
      async readPassage() { return { documentId: 'source-private', documentTitle: 'Book', documentFormat: 'pdf', passageId: 'block-private', text: 'Bounded evidence.' } },
    }),
    readerProfile: () => ({ allowedSkills: [], allowedTools: ['reader_search_passages', 'reader_read_passage'] }),
    resolveReaderSkillId: () => undefined,
  }
}

describe('Reader tools', () => {
  it('registers the six native Reader tools and returns structured public references', async () => {
    const ctx = new Context()
    const registry = new Registry(ctx)
    await ctx.plugin(AgentBroker, { provider: 'study' })
    ctx.studyAgent.registerProvider(provider())
    await ctx.plugin(Tools, {})
    const agent = currentAgent()

    expect(registry.captured.map(tool => tool.name)).toEqual([
      'reader_get_context', 'reader_list_documents', 'reader_get_outline', 'reader_search_passages',
      'reader_read_passage', 'reader_save_note',
    ])
    const getContext = registry.captured.find(tool => tool.name === 'reader_get_context')
    const context = await getContext.execute({}, { agent, signal: new AbortController().signal, concludeTurn: vi.fn() })
    expect(context).toMatchObject({ status: 'success', data: { library: { readyCount: 2, documents: [{ title: 'Book' }, { title: 'Second Book' }] } } })
    expect(JSON.stringify(context)).not.toMatch(/source-private|source-second-private/u)
    const search = registry.captured.find(tool => tool.name === 'reader_search_passages')
    expect(search.description).toContain('scope 单篇直接传')
    expect(search.parameters.properties.scope).toMatchObject({
      description: expect.stringContaining('单篇可直接传'),
      examples: expect.arrayContaining([{ kind: 'document_ref', documentRef: 'doc_1' }]),
    })
    const value = await search.execute(
      { query: 'term', scope: { kind: 'conversation' } },
      { agent, signal: new AbortController().signal, concludeTurn: vi.fn() },
    )
    expect(value).toMatchObject({ status: 'success', data: { results: [{ documentRef: 'doc_1', passageRef: 'passage_1', text: 'Bounded evidence.' }] } })
    expect(JSON.stringify(value)).not.toMatch(/source-private|block-private/u)
    const singleDocument = await search.execute(
      { query: 'single document term', scope: { kind: 'document_ref', documentRef: 'doc_1' } },
      { agent, signal: new AbortController().signal, concludeTurn: vi.fn() },
    )
    expect(singleDocument).toMatchObject({ status: 'success', data: { results: [{ documentRef: 'doc_1' }] } })
    const outline = registry.captured.find(tool => tool.name === 'reader_get_outline')
    const read = registry.captured.find(tool => tool.name === 'reader_read_passage')
    const save = registry.captured.find(tool => tool.name === 'reader_save_note')
    expect(outline.parameters.properties.document.examples).toContainEqual({ kind: 'document_ref', documentRef: 'doc_1' })
    expect(read.parameters.properties.target.examples).toContainEqual({ kind: 'passage_ref', passageRef: 'passage_1' })
    expect(save.parameters.properties.destination).toMatchObject({ const: 'study_space', description: '固定传 study_space。' })
    expect(save.parameters.properties.sourcePassageRefs).toMatchObject({ description: expect.stringContaining('1 到 20'), examples: [['passage_1', 'passage_2']] })
    await ctx.fiber.dispose()
  })
})
