import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AssetFolderView, AssetNamespace, InjectionProfileRecord, InjectionStudioSnapshot, PromptBinding, ProfileSkillBinding, StudioAssetSummary, ToolPolicyBinding } from '../../studio/types.ts'
import type { ToolDescriptorView } from '../../study/types.ts'
import type { StudyRemote } from '../remote.ts'
import { useBilingualText, type BilingualText } from '../StudyLocale.tsx'

type Category = 'documents' | 'skills' | 'tools' | 'rules'
const commandId = (kind: string): string => `overview:${kind}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`

export function OverviewDashboard(props: { readonly sessionId: string; readonly studyRemote: StudyRemote | undefined; readonly onNavigate: (section: 'library' | 'profiles' | 'prompts' | 'skills' | 'tools') => void; readonly onChanged: () => void }) {
  const b = useBilingualText()
  const [category, setCategory] = useState<Category>('documents')
  const [studio, setStudio] = useState<InjectionStudioSnapshot>()
  const [profile, setProfile] = useState<InjectionProfileRecord>()
  const [tools, setTools] = useState<readonly ToolDescriptorView[]>([])
  const [documents, setDocuments] = useState<readonly StudioAssetSummary[]>([])
  const [skillAssets, setSkillAssets] = useState<readonly StudioAssetSummary[]>([])
  const [folders, setFolders] = useState<readonly AssetFolderView[]>([])
  const [busyKey, setBusyKey] = useState<string>()
  const [message, setMessage] = useState<string>()
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')

  const load = useCallback(async (): Promise<void> => {
    if (props.studyRemote === undefined) return
    const [studioResult, toolResult, documentResult, skillResult, folderResult] = await Promise.all([
      props.studyRemote.studioSnapshot({ sessionId: props.sessionId }),
      props.studyRemote.listToolCatalog({ sessionId: props.sessionId }),
      props.studyRemote.listAssets({ sessionId: props.sessionId, namespace: 'library', limit: 100 }),
      props.studyRemote.listAssets({ sessionId: props.sessionId, namespace: 'skill', limit: 100 }),
      loadOverviewFolders(props.studyRemote, props.sessionId),
    ])
    if (!studioResult.ok) throw new Error(studioResult.error.message)
    if (!toolResult.ok) throw new Error(toolResult.error.message)
    if (!documentResult.ok) throw new Error(documentResult.error.message)
    if (!skillResult.ok) throw new Error(skillResult.error.message)
    setStudio(studioResult.value); setTools(toolResult.value); setDocuments(documentResult.value.assets); setSkillAssets(skillResult.value.assets); setFolders(folderResult)
    const binding = studioResult.value.binding
    if (binding === undefined) { setProfile(undefined); return }
    const detail = await props.studyRemote.getAssetDetail({ sessionId: props.sessionId, kind: 'profile', assetId: binding.profileId })
    if (!detail.ok) throw new Error(detail.error.message)
    setProfile(detail.value.kind === 'profile' ? detail.value.value : undefined)
  }, [props.sessionId, props.studyRemote])

  useEffect(() => { let cancelled = false; void load().catch(error => { if (!cancelled) setMessage(error instanceof Error ? error.message : String(error)) }); return () => { cancelled = true } }, [load])
  const binding = studio?.binding
  const revision = useMemo(() => binding === undefined ? undefined : profile?.revisions.find(item => item.version === binding.profileVersion), [binding, profile])
  const visibleDocuments = documents.filter(asset => asset.source?.granted !== false)
  const defaultSkills = studio?.skills.filter(skill => skill.origin === 'builtin') ?? []
  const enabledSkills = binding === undefined
    ? defaultSkills.map(skill => ({ skillId: skill.id, skillVersion: skill.version, enabled: true, invocation: 'both' as const }))
    : revision?.skillBindings.filter(item => item.enabled) ?? []
  const enabledTools = binding === undefined
    ? tools.filter(tool => tool.enabledInCurrentProfile)
    : tools.filter(tool => revision?.toolPolicies.some(item => item.toolName === tool.name && item.enabled) === true && tool.enabledInCurrentProfile)
  const enabledRules = revision?.promptBindings.filter(item => item.enabled) ?? []
  const skillById = useMemo(() => new Map(studio?.skills.map(skill => [skill.id, skill]) ?? []), [studio])
  const skillAssetById = useMemo(() => new Map(skillAssets.map(asset => [asset.id, asset])), [skillAssets])
  const promptById = useMemo(() => new Map(studio?.prompts.map(prompt => [prompt.id, prompt]) ?? []), [studio])

  const updateDocument = async (asset: StudioAssetSummary, enabled: boolean): Promise<void> => {
    if (props.studyRemote === undefined || asset.source === undefined) return
    setBusyKey(`document:${asset.id}`); setMessage(undefined)
    try {
      const result = await props.studyRemote.setSourceAccess({ sessionId: props.sessionId, sourceId: asset.source.id, granted: enabled })
      if (!result.ok) throw new Error(result.error.message)
      setMessage(enabled ? b(`已将《${asset.name}》加入本次对话。`, `Added “${asset.name}” to this conversation.`) : b(`已将《${asset.name}》移出本次对话。`, `Removed “${asset.name}” from this conversation.`))
      await load(); props.onChanged()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusyKey(undefined) }
  }

  const reviseActivePlan = async (kind: Exclude<Category, 'documents'>, id: string, enabled: boolean): Promise<void> => {
    if (props.studyRemote === undefined || studio === undefined || binding === undefined || profile === undefined || revision === undefined) { setMessage(b('请先启用一个配置预设。', 'Choose a configuration preset first.')); return }
    setBusyKey(`${kind}:${id}`); setMessage(undefined)
    try {
      let promptBindings: readonly PromptBinding[] = revision.promptBindings
      let skillBindings: readonly ProfileSkillBinding[] = revision.skillBindings
      let toolPolicies: readonly ToolPolicyBinding[] = revision.toolPolicies
      if (kind === 'rules') {
        const choice = studio.prompts.find(item => item.id === id)
        if (choice === undefined) throw new Error(b('提示词注入不存在。', 'Prompt injection not found.'))
        promptBindings = promptBindings.some(item => item.promptId === id)
          ? promptBindings.map(item => item.promptId === id ? { ...item, enabled } : item)
          : [...promptBindings, { promptId: id, promptVersion: choice.currentVersion, enabled, order: promptBindings.length }]
      } else if (kind === 'skills') {
        const choice = studio.skills.find(item => item.id === id)
        if (choice === undefined) throw new Error(b('Skill 不存在。', 'Skill not found.'))
        skillBindings = skillBindings.some(item => item.skillId === id)
          ? skillBindings.map(item => item.skillId === id ? { ...item, enabled } : item)
          : [...skillBindings, { skillId: id, skillVersion: choice.version, enabled, invocation: choice.userInvocable && choice.modelInvocable ? 'both' : choice.userInvocable ? 'user' : 'model' }]
      } else {
        toolPolicies = toolPolicies.some(item => item.toolName === id)
          ? toolPolicies.map(item => item.toolName === id ? { ...item, enabled } : item)
          : [...toolPolicies, { toolName: id, enabled }]
      }
      const revised = await props.studyRemote.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('revise-plan'), command: { kind: 'revise-profile', profileId: profile.id, expectedRecordVersion: profile.recordVersion, name: profile.name, description: profile.description, promptBindings, skillBindings, toolPolicies, modelPolicy: revision.modelPolicy } })
      if (!revised.ok || revised.value.profile === undefined) throw new Error(revised.ok ? b('配置预设保存结果不完整。', 'The saved configuration preset is incomplete.') : revised.error.message)
      const activated = await props.studyRemote.executeStudioCommand({ sessionId: props.sessionId, commandId: commandId('apply-plan'), command: { kind: 'activate-profile', profileId: profile.id, profileVersion: revised.value.profile.currentVersion, expectedBindingVersion: binding.recordVersion } })
      if (!activated.ok) throw new Error(activated.error.message)
      setMessage(b('设置已保存并用于本次对话。', 'Saved and applied to this conversation.'))
      await load(); props.onChanged()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusyKey(undefined) }
  }

  const saveCurrentConfiguration = async (): Promise<void> => {
    if (props.studyRemote === undefined || saveName.trim() === '') return
    setBusyKey('save-profile'); setMessage(undefined)
    try {
      const result = await props.studyRemote.executeStudioCommand({
        sessionId: props.sessionId,
        commandId: commandId('save-current-profile'),
        command: {
          kind: 'create-profile', name: saveName.trim(),
          description: profile === undefined ? b('根据当前默认设置保存', 'Saved from the current defaults') : b(`基于“${profile.name}”保存`, `Saved from “${profile.name}”`),
          promptBindings: revision?.promptBindings ?? [],
          skillBindings: revision?.skillBindings ?? defaultSkills.map(skill => ({ skillId: skill.id, skillVersion: skill.version, enabled: true, invocation: 'both' as const })),
          toolPolicies: revision?.toolPolicies ?? tools.map(tool => ({ toolName: tool.name, enabled: tool.enabledInCurrentProfile })),
          modelPolicy: { kind: 'inherit-session' },
        },
      })
      if (!result.ok) throw new Error(result.error.message)
      const savedName = result.value.profile?.name ?? saveName.trim()
      setSaveOpen(false); setSaveName('')
      setMessage(b(`已保存配置预设“${savedName}”，当前对话没有切换。`, `Saved configuration preset “${savedName}” without changing this conversation.`))
      await load(); props.onChanged()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusyKey(undefined) }
  }

  const cards = [
    { id: 'documents' as const, label: b('对话资料', 'Conversation documents'), count: visibleDocuments.length, hint: b('本次对话可以查阅的文献', 'Documents available to this conversation') },
    { id: 'skills' as const, label: 'Skills', count: enabledSkills.length, hint: b('本次对话可按需使用的专项方法', 'Specialized methods available on demand') },
    { id: 'tools' as const, label: 'Tools', count: enabledTools.length, hint: b('当前预设允许使用的文献能力', 'Document capabilities allowed by this preset') },
    { id: 'rules' as const, label: b('提示词注入', 'Prompt injections'), count: enabledRules.length + 1, hint: b('安全基础与当前预设中的提示内容', 'Safety baseline and prompts in the current preset') },
  ]
  return <main className="dsh-overview"><header><div><p>{b('总览', 'Overview')}</p><h1>{b('本次对话正在使用什么', 'What this conversation can use')}</h1><span>{binding === undefined ? b('正在使用系统内置的默认预设；下面列出的提示、Skills 和 Tools 均已实际生效。', 'The built-in default preset is active. The prompts, Skills, and Tools below are in effect.') : b('这里只列出当前预设中已经生效的内容。', 'Only active items from the current preset are shown.')}</span></div><div className="dsh-overview-header-actions"><button type="button" onClick={() => { setSaveName(profile === undefined ? b('默认预设副本', 'Default preset copy') : b(`${profile.name} 副本`, `${profile.name} copy`)); setSaveOpen(true) }}>{b('保存为配置预设', 'Save as preset')}</button><button type="button" onClick={() => props.onNavigate('profiles')}>{binding === undefined ? b('默认预设 · 系统内置', 'Default preset · built in') : profile?.name ?? b('当前预设', 'Current preset')}</button></div></header>
    {message === undefined ? null : <p className="dsh-overview-message" role="status">{message}</p>}
    <div className="dsh-overview-metrics">{cards.map(card => <button type="button" key={card.id} aria-pressed={category === card.id} onClick={() => setCategory(card.id)}><strong>{card.count}</strong><span>{card.label}</span><small>{card.hint}</small></button>)}</div>
    <section className="dsh-overview-panel" aria-label={cards.find(card => card.id === category)?.label}><header><div><h2>{cards.find(card => card.id === category)?.label}</h2><p>{cards.find(card => card.id === category)?.hint}</p></div><button type="button" onClick={() => props.onNavigate(category === 'documents' ? 'library' : category === 'rules' ? 'prompts' : category)}>{b('查看全部', 'View all')}</button></header>
      <div className="dsh-overview-items">
        {category === 'documents' ? visibleDocuments.map(asset => <OverviewRow key={asset.id} icon="D" title={asset.name} description={asset.source?.format?.toUpperCase() ?? b('文献', 'Document')} location={assetLocation('library', asset.folderId, folders, b)} enabled enabledText={b('对话可用', 'Available')} busy={busyKey === `document:${asset.id}`} onToggle={enabled => void updateDocument(asset, enabled)} b={b} />)
          : category === 'skills' ? enabledSkills.map(bindingItem => { const skill = skillById.get(bindingItem.skillId); if (skill === undefined) return null; const asset = skillAssetById.get(skill.id); return <OverviewRow key={skill.id} icon="S" title={skill.name} description={skill.description} location={skill.origin === 'builtin' ? b('系统内置方法', 'Built-in method') : assetLocation('skill', asset?.folderId, folders, b)} enabled enabledText={binding === undefined ? b('默认可用', 'Available by default') : b('已启用', 'Enabled')} locked={binding === undefined} lockedText={b('复制默认预设后可调整', 'Copy the default preset to customize')} busy={busyKey === `skills:${skill.id}`} onToggle={enabled => void reviseActivePlan('skills', skill.id, enabled)} b={b} /> })
          : category === 'tools' ? enabledTools.map(tool => <OverviewRow key={tool.name} icon="T" title={b(tool.title ?? tool.name, tool.localized?.en.title ?? tool.title ?? tool.name)} description={b(tool.description, tool.localized?.en.description ?? tool.description)} location={b('系统内置 Tool', 'Built-in Tool')} enabled enabledText={binding === undefined ? b('默认可用', 'Available by default') : b('已启用', 'Enabled')} locked={binding === undefined} lockedText={b('复制默认预设后可调整', 'Copy the default preset to customize')} busy={busyKey === `tools:${tool.name}`} onToggle={enabled => void reviseActivePlan('tools', tool.name, enabled)} b={b} />)
          : <><OverviewRow icon="R" title={b('安全基础', 'Safety baseline')} description={b('系统内置，始终生效', 'Built in and always active')} location={b('系统提示', 'System prompt')} enabled locked b={b} />{enabledRules.map(bindingItem => { const prompt = promptById.get(bindingItem.promptId); if (prompt === undefined) return null; return <OverviewRow key={prompt.id} icon="R" title={prompt.name} description={b('已启用', 'Enabled')} location={assetLocation('prompt', prompt.folderId, folders, b)} enabled busy={busyKey === `rules:${prompt.id}`} onToggle={enabled => void reviseActivePlan('rules', prompt.id, enabled)} b={b} /> })}</>}
        {category === 'documents' && visibleDocuments.length === 0 || category === 'skills' && enabledSkills.length === 0 || category === 'tools' && enabledTools.length === 0 ? <p className="dsh-overview-empty">{b('当前没有已启用的内容。可前往“查看全部”添加。', 'Nothing is enabled here yet. Use “View all” to add items.')}</p> : null}
      </div>
    </section>
    {saveOpen ? <div className="dsh-overview-dialog-backdrop" role="presentation"><section className="dsh-overview-dialog" role="dialog" aria-modal="true" aria-labelledby="dsh-save-profile-title"><h2 id="dsh-save-profile-title">{b('保存当前设置', 'Save current settings')}</h2><p>{b('保存提示词注入、Skills 和 Tools；不会保存文献、阅读位置或服务连接，也不会切换当前对话。', 'Saves prompt injections, Skills, and Tools. Documents, reading position, connections, and the active conversation are unchanged.')}</p><label>{b('预设名称', 'Preset name')}<input autoFocus value={saveName} maxLength={120} onChange={event => setSaveName(event.currentTarget.value)} /></label><div><button type="button" onClick={() => { setSaveOpen(false); setSaveName('') }}>{b('取消', 'Cancel')}</button><button type="button" disabled={busyKey === 'save-profile' || saveName.trim() === ''} onClick={() => void saveCurrentConfiguration()}>{busyKey === 'save-profile' ? b('保存中…', 'Saving…') : b('保存', 'Save')}</button></div></section></div> : null}
  </main>
}

