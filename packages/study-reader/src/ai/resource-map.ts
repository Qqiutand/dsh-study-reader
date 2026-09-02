import type { DocumentSelector, HostAnchor, HostDocument, HostPassage, PassageTarget, PublicDocumentReference, PublicPassageReference, ReaderContextSnapshot, ReaderHost, ToolFailure } from './contracts.ts'

export class ResourceResolutionError extends Error {
  constructor(readonly code: ToolFailure['code'], message: string, readonly retryable = false) { super(message); this.name = 'ResourceResolutionError' }
}

interface StoredPassage { readonly documentId: string; readonly passageId: string }

/** Per-turn opaque model references. Host ids never cross the model boundary. */
export class TurnResourceMap {
  private documentSequence = 0
  private passageSequence = 0
  private readonly documentIdByRef = new Map<string, string>()
  private readonly documentRefById = new Map<string, string>()
  private readonly passageByRef = new Map<string, StoredPassage>()
  private readonly passageRefByKey = new Map<string, string>()

  constructor(private readonly maximumPassages = Number.POSITIVE_INFINITY) {
    if (!(maximumPassages > 0)) throw new Error('maximumPassages must be positive')
  }

  publishDocument(document: HostDocument): PublicDocumentReference {
    let documentRef = this.documentRefById.get(document.id)
    if (documentRef === undefined) {
      documentRef = `doc_${++this.documentSequence}`
      this.documentRefById.set(document.id, documentRef)
      this.documentIdByRef.set(documentRef, document.id)
    }
    return { documentRef, title: document.title, format: document.format, readiness: document.readiness, ...(document.location === undefined ? {} : { location: document.location }) }
  }

  publishPassage(passage: HostPassage): PublicPassageReference {
    const document = this.publishDocument({ id: passage.documentId, title: passage.documentTitle, format: passage.documentFormat ?? 'other', readiness: 'ready', ...(passage.location === undefined ? {} : { location: passage.location }) })
    const key = `${passage.documentId}\u0000${passage.passageId}`
    let passageRef = this.passageRefByKey.get(key)
    if (passageRef === undefined) {
      this.evictOldestPassageIfNeeded()
      passageRef = `passage_${++this.passageSequence}`
      this.passageRefByKey.set(key, passageRef)
      this.passageByRef.set(passageRef, { documentId: passage.documentId, passageId: passage.passageId })
    }
    return { passageRef, documentRef: document.documentRef, documentTitle: document.title, text: passage.text, ...(passage.location === undefined ? {} : { location: passage.location }), ...(passage.score === undefined ? {} : { score: passage.score }) }
  }

  resolveDocumentRef(documentRef: string): string {
    const documentId = this.documentIdByRef.get(documentRef)
    if (documentId === undefined) throw new ResourceResolutionError('RESOURCE_NOT_FOUND', `文档引用 ${documentRef} 在当前轮次中不存在`)
    return documentId
  }

  resolvePassageRef(passageRef: string): StoredPassage {
    const passage = this.passageByRef.get(passageRef)
    if (passage === undefined) throw new ResourceResolutionError('RESOURCE_NOT_FOUND', `段落引用 ${passageRef} 在当前轮次中不存在`)
    return passage
  }

  private evictOldestPassageIfNeeded(): void {
    if (this.passageByRef.size < this.maximumPassages) return
    const oldest = this.passageByRef.entries().next().value as [string, StoredPassage] | undefined
    if (oldest === undefined) return
    const [passageRef, passage] = oldest
    this.passageByRef.delete(passageRef)
    this.passageRefByKey.delete(`${passage.documentId}\u0000${passage.passageId}`)
  }
}

function normalizedTitle(title: string): string { return title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase() }

export async function resolveDocumentSelector(args: { readonly selector: DocumentSelector; readonly snapshot: ReaderContextSnapshot; readonly resources: TurnResourceMap; readonly host: ReaderHost; readonly principalId: string; readonly signal: AbortSignal }): Promise<string> {
  if (args.selector.kind === 'document_ref') return args.resources.resolveDocumentRef(args.selector.documentRef)
  if (args.host.listDocuments === undefined) throw new ResourceResolutionError('CAPABILITY_UNAVAILABLE', '当前运行时不能按标题解析文档')
  const documents = await args.host.listDocuments({ principalId: args.principalId, query: args.selector.title, limit: 50, signal: args.signal })
  const expected = normalizedTitle(args.selector.title)
  const matches = documents.filter(document => normalizedTitle(document.title) === expected)
  if (matches.length === 0) throw new ResourceResolutionError('DOCUMENT_NOT_FOUND', `没有找到标题为“${args.selector.title}”的文档`)
  if (matches.length > 1) throw new ResourceResolutionError('AMBIGUOUS_DOCUMENT', `存在多个标题为“${args.selector.title}”的文档，请先取得明确引用`)
  args.resources.publishDocument(matches[0]!)
  return matches[0]!.id
}

export async function resolvePassageTarget(args: { readonly target: PassageTarget; readonly snapshot: ReaderContextSnapshot; readonly resources: TurnResourceMap; readonly host: ReaderHost; readonly principalId: string; readonly signal: AbortSignal }): Promise<{ documentId: string; anchor: HostAnchor }> {
  if (args.target.kind === 'passage_ref') {
    const passage = args.resources.resolvePassageRef(args.target.passageRef)
    return { documentId: passage.documentId, anchor: { kind: 'passage', passageId: passage.passageId } }
  }
  const documentId = await resolveDocumentSelector({ selector: args.target.document, snapshot: args.snapshot, resources: args.resources, host: args.host, principalId: args.principalId, signal: args.signal })
  return args.target.kind === 'page'
    ? { documentId, anchor: { kind: 'page', page: args.target.page } }
    : { documentId, anchor: { kind: 'section', section: args.target.section } }
}
