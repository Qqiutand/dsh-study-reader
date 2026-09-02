/** Trusted, turn-local marker used by the `/reader-unbounded` command. */

const READER_UNBOUNDED_MARKER = Object.freeze({
  kind: 'reader-unbounded' as const,
  version: 1 as const,
})

/**
 * A direct user source carrying plugin-owned Reader execution metadata.
 *
 * Keeping `kind: 'user'` preserves the ordinary user-message presentation in
 * Harness. The extra field is authored only by the registered command; text
 * from a document or prompt cannot manufacture message-source metadata.
 */
export const READER_UNBOUNDED_USER_SOURCE = Object.freeze({
  kind: 'user' as const,
  studyReader: READER_UNBOUNDED_MARKER,
})

/** Short, trusted runtime guidance attached only to the command's task turn. */
export const READER_UNBOUNDED_CONTEXT_ADDON = [
  '本次请求由 /reader-unbounded 发起：Reader 工具调用次数不设上限，可按任务需要继续检索和读取，并在证据充分后停止。',
  '文献访问权限、持久写入授权、单次工具超时和完全相同参数的重复调用限制仍然生效。',
].join('\n')

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

/** Whether one logged user message was admitted by `/reader-unbounded`. */
export function isReaderUnboundedUserMessage(data: unknown): boolean {
  const source = plainRecord(plainRecord(data)?.source)
  const marker = plainRecord(source?.studyReader)
  return source?.kind === 'user'
    && marker?.kind === READER_UNBOUNDED_MARKER.kind
    && marker.version === READER_UNBOUNDED_MARKER.version
}
