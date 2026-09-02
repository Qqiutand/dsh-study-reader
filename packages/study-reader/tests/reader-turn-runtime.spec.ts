import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import type { ReaderHost } from '../src/ai/contracts.ts'
import { READER_UNBOUNDED_USER_SOURCE } from '../src/ai/reader-unbounded.ts'
import { detectTurnIntents } from '../src/ai/skill-catalog.ts'
import { normalizeStudyReaderProfile, ReaderTurnManager } from '../src/ai/turn-runtime.ts'

function agent(events: readonly { readonly type: string; readonly data: unknown }[]): Agent {
  return { id: 'session-principal', session: { events } } as unknown as Agent
}

function userMessage(text: string) {
  return { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

function unboundedUserMessage(text: string) {
  return { type: 'user/message', data: { source: READER_UNBOUNDED_USER_SOURCE, content: [{ type: 'text', text }] } }
}

function skillInvocation(name: string) {
  return { type: 'user/message', data: { source: { kind: 'skill-invocation', name }, content: [{ type: 'text', text: `/${name}` }] } }
}

function host(capabilities: readonly ('documents.list' | 'documents.outline' | 'passages.search' | 'passages.read' | 'notes.save')[] = ['documents.list', 'documents.outline', 'passages.search', 'passages.read']): ReaderHost {
  return {
    capabilities: new Set(capabilities),
    async getContext() {
      return {
        library: {
          readyCount: 2,
          processingCount: 0,
          documents: [
            { id: 'source-secret-1', title: 'First Book', format: 'pdf', readiness: 'ready' },
            { id: 'source-secret-2', title: 'Second Book', format: 'epub', readiness: 'ready' },
          ],
        },
        private: { principalId: 'session-principal' },
      }
    },
  }
}

describe('ReaderTurnManager', () => {
  it('distinguishes content generation from explicit write and library-wide intent', () => {
    expect(detectTurnIntents('帮我把这一章整理成一份笔记').saveNote).toBe(false)
    expect(detectTurnIntents('把上面的总结保存到书房笔记').saveNote).toBe(true)
    expect(detectTurnIntents('条件期望在这一章是什么意思').crossDocument).toBe(false)
    expect(detectTurnIntents('综合书房中多个文档对条件期望的定义').crossDocument).toBe(true)
  })

  it('keeps persistent writes disabled unless both flag and allow-list opt in', () => {
    expect(normalizeStudyReaderProfile().allowedTools.has('reader_save_note')).toBe(false)
    expect(normalizeStudyReaderProfile().allowPersistentWrites).toBe(false)
    const enabled = normalizeStudyReaderProfile({
      allowedTools: ['reader_read_passage', 'reader_save_note'], allowPersistentWrites: true,
    })
    expect(enabled.allowedTools.has('reader_save_note')).toBe(true)
    expect(enabled.allowPersistentWrites).toBe(true)
  })

  it('leaves enough malformed-call headroom for final evidence retrieval', () => {
    expect(normalizeStudyReaderProfile()).toMatchObject({
      toolCallLimit: 'bounded',
      maxToolCallsPerTurn: 6,
      maxToolAttemptsPerTurn: 15,
    })
  })

  it('applies the unbounded policy and runtime guidance only to the command task turn', async () => {
    const events: Array<{ type: string; data: unknown }> = [
      { type: 'turn/start', data: { turn: 1 } },
      unboundedUserMessage('跨多本文献完成一次系统梳理。'),
    ]
    const current = agent(events)
    const manager = new ReaderTurnManager({
      createHost: () => host(),
      resolveProfile: async () => ({ maxToolCallsPerTurn: 2, maxToolAttemptsPerTurn: 3 }),
      resolveSkillId: () => undefined,
    })

    const commandTurn = await manager.view(current)
    expect(commandTurn.toolCallLimit).toBe('unbounded')
    expect(commandTurn.contextAddon).toContain('/reader-unbounded')
    expect(commandTurn.contextAddon).toContain('完全相同参数的重复调用限制仍然生效')

    events.push(
      { type: 'turn/end', data: { turn: 1 } },
      { type: 'turn/start', data: { turn: 2 } },
      userMessage('普通问题。'),
    )
    const nextTurn = await manager.view(current)
    expect(nextTurn.toolCallLimit).toBe('bounded')
    expect(nextTurn.contextAddon).not.toContain('/reader-unbounded')
  })

  it('rebuilds a provisional pre-step view when the command task message is committed', async () => {
    const events: Array<{ type: string; data: unknown }> = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
    ]
    const current = agent(events)
    const manager = new ReaderTurnManager({
      createHost: () => host(),
      resolveProfile: async () => ({ maxToolCallsPerTurn: 2, maxToolAttemptsPerTurn: 3 }),
      resolveSkillId: () => undefined,
    })

    const provisional = await manager.view(current)
    expect(provisional.toolCallLimit).toBe('bounded')
    expect(provisional.contextAddon).not.toContain('/reader-unbounded')

    // This is the real DSH ordering: pre-step consumers may run before the
    // inbox message is durably appended to the already-open turn.
    events.push(unboundedUserMessage('完整阅读并综合这些文献。'))

    const admitted = await manager.view(current)
    expect(admitted.toolCallLimit).toBe('unbounded')
    expect(admitted.contextAddon).toContain('/reader-unbounded')
  })

  it('keeps all core read tools visible and injects every conversation document without private ids', async () => {
    const current = agent([
      { type: 'turn/start', data: { turn: 1 } },
      userMessage('请重建这个定理的证明。'),
      skillInvocation('reconstruct-proof'),
    ])
    const manager = new ReaderTurnManager({
      createHost: () => host(),
      resolveProfile: async () => ({ allowedSkills: ['reconstruct-proof'], allowedTools: ['reader_search_passages', 'reader_read_passage'] }),
      resolveSkillId: (_principal, name) => name === 'reconstruct-proof' ? name : undefined,
    })

    const view = await manager.view(current)

    expect(view.activeSkillId).toBe('reconstruct-proof')
    expect(view.activeToolNames).toEqual(['reader_get_context', 'reader_list_documents', 'reader_get_outline', 'reader_search_passages', 'reader_read_passage'])
    expect(view.contextAddon).toContain('First Book')
    expect(view.contextAddon).toContain('Second Book')
    expect(view.contextAddon).not.toContain('source-secret')
  })

  it('does not activate an explicit Skill denied by the Profile or the turn intent', async () => {
    const noProofIntent = agent([
      { type: 'turn/start', data: { turn: 2 } },
      userMessage('请解释这个概念。'),
      skillInvocation('reconstruct-proof'),
    ])
    const manager = new ReaderTurnManager({
      createHost: () => host(),
      resolveProfile: async () => ({ allowedSkills: ['reconstruct-proof'], allowedTools: ['reader_search_passages', 'reader_read_passage'] }),
      resolveSkillId: (_principal, name) => name === 'reconstruct-proof' ? name : undefined,
    })

    expect((await manager.view(noProofIntent)).activeToolNames).toEqual(['reader_get_context', 'reader_list_documents', 'reader_get_outline', 'reader_search_passages', 'reader_read_passage'])
  })

  it('rejects loading a second Reader Skill in one turn', async () => {
    const events = [
      { type: 'turn/start', data: { turn: 3 } },
      userMessage('请综合多个文档并重建证明。'),
      skillInvocation('reconstruct-proof'),
    ]
    const current = agent(events)
    const manager = new ReaderTurnManager({
      createHost: () => host(),
      resolveProfile: async () => ({ allowedSkills: ['reconstruct-proof', 'synthesize-sources'], allowedTools: ['reader_search_passages', 'reader_read_passage', 'reader_get_outline'] }),
      resolveSkillId: (_principal, name) => name === 'reconstruct-proof' || name === 'synthesize-sources' ? name : undefined,
    })

    await expect(manager.authorizeSkillLoad(current, 'synthesize-sources')).resolves.toContain('本轮已经选择 Skill reconstruct-proof')
  })

  it('filters Reader Skill discovery with the same Profile and intent policy without selecting one', async () => {
    const current = agent([
      { type: 'turn/start', data: { turn: 4 } },
      userMessage('请重建这个定理的证明。'),
    ])
    const manager = new ReaderTurnManager({
      createHost: () => host(),
      resolveProfile: async () => ({ allowedSkills: ['trace-argument', 'reconstruct-proof'], allowedTools: ['reader_search_passages', 'reader_read_passage'] }),
      resolveSkillId: (_principal, name) => name === 'trace-argument' || name === 'reconstruct-proof' ? name : undefined,
    })

    const eligibility = await manager.skillEligibility(current, ['trace-argument', 'reconstruct-proof', 'unrelated-skill'])

    expect([...eligibility.allowedNames]).toEqual(['reconstruct-proof', 'unrelated-skill'])
    expect([...eligibility.deniedReaderNames]).toEqual(['trace-argument'])
    await expect(manager.authorizeSkillLoad(current, 'reconstruct-proof')).resolves.toBeUndefined()
  })
})
