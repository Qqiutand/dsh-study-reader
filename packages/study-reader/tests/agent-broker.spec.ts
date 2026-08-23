import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import * as AgentBroker from '../src/agent/index.ts'
import type { StudyAgentProvider } from '../src/agent/index.ts'

const provider: StudyAgentProvider = {
  id: 'study', schemaVersion: 2,
  createReaderHost: principalId => ({ capabilities: new Set(['passages.search']), async getContext() { return { library: { readyCount: 0, processingCount: 0, documents: [] }, private: { principalId } } } }),
  readerProfile: () => ({ allowedSkills: ['trace-argument'], allowedTools: ['reader_search_passages'] }),
  resolveReaderSkillId: (_principalId, name) => name === 'trace-argument' ? name : undefined,
}

describe('least-authority Reader Agent broker', () => {
  it('exposes the turn-scoped Reader API instead of legacy study operations', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentBroker, { provider: 'study' })
    ctx.studyAgent.registerProvider(provider)
    const agent = { id: 'principal-1', session: { events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请找出这句话的原文。' }] } },
    ] } } as unknown as Agent

    expect(ctx.studyAgent.providerStatus()).toMatchObject({ active: true, schemaVersion: 2 })
    expect(await ctx.studyAgent.readerTurnView(agent)).toMatchObject({ activeToolNames: ['reader_search_passages'] })
    expect(typeof ctx.studyAgent.authorizeReaderSkillLoad).toBe('function')
    expect(typeof ctx.studyAgent.executeReaderTool).toBe('function')
    expect((ctx.studyAgent as any).searchForCurrentInitiator).toBeUndefined()
    expect((ctx.studyAgent as any).currentReadingContextForCurrentInitiator).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
