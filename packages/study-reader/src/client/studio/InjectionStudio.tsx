/** Durable Prompt/Profile editor backed exclusively by the Host Studio repository. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CompiledInjection, InjectionProfileRecord, InjectionPromptChoice, InjectionSkillDescriptor, InjectionStudioSnapshot, ProfileSkillBinding, PromptAssetRecord, PromptBinding, PromptLayer, StudioAssetSummary, ToolPolicyBinding } from '../../studio/types.ts'
import type { ToolDescriptorView } from '../../study/types.ts'
import type { StudyRemote } from '../remote.ts'
import { useBilingualText } from '../StudyLocale.tsx'

type Mode = 'prompts' | 'profiles'
const DEFAULT_PROFILE_ID = 'study-reader:default-profile'
const commandId = (kind: string): string => `studio:${kind}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
const currentPrompt = (asset: PromptAssetRecord) => asset.revisions.find(item => item.version === asset.currentVersion) ?? asset.revisions.at(-1)!
const currentProfile = (asset: InjectionProfileRecord) => asset.revisions.find(item => item.version === asset.currentVersion) ?? asset.revisions.at(-1)!
function folderPath(id: string, folders: InjectionStudioSnapshot['folders']): string {
  const parts: string[] = []
  const visited = new Set<string>()
  let current = folders.find(folder => folder.id === id)
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id); parts.unshift(current.name)
    current = current.parentId === undefined ? undefined : folders.find(folder => folder.id === current!.parentId)
  }
  return parts.join(' / ')
}

export function InjectionStudio(props: { readonly mode: Mode; readonly sessionId: string; readonly studyRemote: StudyRemote | undefined; readonly folderId?: string; readonly onFolderSelect?: (folderId?: string) => void; readonly onStudioChanged?: () => void }) {
  const b = useBilingualText()
  const [snapshot, setSnapshot] = useState<InjectionStudioSnapshot>()
  const [tools, setTools] = useState<readonly ToolDescriptorView[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [assetRows, setAssetRows] = useState<readonly StudioAssetSummary[]>([])
  const [assetCursor, setAssetCursor] = useState<string>()
  const [selectedPrompt, setSelectedPrompt] = useState<PromptAssetRecord>()
  const [selectedProfile, setSelectedProfile] = useState<InjectionProfileRecord>()
  const [moveDialogOpen, setMoveDialogOpen] = useState(false)
  const [moveFolderId, setMoveFolderId] = useState('')
  const [assetQuery, setAssetQuery] = useState('')
  const [submittedAssetQuery, setSubmittedAssetQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const reloadGeneration = useRef(0)
  const reload = useCallback(async () => {
    if (props.studyRemote === undefined) return
    const generation = ++reloadGeneration.current
    setFailure(undefined)
    try {
      const namespace = props.mode === 'prompts' ? 'prompt' as const : 'profile' as const
      const [studio, catalog, page] = await Promise.all([props.studyRemote.studioSnapshot({ sessionId: props.sessionId }), props.studyRemote.listToolCatalog({ sessionId: props.sessionId }), props.studyRemote.listAssets({ sessionId: props.sessionId, namespace, archived: showArchived ? 'archived' : 'active', ...(props.folderId === undefined ? {} : { folderId: props.folderId }), ...(submittedAssetQuery === '' ? {} : { query: submittedAssetQuery }), limit: 40 })])
      if (!studio.ok) throw new Error(studio.error.message)
      if (!catalog.ok) throw new Error(catalog.error.message)
      if (!page.ok) throw new Error(page.error.message)
      if (generation !== reloadGeneration.current) return
      setSnapshot(studio.value); setTools(catalog.value)
      setAssetRows(page.value.assets); setAssetCursor(page.value.nextCursor)
      setSelectedId(current => {
        if (current === '__new__' || props.mode === 'profiles' && current === DEFAULT_PROFILE_ID) return current
        if (page.value.assets.some(asset => asset.id === current)) return current
        if (showArchived) return page.value.assets[0]?.id
        if (props.mode === 'profiles') return studio.value.binding?.profileId ?? DEFAULT_PROFILE_ID
        return page.value.assets[0]?.id
      })
    } catch (error) { if (generation === reloadGeneration.current) setFailure(error instanceof Error ? error.message : String(error)) }
  }, [props.folderId, props.mode, props.sessionId, props.studyRemote, showArchived, submittedAssetQuery])
  const selectedRecordVersion = assetRows.find(asset => asset.id === selectedId)?.recordVersion
  useEffect(() => {
    setSnapshot(undefined); setSelectedId(undefined); setSelectedPrompt(undefined); setSelectedProfile(undefined)
    void reload()
    return () => { reloadGeneration.current += 1 }
  }, [reload])
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setFailure(undefined)
    try { await action(); await reload(); props.onStudioChanged?.() } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  useEffect(() => {
    setSelectedPrompt(undefined); setSelectedProfile(undefined)
    if (props.studyRemote === undefined || selectedId === undefined || selectedId === '__new__' || selectedId === DEFAULT_PROFILE_ID || selectedId === snapshot?.immutableBaseline.id) return
    let cancelled = false
    const kind = props.mode === 'prompts' ? 'prompt' as const : 'profile' as const
    void props.studyRemote.getAssetDetail({ sessionId: props.sessionId, kind, assetId: selectedId }).then(result => {
      if (cancelled || !result.ok) return
      if (result.value.kind === 'prompt') setSelectedPrompt(result.value.value)
      if (result.value.kind === 'profile') setSelectedProfile(result.value.value)
    }).catch(error => { if (!cancelled) setFailure(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true }
  }, [props.mode, props.sessionId, props.studyRemote, selectedId, selectedRecordVersion, snapshot?.immutableBaseline.id])
  const selectedAsset = selectedPrompt ?? selectedProfile
  const namespace = props.mode === 'prompts' ? 'prompt' as const : 'profile' as const
  const folders = snapshot?.folders.filter(folder => folder.namespace === namespace) ?? []
  const loadMoreAssets = async (): Promise<void> => {
    if (props.studyRemote === undefined || assetCursor === undefined) return
    const generation = reloadGeneration.current
    const result = await props.studyRemote.listAssets({ sessionId: props.sessionId, namespace, archived: showArchived ? 'archived' : 'active', ...(props.folderId === undefined ? {} : { folderId: props.folderId }), ...(submittedAssetQuery === '' ? {} : { query: submittedAssetQuery }), cursor: assetCursor, limit: 40 })
    if (generation !== reloadGeneration.current) return
    if (!result.ok) { setFailure(result.error.message); return }
    setAssetRows(current => [...current, ...result.value.assets]); setAssetCursor(result.value.nextCursor)
  }
  const treeCommand = async (command: import('../../studio/types.ts').AssetTreeCommand): Promise<void> => { await run(async () => {
    const result = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('asset-tree'), command: { kind: 'apply-asset-tree', treeCommand: command } })
    if (!result.ok) throw new Error(result.error.message)
  }) }
  const loadCurrentProfileDraft = useCallback(async (): Promise<ProfileDraft> => {
    if (props.studyRemote === undefined || snapshot === undefined) throw new Error(b('当前设置尚未载入。', 'Current settings have not loaded.'))
    if (snapshot.binding === undefined) return {
      name: b('默认预设副本', 'Default preset copy'), description: b('基于系统内置默认预设创建，可独立调整。', 'Created from the built-in default preset and independently editable.'), promptBindings: [],
      skillBindings: snapshot.skills.filter(skill => skill.origin === 'builtin').map(skill => ({ skillId: skill.id, skillVersion: skill.version, enabled: true, invocation: 'both' as const })),
      toolPolicies: tools.map(tool => ({ toolName: tool.name, enabled: tool.enabledInCurrentProfile })), modelPolicy: { kind: 'inherit-session' },
    }
    const result = await props.studyRemote.getAssetDetail({ sessionId: props.sessionId, kind: 'profile', assetId: snapshot.binding.profileId })
    if (!result.ok) throw new Error(result.error.message)
    if (result.value.kind !== 'profile') throw new Error(b('当前配置预设类型不正确。', 'The current configuration preset has an invalid type.'))
    const profile = result.value.value
    const revision = profile.revisions.find(candidate => candidate.version === snapshot.binding!.profileVersion)
    if (revision === undefined) throw new Error(b('当前配置预设内容不存在。', 'The current configuration preset revision is missing.'))
    return {
      name: b(`${profile.name} 副本`, `${profile.name} copy`), description: profile.description,
      promptBindings: revision.promptBindings, skillBindings: revision.skillBindings,
      toolPolicies: revision.toolPolicies, modelPolicy: { kind: 'inherit-session' },
    }
  }, [b, props.sessionId, props.studyRemote, snapshot, tools])
  const sectionName = props.mode === 'prompts' ? b('提示词注入', 'Prompt injections') : b('配置预设', 'Configuration presets')
  return <section className="dsh-injection-studio" aria-label={sectionName}>
    <aside className="dsh-injection-list"><header><div><h1>{sectionName}</h1><p>{props.mode === 'prompts' ? b('管理注入到系统提示词的内容', 'Manage content injected into the system prompt') : b('组合提示词、Skills 与 Tools', 'Combine prompts, Skills, and Tools')}</p></div><button type="button" aria-label={b(`新建${sectionName}`, `Create ${sectionName.toLowerCase()}`)} disabled={busy || props.studyRemote === undefined} onClick={() => { setSelectedId('__new__') }}>{b('新建', 'New')}</button></header>
      {failure === undefined ? null : <p role="alert" className="dsh-studio-alert">{failure}</p>}
      <form className="dsh-studio-list-search" onSubmit={event => { event.preventDefault(); setSubmittedAssetQuery(assetQuery.trim()) }}><input aria-label={b(`搜索${sectionName}`, `Search ${sectionName.toLowerCase()}`)} value={assetQuery} onChange={event => setAssetQuery(event.currentTarget.value)} placeholder={b('搜索名称或说明', 'Search name or description')} /><button type="submit">{b('搜索', 'Search')}</button>{submittedAssetQuery === '' ? null : <button type="button" onClick={() => { setAssetQuery(''); setSubmittedAssetQuery('') }}>{b('清除', 'Clear')}</button>}</form>
      <button type="button" aria-pressed={showArchived} onClick={() => { setShowArchived(value => !value); setSelectedId(undefined) }}>{showArchived ? b('返回使用中', 'Back to active') : b('查看已归档', 'View archived')}</button>
      {props.mode === 'prompts' && snapshot !== undefined && !showArchived ? <button type="button" className="dsh-baseline-row" onClick={() => { setSelectedId(snapshot.immutableBaseline.id) }} aria-current={selectedId === snapshot.immutableBaseline.id ? 'page' : undefined}><strong>{snapshot.immutableBaseline.name}</strong><small>{b('内置 · 只读 · 始终生效', 'Built in · read only · always active')}</small></button> : null}
      {props.mode === 'profiles' && snapshot !== undefined && !showArchived ? <button type="button" className="dsh-baseline-row" onClick={() => { setSelectedId(DEFAULT_PROFILE_ID) }} aria-current={selectedId === DEFAULT_PROFILE_ID ? 'page' : undefined}><strong>{b('默认预设', 'Default preset')}</strong><small>{b(`系统内置 · 只读${snapshot.binding === undefined ? ' · 当前使用' : ''}`, `Built in · read only${snapshot.binding === undefined ? ' · active' : ''}`)}</small></button> : null}
      {assetRows.map(asset => <button type="button" key={asset.id} onClick={() => { setSelectedId(asset.id) }} onContextMenu={event => { event.preventDefault(); setSelectedId(asset.id); setMoveFolderId(asset.folderId ?? ''); setMoveDialogOpen(true) }} aria-current={selectedId === asset.id ? 'page' : undefined} title={b('右键可移动', 'Right-click to move')}><strong>{asset.name}</strong><small>{asset.archived ? b('已归档', 'Archived') : props.mode === 'prompts' ? b('我的提示', 'My prompt') : b('我的预设', 'My preset')}</small></button>)}
      {assetCursor === undefined ? null : <button type="button" disabled={busy} onClick={() => void loadMoreAssets()}>{b('加载更多', 'Load more')}</button>}
      {selectedId !== undefined && selectedId !== '__new__' && selectedId !== DEFAULT_PROFILE_ID && selectedId !== snapshot?.immutableBaseline.id && selectedAsset !== undefined ? <button type="button" className="dsh-move-asset" onClick={() => { setMoveFolderId(selectedAsset.folderId ?? ''); setMoveDialogOpen(true) }}>{b('移动到…', 'Move to…')}</button> : null}
    </aside>
    <main className="dsh-injection-detail">
      {snapshot === undefined ? <p>{b('正在读取设置…', 'Loading settings…')}</p>
        : props.mode === 'prompts' && selectedId === snapshot.immutableBaseline.id ? <BaselineDetail asset={snapshot.immutableBaseline} busy={busy} onClone={async () => { const revision = currentPrompt(snapshot.immutableBaseline); await run(async () => { const result = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('clone-baseline'), command: { kind: 'create-prompt', name: `${snapshot.immutableBaseline.name} copy`, description: snapshot.immutableBaseline.description, layer: revision.layer, priority: revision.priority, content: revision.content } }); if (!result.ok) throw new Error(result.error.message); setSelectedId(result.value.prompt?.id) }) }} />
        : props.mode === 'prompts' && selectedId === '__new__' ? <PromptEditor key="new-prompt" busy={busy} onSave={async draft => { await run(async () => { const result = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('create-prompt'), command: { kind: 'create-prompt', ...draft } }); if (!result.ok) throw new Error(result.error.message); setSelectedId(result.value.prompt?.id) }) }} />
        : props.mode === 'prompts' && selectedPrompt !== undefined ? <PromptEditor key={`${selectedPrompt.id}:${selectedPrompt.recordVersion}`} asset={selectedPrompt} busy={busy} onSave={async draft => { await run(async () => { const result = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('revise-prompt'), command: { kind: 'revise-prompt', promptId: selectedPrompt.id, expectedRecordVersion: selectedPrompt.recordVersion, ...draft } }); if (!result.ok) throw new Error(result.error.message) }) }} onClone={async () => { const revision = currentPrompt(selectedPrompt); await run(async () => { const result = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('clone-prompt'), command: { kind: 'create-prompt', name: `${selectedPrompt.name} copy`, description: selectedPrompt.description, layer: revision.layer, priority: revision.priority, content: revision.content, ...(selectedPrompt.folderId === undefined ? {} : { folderId: selectedPrompt.folderId }) } }); if (!result.ok) throw new Error(result.error.message); setSelectedId(result.value.prompt?.id) }) }} onArchive={async () => { await run(async () => { const result = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('archive-prompt'), command: { kind: 'archive-prompt', promptId: selectedPrompt.id, expectedRecordVersion: selectedPrompt.recordVersion, archived: !selectedPrompt.archived } }); if (!result.ok) throw new Error(result.error.message) }) }} onDelete={async () => { await run(async () => { const result = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('delete-prompt'), command: { kind: 'delete-prompt', promptId: selectedPrompt.id, expectedRecordVersion: selectedPrompt.recordVersion } }); if (!result.ok) throw new Error(result.error.message); setSelectedId(undefined) }) }} />
        : props.mode === 'profiles' && selectedId === DEFAULT_PROFILE_ID ? <DefaultProfileDetail skills={snapshot.skills.filter(skill => skill.origin === 'builtin')} tools={tools.filter(tool => tool.enabledInCurrentProfile)} active={snapshot.binding === undefined} onCopy={() => { setSelectedId('__new__') }} />
        : props.mode === 'profiles' && selectedId === '__new__' ? <ProfileEditor key="new-profile" prompts={snapshot.prompts} skills={snapshot.skills} tools={tools} busy={busy} binding={snapshot.binding} onUseCurrent={loadCurrentProfileDraft} onSave={async draft => { await run(async () => { const result = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('create-profile'), command: { kind: 'create-profile', ...draft } }); if (!result.ok) throw new Error(result.error.message); setSelectedId(result.value.profile?.id) }) }} />
        : props.mode === 'profiles' && selectedProfile !== undefined ? <ProfileEditor key={`${selectedProfile.id}:${selectedProfile.recordVersion}`} asset={selectedProfile} prompts={snapshot.prompts} skills={snapshot.skills} tools={tools} busy={busy} binding={snapshot.binding} onSave={async draft => { await run(async () => {
          const revised = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('revise-profile'), command: { kind: 'revise-profile', profileId: selectedProfile.id, expectedRecordVersion: selectedProfile.recordVersion, ...draft } })
          if (!revised.ok) throw new Error(revised.error.message)
          if (snapshot.binding?.profileId === selectedProfile.id && revised.value.profile !== undefined) {
            const activated = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('apply-profile-changes'), command: { kind: 'activate-profile', profileId: selectedProfile.id, profileVersion: revised.value.profile.currentVersion, expectedBindingVersion: snapshot.binding.recordVersion } })
            if (!activated.ok) throw new Error(activated.error.message)
          }
        }) }} onClone={async () => { const revision = currentProfile(selectedProfile); await run(async () => { const result = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('clone-profile'), command: { kind: 'create-profile', name: `${selectedProfile.name} copy`, description: selectedProfile.description, promptBindings: revision.promptBindings, skillBindings: revision.skillBindings, toolPolicies: revision.toolPolicies, modelPolicy: revision.modelPolicy, ...(selectedProfile.folderId === undefined ? {} : { folderId: selectedProfile.folderId }) } }); if (!result.ok) throw new Error(result.error.message); setSelectedId(result.value.profile?.id) }) }} onCompile={async () => { const result = await props.studyRemote!.compileInjectionProfile({ sessionId: props.sessionId, profileId: selectedProfile.id, profileVersion: selectedProfile.currentVersion }); if (!result.ok) throw new Error(result.error.message); return result.value }} onActivate={async () => { await run(async () => { const result = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('activate-profile'), command: { kind: 'activate-profile', profileId: selectedProfile.id, profileVersion: selectedProfile.currentVersion, expectedBindingVersion: snapshot.binding?.recordVersion ?? 0 } }); if (!result.ok) throw new Error(result.error.message) }) }} {...snapshot.binding?.profileId !== selectedProfile.id ? {} : { onDeactivate: async () => { await run(async () => { const result = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('deactivate-profile'), command: { kind: 'deactivate-profile', expectedBindingVersion: snapshot.binding!.recordVersion } }); if (!result.ok) throw new Error(result.error.message) }) } }} onArchive={async () => { await run(async () => { const result = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('archive-profile'), command: { kind: 'archive-profile', profileId: selectedProfile.id, expectedRecordVersion: selectedProfile.recordVersion, archived: !selectedProfile.archived } }); if (!result.ok) throw new Error(result.error.message) }) }} onDelete={async () => { await run(async () => { const result = await props.studyRemote!.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('delete-profile'), command: { kind: 'delete-profile', profileId: selectedProfile.id, expectedRecordVersion: selectedProfile.recordVersion } }); if (!result.ok) throw new Error(result.error.message); setSelectedId(undefined) }) }} />
        : <div className="dsh-studio-empty"><h2>{b('选择或创建一个', 'Select or create a ')}{sectionName}</h2><p>{b('选择后可以直接编辑、保存、归档或删除。', 'Then edit, save, archive, or delete it directly.')}</p></div>}
    </main>
    {moveDialogOpen && selectedAsset !== undefined ? <div className="dsh-studio-dialog-backdrop" role="presentation"><section className="dsh-studio-dialog" role="dialog" aria-modal="true" aria-labelledby="dsh-move-asset-title"><h2 id="dsh-move-asset-title">{b(`移动“${selectedAsset.name}”`, `Move “${selectedAsset.name}”`)}</h2><label>{b('目标文件夹', 'Destination folder')}<select autoFocus value={moveFolderId} onChange={event => setMoveFolderId(event.currentTarget.value)}><option value="">{b('未分类', 'Uncategorized')}</option>{folders.map(folder => <option value={folder.id} key={folder.id}>{folderPath(folder.id, folders)}</option>)}</select></label><div><button type="button" onClick={() => setMoveDialogOpen(false)}>{b('取消', 'Cancel')}</button><button type="button" disabled={busy || moveFolderId === (selectedAsset.folderId ?? '')} onClick={() => { const next = moveFolderId; void treeCommand({ kind: 'move-asset', namespace, assetId: selectedAsset.id, expectedVersion: selectedAsset.recordVersion, ...(next === '' ? {} : { folderId: next }) }).then(() => { setMoveDialogOpen(false); props.onFolderSelect?.(next === '' ? undefined : next) }) }}>{b('移动', 'Move')}</button></div></section></div> : null}
  </section>
}

function BaselineDetail({ asset, busy, onClone }: { readonly asset: PromptAssetRecord; readonly busy: boolean; readonly onClone: () => Promise<void> }) {
  const b = useBilingualText()
  const revision = currentPrompt(asset)
  return <article className="dsh-asset-readonly"><header><div><h1>{asset.name}</h1><p>{asset.description}</p></div><div><span>{b('只读', 'Read only')}</span><button type="button" disabled={busy} onClick={() => void onClone()}>{b('复制为可编辑提示', 'Copy as editable prompt')}</button></div></header><dl><div><dt>{b('适用层级', 'Layer')}</dt><dd>{revision.layer}</dd></div><div><dt>{b('内容校验值', 'Content hash')}</dt><dd><code>{revision.contentHash}</code></dd></div></dl><pre>{revision.content}</pre></article>
}

function DefaultProfileDetail(props: { readonly skills: readonly InjectionSkillDescriptor[]; readonly tools: readonly ToolDescriptorView[]; readonly active: boolean; readonly onCopy: () => void }) {
  const b = useBilingualText()
  return <article className="dsh-asset-readonly"><header><div><h1>{b('默认预设', 'Default preset')}</h1><p>{b('没有选择自定义预设时，系统会使用这套只读配置；它不是“没有配置”。', 'When no custom preset is selected, this read-only preset remains active. It is not an unconfigured state.')}</p></div><div><span>{b(`系统内置 · 只读${props.active ? ' · 当前使用' : ''}`, `Built in · read only${props.active ? ' · active' : ''}`)}</span><button type="button" onClick={props.onCopy}>{b('复制为可编辑预设', 'Copy as editable preset')}</button></div></header>
    <section><h2>{b('提示词注入', 'Prompt injections')}</h2><p>{b('安全基础始终生效，不能被配置预设关闭。', 'The safety baseline is always active and cannot be disabled by a preset.')}</p></section>
    <section><h2>Skills（{props.skills.length}）</h2><ul>{props.skills.map(skill => <li key={skill.id}><strong>{skill.name}</strong><span>{skill.description}</span></li>)}</ul></section>
    <section><h2>Tools（{props.tools.length}）</h2><ul>{props.tools.map(tool => <li key={tool.name}><strong>{tool.title}</strong><code>{tool.name}</code></li>)}</ul></section>
  </article>
}

interface PromptDraft { readonly name: string; readonly description: string; readonly layer: PromptLayer; readonly priority: number; readonly content: string }
function PromptEditor(props: { readonly asset?: PromptAssetRecord; readonly busy: boolean; readonly onSave: (draft: PromptDraft) => Promise<void>; readonly onClone?: () => Promise<void>; readonly onArchive?: () => Promise<void>; readonly onDelete?: () => Promise<void> }) {
  const b = useBilingualText()
  const revision = props.asset === undefined ? undefined : currentPrompt(props.asset)
  const [name, setName] = useState(props.asset?.name ?? ''); const [description, setDescription] = useState(props.asset?.description ?? '')
  const [layer] = useState<PromptLayer>('system-addon'); const [priority, setPriority] = useState(revision?.priority ?? 0); const [content, setContent] = useState(revision?.content ?? '')
  return <form className="dsh-asset-editor" onSubmit={event => { event.preventDefault(); void props.onSave({ name, description, layer, priority, content }) }}><header><div><h1>{props.asset === undefined ? b('新建提示词注入', 'New prompt injection') : props.asset.name}</h1><p>{props.asset === undefined ? b('写下要注入系统提示词的内容。', 'Write the content to inject into the system prompt.') : b('修改后直接保存。', 'Edit and save directly.')}</p></div><div className="dsh-editor-actions"><button type="submit" disabled={props.busy || name.trim() === '' || content.trim() === ''}>{props.busy ? b('保存中…', 'Saving…') : props.asset === undefined ? b('创建提示词注入', 'Create prompt injection') : b('保存修改', 'Save changes')}</button>{props.onClone === undefined ? null : <button type="button" onClick={() => void props.onClone!()}>{b('复制', 'Copy')}</button>}{props.onArchive === undefined ? null : <button type="button" onClick={() => { void props.onArchive!() }}>{props.asset?.archived ? b('恢复', 'Restore') : b('归档', 'Archive')}</button>}{props.asset?.archived !== true || props.onDelete === undefined ? null : <button type="button" onClick={() => { if (globalThis.confirm(b(`永久删除提示词注入“${props.asset!.name}”？此操作无法恢复。`, `Permanently delete prompt injection “${props.asset!.name}”? This cannot be undone.`))) void props.onDelete!() }}>{b('永久删除', 'Delete permanently')}</button>}</div></header>
    <label>{b('名称', 'Name')}<input value={name} maxLength={120} onChange={event => { setName(event.currentTarget.value) }} /></label><label>{b('说明', 'Description')}<input value={description} onChange={event => { setDescription(event.currentTarget.value) }} /></label><div className="dsh-editor-grid"><label>{b('提示层级', 'Prompt layer')}<input value={b('系统补充', 'System add-on')} readOnly /></label><label>{b('优先级', 'Priority')}<input type="number" min={-9999} max={10000} value={priority} onChange={event => { setPriority(event.currentTarget.valueAsNumber) }} /></label></div><label>{b('提示内容', 'Prompt content')}<textarea value={content} onChange={event => { setContent(event.currentTarget.value) }} spellCheck={false} /></label>{revision === undefined ? null : <p className="dsh-studio-hash">{b('内容校验值：', 'Content hash: ')}<code>{revision.contentHash}</code></p>}</form>
}

interface ProfileDraft { readonly name: string; readonly description: string; readonly promptBindings: readonly PromptBinding[]; readonly skillBindings: readonly ProfileSkillBinding[]; readonly toolPolicies: readonly ToolPolicyBinding[]; readonly modelPolicy: { readonly kind: 'inherit-session' } }
function ProfileEditor(props: { readonly asset?: InjectionProfileRecord; readonly prompts: readonly InjectionPromptChoice[]; readonly skills: readonly InjectionSkillDescriptor[]; readonly tools: readonly ToolDescriptorView[]; readonly busy: boolean; readonly binding?: InjectionStudioSnapshot['binding']; readonly onSave: (draft: ProfileDraft) => Promise<void>; readonly onUseCurrent?: () => Promise<ProfileDraft>; readonly onClone?: () => Promise<void>; readonly onCompile?: (version?: number) => Promise<CompiledInjection>; readonly onActivate?: () => Promise<void>; readonly onDeactivate?: () => Promise<void>; readonly onArchive?: () => Promise<void>; readonly onDelete?: () => Promise<void> }) {
  const b = useBilingualText()
  const revision = props.asset === undefined ? undefined : currentProfile(props.asset)
  const [name, setName] = useState(props.asset?.name ?? ''); const [description, setDescription] = useState(props.asset?.description ?? '')
  const [promptBindings, setPromptBindings] = useState<readonly PromptBinding[]>(revision?.promptBindings ?? []); const [skillBindings, setSkillBindings] = useState<readonly ProfileSkillBinding[]>(revision?.skillBindings ?? []); const [toolPolicies, setToolPolicies] = useState<readonly ToolPolicyBinding[]>(revision?.toolPolicies ?? [])
  const [compiled, setCompiled] = useState<CompiledInjection>(); const [previewFailure, setPreviewFailure] = useState<string>()
  const [copyingCurrent, setCopyingCurrent] = useState(false); const [currentFailure, setCurrentFailure] = useState<string>()
  const initializedCurrent = useRef(false)
  const bound = props.asset !== undefined && props.binding?.profileId === props.asset.id && props.binding.profileVersion === props.asset.currentVersion
  const applyCurrent = useCallback(async (): Promise<void> => {
    if (props.onUseCurrent === undefined) return
    setCopyingCurrent(true); setCurrentFailure(undefined)
    try {
      const draft = await props.onUseCurrent()
      setName(draft.name); setDescription(draft.description); setPromptBindings(draft.promptBindings); setSkillBindings(draft.skillBindings); setToolPolicies(draft.toolPolicies)
    } catch (error) { setCurrentFailure(error instanceof Error ? error.message : String(error)) }
    finally { setCopyingCurrent(false) }
  }, [props.onUseCurrent])
  useEffect(() => {
    if (props.asset !== undefined || props.onUseCurrent === undefined || initializedCurrent.current) return
    initializedCurrent.current = true
    void applyCurrent()
  }, [applyCurrent, props.asset, props.onUseCurrent])
  const promptMap = useMemo(() => new Map(promptBindings.map(binding => [binding.promptId, binding])), [promptBindings])
  return <form className="dsh-asset-editor" onSubmit={event => { event.preventDefault(); void props.onSave({ name, description, promptBindings, skillBindings, toolPolicies, modelPolicy: { kind: 'inherit-session' } }) }}><header><div><h1>{props.asset === undefined ? b('新建配置预设', 'New configuration preset') : props.asset.name}</h1><p>{bound ? b('本次对话正在使用这套预设。', 'This conversation is using this preset.') : props.asset === undefined ? b('已复制本次对话当前有效的设置；修改后保存为独立预设。', 'Current effective settings were copied. Edit and save them as an independent preset.') : b('修改后直接保存。', 'Edit and save directly.')}</p></div><div className="dsh-editor-actions"><button type="submit" disabled={props.busy || copyingCurrent || name.trim() === ''}>{props.busy ? b('保存中…', 'Saving…') : props.asset === undefined ? b('创建配置预设', 'Create preset') : b('保存修改', 'Save changes')}</button>{props.onUseCurrent === undefined ? null : <button type="button" disabled={props.busy || copyingCurrent} onClick={() => { void applyCurrent() }}>{copyingCurrent ? b('读取中…', 'Loading…') : b('重新载入当前设置', 'Reload current settings')}</button>}{props.onClone === undefined ? null : <button type="button" onClick={() => void props.onClone!()}>{b('复制', 'Copy')}</button>}{props.onActivate === undefined ? null : <button type="button" disabled={props.busy || bound || props.asset?.archived} onClick={() => { void props.onActivate!() }}>{bound ? b('正在使用', 'Active') : b('用于本次对话', 'Use in this conversation')}</button>}{props.onDeactivate === undefined ? null : <button type="button" onClick={() => { void props.onDeactivate!() }}>{b('停止使用', 'Stop using')}</button>}{props.onArchive === undefined ? null : <button type="button" onClick={() => { void props.onArchive!() }}>{props.asset?.archived ? b('恢复', 'Restore') : b('归档', 'Archive')}</button>}{props.asset?.archived !== true || props.onDelete === undefined ? null : <button type="button" onClick={() => { if (globalThis.confirm(b(`永久删除配置预设“${props.asset!.name}”？此操作无法恢复。`, `Permanently delete configuration preset “${props.asset!.name}”? This cannot be undone.`))) void props.onDelete!() }}>{b('永久删除', 'Delete permanently')}</button>}</div></header>{currentFailure === undefined ? null : <p role="alert" className="dsh-studio-alert">{currentFailure}</p>}
    <label>{b('名称', 'Name')}<input value={name} maxLength={120} onChange={event => { setName(event.currentTarget.value) }} /></label><label>{b('说明', 'Description')}<input value={description} onChange={event => { setDescription(event.currentTarget.value) }} /></label>
    <fieldset><legend>{b('提示词注入', 'Prompt injections')}</legend><p>{b('安全基础始终生效，不能关闭。', 'The safety baseline is always active and cannot be disabled.')}</p>{props.prompts.filter(prompt => !prompt.archived).map((prompt, index) => { const binding = promptMap.get(prompt.id); return <div className="dsh-skill-binding" key={prompt.id}><label className="dsh-check-row"><input type="checkbox" checked={binding?.enabled ?? false} onChange={event => { const enabled = event.currentTarget.checked; setPromptBindings(current => { const existing = current.find(item => item.promptId === prompt.id); return existing === undefined ? [...current, { promptId: prompt.id, promptVersion: prompt.currentVersion, enabled, order: index }] : current.map(item => item.promptId === prompt.id ? { ...item, enabled } : item) }) }} /><span><strong>{prompt.name}</strong></span></label>{binding?.enabled !== true ? null : <label>{b('顺序', 'Order')}<input type="number" value={binding.order} onChange={event => { const order = event.currentTarget.valueAsNumber; setPromptBindings(current => current.map(item => item.promptId === prompt.id ? { ...item, order } : item)) }} /></label>}</div> })}</fieldset>
    <fieldset><legend>Skills</legend>{props.skills.length === 0 ? <p>{b('还没有可用的 Skill。', 'No Skills are available yet.')}</p> : props.skills.map(skill => { const binding = skillBindings.find(item => item.skillId === skill.id); return <div className="dsh-skill-binding" key={skill.id}><label className="dsh-check-row"><input type="checkbox" checked={binding?.enabled ?? false} onChange={event => { const enabled = event.currentTarget.checked; setSkillBindings(current => { const existing = current.find(item => item.skillId === skill.id); if (existing !== undefined) return current.map(item => item.skillId === skill.id ? { ...item, enabled } : item); return [...current, { skillId: skill.id, skillVersion: skill.version, enabled, invocation: skill.userInvocable && skill.modelInvocable ? 'both' : skill.modelInvocable ? 'model' : 'user' }] }) }} /><span><strong>{skill.name}</strong><small>{b('需要', 'Requires')} {skill.requiredTools.join(', ') || b('无额外工具', 'no additional tools')}</small></span></label>{binding?.enabled ? <select aria-label={b(`${skill.name} 使用方式`, `${skill.name} invocation`)} value={binding.invocation} onChange={event => { const invocation = event.currentTarget.value as ProfileSkillBinding['invocation']; setSkillBindings(current => current.map(item => item.skillId === skill.id ? { ...item, invocation } : item)) }}><option value="user" disabled={!skill.userInvocable}>{b('手动使用', 'User invoked')}</option><option value="model" disabled={!skill.modelInvocable}>{b('助手按需使用', 'Assistant invoked')}</option><option value="both" disabled={!skill.userInvocable || !skill.modelInvocable}>{b('两者均可', 'Both')}</option></select> : null}</div> })}</fieldset>
    <fieldset><legend>Tools</legend>{props.tools.map(tool => { const policy = toolPolicies.find(item => item.toolName === tool.name); return <div className="dsh-tool-policy" key={tool.name}><label className="dsh-check-row"><input type="checkbox" checked={policy?.enabled ?? false} onChange={event => { const enabled = event.currentTarget.checked; setToolPolicies(current => [...current.filter(item => item.toolName !== tool.name), { toolName: tool.name, enabled, ...(policy?.guidanceAppendix === undefined ? {} : { guidanceAppendix: policy.guidanceAppendix }) }]) }} /><span><strong>{b(tool.title, tool.localized?.en.title ?? tool.title)}</strong><small>{tool.name}</small></span></label>{policy?.enabled ? <label>{b('补充说明（可选）', 'Additional guidance (optional)')}<textarea rows={2} maxLength={4000} placeholder={b('例如：检索时优先查找定义；没有特殊要求请留空。', 'Example: prioritize definitions when searching. Leave blank when no special guidance is needed.')} value={policy.guidanceAppendix ?? ''} onChange={event => { const guidanceAppendix = event.currentTarget.value; setToolPolicies(current => current.map(item => item.toolName === tool.name ? { ...item, guidanceAppendix } : item)) }} /></label> : null}</div> })}</fieldset>
    {props.onCompile === undefined ? null : <section className="dsh-compile-preview"><div className="dsh-compile-heading"><h2>{b('预设预览', 'Preset preview')}</h2><button type="button" onClick={() => { setPreviewFailure(undefined); void props.onCompile!().then(setCompiled).catch(error => { setPreviewFailure(error instanceof Error ? error.message : String(error)) }) }}>{b('生成预览', 'Generate preview')}</button></div>{previewFailure === undefined ? null : <p role="alert">{previewFailure}</p>}{compiled === undefined ? <p>{b('预览不会改变当前对话，只用于确认最终会采用的提示、方法和工具。', 'Previewing does not change the conversation; it only shows the prompts, methods, and tools that would be used.')}</p> : <><dl><div><dt>{b('预计长度', 'Estimated length')}</dt><dd>{compiled.manifest.estimatedTokens} tokens</dd></div><div><dt>{b('提示校验值', 'Prompt hash')}</dt><dd><code>{compiled.manifest.promptHash}</code></dd></div><div><dt>{b('工具校验值', 'Tool-set hash')}</dt><dd><code>{compiled.manifest.toolSetHash}</code></dd></div></dl><details><summary>{b('系统提示', 'System prompt')}</summary><pre>{compiled.systemText}</pre></details><details><summary>{b('技术清单', 'Technical manifest')}</summary><pre>{JSON.stringify(compiled.manifest, null, 2)}</pre></details></>}</section>}
  </form>
}
