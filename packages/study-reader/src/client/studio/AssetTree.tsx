/** Lazy, typed navigation tree for the unified Study Studio. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssetFolderView, AssetNamespace, AssetTreeCommand } from '../../studio/types.ts'
import type { StudyRemote } from '../remote.ts'
import { useBilingualText, type BilingualText } from '../StudyLocale.tsx'

export type StudioSection = 'overview' | 'library' | 'profiles' | 'prompts' | 'skills' | 'tools' | 'permissions' | 'services'
export interface StudioTreeSelection { readonly section: StudioSection; readonly folderId?: string }
type FolderDialog =
  | { readonly kind: 'create'; readonly namespace: AssetNamespace; readonly parentId?: string }
  | { readonly kind: 'manage'; readonly folder: AssetFolderView }

type SectionRow = { readonly id: StudioSection; readonly label: string; readonly description: string; readonly namespace?: AssetNamespace; readonly group: string }
const localizedSections = (b: BilingualText): readonly SectionRow[] => [
  { id: 'overview', label: b('总览', 'Overview'), description: b('本次对话正在使用什么', 'What this conversation uses'), group: b('概览', 'Overview') },
  { id: 'library', label: b('全部文献', 'All documents'), description: b('导入、整理与预览', 'Import, organize, and preview'), namespace: 'library', group: b('文献库', 'Library') },
  { id: 'profiles', label: b('配置预设', 'Configuration presets'), description: b('组合提示词注入、Skills 与 Tools', 'Combine prompt injections, skills, and tools'), namespace: 'profile', group: b('助手设置', 'Assistant settings') },
  { id: 'prompts', label: b('提示词注入', 'Prompt injections'), description: b('管理回答方式与边界', 'Manage response behavior and boundaries'), namespace: 'prompt', group: b('助手设置', 'Assistant settings') },
  { id: 'skills', label: 'Skills', description: b('专项方法与适用条件', 'Specialized methods and conditions'), namespace: 'skill', group: b('助手设置', 'Assistant settings') },
  { id: 'tools', label: 'Tools', description: b('当前可用的文献能力', 'Available document capabilities'), group: b('助手设置', 'Assistant settings') },
  { id: 'permissions', label: b('访问权限', 'Access'), description: b('当前会话能力边界', 'Conversation capability boundaries'), group: b('连接与权限', 'Connections and access') },
  { id: 'services', label: b('服务连接', 'Service connections'), description: b('解析服务和凭据状态', 'Extraction services and credentials'), group: b('连接与权限', 'Connections and access') },
]

export function AssetTree(props: { readonly sessionId: string; readonly studyRemote: StudyRemote | undefined; readonly selected: StudioTreeSelection; readonly profileStatus?: string; readonly collapsed?: boolean; readonly onToggleCollapsed?: () => void; readonly onSelect: (selection: StudioTreeSelection) => void; readonly onTreeChanged?: () => void }) {
  const b = useBilingualText()
  const sections = localizedSections(b)
  const [knownFolders, setKnownFolders] = useState<ReadonlyMap<string, AssetFolderView>>(new Map())
  const [dialog, setDialog] = useState<FolderDialog>()
  const [folderName, setFolderName] = useState('')
  const [parentId, setParentId] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [loadingMoveTargets, setLoadingMoveTargets] = useState(false)
  const folderLoadGeneration = useRef(0)
  useEffect(() => {
    folderLoadGeneration.current += 1
    setKnownFolders(new Map())
    setDialog(undefined)
    setFailure(undefined)
    setLoadingMoveTargets(false)
  }, [props.sessionId, props.studyRemote])
  const rememberFolders = useCallback((folders: readonly AssetFolderView[]) => {
    setKnownFolders(current => {
      const next = new Map(current)
      for (const folder of folders) next.set(folder.id, folder)
      return next
    })
  }, [])
  const openCreate = (namespace: AssetNamespace, parentIdValue?: string): void => {
    setFolderName(''); setParentId(parentIdValue ?? '')
    setDialog({ kind: 'create', namespace, ...(parentIdValue === undefined ? {} : { parentId: parentIdValue }) })
  }
  const openManage = (folder: AssetFolderView): void => {
    setFolderName(folder.name); setParentId(folder.parentId ?? ''); setDialog({ kind: 'manage', folder })
    if (props.studyRemote === undefined) return
    const generation = ++folderLoadGeneration.current
    setLoadingMoveTargets(true); setFailure(undefined)
    void listAllTreeFolders(props.studyRemote, props.sessionId, folder.namespace)
      .then(folders => { if (generation === folderLoadGeneration.current) rememberFolders(folders) })
      .catch(error => { if (generation === folderLoadGeneration.current) setFailure(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (generation === folderLoadGeneration.current) setLoadingMoveTargets(false) })
  }
  const execute = async (treeCommand: AssetTreeCommand): Promise<void> => {
    if (props.studyRemote === undefined) return
    setBusy(true); setFailure(undefined)
    try {
      const result = await props.studyRemote.executeStudioCommand({ sessionId: props.sessionId, commandId: `asset-tree-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`, command: { kind: 'apply-asset-tree', treeCommand } })
      if (!result.ok) throw new Error(result.error.message)
      setDialog(undefined); setKnownFolders(new Map()); setRefreshVersion(value => value + 1)
      props.onTreeChanged?.()
      if (treeCommand.kind === 'delete-folder' && props.selected.folderId === treeCommand.folderId) props.onSelect({ section: props.selected.section })
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const visibleSections = props.collapsed ? sections.filter(item => item.id === 'library') : sections
  const toggleAssistantSettings = (): void => {
    // Collapsing hides only the assistant-configuration branch.  Never leave
    // the content pane on a now-hidden settings route: return it to Bookroom.
    // A selected library folder is deliberately preserved.
    if (!props.collapsed && props.selected.section !== 'library') props.onSelect({ section: 'library' })
    props.onToggleCollapsed?.()
  }
  return (<nav className="dsh-studio-tree" aria-label={b('书房导航', 'Bookroom navigation')}>
    <header><button type="button" className="dsh-studio-collapse" aria-label={props.collapsed ? b('展开助手设置', 'Expand assistant settings') : b('收起助手设置', 'Collapse assistant settings')} onClick={toggleAssistantSettings}>{props.collapsed ? '»' : '«'}</button><strong>{b('书房', 'Bookroom')}</strong><small>{props.collapsed ? b('文献库', 'Library') : b('文献与助手设置', 'Documents and assistant settings')}</small>{props.collapsed || props.profileStatus === undefined ? null : <span className="dsh-studio-profile-status">{props.profileStatus}</span>}</header>
    {[...new Set(visibleSections.map(item => item.group))].map(group => <section key={group}><h2>{group}</h2>
      {visibleSections.filter(item => item.group === group).map(item => <div className="dsh-studio-tree-branch" key={item.id}>
        <div className="dsh-studio-section-row"><button type="button" title={item.label} aria-current={props.selected.section === item.id && props.selected.folderId === undefined ? 'page' : undefined} onClick={() => props.onSelect({ section: item.id })}>
          <span>{item.label}</span><small>{item.description}</small>
        </button>{item.namespace === undefined ? null : <button type="button" className="dsh-studio-folder-add" aria-label={`${b('新建', 'Create')} ${item.label} ${b('文件夹', 'folder')}`} onClick={() => openCreate(item.namespace!)}>＋</button>}</div>
        {item.namespace !== 'library' ? null : <div className="dsh-studio-folder-level" data-depth="root"><div className="dsh-studio-folder-node dsh-studio-folder-virtual"><span className="dsh-studio-folder-toggle" aria-hidden>•</span><button type="button" className="dsh-studio-folder-select" aria-current={props.selected.section === 'library' && props.selected.folderId === '' ? 'page' : undefined} onClick={() => props.onSelect({ section: 'library', folderId: '' })}><span>{b('未分类', 'Uncategorized')}</span></button></div></div>}
        {item.namespace === undefined ? null : <FolderLevel sessionId={props.sessionId} remote={props.studyRemote} namespace={item.namespace} section={item.id} selected={props.selected} onSelect={props.onSelect} refreshVersion={refreshVersion} onFolders={rememberFolders} onManage={openManage} />}
      </div>)}
    </section>)}
    {failure === undefined ? null : <small className="dsh-studio-tree-error" role="alert">{failure}</small>}
    {dialog === undefined ? null : <FolderDialogView b={b} dialog={dialog} folderName={folderName} parentId={parentId} knownFolders={[...knownFolders.values()]} busy={busy} loadingMoveTargets={loadingMoveTargets} onName={setFolderName} onParent={setParentId} onCreateChild={openCreate} onExecute={execute} onClose={() => setDialog(undefined)} />}
  </nav>)
}

function FolderDialogView(props: { readonly b: BilingualText; readonly dialog: FolderDialog; readonly folderName: string; readonly parentId: string; readonly knownFolders: readonly AssetFolderView[]; readonly busy: boolean; readonly loadingMoveTargets: boolean; readonly onName: (name: string) => void; readonly onParent: (id: string) => void; readonly onCreateChild: (namespace: AssetNamespace, parentId: string) => void; readonly onExecute: (command: AssetTreeCommand) => Promise<void>; readonly onClose: () => void }) {
  if (props.dialog.kind === 'create') {
    const dialog = props.dialog
    return <div className="dsh-studio-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose() }}><div className="dsh-studio-dialog" role="dialog" aria-modal="true" aria-label={props.b('新建文件夹', 'Create folder')}><h2>{dialog.parentId === undefined ? props.b('新建文件夹', 'Create folder') : props.b('新建子文件夹', 'Create subfolder')}</h2><label>{props.b('名称', 'Name')}<input aria-label={props.b('文件夹名称', 'Folder name')} value={props.folderName} disabled={props.busy} onChange={event => props.onName(event.currentTarget.value)} /></label><div><button type="button" disabled={props.busy || props.folderName.trim() === ''} onClick={() => void props.onExecute({ kind: 'create-folder', namespace: dialog.namespace, name: props.folderName, ...(dialog.parentId === undefined ? {} : { parentId: dialog.parentId }) })}>{props.b('创建', 'Create')}</button><button type="button" onClick={props.onClose}>{props.b('取消', 'Cancel')}</button></div></div></div>
  }
  const folder = props.dialog.folder
  return (<div className="dsh-studio-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose() }}>
    <div className="dsh-studio-dialog" role="dialog" aria-modal="true" aria-label={`${props.b('管理', 'Manage')} ${folder.name}`}>
      <h2>{props.b('管理', 'Manage')} {folder.name}</h2>
      <label>{props.b('名称', 'Name')}<input aria-label={props.b('文件夹名称', 'Folder name')} value={props.folderName} disabled={props.busy || !folder.capabilities.canRename} onChange={event => props.onName(event.currentTarget.value)} /></label>
      <label>{props.b('上级', 'Parent')}<select aria-label={props.b('文件夹上级', 'Parent folder')} value={props.parentId} disabled={props.busy || props.loadingMoveTargets || !folder.capabilities.canMove} onChange={event => props.onParent(event.currentTarget.value)}><option value="">{props.loadingMoveTargets ? props.b('正在读取文件夹…', 'Loading folders…') : props.b('根目录', 'Root')}</option>{folderMoveTargets(folder, props.knownFolders).map(candidate => <option value={candidate.id} key={candidate.id}>{folderPath(candidate, props.knownFolders)}</option>)}</select></label>
      <div><span className="dsh-studio-folder-actions"><button type="button" disabled={props.busy || !folder.capabilities.canCreateChild} onClick={() => props.onCreateChild(folder.namespace, folder.id)}>{props.b('新建子文件夹', 'Create subfolder')}</button><button type="button" disabled={props.busy || !folder.capabilities.canRename || props.folderName.trim() === '' || props.folderName.trim() === folder.name} onClick={() => void props.onExecute({ kind: 'rename-folder', folderId: folder.id, name: props.folderName, expectedVersion: folder.version })}>{props.b('重命名', 'Rename')}</button><button type="button" disabled={props.busy || !folder.capabilities.canMove || props.parentId === (folder.parentId ?? '')} onClick={() => void props.onExecute({ kind: 'move-folder', folderId: folder.id, expectedVersion: folder.version, ...(props.parentId === '' ? {} : { parentId: props.parentId }) })}>{props.b('移动', 'Move')}</button><button type="button" disabled={props.busy || !folder.capabilities.canDelete} onClick={() => void props.onExecute({ kind: 'delete-folder', folderId: folder.id, expectedVersion: folder.version })}>{props.b('删除空文件夹', 'Delete empty folder')}</button></span><button type="button" onClick={props.onClose}>{props.b('取消', 'Cancel')}</button></div>
    </div>
  </div>)
}

function FolderLevel(props: { readonly sessionId: string; readonly remote: StudyRemote | undefined; readonly namespace: AssetNamespace; readonly section: StudioSection; readonly parentId?: string; readonly selected: StudioTreeSelection; readonly onSelect: (selection: StudioTreeSelection) => void; readonly refreshVersion: number; readonly onFolders: (folders: readonly AssetFolderView[]) => void; readonly onManage: (folder: AssetFolderView) => void }) {
  const b = useBilingualText()
  const [folders, setFolders] = useState<readonly AssetFolderView[]>([])
  const [cursor, setCursor] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const [failure, setFailure] = useState<string>()
  const generation = useRef(0)
  const load = async (next?: string): Promise<void> => {
    if (props.remote === undefined) return
    const expectedGeneration = generation.current
    const result = await props.remote.listTreeChildren({ sessionId: props.sessionId, namespace: props.namespace, ...(props.parentId === undefined ? {} : { parentId: props.parentId }), ...(next === undefined ? {} : { cursor: next }), limit: 40 })
    if (expectedGeneration !== generation.current) return
    if (!result.ok) { setFailure(result.error.message); return }
    setFolders(current => next === undefined ? result.value.folders : [...current, ...result.value.folders])
    props.onFolders(result.value.folders); setCursor(result.value.nextCursor); setLoaded(true)
  }
  useEffect(() => {
    generation.current += 1
    setFolders([]); setCursor(undefined); setLoaded(false); setFailure(undefined)
    if (props.remote === undefined) return
    let cancelled = false
    void props.remote.listTreeChildren({ sessionId: props.sessionId, namespace: props.namespace, ...(props.parentId === undefined ? {} : { parentId: props.parentId }), limit: 40 }).then(result => {
      if (cancelled) return
      if (!result.ok) { setFailure(result.error.message); return }
      setFolders(result.value.folders); props.onFolders(result.value.folders); setCursor(result.value.nextCursor); setLoaded(true)
    }).catch(error => { if (!cancelled) setFailure(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true }
  }, [props.sessionId, props.remote, props.namespace, props.parentId, props.refreshVersion])
  if (!loaded && failure === undefined) return null
  return (<div className="dsh-studio-folder-level" data-depth={props.parentId === undefined ? 'root' : 'nested'}>
    {failure === undefined ? null : <small role="alert">{failure}</small>}
    {folders.map(folder => <FolderNode key={folder.id} folder={folder} {...props} />)}
    {cursor === undefined ? null : <button type="button" className="dsh-studio-tree-more" onClick={() => void load(cursor)}>{b('加载更多文件夹', 'Load more folders')}</button>}
  </div>)
}

function folderPath(folder: AssetFolderView, folders: readonly AssetFolderView[]): string {
  const byId = new Map(folders.map(candidate => [candidate.id, candidate]))
  const parts: string[] = []
  const visited = new Set<string>()
  let current: AssetFolderView | undefined = folder
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id); parts.unshift(current.name)
    current = current.parentId === undefined ? undefined : byId.get(current.parentId)
  }
  return parts.join(' / ')
}

function folderMoveTargets(folder: AssetFolderView, folders: readonly AssetFolderView[]): readonly AssetFolderView[] {
  const byId = new Map(folders.map(candidate => [candidate.id, candidate]))
  const isDescendant = (candidate: AssetFolderView): boolean => {
    const visited = new Set<string>()
    let current: AssetFolderView | undefined = candidate
    while (current?.parentId !== undefined && !visited.has(current.id)) {
      visited.add(current.id)
      if (current.parentId === folder.id) return true
      current = byId.get(current.parentId)
    }
    return false
  }
  return folders
    .filter(candidate => candidate.namespace === folder.namespace && candidate.id !== folder.id && candidate.capabilities.canAcceptAssets && !isDescendant(candidate))
    .sort((left, right) => folderPath(left, folders).localeCompare(folderPath(right, folders)))
}

async function listAllTreeFolders(remote: StudyRemote, sessionId: string, namespace: AssetNamespace): Promise<readonly AssetFolderView[]> {
  const folders: AssetFolderView[] = []
  const pending: Array<string | undefined> = [undefined]
  const visitedParents = new Set<string>()
  while (pending.length > 0) {
    const parentId = pending.shift()
    const parentKey = parentId ?? ''
    if (visitedParents.has(parentKey)) continue
    visitedParents.add(parentKey)
    let cursor: string | undefined
    do {
      const result = await remote.listTreeChildren({ sessionId, namespace, ...(parentId === undefined ? {} : { parentId }), ...(cursor === undefined ? {} : { cursor }), limit: 100 })
      if (!result.ok) throw new Error(result.error.message)
      folders.push(...result.value.folders)
      pending.push(...result.value.folders.map(folder => folder.id))
      cursor = result.value.nextCursor
    } while (cursor !== undefined)
  }
  return folders
}

function FolderNode(props: { readonly folder: AssetFolderView; readonly sessionId: string; readonly remote: StudyRemote | undefined; readonly namespace: AssetNamespace; readonly section: StudioSection; readonly selected: StudioTreeSelection; readonly onSelect: (selection: StudioTreeSelection) => void; readonly refreshVersion: number; readonly onFolders: (folders: readonly AssetFolderView[]) => void; readonly onManage: (folder: AssetFolderView) => void }) {
  const b = useBilingualText()
  const storageKey = `dsh.study-reader.studio-tree-expanded.v1:${props.sessionId}:${props.namespace}:${props.folder.id}`
  const [expanded, setExpanded] = useState(() => globalThis.localStorage?.getItem(storageKey) === 'true')
  const toggle = (): void => setExpanded(value => { const next = !value; globalThis.localStorage?.setItem(storageKey, String(next)); return next })
  return (<div className="dsh-studio-folder-node" onContextMenu={event => { event.preventDefault(); props.onManage(props.folder) }}>
    <button type="button" className="dsh-studio-folder-toggle" aria-label={`${expanded ? b('折叠', 'Collapse') : b('展开', 'Expand')} ${props.folder.name}`} aria-expanded={expanded} onClick={toggle}>{expanded ? '▾' : '▸'}</button>
    <button type="button" className="dsh-studio-folder-select" aria-current={props.selected.section === props.section && props.selected.folderId === props.folder.id ? 'page' : undefined} onClick={() => props.onSelect({ section: props.section, folderId: props.folder.id })}><span>{props.folder.name}</span></button>
    <button type="button" className="dsh-studio-folder-menu" aria-label={`${b('管理', 'Manage')} ${props.folder.name}`} onClick={() => props.onManage(props.folder)}>•••</button>
    {expanded ? <FolderLevel sessionId={props.sessionId} remote={props.remote} namespace={props.namespace} section={props.section} parentId={props.folder.id} selected={props.selected} onSelect={props.onSelect} refreshVersion={props.refreshVersion} onFolders={props.onFolders} onManage={props.onManage} /> : null}
  </div>)
}
