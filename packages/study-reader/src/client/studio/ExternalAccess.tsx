/** Browser control plane for stable external MCP connections and editable reading sets. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CreateExternalAccessResult, ExternalAccessSnapshot, ExternalAccessView, ExternalReadingSetView } from '../../study/types.ts'
import type { StudyRemote } from '../remote.ts'
import { useBilingualText } from '../StudyLocale.tsx'

function commandId(prefix: string): string {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? String(Date.now())}`
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(globalThis.navigator?.language ?? 'zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

async function copyText(value: string): Promise<void> {
  await globalThis.navigator.clipboard.writeText(value)
}

function readingSetDocuments(readingSet: ExternalReadingSetView, missingLabel: string): string {
  const visible = readingSet.documentTitles.slice(0, 3).join('、')
  const remainder = Math.max(0, readingSet.documentTitles.length - 3)
  return `${visible}${remainder === 0 ? '' : ` +${String(remainder)}`}${readingSet.missingDocumentCount === 0 ? '' : ` · ${String(readingSet.missingDocumentCount)} ${missingLabel}`}`
}

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u

function isInsideFolder(folderId: string | undefined, ancestorId: string, parentById: ReadonlyMap<string, string | undefined>): boolean {
  let current = folderId
  const visited = new Set<string>()
  while (current !== undefined && !visited.has(current)) {
    if (current === ancestorId) return true
    visited.add(current)
    current = parentById.get(current)
  }
  return false
}

function availableMcpName(root: string, usedNames: ReadonlySet<string>): string {
  if (!usedNames.has(root)) return root
  for (let index = 2; index < 10_000; index += 1) {
    const suffix = `-${String(index)}`
    const candidate = `${root.slice(0, 64 - suffix.length)}${suffix}`
    if (!usedNames.has(candidate)) return candidate
  }
  return `study-reader-${Date.now().toString(36)}`.slice(0, 64)
}

function folderTone(folderId: string | undefined): string {
  if (folderId === undefined) return 'neutral'
  let hash = 0
  for (const character of folderId) hash = ((hash * 31) + (character.codePointAt(0) ?? 0)) >>> 0
  return String(hash % 6)
}

export function ExternalAccess(props: { readonly sessionId: string; readonly studyRemote: StudyRemote | undefined }) {
  const b = useBilingualText()
  const defaultReadingSetLabel = b('书单', 'Reading set')
  const [snapshot, setSnapshot] = useState<ExternalAccessSnapshot>()
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [targetAccessId, setTargetAccessId] = useState('new')
  const [editingSetRef, setEditingSetRef] = useState<string>()
  const [readingSetLabel, setReadingSetLabel] = useState(defaultReadingSetLabel)
  const [connectionLabel, setConnectionLabel] = useState('Codex')
  const [mcpServerName, setMcpServerName] = useState('study-reader')
  const [expiresInDays, setExpiresInDays] = useState(365)
  const [query, setQuery] = useState('')
  const [folderFilter, setFolderFilter] = useState('all')
  const [selectionFilter, setSelectionFilter] = useState<'all' | 'selected' | 'unselected'>('all')
  const [created, setCreated] = useState<CreateExternalAccessResult>()
  const [failure, setFailure] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState(false)
  const credentialPanelRef = useRef<HTMLElement>(null)

  const conversationSelection = (value: ExternalAccessSnapshot): Set<string> => new Set(value.sources
    .filter(source => source.selectedInConversation && source.revisionId !== undefined)
    .map(source => String(source.id)))

  const load = async (): Promise<ExternalAccessSnapshot | undefined> => {
    if (props.studyRemote === undefined) return undefined
    const result = await props.studyRemote.externalAccessSnapshot({ sessionId: props.sessionId })
    if (!result.ok) throw new Error(result.error.message)
    setSnapshot(result.value)
    return result.value
  }

  useEffect(() => {
    let cancelled = false
    setSnapshot(undefined); setCreated(undefined); setFailure(undefined); setNotice(undefined); setEditingSetRef(undefined)
    if (props.studyRemote === undefined) return
    void props.studyRemote.externalAccessSnapshot({ sessionId: props.sessionId }).then(result => {
      if (cancelled) return
      if (!result.ok) { setFailure(result.error.message); return }
      setSnapshot(result.value)
      setSelectedIds(conversationSelection(result.value))
      const active = result.value.connections.find(connection => connection.state === 'active')
      setTargetAccessId(active?.id ?? 'new')
      setMcpServerName(availableMcpName('study-reader', new Set(result.value.connections.map(connection => connection.mcpServerName))))
    }).catch(error => { if (!cancelled) setFailure(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true }
  }, [props.sessionId, props.studyRemote])

  useEffect(() => {
    if (created !== undefined) credentialPanelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [created])

  const readySources = useMemo(() => snapshot?.sources.filter(source => source.revisionId !== undefined) ?? [], [snapshot])
  const conversationSourceIds = useMemo(() => readySources.filter(source => source.selectedInConversation).map(source => String(source.id)), [readySources])
  const activeConnections = useMemo(() => snapshot?.connections.filter(connection => connection.state === 'active') ?? [], [snapshot])
  const listedConnections = useMemo(() => snapshot?.connections.filter(connection => connection.state !== 'revoked') ?? [], [snapshot])
  const targetConnection = useMemo(() => activeConnections.find(connection => connection.id === targetAccessId), [activeConnections, targetAccessId])
  const folderParentById = useMemo(() => new Map(snapshot?.folders.map(folder => [folder.id, folder.parentId]) ?? []), [snapshot])
  const folderNameById = useMemo(() => new Map(snapshot?.folders.map(folder => [folder.id, folder.name]) ?? []), [snapshot])
  const folderOptions = useMemo(() => (snapshot?.folders ?? []).map(folder => {
    const names: string[] = []
    const visited = new Set<string>()
    let current: string | undefined = folder.id
    while (current !== undefined && !visited.has(current)) {
      visited.add(current)
      names.unshift(folderNameById.get(current) ?? current)
      current = folderParentById.get(current)
    }
    return { ...folder, path: names.join(' / ') }
  }).sort((left, right) => left.path.localeCompare(right.path)), [folderNameById, folderParentById, snapshot])
  const categorySources = useMemo(() => readySources.filter(source => folderFilter === 'all'
    || (folderFilter === 'uncategorized'
      ? source.folderId === undefined
      : isInsideFolder(source.folderId, folderFilter, folderParentById))), [folderFilter, folderParentById, readySources])
  const searchedSources = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return categorySources.filter(source => needle === '' || source.title.toLocaleLowerCase().includes(needle) || source.authors?.some(author => author.toLocaleLowerCase().includes(needle)))
  }, [categorySources, query])
  const visibleSources = useMemo(() => searchedSources.filter(source => selectionFilter === 'all'
    || (selectionFilter === 'selected') === selectedIds.has(String(source.id))), [searchedSources, selectedIds, selectionFilter])
  const visibleSelectedCount = useMemo(() => searchedSources.filter(source => selectedIds.has(String(source.id))).length, [searchedSources, selectedIds])
  const canManage = snapshot?.enabled === true && snapshot.controlMode === 'trusted-local-user' && props.studyRemote !== undefined
  const creatingConnection = targetAccessId === 'new'
  const mcpServerNameValid = MCP_SERVER_NAME_PATTERN.test(mcpServerName)

  const resetSetDraft = (value = snapshot): void => {
    setEditingSetRef(undefined)
    setReadingSetLabel(defaultReadingSetLabel)
    if (value !== undefined) setSelectedIds(conversationSelection(value))
  }

  const toggle = (sourceId: string): void => setSelectedIds(current => {
    const next = new Set(current)
    if (next.has(sourceId)) next.delete(sourceId); else next.add(sourceId)
    return next
  })

  const save = async (): Promise<void> => {
    if (props.studyRemote === undefined) return
    setBusy(true); setFailure(undefined); setNotice(undefined)
    try {
      if (creatingConnection) {
        const result = await props.studyRemote.createExternalAccess({
          sessionId: props.sessionId,
          commandId: commandId('external-access-create'),
          label: connectionLabel,
          mcpServerName,
          readingSetLabel,
          sourceIds: [...selectedIds],
          expiresInDays,
        })
        if (!result.ok) throw new Error(result.error.message)
        setCreated(result.value)
        setTargetAccessId(result.value.connection.id)
        const next = await load()
        resetSetDraft(next)
      } else {
        if (targetConnection === undefined) throw new Error(b('目标客户端授权不存在。', 'The target client authorization no longer exists.'))
        const result = await props.studyRemote.saveExternalReadingSet({
          sessionId: props.sessionId,
          commandId: commandId(editingSetRef === undefined ? 'external-set-create' : 'external-set-update'),
          accessId: targetConnection.id,
          expectedVersion: targetConnection.version,
          ...(editingSetRef === undefined ? {} : { setRef: editingSetRef }),
          label: readingSetLabel,
          sourceIds: [...selectedIds],
        })
        if (!result.ok) throw new Error(result.error.message)
        const next = await load()
        resetSetDraft(next)
        setNotice(b('书单已保存，现有客户端配置和 Token 不需要修改。', 'Reading set saved. The existing client configuration and token do not need to change.'))
      }
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const editSet = (connection: ExternalAccessView, readingSet: ExternalReadingSetView): void => {
    const readyIds = new Set(readySources.map(source => String(source.id)))
    setTargetAccessId(connection.id)
    setEditingSetRef(readingSet.setRef)
    setReadingSetLabel(readingSet.label)
    setSelectedIds(new Set(readingSet.sourceIds.filter(sourceId => readyIds.has(sourceId))))
    setFailure(undefined)
    setNotice(b(`正在编辑“${readingSet.label}”；保存后 Token 不变。`, `Editing “${readingSet.label}”; its token will not change.`))
  }

  const copySet = (connection: ExternalAccessView, readingSet: ExternalReadingSetView): void => {
    editSet(connection, readingSet)
    setEditingSetRef(undefined)
    setReadingSetLabel(b(`${readingSet.label} 副本`, `${readingSet.label} copy`))
    setNotice(b(`已把“${readingSet.label}”复制为新书单草稿。`, `Copied “${readingSet.label}” into a new reading-set draft.`))
  }

  const deleteSet = async (connection: ExternalAccessView, readingSet: ExternalReadingSetView): Promise<void> => {
    if (props.studyRemote === undefined || connection.readingSets.length <= 1) return
    if (globalThis.confirm?.(b(`删除书单“${readingSet.label}”？客户端授权和 Token 会保留。`, `Delete reading set “${readingSet.label}”? The client authorization and token will remain.`)) === false) return
    setBusy(true); setFailure(undefined); setNotice(undefined)
    try {
      const result = await props.studyRemote.deleteExternalReadingSet({ sessionId: props.sessionId, commandId: commandId('external-set-delete'), accessId: connection.id, expectedVersion: connection.version, setRef: readingSet.setRef })
      if (!result.ok) throw new Error(result.error.message)
      const next = await load()
      if (editingSetRef === readingSet.setRef) resetSetDraft(next)
      setNotice(b('书单已删除，客户端授权和 Token 保持不变。', 'Reading set deleted. The client authorization and token remain unchanged.'))
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const revoke = async (connection: ExternalAccessView): Promise<void> => {
    if (props.studyRemote === undefined) return
    setBusy(true); setFailure(undefined); setNotice(undefined)
    try {
      const result = await props.studyRemote.revokeExternalAccess({ sessionId: props.sessionId, commandId: commandId('external-access-revoke'), accessId: connection.id, expectedVersion: connection.version })
      if (!result.ok) throw new Error(result.error.message)
      if (created?.connection.id === connection.id) setCreated(undefined)
      const next = await load()
      const nextActive = next?.connections.find(item => item.state === 'active')
      setTargetAccessId(nextActive?.id ?? 'new')
      resetSetDraft(next)
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const showCredentials = async (connection: ExternalAccessView): Promise<void> => {
    if (props.studyRemote === undefined) return
    setBusy(true); setFailure(undefined); setNotice(undefined)
    try {
      const result = await props.studyRemote.externalAccessCredentials({ sessionId: props.sessionId, accessId: connection.id })
      if (!result.ok) throw new Error(result.error.message)
      setCreated(result.value)
      setNotice(b(`正在显示“${connection.label}”的 Codex 与 Antigravity 配置；Token 没有发生变化。`, `Showing the Codex and Antigravity configurations for “${connection.label}”; its token has not changed.`))
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const copy = async (value: string, message: string): Promise<void> => {
    try { await copyText(value); setNotice(message) }
    catch { setFailure(b('复制失败，请手动选择文本。', 'Copy failed. Select the text manually.')) }
  }

  if (props.studyRemote === undefined) return <section className="dsh-external-access"><p role="alert">{b('Study Reader 服务暂不可用。', 'Study Reader is unavailable.')}</p></section>
  if (snapshot === undefined && failure === undefined) return <section className="dsh-external-access"><p role="status">{b('正在读取外部访问设置…', 'Loading external access settings…')}</p></section>

  return <section className="dsh-external-access">
    <header>
      <div><p>MCP</p><h1>{b('外部 AI 访问', 'External AI access')}</h1><span>{b('为 Codex、Antigravity 或其他 MCP 客户端管理独立授权和可访问书单。', 'Manage independent client authorizations and accessible reading sets for Codex, Antigravity, or another MCP client.')}</span></div>
      {snapshot === undefined ? null : <code>{snapshot.mcpUrl}</code>}
    </header>
    {snapshot?.enabled === false ? <p className="dsh-external-access-alert" role="alert">{b('插件配置中已关闭 MCP 入口。', 'The MCP endpoint is disabled in the plugin configuration.')}</p> : null}
    {snapshot?.controlMode === 'disabled' ? <p className="dsh-external-access-alert" role="alert">{b('本地管理写入已关闭，不能管理客户端授权或书单。', 'Local management writes are disabled, so client authorizations and reading sets cannot be managed.')}</p> : null}
    {failure === undefined ? null : <p className="dsh-external-access-alert" role="alert">{failure}</p>}
    {notice === undefined ? null : <p className="dsh-external-access-notice" role="status">{notice}</p>}

    <section className="dsh-external-access-model" aria-label={b('外部访问如何工作', 'How external access works')}>
      <div><small>{b('1 · 配置客户端', '1 · Configure the client')}</small><strong>{b('MCP 地址 + Bearer Token', 'MCP URL + bearer token')}</strong><span>{b('只需配置一次。', 'Configured once.')}</span></div>
      <i aria-hidden="true">→</i>
      <div><small>{b('2 · 授权范围', '2 · Authorization scope')}</small><strong>{b('这枚 Token 下的全部书单', 'Every set under this token')}</strong><span>{b('书单可在书房中随时修改。', 'Sets remain editable in the Bookroom.')}</span></div>
      <i aria-hidden="true">→</i>
      <div><small>{b('3 · AI 选择书单', '3 · AI selects a set')}</small><strong><code>reader_list_sets → setRef</code></strong><span>{b('setRef 不是密钥，无需写入客户端配置。', 'setRef is not a secret and is not part of client configuration.')}</span></div>
    </section>

    {created === undefined ? null : <section ref={credentialPanelRef} className="dsh-external-access-result" aria-label={b('客户端配置', 'Client configuration')}>
      <header><div><h2>{b(`${created.connection.label} · 客户端配置`, `${created.connection.label} · Client configuration`)}</h2><p>{b('Codex 与 Antigravity 可以同时使用下面同一个地址和 Token。以后可从授权卡片再次打开，Token 不会改变。', 'Codex and Antigravity can use the same URL and token below at the same time. Reopen this configuration from the authorization card at any time without changing the token.')}</p></div></header>
      <div className="dsh-external-access-credential-explanation"><p><strong>{b('保持 DSH Web 运行', 'Keep DSH Web running')}</strong><span>{b('MCP 服务由 Study Reader 插件提供；DSH Web 停止时，两个客户端都无法连接。', 'The Study Reader plugin serves this MCP endpoint; neither client can connect while DSH Web is stopped.')}</span></p><p><strong>{b('不需要 MCP Login', 'No MCP login')}</strong><span>{b('这里使用固定 Bearer Token，不是 OAuth。不要运行 codex mcp login。', 'This connection uses a fixed bearer token, not OAuth. Do not run codex mcp login.')}</span></p></div>
      <label>{b('MCP 服务地址', 'MCP server URL')}<div><code>{created.mcpUrl}</code><button type="button" onClick={() => void copy(created.mcpUrl, b('MCP 地址已复制。', 'MCP URL copied.'))}>{b('复制', 'Copy')}</button></div></label>
      <label>{b('Bearer Token', 'Bearer token')}<div><code>{created.token}</code><button type="button" onClick={() => void copy(created.token, b('Bearer Token 已复制。', 'Bearer token copied.'))}>{b('复制', 'Copy')}</button></div><small>{b('这是这份授权的固定 Token；编辑书单不会改变它。', 'This is the stable token for this authorization; editing reading sets does not change it.')}</small></label>
      <div className="dsh-external-access-client-configs">
        <article aria-label="Codex">
          <header><h3>Codex</h3><p>{b('配置已直接包含 Authorization header，不依赖 .bashrc 或环境变量。', 'The configuration includes the Authorization header directly and does not depend on .bashrc or environment variables.')}</p></header>
          <label>{b('写入 ~/.codex/config.toml', 'Add to ~/.codex/config.toml')}<div><pre>{created.codexConfig}</pre><button type="button" onClick={() => void copy(created.codexConfig, b('Codex 配置已复制。', 'Codex configuration copied.'))}>{b('复制完整配置', 'Copy full configuration')}</button></div><small>{b('保存后重启 Codex。不要再执行 codex mcp login。', 'Restart Codex after saving. Do not run codex mcp login.')}</small></label>
        </article>
        <article aria-label="Antigravity">
          <header><h3>Antigravity</h3><p>{b('同一个 Streamable HTTP 地址与 Token，可与 Codex 同时使用。', 'Uses the same Streamable HTTP URL and token and can run alongside Codex.')}</p></header>
          <label>{b('写入 ~/.gemini/config/mcp_config.json 或项目 .agents/mcp_config.json', 'Add to ~/.gemini/config/mcp_config.json or project .agents/mcp_config.json')}<div><pre>{created.antigravityConfig}</pre><button type="button" onClick={() => void copy(created.antigravityConfig, b('Antigravity 配置已复制。', 'Antigravity configuration copied.'))}>{b('复制完整配置', 'Copy full configuration')}</button></div></label>
        </article>
      </div>
    </section>}

    <div className="dsh-external-access-grid">
      <section className="dsh-external-access-panel">
        <header><div><h2>{editingSetRef !== undefined ? b('编辑书单', 'Edit reading set') : creatingConnection ? b('授权新客户端', 'Authorize a new client') : b('添加书单', 'Add reading set')}</h2><p>{creatingConnection ? b('创建一枚独立 Token，并为这份授权设置第一份书单。', 'Create an independent token and the first reading set available through it.') : b('在同一份客户端授权下管理书单；Token 和客户端配置不会改变。', 'Manage a set under the same client authorization; its token and client configuration do not change.')}</p></div><strong>{selectedIds.size}</strong></header>
        <div className="dsh-external-access-fields">
          <div className="dsh-external-access-client-field"><span>{b('客户端授权', 'Client authorization')}</span><div><select aria-label={b('客户端授权', 'Client authorization')} value={targetAccessId} disabled={!canManage || busy || editingSetRef !== undefined} onChange={event => { setTargetAccessId(event.currentTarget.value); resetSetDraft() }}><option value="new">{b('创建新的客户端授权', 'Create a new client authorization')}</option>{activeConnections.map(connection => <option key={connection.id} value={connection.id}>{connection.label} · {connection.mcpServerName}</option>)}</select>{targetConnection === undefined ? null : <button type="button" disabled={!canManage || busy} onClick={() => void showCredentials(targetConnection)}>{b('查看 Token 与配置', 'View token & config')}</button>}</div><small>{creatingConnection ? b('生成一枚可独立撤销和过期的 Token。', 'Creates a token that can expire or be revoked independently.') : b('新书单会立即加入这枚 Token 的授权范围。', 'The new set immediately joins this token\'s authorization scope.')}</small></div>
          {creatingConnection ? <label>{b('客户端名称', 'Client name')}<input aria-label={b('客户端名称', 'Client name')} value={connectionLabel} maxLength={120} disabled={!canManage || busy} onChange={event => setConnectionLabel(event.currentTarget.value)} /><small>{b('仅用于在这个页面识别谁在使用这枚 Token，例如 Codex。', 'Only identifies who uses this token on this page, for example Codex.')}</small></label> : null}
          {creatingConnection ? <label>{b('MCP 配置标识', 'MCP configuration key')}<input aria-label={b('MCP 配置标识', 'MCP configuration key')} value={mcpServerName} maxLength={64} spellCheck={false} aria-invalid={!mcpServerNameValid} disabled={!canManage || busy} onChange={event => setMcpServerName(event.currentTarget.value)} /><small>{b('写入 Codex 或 Antigravity 配置的本机名称；通常保持 study-reader。', 'The local name written into Codex or Antigravity configuration; usually keep study-reader.')}</small></label> : null}
          {creatingConnection ? <label>{b('授权有效期', 'Authorization expiry')}<select aria-label={b('授权有效期', 'Authorization expiry')} value={expiresInDays} disabled={!canManage || busy} onChange={event => setExpiresInDays(Number(event.currentTarget.value))}><option value={30}>{b('30 天', '30 days')}</option><option value={90}>{b('90 天', '90 days')}</option><option value={365}>{b('365 天', '365 days')}</option></select></label> : null}
          <label>{b('书单名称', 'Reading set name')}<input aria-label={b('书单名称', 'Reading set name')} value={readingSetLabel} maxLength={120} disabled={!canManage || busy} onChange={event => setReadingSetLabel(event.currentTarget.value)} /><small>{b('AI 会在 reader_list_sets 中看到这个名称和文献数量。', 'AI sees this name and document count in reader_list_sets.')}</small></label>
        </div>
        <div className="dsh-external-access-source-presets">
          <label>{b('文献分类', 'Document category')}<select aria-label={b('文献分类', 'Document category')} value={folderFilter} onChange={event => setFolderFilter(event.currentTarget.value)}><option value="all">{b(`全部文献 (${String(readySources.length)})`, `All documents (${String(readySources.length)})`)}</option><option value="uncategorized">{b(`未分类 (${String(readySources.filter(source => source.folderId === undefined).length)})`, `Uncategorized (${String(readySources.filter(source => source.folderId === undefined).length)})`)}</option>{folderOptions.map(folder => <option key={folder.id} value={folder.id}>{folder.path} ({readySources.filter(source => isInsideFolder(source.folderId, folder.id, folderParentById)).length})</option>)}</select></label>
          <button type="button" disabled={!canManage || busy || conversationSourceIds.length === 0} onClick={() => { setSelectedIds(new Set(conversationSourceIds)); setNotice(b(`已载入本次对话的 ${String(conversationSourceIds.length)} 篇文献。`, `Loaded ${String(conversationSourceIds.length)} documents from this conversation.`)) }}>{b(`使用本次对话 (${String(conversationSourceIds.length)})`, `Use current conversation (${String(conversationSourceIds.length)})`)}</button>
        </div>
        <div className="dsh-external-access-selection-filter" role="group" aria-label={b('勾选状态', 'Selection status')}><button type="button" aria-pressed={selectionFilter === 'all'} onClick={() => setSelectionFilter('all')}>{b(`全部 (${String(searchedSources.length)})`, `All (${String(searchedSources.length)})`)}</button><button type="button" aria-pressed={selectionFilter === 'selected'} onClick={() => setSelectionFilter('selected')}>{b(`已勾选 (${String(visibleSelectedCount)})`, `Selected (${String(visibleSelectedCount)})`)}</button><button type="button" aria-pressed={selectionFilter === 'unselected'} onClick={() => setSelectionFilter('unselected')}>{b(`未勾选 (${String(searchedSources.length - visibleSelectedCount)})`, `Unselected (${String(searchedSources.length - visibleSelectedCount)})`)}</button></div>
        <div className="dsh-external-access-source-toolbar"><input type="search" aria-label={b('筛选文献', 'Filter documents')} placeholder={b('按标题或作者筛选', 'Filter by title or author')} value={query} onChange={event => setQuery(event.currentTarget.value)} /><button type="button" disabled={!canManage || busy || visibleSources.length === 0} onClick={() => setSelectedIds(current => new Set([...current, ...visibleSources.map(source => String(source.id))]))}>{b('选择当前列表', 'Select current list')}</button><button type="button" disabled={!canManage || busy} onClick={() => setSelectedIds(new Set())}>{b('清空', 'Clear')}</button></div>
        <div className="dsh-external-access-sources">
          {visibleSources.length === 0 ? <p>{selectionFilter === 'selected' ? b('当前范围内没有已勾选文献。', 'No selected documents in the current scope.') : selectionFilter === 'unselected' ? b('当前范围内没有未勾选文献。', 'No unselected documents in the current scope.') : b('没有可选文献。', 'No selectable documents.')}</p> : visibleSources.map(source => <label key={String(source.id)} data-selected={selectedIds.has(String(source.id))}>
            <input type="checkbox" checked={selectedIds.has(String(source.id))} disabled={!canManage || busy} onChange={() => toggle(String(source.id))} />
            <span><strong>{source.title}</strong><small className="dsh-external-access-source-meta">{source.format === undefined ? null : <span data-kind="format" data-format={source.format}>{source.format.toUpperCase()}</span>}{source.authors === undefined || source.authors.length === 0 ? null : <span data-kind="author">{source.authors.join(', ')}</span>}<span data-kind="folder" data-tone={folderTone(source.folderId)}>{source.folderId === undefined ? b('未分类', 'Uncategorized') : (folderNameById.get(source.folderId) ?? source.folderId)}</span>{source.selectedInConversation ? <span data-kind="conversation">{b('本次对话', 'Current conversation')}</span> : null}</small></span>
          </label>)}
        </div>
        <footer><span>{selectedIds.size > 100 ? b('一个书单最多包含 100 篇文献。', 'A reading set can contain at most 100 documents.') : b('书单可随时编辑；Reader 调用次数不设上限，单次结果仍有大小边界。', 'Sets remain editable; Reader call count is unlimited while each result remains bounded.')}</span><div className="dsh-external-access-footer-actions">{editingSetRef === undefined ? null : <button type="button" disabled={busy} onClick={() => resetSetDraft()}>{b('取消编辑', 'Cancel edit')}</button>}<button type="button" disabled={!canManage || busy || readingSetLabel.trim() === '' || (creatingConnection && (connectionLabel.trim() === '' || !mcpServerNameValid)) || selectedIds.size === 0 || selectedIds.size > 100} onClick={() => void save()}>{busy ? b('正在处理…', 'Working…') : creatingConnection ? b('生成客户端授权', 'Generate client authorization') : editingSetRef === undefined ? b('添加书单', 'Add set') : b('保存书单', 'Save set')}</button></div></footer>
      </section>

      <section className="dsh-external-access-panel">
        <header><div><h2>{b('客户端授权与书单', 'Client authorizations and reading sets')}</h2><p>{b('每份授权只有一枚 Token，可包含多份书单。如需独立的可见范围、过期或撤销，请另建一份客户端授权。', 'Each authorization has one token and may contain multiple sets. Create another client authorization when visibility, expiry, or revocation must be independent.')}</p></div><strong>{listedConnections.length}</strong></header>
        <div className="dsh-external-access-connections">
          {listedConnections.length === 0 ? <p>{b('还没有客户端授权。', 'No client authorizations yet.')}</p> : listedConnections.map(connection => <article key={connection.id} data-state={connection.state}>
            <div><strong>{connection.label}</strong><span>{connection.state === 'active' ? b('可用', 'Active') : connection.state === 'expired' ? b('已过期', 'Expired') : b('已撤销', 'Revoked')}</span>{connection.state !== 'active' ? null : <button className="dsh-external-access-view-config" type="button" disabled={!canManage || busy} onClick={() => void showCredentials(connection)}>{b('查看 Token 与配置', 'View token & config')}</button>}</div>
            <div className="dsh-external-access-connection-meta"><span>{b('MCP 配置标识', 'MCP configuration key')}</span><code>{connection.mcpServerName}</code><small>{b('到期', 'Expires')}: {formatDate(connection.expiresAt)}</small></div>
            <div className="dsh-external-access-set-list">{connection.readingSets.map(readingSet => <section key={readingSet.setRef} className="dsh-external-access-set">
              <div><strong>{readingSet.label}</strong></div>
              <p>{readingSetDocuments(readingSet, b('篇文献已不存在', 'documents no longer exist')) || b('没有可用文献', 'No available documents')}</p>
              <div className="dsh-external-access-set-ref"><span>{b('书单标识（setRef）', 'Set identifier (setRef)')}</span><code>{readingSet.setRef}</code><button type="button" title={b('复制书单标识', 'Copy set identifier')} onClick={() => void copy(readingSet.setRef, b('书单标识已复制。', 'Set identifier copied.'))}>{b('复制', 'Copy')}</button><small>{b('AI 用它选择这份书单；需要时可复制到对话中。', 'AI uses this to select the reading set; copy it into a conversation when needed.')}</small></div>
              <small>{readingSet.sourceIds.length} {b('篇文献', 'documents')}</small>
              {connection.state !== 'active' ? null : <div className="dsh-external-access-set-actions"><button type="button" disabled={!canManage || busy} onClick={() => editSet(connection, readingSet)}>{b('编辑', 'Edit')}</button><button type="button" disabled={!canManage || busy} onClick={() => copySet(connection, readingSet)}>{b('复制', 'Copy')}</button><button type="button" disabled={!canManage || busy || connection.readingSets.length <= 1} title={connection.readingSets.length <= 1 ? b('最后一个书单不能删除，请撤销整份客户端授权。', 'The last set cannot be deleted; revoke the client authorization instead.') : undefined} onClick={() => void deleteSet(connection, readingSet)}>{b('删除', 'Delete')}</button></div>}
            </section>)}</div>
            {connection.state !== 'active' ? null : <div className="dsh-external-access-connection-actions"><button type="button" disabled={!canManage || busy} onClick={() => { setTargetAccessId(connection.id); resetSetDraft(); setNotice(b(`新书单将加入“${connection.label}”的授权范围，Token 不变。`, `The new set will join “${connection.label}”'s authorization scope without changing its token.`)) }}>{b('添加书单', 'Add set')}</button><button type="button" disabled={!canManage || busy} onClick={() => void revoke(connection)}>{b('撤销授权', 'Revoke authorization')}</button></div>}
          </article>)}
        </div>
      </section>
    </div>

  </section>
}
