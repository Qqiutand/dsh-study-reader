/** Browser control plane for stable external MCP connections and editable reading sets. */
import { useEffect, useMemo, useState } from 'react'
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
  const [created, setCreated] = useState<CreateExternalAccessResult>()
  const [failure, setFailure] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState(false)

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
  const visibleSources = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return readySources.filter(source => {
      const matchesFolder = folderFilter === 'all'
        || (folderFilter === 'selected'
          ? selectedIds.has(String(source.id))
          : folderFilter === 'uncategorized'
            ? source.folderId === undefined
            : isInsideFolder(source.folderId, folderFilter, folderParentById))
      return matchesFolder && (needle === '' || source.title.toLocaleLowerCase().includes(needle) || source.authors?.some(author => author.toLocaleLowerCase().includes(needle)))
    })
  }, [folderFilter, folderParentById, query, readySources, selectedIds])
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
    setBusy(true); setFailure(undefined); setNotice(undefined); setCreated(undefined)
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
        if (targetConnection === undefined) throw new Error(b('目标连接不存在。', 'The target connection no longer exists.'))
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
        setNotice(b('书单已保存，现有 Codex 连接和 Token 不需要修改。', 'Reading set saved. The existing Codex connection and token do not need to change.'))
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
    setCreated(undefined); setFailure(undefined)
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
    if (globalThis.confirm?.(b(`删除书单“${readingSet.label}”？连接本身和 Token 会保留。`, `Delete reading set “${readingSet.label}”? The connection and token will remain.`)) === false) return
    setBusy(true); setFailure(undefined); setNotice(undefined)
    try {
      const result = await props.studyRemote.deleteExternalReadingSet({ sessionId: props.sessionId, commandId: commandId('external-set-delete'), accessId: connection.id, expectedVersion: connection.version, setRef: readingSet.setRef })
      if (!result.ok) throw new Error(result.error.message)
      const next = await load()
      if (editingSetRef === readingSet.setRef) resetSetDraft(next)
      setNotice(b('书单已删除，连接和 Token 保持不变。', 'Reading set deleted. The connection and token remain unchanged.'))
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

  const copy = async (value: string, message: string): Promise<void> => {
    try { await copyText(value); setNotice(message) }
    catch { setFailure(b('复制失败，请手动选择文本。', 'Copy failed. Select the text manually.')) }
  }

  if (props.studyRemote === undefined) return <section className="dsh-external-access"><p role="alert">{b('Study Reader 服务暂不可用。', 'Study Reader is unavailable.')}</p></section>
  if (snapshot === undefined && failure === undefined) return <section className="dsh-external-access"><p role="status">{b('正在读取外部访问设置…', 'Loading external access settings…')}</p></section>

  return <section className="dsh-external-access">
    <header>
      <div><p>MCP</p><h1>{b('外部 AI 访问', 'External AI access')}</h1><span>{b('一个连接可以管理多个命名书单；日常修改书单不需要更换 Token。', 'One connection can manage multiple named reading sets; editing sets does not rotate its token.')}</span></div>
      {snapshot === undefined ? null : <code>{snapshot.mcpUrl}</code>}
    </header>
    {snapshot?.enabled === false ? <p className="dsh-external-access-alert" role="alert">{b('插件配置中已关闭 MCP 入口。', 'The MCP endpoint is disabled in the plugin configuration.')}</p> : null}
    {snapshot?.controlMode === 'disabled' ? <p className="dsh-external-access-alert" role="alert">{b('本地管理写入已关闭，不能管理连接或书单。', 'Local management writes are disabled, so connections and reading sets cannot be managed.')}</p> : null}
    {failure === undefined ? null : <p className="dsh-external-access-alert" role="alert">{failure}</p>}
    {notice === undefined ? null : <p className="dsh-external-access-notice" role="status">{notice}</p>}

    <div className="dsh-external-access-grid">
      <section className="dsh-external-access-panel">
        <header><div><h2>{editingSetRef === undefined ? b('添加书单', 'Add reading set') : b('编辑书单', 'Edit reading set')}</h2><p>{b('先选择书单所属连接，再选择文献。AI 通过简短的 setRef 区分书单。', 'Choose the connection, then its documents. The AI distinguishes sets with a short setRef.')}</p></div><strong>{selectedIds.size}</strong></header>
        <div className="dsh-external-access-fields">
          <label>{b('所属连接', 'Connection')}<select aria-label={b('所属连接', 'Connection')} value={targetAccessId} disabled={!canManage || busy || editingSetRef !== undefined} onChange={event => { setTargetAccessId(event.currentTarget.value); resetSetDraft() }}><option value="new">{b('新建连接（首次配置）', 'New connection (first-time setup)')}</option>{activeConnections.map(connection => <option key={connection.id} value={connection.id}>{connection.label} · {connection.mcpServerName}</option>)}</select><small>{creatingConnection ? b('会生成一次连接凭据。', 'Creates connection credentials once.') : b('保存书单不会改变这个连接的 Token。', 'Saving a set does not change this connection token.')}</small></label>
          <label>{b('书单名称', 'Reading set name')}<input aria-label={b('书单名称', 'Reading set name')} value={readingSetLabel} maxLength={120} disabled={!canManage || busy} onChange={event => setReadingSetLabel(event.currentTarget.value)} /><small>{b('AI 可以看到此名称和文献数量。', 'The AI can see this name and its document count.')}</small></label>
          {creatingConnection ? <label>{b('连接名称', 'Connection name')}<input aria-label={b('连接名称', 'Connection name')} value={connectionLabel} maxLength={120} disabled={!canManage || busy} onChange={event => setConnectionLabel(event.currentTarget.value)} /><small>{b('例如 Codex；它不是书单名称。', 'For example, Codex; this is not a set name.')}</small></label> : null}
          {creatingConnection ? <label>{b('Codex MCP 名称', 'Codex MCP name')}<input aria-label={b('Codex MCP 名称', 'Codex MCP name')} value={mcpServerName} maxLength={64} spellCheck={false} aria-invalid={!mcpServerNameValid} disabled={!canManage || busy} onChange={event => setMcpServerName(event.currentTarget.value)} /><small>{b('通常保持 study-reader 即可。', 'Usually keep study-reader.')}</small></label> : null}
          {creatingConnection ? <label>{b('连接有效期', 'Connection expiry')}<select aria-label={b('连接有效期', 'Connection expiry')} value={expiresInDays} disabled={!canManage || busy} onChange={event => setExpiresInDays(Number(event.currentTarget.value))}><option value={30}>{b('30 天', '30 days')}</option><option value={90}>{b('90 天', '90 days')}</option><option value={365}>{b('365 天', '365 days')}</option></select></label> : null}
        </div>
        <div className="dsh-external-access-source-presets">
          <label>{b('文献分类', 'Document category')}<select aria-label={b('文献分类', 'Document category')} value={folderFilter} onChange={event => setFolderFilter(event.currentTarget.value)}><option value="all">{b(`全部文献 (${String(readySources.length)})`, `All documents (${String(readySources.length)})`)}</option><option value="selected">{b(`已勾选 (${String(selectedIds.size)})`, `Selected (${String(selectedIds.size)})`)}</option><option value="uncategorized">{b(`未分类 (${String(readySources.filter(source => source.folderId === undefined).length)})`, `Uncategorized (${String(readySources.filter(source => source.folderId === undefined).length)})`)}</option>{folderOptions.map(folder => <option key={folder.id} value={folder.id}>{folder.path} ({readySources.filter(source => isInsideFolder(source.folderId, folder.id, folderParentById)).length})</option>)}</select></label>
          <button type="button" disabled={!canManage || busy || conversationSourceIds.length === 0} onClick={() => { setSelectedIds(new Set(conversationSourceIds)); setNotice(b(`已载入本次对话的 ${String(conversationSourceIds.length)} 篇文献。`, `Loaded ${String(conversationSourceIds.length)} documents from this conversation.`)) }}>{b(`使用本次对话 (${String(conversationSourceIds.length)})`, `Use current conversation (${String(conversationSourceIds.length)})`)}</button>
        </div>
        <div className="dsh-external-access-source-toolbar"><input type="search" aria-label={b('筛选文献', 'Filter documents')} placeholder={b('按标题或作者筛选', 'Filter by title or author')} value={query} onChange={event => setQuery(event.currentTarget.value)} /><button type="button" disabled={!canManage || busy || visibleSources.length === 0} onClick={() => setSelectedIds(current => new Set([...current, ...visibleSources.map(source => String(source.id))]))}>{b('选择当前列表', 'Select current list')}</button><button type="button" disabled={!canManage || busy} onClick={() => setSelectedIds(new Set())}>{b('清空', 'Clear')}</button></div>
        <div className="dsh-external-access-sources">
          {visibleSources.length === 0 ? <p>{folderFilter === 'selected' ? b('还没有勾选文献。', 'No documents selected yet.') : b('没有可选文献。', 'No selectable documents.')}</p> : visibleSources.map(source => <label key={String(source.id)} data-selected={selectedIds.has(String(source.id))}>
            <input type="checkbox" checked={selectedIds.has(String(source.id))} disabled={!canManage || busy} onChange={() => toggle(String(source.id))} />
            <span><strong>{source.title}</strong><small>{[source.format?.toUpperCase(), source.authors?.join(', '), source.folderId === undefined ? b('未分类', 'Uncategorized') : folderNameById.get(source.folderId), source.selectedInConversation ? b('本次对话', 'Current conversation') : undefined].filter(Boolean).join(' · ')}</small></span>
          </label>)}
        </div>
        <footer><span>{selectedIds.size > 100 ? b('一个书单最多包含 100 篇文献。', 'A reading set can contain at most 100 documents.') : b('书单可随时编辑；Reader 调用次数不设上限，单次结果仍有大小边界。', 'Sets remain editable; Reader call count is unlimited while each result remains bounded.')}</span><div className="dsh-external-access-footer-actions">{editingSetRef === undefined ? null : <button type="button" disabled={busy} onClick={() => resetSetDraft()}>{b('取消编辑', 'Cancel edit')}</button>}<button type="button" disabled={!canManage || busy || readingSetLabel.trim() === '' || (creatingConnection && (connectionLabel.trim() === '' || !mcpServerNameValid)) || selectedIds.size === 0 || selectedIds.size > 100} onClick={() => void save()}>{busy ? b('正在处理…', 'Working…') : creatingConnection ? b('创建连接', 'Create connection') : editingSetRef === undefined ? b('添加书单', 'Add set') : b('保存书单', 'Save set')}</button></div></footer>
      </section>

      <section className="dsh-external-access-panel">
        <header><div><h2>{b('连接与书单', 'Connections and reading sets')}</h2><p>{b('一条连接可以包含多份书单。连接负责认证，书单决定 AI 可查阅的文献；修改书单不会改变 Codex 配置。', 'One connection can contain multiple reading sets. The connection authenticates; each set determines which documents AI can access. Editing a set does not change the Codex configuration.')}</p></div><strong>{listedConnections.length}</strong></header>
        <div className="dsh-external-access-connections">
          {listedConnections.length === 0 ? <p>{b('还没有外部连接。', 'No external connections yet.')}</p> : listedConnections.map(connection => <article key={connection.id} data-state={connection.state}>
            <div><strong>{connection.label}</strong><span>{connection.state === 'active' ? b('可用', 'Active') : connection.state === 'expired' ? b('已过期', 'Expired') : b('已撤销', 'Revoked')}</span></div>
            <code>{connection.mcpServerName}</code><small>{b('到期', 'Expires')}: {formatDate(connection.expiresAt)}</small>
            <div className="dsh-external-access-set-list">{connection.readingSets.map(readingSet => <section key={readingSet.setRef} className="dsh-external-access-set">
              <div><strong>{readingSet.label}</strong></div>
              <p>{readingSetDocuments(readingSet, b('篇文献已不存在', 'documents no longer exist')) || b('没有可用文献', 'No available documents')}</p>
              <div className="dsh-external-access-set-ref"><span>{b('书单标识（setRef）', 'Set identifier (setRef)')}</span><code>{readingSet.setRef}</code><button type="button" title={b('复制书单标识', 'Copy set identifier')} onClick={() => void copy(readingSet.setRef, b('书单标识已复制。', 'Set identifier copied.'))}>{b('复制', 'Copy')}</button><small>{b('AI 用它选择这份书单；需要时可复制到对话中。', 'AI uses this to select the reading set; copy it into a conversation when needed.')}</small></div>
              <small>{readingSet.sourceIds.length} {b('篇文献', 'documents')}</small>
              {connection.state !== 'active' ? null : <div className="dsh-external-access-set-actions"><button type="button" disabled={!canManage || busy} onClick={() => editSet(connection, readingSet)}>{b('编辑', 'Edit')}</button><button type="button" disabled={!canManage || busy} onClick={() => copySet(connection, readingSet)}>{b('复制', 'Copy')}</button><button type="button" disabled={!canManage || busy || connection.readingSets.length <= 1} title={connection.readingSets.length <= 1 ? b('最后一个书单不能删除，请撤销连接。', 'The last set cannot be deleted; revoke the connection instead.') : undefined} onClick={() => void deleteSet(connection, readingSet)}>{b('删除', 'Delete')}</button></div>}
            </section>)}</div>
            {connection.state !== 'active' ? null : <div className="dsh-external-access-connection-actions"><button type="button" disabled={!canManage || busy} onClick={() => { setTargetAccessId(connection.id); resetSetDraft(); setNotice(b(`新书单将加入“${connection.label}”，Token 不变。`, `The new set will be added to “${connection.label}” without changing its token.`)) }}>{b('添加书单', 'Add set')}</button><button type="button" disabled={!canManage || busy} onClick={() => void revoke(connection)}>{b('撤销连接', 'Revoke connection')}</button></div>}
          </article>)}
        </div>
      </section>
    </div>

    {created === undefined ? null : <section className="dsh-external-access-result" aria-label={b('新连接凭据', 'New connection credentials')}>
      <header><div><h2>{b('连接已生成', 'Connection created')}</h2><p>{b(`这是 ${created.connection.mcpServerName} 唯一一次需要配置的连接凭据。以后在书房中增删或修改书单，Token 都不会变化。`, `These are the one-time credentials for ${created.connection.mcpServerName}. Adding, removing, or editing its reading sets later will not change the token.`)}</p></div><button type="button" onClick={() => setCreated(undefined)}>{b('隐藏', 'Hide')}</button></header>
      <label>{b('Bearer Token', 'Bearer token')}<div><input readOnly value={created.token} /><button type="button" onClick={() => void copy(created.token, b('Token 已复制。', 'Token copied.'))}>{b('复制', 'Copy')}</button></div></label>
      <label>{b('启动 Codex 前设置一次', 'Set once before starting Codex')}<div><code>{`export ${created.environmentVariable}='${created.token}'`}</code><button type="button" onClick={() => void copy(`export ${created.environmentVariable}='${created.token}'`, b('环境变量命令已复制。', 'Environment command copied.'))}>{b('复制', 'Copy')}</button></div></label>
      <label>{b('写入 ~/.codex/config.toml', 'Add to ~/.codex/config.toml')}<div><pre>{created.codexConfig}</pre><button type="button" onClick={() => void copy(created.codexConfig, b('Codex 配置已复制。', 'Codex configuration copied.'))}>{b('复制', 'Copy')}</button></div></label>
    </section>}
  </section>
}
