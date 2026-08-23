/** Unified navigation shell for document and injection assets. */
import { useEffect, useState, type CSSProperties } from 'react'
import { ManagementWorkspace } from '../ManagementWorkspace.tsx'
import { ReadingWorkspace } from '../ReadingWorkspace.tsx'
import type { StudyRemote } from '../remote.ts'
import { AssetTree, type StudioSection, type StudioTreeSelection } from './AssetTree.tsx'
import { STUDIO_SHELL_CSS } from './StudioShell.css.ts'
import { ToolCatalog } from './ToolCatalog.tsx'
import { MinerUSettings, type MinerUSettingsProps } from '../MinerUSettings.tsx'
import { InjectionStudio } from './InjectionStudio.tsx'
import { VerticalResizeHandle } from '../VerticalResizeHandle.tsx'
import { OverviewDashboard } from './OverviewDashboard.tsx'
import { useBilingualText } from '../StudyLocale.tsx'

const STORAGE_PREFIX = 'dsh.study-reader.studio-section.v1:'
const TREE_WIDTH_PREFIX = 'dsh.study-reader.studio-tree-width.v1:'
const TREE_COLLAPSED_PREFIX = 'dsh.study-reader.studio-tree-collapsed.v1:'

function storedTreeWidth(sessionId: string): number {
  const width = Number(globalThis.localStorage?.getItem(`${TREE_WIDTH_PREFIX}${sessionId}`))
  return Number.isFinite(width) ? Math.min(390, Math.max(190, width)) : 248
}