function OverviewRow(props: { readonly icon: string; readonly title: string; readonly description: string; readonly location: string; readonly enabled: boolean; readonly enabledText?: string; readonly busy?: boolean; readonly locked?: boolean; readonly lockedText?: string; readonly onToggle?: (enabled: boolean) => void; readonly b?: BilingualText }) {
  const b = props.b ?? ((zh: string) => zh)
  return <article className="dsh-overview-row" data-enabled={props.enabled}><i aria-hidden="true">{props.icon}</i><div><strong>{props.title}</strong><p>{props.description}</p><small>{props.location}</small></div><span>{props.enabledText ?? b('已启用', 'Enabled')}</span><button type="button" disabled={props.busy || props.locked} onClick={() => props.onToggle?.(false)}>{props.locked ? props.lockedText ?? b('始终生效', 'Always active') : props.busy ? b('正在更新…', 'Updating…') : b('停用', 'Disable')}</button></article>
}

function assetLocation(namespace: AssetNamespace, folderId: string | undefined, folders: readonly AssetFolderView[], b: BilingualText): string {
  const rootLabels: Readonly<Record<AssetNamespace, string>> = { library: b('文献库', 'Library'), prompt: b('提示词注入', 'Prompt injections'), skill: 'Skills', profile: b('配置预设', 'Configuration presets') }
  if (folderId === undefined) return `${rootLabels[namespace]} / ${b('根目录', 'Root')}`
  const byId = new Map(folders.filter(folder => folder.namespace === namespace).map(folder => [folder.id, folder]))
  const names: string[] = []
  const visited = new Set<string>()
  let current = byId.get(folderId)
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id); names.unshift(current.name); current = current.parentId === undefined ? undefined : byId.get(current.parentId)
  }
  return `${rootLabels[namespace]} / ${names.length === 0 ? b('根目录', 'Root') : names.join(' / ')}`
}

async function loadOverviewFolders(remote: StudyRemote, sessionId: string): Promise<readonly AssetFolderView[]> {
  const folders: AssetFolderView[] = []
  for (const namespace of ['library', 'prompt', 'skill'] as const) {
    const parents: Array<string | undefined> = [undefined]
    while (parents.length > 0) {
      const parentId = parents.shift()
      let cursor: string | undefined
      do {
        const result = await remote.listTreeChildren({ sessionId, namespace, ...(parentId === undefined ? {} : { parentId }), ...(cursor === undefined ? {} : { cursor }), limit: 100 })
        if (!result.ok) throw new Error(result.error.message)
        folders.push(...result.value.folders); parents.push(...result.value.folders.map(folder => folder.id)); cursor = result.value.nextCursor
      } while (cursor !== undefined)
    }
  }
  return folders
}
