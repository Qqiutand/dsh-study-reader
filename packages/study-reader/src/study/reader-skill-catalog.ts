import type { UserMessage } from '@deepseek-ai/dsh-session'

export function readerSkillMessageSource(message: UserMessage): Readonly<Record<string, unknown>> {
  return message.source as unknown as Readonly<Record<string, unknown>>
}

/** Remove Profile- or intent-denied Reader Skills from one native DSH catalog message. */
export function filterReaderSkillCatalogMessage(
  message: UserMessage,
  denied: ReadonlySet<string>,
): UserMessage {
  const source = readerSkillMessageSource(message)
  if (source.kind !== 'skill-catalog' || !Array.isArray(source.entries) || denied.size === 0) return message
  const entries = source.entries.filter(entry => {
    if (entry === null || typeof entry !== 'object') return true
    const name = (entry as Readonly<Record<string, unknown>>).name
    return typeof name !== 'string' || !denied.has(name)
  })
  const deniedPrefixes = [...denied].map(name => `- \`${name}\`:`)
  return {
    ...message,
    content: message.content.map(block => block.type !== 'text'
      ? block
      : {
          ...block,
          text: block.text
            .split('\n')
            .filter(line => !deniedPrefixes.some(prefix => line.startsWith(prefix)))
            .join('\n'),
        }),
    source: { ...source, entries } as unknown as UserMessage['source'],
  }
}

/** Apply Reader policy to native DSH catalog and direct Skill-invocation messages. */
export async function filterNativeReaderSkillMessages(
  messages: readonly UserMessage[],
  deniedReaderNames: ReadonlySet<string>,
  authorizeLoad: (name: string) => Promise<string | undefined>,
): Promise<UserMessage[]> {
  const accepted: UserMessage[] = []
  for (const message of messages) {
    const source = readerSkillMessageSource(message)
    if (source.kind === 'skill-invocation' && typeof source.name === 'string') {
      const denial = await authorizeLoad(source.name)
      if (denial !== undefined) continue
    }
    accepted.push(filterReaderSkillCatalogMessage(message, deniedReaderNames))
  }
  return accepted
}
