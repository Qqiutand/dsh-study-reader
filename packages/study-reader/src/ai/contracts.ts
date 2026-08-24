/** Least-authority contracts for the model-facing Study Reader runtime. */

export const READER_TOOL_NAMES = [
  'reader_get_context',
  'reader_list_documents',
  'reader_get_outline',
  'reader_search_passages',
  'reader_read_passage',
  'reader_save_note',
] as const

export const CORE_READER_TOOL_NAMES = [
  'reader_get_context',
  'reader_list_documents',
  'reader_get_outline',
  'reader_search_passages',
  'reader_read_passage',
] as const satisfies readonly ReaderToolName[]

export type ReaderToolName = typeof READER_TOOL_NAMES[number]
export type ReaderCapability =
  | 'documents.list'
  | 'documents.outline'
  | 'passages.search'
  | 'passages.read'
  | 'notes.save'
export type ReaderToolEffect = 'read' | 'write'
export type ReaderDocumentFormat = 'pdf' | 'epub' | 'markdown' | 'text' | 'html' | 'other'
export type ReaderDocumentReadiness = 'ready' | 'loading' | 'indexing' | 'failed' | 'unknown'

export interface HumanLocation {
  readonly label: string
  readonly page?: number
  readonly chapter?: string
  readonly section?: string
  readonly paragraph?: number
  readonly progress?: number
}

export type HostAnchor =
  | { readonly kind: 'passage'; readonly passageId: string }
  | { readonly kind: 'page'; readonly page: number }
  | { readonly kind: 'section'; readonly section: string }

/** Host-only caller state. It must never be assembled into a prompt. */
export interface ReaderPrivateContext {
  readonly principalId: string
}

/** All documents explicitly made available to this conversation. */
export interface ReaderLibraryContext {
  readonly readyCount: number
  readonly processingCount: number
  readonly documents: readonly HostDocument[]
}

export interface ReaderContextSnapshot {
  readonly library: ReaderLibraryContext
  readonly private: ReaderPrivateContext
}

export type DocumentSelector =
  | { readonly kind: 'document_ref'; readonly documentRef: string }
  | { readonly kind: 'document_title'; readonly title: string }

export type PassageTarget =
  | { readonly kind: 'passage_ref'; readonly passageRef: string }
  | { readonly kind: 'page'; readonly document: DocumentSelector; readonly page: number }
  | { readonly kind: 'section'; readonly document: DocumentSelector; readonly section: string }

export interface HostDocument {
  readonly id: string
  readonly title: string
  readonly format: ReaderDocumentFormat
  readonly readiness: ReaderDocumentReadiness
  readonly location?: HumanLocation
}

export interface HostOutlineNode {
  readonly title: string
  readonly level: number
  readonly location?: HumanLocation
  readonly children?: readonly HostOutlineNode[]
}

export interface HostPassage {
  readonly documentId: string
  readonly documentTitle: string
  readonly documentFormat?: ReaderDocumentFormat
  readonly passageId: string
  readonly text: string
  readonly location?: HumanLocation
  readonly score?: number
}

export interface ReaderHost {
  readonly capabilities: ReadonlySet<ReaderCapability>
  getContext(args: { readonly principalId: string; readonly signal: AbortSignal }): Promise<ReaderContextSnapshot>
  listDocuments?(args: { readonly principalId: string; readonly query?: string; readonly limit: number; readonly signal: AbortSignal }): Promise<readonly HostDocument[]>
  getOutline?(args: { readonly principalId: string; readonly documentId: string; readonly maxDepth: number; readonly signal: AbortSignal }): Promise<readonly HostOutlineNode[]>
  searchPassages?(args: { readonly principalId: string; readonly query: string; readonly documentIds?: readonly string[]; readonly limit: number; readonly signal: AbortSignal }): Promise<{ readonly passages: readonly HostPassage[]; readonly truncated: boolean; readonly warnings?: readonly string[] }>
  readPassage?(args: { readonly principalId: string; readonly documentId: string; readonly anchor: HostAnchor; readonly window: number; readonly signal: AbortSignal }): Promise<{ readonly documentId: string; readonly documentTitle: string; readonly documentFormat?: ReaderDocumentFormat; readonly passageId?: string; readonly text: string; readonly location?: HumanLocation; readonly warnings?: readonly string[] }>
  saveNote?(args: { readonly principalId: string; readonly title?: string; readonly content: string; readonly documentId?: string; readonly sourcePassages: readonly { readonly documentId: string; readonly passageId: string }[]; readonly signal: AbortSignal }): Promise<{ readonly accepted: boolean; readonly persisted: boolean; readonly noteId?: string; readonly title?: string; readonly persistedAt?: string; readonly warning?: string }>
}

export interface PublicDocumentReference {
  readonly documentRef: string
  readonly title: string
  readonly format: ReaderDocumentFormat
  readonly readiness: ReaderDocumentReadiness
  readonly location?: HumanLocation
}

export interface PublicPassageReference {
  readonly passageRef: string
  readonly documentRef: string
  readonly documentTitle: string
  readonly text: string
  readonly location?: HumanLocation
  readonly score?: number
}

export interface ToolFailure {
  readonly code:
    | 'UNKNOWN_TOOL' | 'INVALID_ARGUMENT' | 'SKILL_REQUIRED' | 'TOOL_NOT_ALLOWED'
    | 'CAPABILITY_UNAVAILABLE' | 'SIDE_EFFECT_NOT_AUTHORIZED' | 'LIBRARY_SEARCH_NOT_AUTHORIZED'
    | 'CALL_BUDGET_EXCEEDED' | 'DUPLICATE_CALL' | 'SEARCH_STOPPED' | 'DOCUMENT_NOT_FOUND'
    | 'AMBIGUOUS_DOCUMENT' | 'RESOURCE_NOT_FOUND' | 'DOCUMENT_NOT_READY' | 'PERMISSION_DENIED'
    | 'TIMEOUT' | 'ABORTED' | 'HOST_ERROR' | 'NOT_CONFIRMED'
  readonly message: string
  readonly retryable: boolean
}

export type ToolResult<T> =
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'empty'; readonly reason: string; readonly scope?: string }
  | { readonly status: 'partial'; readonly data: T; readonly warnings: readonly string[] }
  | { readonly status: 'error'; readonly error: ToolFailure }

export const toolResult = {
  success<T>(data: T): ToolResult<T> { return { status: 'success', data } },
  empty(reason: string, scope?: string): ToolResult<never> { return { status: 'empty', reason, ...(scope === undefined ? {} : { scope }) } },
  partial<T>(data: T, warnings: readonly string[]): ToolResult<T> { return { status: 'partial', data, warnings } },
  error(code: ToolFailure['code'], message: string, retryable = false): ToolResult<never> { return { status: 'error', error: { code, message, retryable } } },
}

export interface StudyReaderProfile {
  readonly allowedSkills: ReadonlySet<string>
  readonly allowedTools: ReadonlySet<ReaderToolName>
  readonly allowLibraryWideSearch: boolean
  readonly allowPersistentWrites: boolean
  /** Shared discovery budget. Final evidence reads and an authorized save have separate reserves. */
  readonly maxToolCallsPerTurn: number
  readonly maxToolAttemptsPerTurn: number
}

export interface TurnAuthorization {
  readonly persistentWrite: boolean
}