function storedSection(sessionId: string): StudioSection {
  const value = globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${sessionId}`)
  return value === 'overview' || value === 'library' || value === 'profiles' || value === 'prompts' || value === 'skills' || value === 'tools'
    || value === 'permissions' || value === 'services' ? value : 'overview'
}

export function StudioShell(props: { readonly sessionId: string; readonly studyRemote: StudyRemote | undefined; readonly credentialsApi: MinerUSettingsProps['credentials'] }) {
  const b = useBilingualText()
  const [selection, setSelection] = useState<StudioTreeSelection>(() => ({ section: storedSection(props.sessionId) }))
  const [profileStatus, setProfileStatus] = useState(() => b('当前：默认预设', 'Current: Default preset'))
  const [studioVersion, setStudioVersion] = useState(0)
  const [assetTreeVersion, setAssetTreeVersion] = useState(0)
  const [treeCollapsed, setTreeCollapsed] = useState(() => globalThis.localStorage?.getItem(`${TREE_COLLAPSED_PREFIX}${props.sessionId}`) === 'true')
  const [treeWidth, setTreeWidth] = useState(() => storedTreeWidth(props.sessionId))
  useEffect(() => { setSelection({ section: storedSection(props.sessionId) }); setTreeWidth(storedTreeWidth(props.sessionId)); setTreeCollapsed(globalThis.localStorage?.getItem(`${TREE_COLLAPSED_PREFIX}${props.sessionId}`) === 'true') }, [props.sessionId])
  useEffect(() => {
    let cancelled = false
    if (props.studyRemote === undefined) { setProfileStatus(b('设置服务暂不可用', 'Settings are unavailable')); return }
    void props.studyRemote.studioSnapshot({ sessionId: props.sessionId }).then(result => {
      if (cancelled) return
      if (!result.ok) { setProfileStatus(b('配置预设暂不可用', 'Configuration presets are unavailable')); return }
      const binding = result.value.binding
      const profile = binding === undefined ? undefined : result.value.profiles.find(candidate => candidate.id === binding.profileId)
      setProfileStatus(binding === undefined ? b('当前：默认预设', 'Current: Default preset') : `${b('当前', 'Current')}: ${profile?.name ?? b('自定义预设', 'Custom preset')}`)
    }).catch(() => { if (!cancelled) setProfileStatus(b('配置预设暂不可用', 'Configuration presets are unavailable')) })
    return () => { cancelled = true }
  }, [b, props.sessionId, props.studyRemote, studioVersion])
  const select = (next: StudioTreeSelection): void => {
    setSelection(next)
    globalThis.localStorage?.setItem(`${STORAGE_PREFIX}${props.sessionId}`, next.section)
  }
  const section = selection.section
  const resizeTree = (delta: number): void => setTreeWidth(current => {
    const next = Math.min(390, Math.max(190, current + delta))
    globalThis.localStorage?.setItem(`${TREE_WIDTH_PREFIX}${props.sessionId}`, String(next))
    return next
  })
  const style = { '--dsh-studio-tree-width': `${treeWidth}px` } as CSSProperties
  const toggleTree = (): void => setTreeCollapsed(current => { const next = !current; globalThis.localStorage?.setItem(`${TREE_COLLAPSED_PREFIX}${props.sessionId}`, String(next)); return next })
  return <div className="dsh-studio" data-studio-section={section} data-collapsed={treeCollapsed} style={style}>
    <style data-plugin-css="ui-study/studio-shell">{STUDIO_SHELL_CSS}</style>
    <AssetTree sessionId={props.sessionId} studyRemote={props.studyRemote} selected={selection} profileStatus={profileStatus} collapsed={treeCollapsed} onToggleCollapsed={toggleTree} onSelect={select} onTreeChanged={() => setAssetTreeVersion(value => value + 1)} />
    <VerticalResizeHandle ariaLabel={b('调整资产导航宽度', 'Resize asset navigation')} className="dsh-studio-resizer" onDelta={resizeTree} />
    <div className="dsh-studio-content">
      {section === 'overview' ? <OverviewDashboard sessionId={props.sessionId} studyRemote={props.studyRemote} onNavigate={next => select({ section: next })} onChanged={() => setStudioVersion(value => value + 1)} />
        : section === 'library' ? <ReadingWorkspace key={props.sessionId} sessionId={props.sessionId} studyRemote={props.studyRemote} refreshVersion={assetTreeVersion} {...selection.folderId === undefined ? {} : { folderId: selection.folderId }} />
        : section === 'skills' ? <ManagementWorkspace tab="skills" sessionId={props.sessionId} studyRemote={props.studyRemote} {...selection.folderId === undefined ? {} : { folderId: selection.folderId }} />
        : section === 'permissions' ? <ManagementWorkspace tab="permissions" sessionId={props.sessionId} studyRemote={props.studyRemote} />
        : section === 'tools' ? <ToolCatalog sessionId={props.sessionId} studyRemote={props.studyRemote} />
        : section === 'prompts' || section === 'profiles' ? <InjectionStudio mode={section} sessionId={props.sessionId} studyRemote={props.studyRemote} onStudioChanged={() => setStudioVersion(value => value + 1)} onFolderSelect={folderId => select({ section, ...(folderId === undefined ? {} : { folderId }) })} {...selection.folderId === undefined ? {} : { folderId: selection.folderId }} />
        : section === 'services' ? <MinerUSettings credentials={props.credentialsApi} {...props.studyRemote === undefined ? {} : { studyRemote: props.studyRemote, sessionId: props.sessionId }} />
        : <StudioFoundation section={section} />}
    </div>
  </div>
}

function StudioFoundation(props: { readonly section: 'services' }) {
  const b = useBilingualText()
  const copy = {
    services: [b('服务连接', 'Service connections'), b('配置文献识别等外部服务。密钥由系统的凭据服务安全保存。', 'Configure document extraction services. Secrets are stored by the Host credential service.')],
  } as const
  const [title, description] = copy[props.section]
  return <section className="dsh-studio-placeholder"><div><h1>{title}</h1><p>{description}</p><p role="status">{b('当前无法读取服务连接设置，请检查系统的凭据服务。', 'Service connection settings are unavailable. Check the Host credential service.')}</p></div></section>
}
