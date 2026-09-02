/** One-shot command that starts an unbounded Reader task without persistent mode state. */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { READER_UNBOUNDED_USER_SOURCE } from '../ai/reader-unbounded.ts'

export const READER_UNBOUNDED_COMMAND = 'reader-unbounded'

/** Build the command definition separately so its admission behavior is unit-testable. */
export function createReaderUnboundedCommand(): CommandDefinition {
  return {
    name: READER_UNBOUNDED_COMMAND,
    description: 'Run one Reader task without tool-call count limits',
    input: { hint: '<task>' },
    handler: ({ agent, rawInput }) => {
      const task = rawInput.trim()
      if (task === '') {
        return {
          kind: 'error',
          text: 'A task is required. Usage: /reader-unbounded <task>',
        }
      }
      // `followup` guarantees an isolated turn even when the command is
      // submitted while another task is still running.
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: task }],
        source: READER_UNBOUNDED_USER_SOURCE,
      }))
      return {
        kind: 'success',
        text: 'Reader tool-call count limits are disabled for this task only.',
      }
    },
  }
}
