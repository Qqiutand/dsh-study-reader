/** Small browser control plane for fixed-scope, read-only external MCP grants. */
import { useEffect, useMemo, useState } from 'react'
import type { CreateExternalAccessResult, ExternalAccessSnapshot, ExternalAccessView } from '../../study/types.ts'
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

function connectionDocuments(connection: ExternalAccessView, missingLabel: string): string {
  const visible = connection.documentTitles.slice(0, 3).join('、')
  const remainder = Math.max(0, connection.documentTitles.length - 3)
  return `${visible}${remainder === 0 ? '' : ` +${String(remainder)}`}${connection.missingDocumentCount === 0 ? '' : ` · ${String(connection.missingDocumentCount)} ${missingLabel}`}`
}

export function ExternalAccess(props: { readonly sessionId: string; readonly studyRemote: StudyRemote | undefined }) {
  const b = useBilingualText()
  const [snapshot, setSnapshot] = useState<ExternalAccessSnapshot>()
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [label, setLabel] = useState('Codex')
  const [expiresInDays, setExpiresInDays] = useState(30)
  const [query, setQuery] = useState('')
  const [created, setCreated] = useState<CreateExternalAccessResult>()
  const [failure, setFailure] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState(false)

  const load = async (resetSelection: boolean): Promise<void> => {
    if (props.studyRemote === undefined) return
    const result = await props.studyRemote.externalAccessSnapshot({ sessionId: props.sessionId })
    if (!result.ok) throw new Error(result.error.message)
    setSnapshot(result.value)
    if (resetSelection) {
      setSelectedIds(new Set(result.value.sources.filter(source => source.selectedInConversation && source.revisionId !== undefined).map(source => String(source.id))))
    }
  }

  useEffect(() => {
    let cancelled = false
    setSnapshot(undefined); setCreated(undefined); setFailure(undefined); setNotice(undefined)
    if (props.studyRemote === undefined) return
    void props.studyRemote.externalAccessSnapshot({ sessionId: props.sessionId }).then(result => {
      if (cancelled) return
      if (!result.ok) { setFailure(result.error.message); return }
      setSnapshot(result.value)
      setSelectedIds(new Set(result.value.sources.filter(source => source.selectedInConversation && source.revisionId !== undefined).map(source => String(source.id))))
    }).catch(error => { if (!cancelled) setFailure(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true }
  }, [props.sessionId, props.studyRemote])

  const readySources = useMemo(() => snapshot?.sources.filter(source => source.revisionId !== undefined) ?? [], [snapshot])
  const visibleSources = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return readySources.filter(source => needle === '' || source.title.toLocaleLowerCase().includes(needle) || source.authors?.some(author => author.toLocaleLowerCase().includes(needle)))
  }, [query, readySources])
  const canManage = snapshot?.enabled === true && snapshot.controlMode === 'trusted-local-user' && props.studyRemote !== undefined

  const toggle = (sourceId: string): void => setSelectedIds(current => {
    const next = new Set(current)
    if (next.has(sourceId)) next.delete(sourceId); else next.add(sourceId)
    return next
  })

  const create = async (): Promise<void> => {
    if (props.studyRemote === undefined) return
    setBusy(true); setFailure(undefined); setNotice(undefined); setCreated(undefined)
    try {
      const result = await props.studyRemote.createExternalAccess({
        sessionId: props.sessionId,
        commandId: commandId('external-access-create'),
        label,
        sourceIds: [...selectedIds],
        expiresInDays,
      })
      if (!result.ok) throw new Error(result.error.message)
      setCreated(result.value)
      await load(false)
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const revoke = async (connection: ExternalAccessView): Promise<void> => {
    if (props.studyRemote === undefined) return
    setBusy(true); setFailure(undefined); setNotice(undefined)
    try {
      const result = await props.studyRemote.revokeExternalAccess({
        sessionId: props.sessionId,
        commandId: commandId('external-access-revoke'),
        accessId: connection.id,
        expectedVersion: connection.version,
      })
      if (!result.ok) throw new Error(result.error.message)
      if (created?.connection.id === connection.id) setCreated(undefined)
      await load(false)
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
      <div><p>MCP</p><h1>{b('外部 AI 访问', 'External AI access')}</h1><span>{b('让 Codex 等客户端只读取你明确选择的文献。', 'Let clients such as Codex read only the documents you explicitly select.')}</span></div>
      {snapshot === undefined ? null : <code>{snapshot.mcpUrl}</code>}
    </header>
    {snapshot?.enabled === false ? <p className="dsh-external-access-alert" role="alert">{b('插件配置中已关闭 MCP 入口。', 'The MCP endpoint is disabled in the plugin configuration.')}</p> : null}
    {snapshot?.controlMode === 'disabled' ? <p className="dsh-external-access-alert" role="alert">{b('本地管理写入已关闭，不能创建或撤销连接。', 'Local management writes are disabled, so connections cannot be created or revoked.')}</p> : null}
    {failure === undefined ? null : <p className="dsh-external-access-alert" role="alert">{failure}</p>}
    {notice === undefined ? null : <p className="dsh-external-access-notice" role="status">{notice}</p>}

    <div className="dsh-external-access-grid">
      <section className="dsh-external-access-panel">
        <header><div><h2>{b('新建连接', 'New connection')}</h2><p>{b('默认勾选本次对话正在使用的文献，你可以在生成前修改。', 'Documents used by this conversation are selected initially; adjust them before creating the connection.')}</p></div><strong>{selectedIds.size}</strong></header>
        <div className="dsh-external-access-fields">
          <label>{b('连接名称', 'Connection name')}<input value={label} maxLength={120} disabled={!canManage || busy} onChange={event => setLabel(event.currentTarget.value)} /></label>
          <label>{b('有效期', 'Expires after')}<select value={expiresInDays} disabled={!canManage || busy} onChange={event => setExpiresInDays(Number(event.currentTarget.value))}><option value={7}>{b('7 天', '7 days')}</option><option value={30}>{b('30 天', '30 days')}</option><option value={90}>{b('90 天', '90 days')}</option><option value={365}>{b('365 天', '365 days')}</option></select></label>
        </div>
        <div className="dsh-external-access-source-toolbar"><input type="search" aria-label={b('筛选文献', 'Filter documents')} placeholder={b('按标题或作者筛选', 'Filter by title or author')} value={query} onChange={event => setQuery(event.currentTarget.value)} /><button type="button" disabled={!canManage || busy} onClick={() => setSelectedIds(new Set(readySources.map(source => String(source.id))))}>{b('全选', 'Select all')}</button><button type="button" disabled={!canManage || busy} onClick={() => setSelectedIds(new Set())}>{b('清空', 'Clear')}</button></div>
        <div className="dsh-external-access-sources">
          {visibleSources.length === 0 ? <p>{b('没有可选文献。', 'No selectable documents.')}</p> : visibleSources.map(source => <label key={String(source.id)}>
            <input type="checkbox" checked={selectedIds.has(String(source.id))} disabled={!canManage || busy} onChange={() => toggle(String(source.id))} />
            <span><strong>{source.title}</strong><small>{[source.format?.toUpperCase(), source.authors?.join(', '), source.selectedInConversation ? b('本次对话', 'Current conversation') : undefined].filter(Boolean).join(' · ')}</small></span>
          </label>)}
        </div>
        <footer><span>{b('只提供 5 个只读 Reader Tools；不能导入、删除、保存笔记或修改书房设置。', 'Only five read-only Reader tools are exposed; clients cannot import, delete, save notes, or change Bookroom settings.')}</span><button type="button" disabled={!canManage || busy || label.trim() === '' || selectedIds.size === 0} onClick={() => void create()}>{busy ? b('正在处理…', 'Working…') : b('生成连接', 'Create connection')}</button></footer>
      </section>

      <section className="dsh-external-access-panel">
        <header><div><h2>{b('已有连接', 'Existing connections')}</h2><p>{b('授权范围固定；需要换书时请新建连接并撤销旧连接。', 'A connection has a fixed scope. Create a new one and revoke the old one when the document set changes.')}</p></div><strong>{snapshot?.connections.filter(connection => connection.state === 'active').length ?? 0}</strong></header>
        <div className="dsh-external-access-connections">
          {(snapshot?.connections.length ?? 0) === 0 ? <p>{b('还没有外部连接。', 'No external connections yet.')}</p> : snapshot?.connections.map(connection => <article key={connection.id} data-state={connection.state}>
            <div><strong>{connection.label}</strong><span>{connection.state === 'active' ? b('可用', 'Active') : connection.state === 'expired' ? b('已过期', 'Expired') : b('已撤销', 'Revoked')}</span></div>
            <p>{connectionDocuments(connection, b('篇文献已不存在', 'documents no longer exist'))}</p><small>{b('到期', 'Expires')}: {formatDate(connection.expiresAt)}</small>
            {connection.state !== 'active' ? null : <button type="button" disabled={!canManage || busy} onClick={() => void revoke(connection)}>{b('撤销', 'Revoke')}</button>}
          </article>)}
        </div>
      </section>
    </div>

    {created === undefined ? null : <section className="dsh-external-access-result" aria-label={b('新连接凭据', 'New connection credentials')}>
      <header><div><h2>{b('连接已生成', 'Connection created')}</h2><p>{b('Token 只在这里显示。复制后请把它当作密码保存；关闭或刷新页面后不能再次查看。', 'The token is shown only here. Copy and store it like a password; it cannot be viewed again after this page is closed or refreshed.')}</p></div><button type="button" onClick={() => setCreated(undefined)}>{b('隐藏', 'Hide')}</button></header>
      <label>{b('Bearer Token', 'Bearer token')}<div><input readOnly value={created.token} /><button type="button" onClick={() => void copy(created.token, b('Token 已复制。', 'Token copied.'))}>{b('复制', 'Copy')}</button></div></label>
      <label>{b('启动 Codex 前设置环境变量', 'Set the environment variable before starting Codex')}<div><code>{`export ${created.environmentVariable}='${created.token}'`}</code><button type="button" onClick={() => void copy(`export ${created.environmentVariable}='${created.token}'`, b('环境变量命令已复制。', 'Environment command copied.'))}>{b('复制', 'Copy')}</button></div></label>
      <label>{b('写入 ~/.codex/config.toml', 'Add to ~/.codex/config.toml')}<div><pre>{created.codexConfig}</pre><button type="button" onClick={() => void copy(created.codexConfig, b('Codex 配置已复制。', 'Codex configuration copied.'))}>{b('复制', 'Copy')}</button></div></label>
    </section>}
  </section>
}
