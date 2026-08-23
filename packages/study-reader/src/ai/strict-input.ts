import type { DocumentSelector, PassageTarget } from './contracts.ts'

export class ToolInputError extends Error {
  constructor(readonly path: string, message: string) { super(`${path}: ${message}`); this.name = 'ToolInputError' }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function strictObject(value: unknown, path: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ToolInputError(path, '必须是对象')
  const unknown = Object.keys(value).filter(key => !allowedKeys.includes(key))
  if (unknown.length > 0) throw new ToolInputError(path, `包含不允许的字段：${unknown.join(', ')}`)
  return value
}

export function requiredString(object: Record<string, unknown>, key: string, path: string, maximum = 10_000): string {
  const value = object[key]
  if (typeof value !== 'string') throw new ToolInputError(`${path}.${key}`, '必须是字符串')
  const trimmed = value.trim()
  if (trimmed === '') throw new ToolInputError(`${path}.${key}`, '不能为空')
  if (trimmed.length > maximum) throw new ToolInputError(`${path}.${key}`, `长度不能超过 ${maximum}`)
  return trimmed
}

export function optionalString(object: Record<string, unknown>, key: string, path: string, maximum: number): string | undefined {
  return object[key] === undefined ? undefined : requiredString(object, key, path, maximum)
}

export function optionalInteger(object: Record<string, unknown>, key: string, path: string, fallback: number, minimum: number, maximum: number): number {
  const value = object[key]
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new ToolInputError(`${path}.${key}`, `必须是 ${minimum} 到 ${maximum} 之间的整数`)
  return value as number
}

export function requiredLiteral<T extends string>(object: Record<string, unknown>, key: string, path: string, values: readonly T[]): T {
  const value = object[key]
  if (typeof value !== 'string' || !values.includes(value as T)) throw new ToolInputError(`${path}.${key}`, `必须是以下值之一：${values.join(', ')}`)
  return value as T
}

export function parseDocumentSelector(value: unknown, path = 'document'): DocumentSelector {
  const base = strictObject(value, path, ['kind', 'documentRef', 'title'])
  const kind = requiredLiteral(base, 'kind', path, ['document_ref', 'document_title'] as const)
  if (kind === 'document_ref') { const object = strictObject(value, path, ['kind', 'documentRef']); return { kind, documentRef: requiredString(object, 'documentRef', path, 100) } }
  const object = strictObject(value, path, ['kind', 'title'])
  return { kind, title: requiredString(object, 'title', path, 300) }
}

export function parsePassageTarget(value: unknown, path = 'target'): PassageTarget {
  const base = strictObject(value, path, ['kind', 'passageRef', 'document', 'page', 'section'])
  const kind = requiredLiteral(base, 'kind', path, ['passage_ref', 'page', 'section'] as const)
  if (kind === 'passage_ref') { const object = strictObject(value, path, ['kind', 'passageRef']); return { kind, passageRef: requiredString(object, 'passageRef', path, 100) } }
  if (kind === 'page') {
    const object = strictObject(value, path, ['kind', 'document', 'page'])
    if (!Number.isInteger(object.page) || (object.page as number) < 1) throw new ToolInputError(`${path}.page`, '必须是大于等于 1 的整数')
    return { kind, document: parseDocumentSelector(object.document, `${path}.document`), page: object.page as number }
  }
  const object = strictObject(value, path, ['kind', 'document', 'section'])
  return { kind, document: parseDocumentSelector(object.document, `${path}.document`), section: requiredString(object, 'section', path, 500) }
}
