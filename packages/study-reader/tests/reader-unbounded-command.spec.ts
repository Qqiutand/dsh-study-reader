import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { createReaderUnboundedCommand } from '../src/study/reader-unbounded-command.ts'

function invocation(agent: Agent, rawInput: string) {
  return {
    commandId: 'command-test' as never,
    agent,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  }
}

describe('/reader-unbounded', () => {
  it('requires an inline task and does not queue an empty command', async () => {
    const followup = vi.fn()
    const agent = { followup } as unknown as Agent

    const result = await createReaderUnboundedCommand().handler(invocation(agent, '   '))
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('/reader-unbounded <task>') })
    expect(followup).not.toHaveBeenCalled()
  })

  it('queues one ordinary follow-up turn with the trusted marker', async () => {
    const messages: UserMessage[] = []
    const agent = { followup: (message: UserMessage) => messages.push(message) } as unknown as Agent

    const result = await createReaderUnboundedCommand().handler(invocation(agent, '  compare the two proofs  '))
    expect(result).toEqual({
      kind: 'success',
      text: 'Reader tool-call count limits are disabled for this task only.',
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'compare the two proofs' }],
      source: {
        kind: 'user',
        studyReader: { kind: 'reader-unbounded', version: 1 },
      },
    })
  })
})
