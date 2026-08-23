/** Local-user Bookroom controls. Skill instructions are rendered as inert text. */
import { useEffect, useRef, useState } from 'react'
import type {
  AgentGrant,
  ManagedStudySkillView,
  ManagementFolderView,
  ManagementProposal,
  ManagementSkillView,
  RegistryStudySkillView,
  RegistrySkillCatalogStatus,
  StudySkill,
} from '../study/management.ts'
import type { StudyRemote } from './remote.ts'
import { MANAGEMENT_WORKSPACE_CSS } from './ManagementWorkspace.css.ts'
import type { AssetTreeCommand } from '../studio/types.ts'
import { useBilingualText, type BilingualText } from './StudyLocale.tsx'

export type ManagementTab = 'skills' | 'permissions'

interface Snapshot {
  readonly controlMode: 'trusted-local-user' | 'disabled'
  readonly grants: readonly AgentGrant[]
  readonly grantVersion: number
  readonly folders: readonly ManagementFolderView[]
  readonly skills: readonly ManagementSkillView[]
  readonly proposals: readonly ManagementProposal[]
  readonly registrySkills: RegistrySkillCatalogStatus
}
type SkillCommand =
  | { readonly kind: 'create-skill'; readonly name: string; readonly description: string; readonly trigger: string; readonly instructions: string; readonly requiredTools: readonly string[]; readonly userInvocable: boolean; readonly modelInvocable: boolean }
  | { readonly kind: 'revise-skill'; readonly skillId: string; readonly name: string; readonly description: string; readonly trigger: string; readonly instructions: string; readonly requiredTools: readonly string[]; readonly userInvocable: boolean; readonly modelInvocable: boolean; readonly expectedRecordVersion: number }
  | { readonly kind: 'archive-skill'; readonly skillId: string; readonly expectedRecordVersion: number; readonly archived: boolean }
  | { readonly kind: 'delete-skill'; readonly skillId: string; readonly expectedRecordVersion: number }
  | { readonly kind: 'clone-skill'; readonly skillId: string }

type CommandResult = { readonly ok: boolean; readonly error?: { readonly message: string } }
type RunCommand = <T extends CommandResult>(action: () => Promise<T>, onSuccess?: (result: T) => void) => Promise<boolean>

const grantLabels = (b: BilingualText): Readonly<Record<AgentGrant, readonly [string, string]>> => ({
  'library.import': [b('导入文献', 'Import documents'), b('允许助手建议导入；文件选择和确认始终由你完成。', 'Allow import suggestions; you always choose and confirm files.')],
  'library.organize': [b('整理书库', 'Organize library'), b('允许助手建议整理书库。', 'Allow the assistant to suggest library organization.')],
  'library.delete.propose': [b('提出删除请求', 'Propose deletion'), b('助手只能提出请求，不能自行删除。', 'The assistant may only propose; it cannot delete by itself.')],
  'skills.create.propose': [b('提出新建 Skill', 'Propose a new Skill'), b('助手只能提出建议，内容不会在这里执行。', 'The assistant may only suggest; content is never executed here.')],
  'skills.edit.propose': [b('提出修改 Skill', 'Propose Skill edits'), b('助手只能提出建议，更新仍需你确认。', 'The assistant may only suggest; you must confirm updates.')],
})

function commandId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

function isManagedSkill(skill: ManagementSkillView): skill is ManagedStudySkillView {
  return skill.origin.kind === 'managed'
}

function managedSkillView(skill: StudySkill): ManagedStudySkillView {
  const writable = skill.source === 'user'
  return {
    ...skill,
    origin: { kind: 'managed' },
    capabilities: {
      canClone: true,
      canEdit: writable,
      canMove: writable,
      canArchive: writable,
      canDelete: writable && skill.archived,
    },
  }
}

export function ManagementWorkspace(props: { readonly tab: ManagementTab; readonly sessionId: string; readonly studyRemote: StudyRemote | undefined; readonly folderId?: string }) {
  const b = useBilingualText()
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>()
  const [failure, setFailure] = useState<string | undefined>()
  const [refresh, setRefresh] = useState(0)
  const [pending, setPending] = useState(false)
  const snapshotRequest = useRef(0)
  const snapshotScope = useRef<{ readonly sessionId: string; readonly remote: StudyRemote | undefined } | undefined>()
  useEffect(() => {
    let alive = true
    const request = ++snapshotRequest.current
    const scopeChanged = snapshotScope.current?.sessionId !== props.sessionId || snapshotScope.current.remote !== props.studyRemote
    snapshotScope.current = { sessionId: props.sessionId, remote: props.studyRemote }
    if (scopeChanged) {
      setSnapshot(undefined)
      setFailure(undefined)
    }
    if (props.studyRemote === undefined) return
    void props.studyRemote.managementSnapshot({ sessionId: props.sessionId }).then(result => {
      if (!alive || request !== snapshotRequest.current) return
      if (result.ok) setSnapshot(current => {
        const next = result.value as Snapshot
        return current !== undefined && next.grantVersion < current.grantVersion
          ? { ...next, grants: current.grants, grantVersion: current.grantVersion }
          : next
      })
      else setFailure(result.error.message)
    }).catch(error => { if (alive && request === snapshotRequest.current) setFailure(error instanceof Error ? error.message : String(error)) })
    return () => { alive = false }
  }, [props.sessionId, props.studyRemote, refresh])
  const reload = (): void => { snapshotRequest.current += 1; setRefresh(value => value + 1) }
  const disabled = pending || snapshot?.controlMode === 'disabled' || props.studyRemote === undefined
  const run: RunCommand = async (action, onSuccess) => {
    if (pending) return false
    setPending(true); setFailure(undefined)
    try { const result = await action(); if (!result.ok) { setFailure(result.error?.message ?? b('操作未完成', 'Operation did not complete')); reload(); return false } onSuccess?.(result); reload(); return true }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)); reload(); return false }
    finally { setPending(false) }
  }
  const applySkillCommand = (result: { readonly skill?: StudySkill }): void => {
    setSnapshot(current => {
      if (current === undefined) return current
      const projected = result.skill === undefined ? undefined : managedSkillView(result.skill)
      const skills = projected === undefined
        ? current.skills
        : current.skills.some(skill => skill.id === projected.id)
          ? current.skills.map(skill => skill.id === projected.id ? projected : skill)
          : [...current.skills, projected]
      return { ...current, skills }
    })
  }
  const applyGrants = (grants: readonly AgentGrant[], grantVersion: number): void => {
    setSnapshot(current => current === undefined ? current : { ...current, grants, grantVersion })
  }
  return <section className="dsh-study-management" aria-label={props.tab === 'skills' ? b('Skills 管理', 'Skill management') : b('访问权限', 'Access')}>
    <style>{MANAGEMENT_WORKSPACE_CSS}</style>
    <div className="dsh-study-management-shell">
      {failure !== undefined && <div className="dsh-study-management-alert" role="alert">{failure}</div>}
      {snapshot?.controlMode === 'disabled' && <div className="dsh-study-management-note">{b('本地管理控制当前为只读模式；此页面不会执行任何变更。', 'Local management is read-only; this page will not make changes.')}</div>}
      {props.tab === 'skills'
        ? <Skills b={b} snapshot={snapshot} sessionId={props.sessionId} remote={props.studyRemote} disabled={disabled} run={run} applySkillCommand={applySkillCommand} {...props.folderId === undefined ? {} : { externalFolderId: props.folderId }} />
        : <Permissions b={b} snapshot={snapshot} sessionId={props.sessionId} remote={props.studyRemote} disabled={disabled} run={run} applyGrants={applyGrants} />}
      <Proposals b={b} snapshot={snapshot} sessionId={props.sessionId} remote={props.studyRemote} disabled={disabled} run={run} />
    </div>
  </section>
}

function Permissions({ b, snapshot, sessionId, remote, disabled, run, applyGrants }: { readonly b: BilingualText; readonly snapshot: Snapshot | undefined; readonly sessionId: string; readonly remote: StudyRemote | undefined; readonly disabled: boolean; readonly run: RunCommand; readonly applyGrants: (grants: readonly AgentGrant[], grantVersion: number) => void }) {
  const grants = snapshot?.grants ?? []
  const toggle = (grant: AgentGrant): void => {
    const next = grants.includes(grant) ? grants.filter(item => item !== grant) : [...grants, grant]
    if (remote === undefined || snapshot === undefined) return
    // A controlled checkbox must reflect the local-user intent in this same
    // change event.  Waiting for the RPC result makes React restore the old
    // `checked` value while the control is pending (and breaks normal clicks).
    // A rejected command refreshes the authoritative snapshot and rolls this
    // tentative value back.
    applyGrants(next, snapshot.grantVersion)
    void run(
      async () => await remote.executeManagementCommand({ sessionId, commandId: commandId('grant'), command: { kind: 'set-agent-grants', grants: next, expectedVersion: snapshot.grantVersion } }),
      result => {
        if (result.ok && result.value.grants !== undefined && result.value.grantVersion !== undefined) {
          applyGrants(result.value.grants, result.value.grantVersion)
        }
      },
    )
  }
  return <><header className="dsh-study-management-header"><div><h2>{b('访问权限', 'Access')}</h2><p>{b('控制助手在本次对话中可以建议哪些操作。高风险操作仍需你明确确认。', 'Control which operations the assistant may suggest. High-risk actions still require explicit confirmation.')}</p></div></header>
    <div className="dsh-study-management-editor">{(Object.entries(grantLabels(b)) as readonly [AgentGrant, readonly [string, string]][]).map(([grant, text]) => <label className="dsh-study-management-permission" key={grant}><input aria-label={text[0]} type="checkbox" checked={grants.includes(grant)} disabled={disabled} onChange={() => { toggle(grant) }} /><span><strong>{text[0]}</strong><small>{text[1]}</small></span></label>)}</div></>
}

function Skills({ b, snapshot, sessionId, remote, disabled, run, applySkillCommand, externalFolderId }: { readonly b: BilingualText; readonly snapshot: Snapshot | undefined; readonly sessionId: string; readonly remote: StudyRemote | undefined; readonly disabled: boolean; readonly run: RunCommand; readonly applySkillCommand: (result: { readonly skill?: StudySkill }) => void; readonly externalFolderId?: string }) {
  const [editor, setEditor] = useState<StudySkill | 'new' | undefined>()
  const [selectedSkillId, setSelectedSkillId] = useState<string>()
  const [registryQuery, setRegistryQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [moveSkill, setMoveSkill] = useState<ManagedStudySkillView | undefined>()
  const [moveFolderId, setMoveFolderId] = useState('')
  const [deleteSkill, setDeleteSkill] = useState<ManagedStudySkillView | undefined>()
  const folderId = externalFolderId
  const folders = (snapshot?.folders ?? []).filter(folder => folder.kind === 'skill')
  const activeFolder = folders.find(folder => folder.id === folderId)
  const execute = async (command: SkillCommand): Promise<boolean> => remote === undefined ? false : await run(async () => await remote.executeSkillCommand({ sessionId, commandId: commandId('skill'), command }), result => { if (result.ok) applySkillCommand(result.value) })
  const executeTree = async (treeCommand: AssetTreeCommand): Promise<boolean> => remote === undefined ? false : await run(async () => await remote.executeStudioCommand({
    sessionId,
    commandId: commandId('skill-tree'),
    command: { kind: 'apply-asset-tree', treeCommand },
  }))
  const edit = (skill: ManagedStudySkillView): void => {
    if (remote === undefined) return
    void remote.getManagementSkill({ sessionId, skillId: skill.id }).then(result => {
      if (result.ok) setEditor(result.value)
    })
  }
  const writableFolderTargets = folders.filter(folder => folder.origin === 'managed' && folder.capabilities.canAcceptSkills)
  const registrySkills = (snapshot?.skills ?? []).filter((skill): skill is RegistryStudySkillView => skill.origin.kind === 'registry')
  const normalizedRegistryQuery = registryQuery.trim().toLocaleLowerCase()
  const folderScopedSkills = folderId === undefined
    ? snapshot?.skills ?? []
    : activeFolder?.origin === 'registry' && activeFolder.parentId === undefined
      ? registrySkills
      : (snapshot?.skills ?? []).filter(skill => skill.folderId === folderId)
  const visibleSkills = folderScopedSkills.filter(skill => {
    if (isManagedSkill(skill) && skill.archived !== showArchived) return false
    if (!isManagedSkill(skill) && showArchived) return false
    return normalizedRegistryQuery === '' || `${skill.name}\n${skill.description}`.toLocaleLowerCase().includes(normalizedRegistryQuery)
  })
  const selectedSkill = visibleSkills.find(skill => skill.id === selectedSkillId) ?? visibleSkills[0]
  useEffect(() => {
    setEditor(undefined)
    setSelectedSkillId(undefined)
  }, [externalFolderId, sessionId])
  return <><header className="dsh-study-management-header"><div><h2>Skills</h2><p>{b('Skill 是助手可按需采用的专项方法；是否使用由配置预设管理。', 'Skills are specialized methods the assistant may use when appropriate; configuration presets control availability.')}</p></div><button type="button" disabled={disabled} onClick={() => { setEditor('new') }}>{b('创建 Skill', 'Create Skill')}</button></header>
    {snapshot !== undefined && !snapshot.registrySkills.available && <div className="dsh-study-management-note">{b('系统内置的 Skills 暂不可用；这里只显示你自己管理的内容。', 'Built-in Skills are unavailable; only your managed Skills are shown.')}</div>}
    {snapshot?.registrySkills.available === true && !snapshot.registrySkills.complete && <div className="dsh-study-management-note">{b('内置 Skills 尚未全部载入，请稍后刷新。', 'Built-in Skills are still loading. Refresh shortly.')}</div>}
    <div className="dsh-study-management-actions"><label>{b('查找 Skills', 'Find Skills')}<input type="search" aria-label={b('查找 Skills', 'Find Skills')} value={registryQuery} onChange={event => setRegistryQuery(event.target.value)} placeholder={b('名称或说明', 'Name or description')} /></label><button type="button" onClick={() => { setShowArchived(value => !value); setSelectedSkillId(undefined); setEditor(undefined) }}>{showArchived ? b('返回使用中', 'Back to active') : b('查看已归档', 'View archived')}</button></div>
    <p>{b('路径：根目录', 'Path: Root')}{activeFolder === undefined ? '' : ` / ${activeFolder.parentId === undefined ? '' : `${folders.find(folder => folder.id === activeFolder.parentId)?.name ?? ''} / `}${activeFolder.name}`}</p>
    {activeFolder?.origin === 'registry' && <div className="dsh-study-management-note">{b('这里显示系统内置的只读方法。需要修改时，可先复制为自己的 Skill；是否使用由配置预设统一管理。', 'These built-in methods are read-only. Clone one to edit it; configuration presets control availability.')}</div>}
    <div className="dsh-study-skill-explorer">
      <nav className="dsh-study-skill-list" aria-label={b('Skills 列表', 'Skill list')}>{snapshot === undefined ? <div className="dsh-study-management-empty">{b('正在读取 Skills…', 'Loading Skills…')}</div> : visibleSkills.length === 0 ? <div className="dsh-study-management-empty">{showArchived ? b('此文件夹没有已归档的 Skill。', 'This folder has no archived Skills.') : b('此文件夹没有 Skill。', 'This folder has no Skills.')}</div> : visibleSkills.map(skill => <button type="button" key={skill.id} aria-current={skill.id === selectedSkill?.id ? 'page' : undefined} onClick={() => { setSelectedSkillId(skill.id); setEditor(undefined) }}><strong>{skill.name}</strong><small>{skill.description || b('未提供说明。', 'No description.')}</small><span>{isManagedSkill(skill) ? `${skill.source === 'builtin' ? b('系统内置', 'Built in') : b('我的', 'Mine')}${skill.archived ? ` · ${b('已归档', 'Archived')}` : ''}` : `${b('系统内置', 'Built in')} · ${skill.origin.sourceCategory}`}</span></button>)}</nav>
      <div className="dsh-study-skill-detail">
        {editor !== undefined ? <SkillEditor b={b} skill={editor === 'new' ? undefined : editor} disabled={disabled} onCancel={() => { setEditor(undefined) }} onSave={async command => { if (await execute(command)) setEditor(undefined) }} />
          : selectedSkill === undefined ? <div className="dsh-study-management-empty"><h3>{showArchived ? b('没有已归档的 Skill', 'No archived Skills') : b('选择或创建一个 Skill', 'Select or create a Skill')}</h3><p>{showArchived ? b('归档后的内容会显示在这里。', 'Archived content appears here.') : b('说明、适用条件和操作会显示在这里。', 'Description, conditions, and actions appear here.')}</p></div>
          : !isManagedSkill(selectedSkill) ? <article className="dsh-study-management-card"><h3>{selectedSkill.name}</h3><p>{selectedSkill.description || b('未提供说明。', 'No description.')}</p><div className="dsh-study-management-meta"><span>{b('系统提供（只读）', 'System provided (read only)')}</span><span>{b('类别', 'Category')}：{selectedSkill.origin.sourceCategory}</span><span>{b('提供方', 'Provider')}：{selectedSkill.origin.provider}</span><span>{selectedSkill.invocation.modelInvocable ? b('助手可按需使用', 'Assistant may use') : b('助手不会主动使用', 'Assistant will not use automatically')}</span><span>{selectedSkill.invocation.userInvocable ? b('可手动使用', 'User invocable') : b('不可手动使用', 'Not user invocable')}</span></div><div className="dsh-study-management-actions"><button type="button" disabled={disabled || !selectedSkill.capabilities.canClone} onClick={() => { void execute({ kind: 'clone-skill', skillId: selectedSkill.id }) }}>{b('复制为可编辑 Skill', 'Clone as editable Skill')}</button></div></article>
          : <article className="dsh-study-management-card" onContextMenu={event => { if (!selectedSkill.capabilities.canMove) return; event.preventDefault(); setMoveSkill(selectedSkill); setMoveFolderId(selectedSkill.folderId ?? '') }}><h3>{selectedSkill.name}</h3><p>{selectedSkill.description || b('未提供说明。', 'No description.')}</p><div className="dsh-study-management-meta"><span>{selectedSkill.source === 'builtin' ? b('系统内置（只读）', 'Built in (read only)') : b('我创建的', 'Created by me')}</span>{selectedSkill.archived && <span>{b('已归档', 'Archived')}</span>}</div><div className="dsh-study-management-actions">{selectedSkill.capabilities.canClone && <button type="button" disabled={disabled} onClick={() => { void execute({ kind: 'clone-skill', skillId: selectedSkill.id }) }}>{b('复制', 'Clone')}</button>}{selectedSkill.capabilities.canEdit && <button type="button" disabled={disabled} onClick={() => { edit(selectedSkill) }}>{b('编辑', 'Edit')}</button>}{selectedSkill.capabilities.canMove && <button type="button" disabled={disabled} onClick={() => { setMoveSkill(selectedSkill); setMoveFolderId(selectedSkill.folderId ?? '') }}>{b('移动到…', 'Move to…')}</button>}{selectedSkill.capabilities.canArchive && <button type="button" disabled={disabled} onClick={() => { void execute({ kind: 'archive-skill', skillId: selectedSkill.id, expectedRecordVersion: selectedSkill.recordVersion, archived: !selectedSkill.archived }) }}>{selectedSkill.archived ? b('恢复', 'Restore') : b('归档', 'Archive')}</button>}{selectedSkill.capabilities.canDelete && <button type="button" disabled={disabled} onClick={() => setDeleteSkill(selectedSkill)}>{b('永久删除', 'Delete permanently')}</button>}</div>{selectedSkill.source === 'user' && !selectedSkill.archived ? <p>{b('不再使用时可先归档；归档后可以永久删除，系统会同时从引用它的配置预设中移除。', 'Archive unused Skills first. Archived Skills can be permanently deleted and are removed from presets that reference them.')}</p> : null}</article>}
      </div>
    </div>
    {moveSkill === undefined ? null : <div className="dsh-study-management-dialog" role="dialog" aria-modal="true" aria-label={`${b('移动', 'Move')} ${moveSkill.name}`}><h3>{b('移动', 'Move')} {moveSkill.name}</h3><label className="dsh-study-management-field">{b('目标文件夹', 'Destination folder')}<select aria-label={`${b('移动', 'Move')} ${moveSkill.name}`} value={moveFolderId} onChange={event => setMoveFolderId(event.target.value)}><option value="">{b('未分类', 'Uncategorized')}</option>{writableFolderTargets.map(folder => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select></label><div className="dsh-study-management-actions"><button type="button" disabled={disabled} onClick={() => { void executeTree({ kind: 'move-asset', namespace: 'skill', assetId: moveSkill.id, expectedVersion: moveSkill.recordVersion, ...(moveFolderId === '' ? {} : { folderId: moveFolderId }) }).then(ok => { if (ok) setMoveSkill(undefined) }) }}>{b('确认移动', 'Move')}</button><button type="button" onClick={() => setMoveSkill(undefined)}>{b('取消', 'Cancel')}</button></div></div>}
    {deleteSkill === undefined ? null : <div className="dsh-study-management-dialog" role="dialog" aria-modal="true" aria-label={`${b('永久删除', 'Permanently delete')} ${deleteSkill.name}`}><h3>{b('永久删除', 'Permanently delete')} {deleteSkill.name}</h3><p>{b('此操作无法恢复；引用它的配置预设会同步移除该 Skill。', 'This cannot be undone. Presets that reference this Skill will remove it.')}</p><div className="dsh-study-management-actions"><button type="button" disabled={disabled} onClick={() => { void execute({ kind: 'delete-skill', skillId: deleteSkill.id, expectedRecordVersion: deleteSkill.recordVersion }).then(ok => { if (ok) { setDeleteSkill(undefined); setSelectedSkillId(undefined) } }) }}>{b('确认永久删除', 'Delete permanently')}</button><button type="button" onClick={() => setDeleteSkill(undefined)}>{b('取消', 'Cancel')}</button></div></div>}
  </>
}

function SkillEditor({ b, skill, disabled, onCancel, onSave }: { readonly b: BilingualText; readonly skill: StudySkill | undefined; readonly disabled: boolean; readonly onCancel: () => void; readonly onSave: (command: SkillCommand) => Promise<void> }) {
  const [name, setName] = useState(skill?.name ?? ''); const [description, setDescription] = useState(skill?.description ?? ''); const [trigger, setTrigger] = useState(skill?.trigger ?? skill?.description ?? ''); const [instructions, setInstructions] = useState(skill?.instructions ?? '')
  const [requiredTools, setRequiredTools] = useState((skill?.requiredTools ?? []).join(', ')); const [userInvocable, setUserInvocable] = useState(skill?.userInvocable ?? true); const [modelInvocable, setModelInvocable] = useState(skill?.modelInvocable ?? true)
  const capability = { trigger, requiredTools: [...new Set(requiredTools.split(',').map(value => value.trim()).filter(Boolean))], userInvocable, modelInvocable }
  return <form className="dsh-study-management-editor" onSubmit={event => { event.preventDefault(); void onSave(skill === undefined ? { kind: 'create-skill', name, description, instructions, ...capability } : { kind: 'revise-skill', skillId: skill.id, name, description, instructions, ...capability, expectedRecordVersion: skill.recordVersion }) }}>
    <h3>{skill === undefined ? b('创建 Skill', 'Create Skill') : `${b('编辑', 'Edit')} ${skill.name}`}</h3>
    <label className="dsh-study-management-field">{b('名称', 'Name')}<input required value={name} disabled={disabled} onChange={event => { setName(event.target.value) }} /></label>
    <label className="dsh-study-management-field">{b('说明', 'Description')}<input value={description} disabled={disabled} onChange={event => { setDescription(event.target.value) }} /></label>
    <label className="dsh-study-management-field">{b('调用条件', 'Invocation conditions')}<input value={trigger} disabled={disabled} onChange={event => { setTrigger(event.target.value) }} /></label>
    <label className="dsh-study-management-field">{b('所需工具（用逗号分隔）', 'Required tools (comma-separated)')}<input value={requiredTools} disabled={disabled} placeholder="reader_search_passages, reader_read_passage" onChange={event => { setRequiredTools(event.target.value) }} /></label>
    <div className="dsh-study-management-actions"><label><input type="checkbox" checked={userInvocable} disabled={disabled} onChange={event => { setUserInvocable(event.target.checked) }} /> {b('可手动使用', 'User invocable')}</label><label><input type="checkbox" checked={modelInvocable} disabled={disabled} onChange={event => { setModelInvocable(event.target.checked) }} /> {b('助手可按需使用', 'Assistant may invoke')}</label></div>
    <label className="dsh-study-management-field">{b(`指令（纯文本，${instructions.length}/12000）`, `Instructions (plain text, ${instructions.length}/12000)`)}<textarea value={instructions} maxLength={12000} disabled={disabled} onChange={event => { setInstructions(event.target.value) }} /></label>
    <div className="dsh-study-management-actions"><button type="submit" disabled={disabled}>{b('保存', 'Save')}</button><button type="button" onClick={onCancel}>{b('取消', 'Cancel')}</button></div>
  </form>
}

function Proposals({ b, snapshot, sessionId, remote, disabled, run }: { readonly b: BilingualText; readonly snapshot: Snapshot | undefined; readonly sessionId: string; readonly remote: StudyRemote | undefined; readonly disabled: boolean; readonly run: RunCommand }) {
  const [confirming, setConfirming] = useState<ManagementProposal | undefined>()
  const [title, setTitle] = useState('')
  const pending = (snapshot?.proposals ?? []).filter(proposal => proposal.state === 'pending')
  const decide = (proposal: ManagementProposal, decision: 'approved' | 'rejected', expectedTitle?: string): void => { if (remote !== undefined) void run(async () => await remote.decideManagementProposal({ sessionId, commandId: commandId('proposal-decision'), proposalId: proposal.id, expectedVersion: proposal.version, decision, ...(expectedTitle === undefined ? {} : { expectedTitle }) })) }
  return <section className="dsh-study-management-proposals" aria-label={b('待确认操作', 'Pending confirmations')}><h2>{b('待确认操作', 'Pending confirmations')}</h2>{pending.length === 0 ? <p>{b('当前会话没有待确认操作。', 'This conversation has no pending confirmations.')}</p> : pending.map(proposal => { const expired = proposal.expiresAt <= Date.now(); return <article className="dsh-study-management-card" key={proposal.id}><h3>{proposal.kind === 'delete-source' ? b('删除文献', 'Delete document') : b('归档 Skill', 'Archive Skill')}：{proposal.title}</h3><div className="dsh-study-management-meta"><span>{b('请求工具调用', 'Requesting tool call')}：{proposal.requesterToolCallId ?? b('未关联', 'None')}</span><span>{expired ? b('已过期：', 'Expired: ') : b('到期：', 'Expires: ')}{new Date(proposal.expiresAt).toLocaleString()}</span></div><div className="dsh-study-management-actions"><button type="button" disabled={disabled || expired} onClick={() => { if (proposal.kind === 'delete-source') { setConfirming(proposal); setTitle('') } else decide(proposal, 'approved') }}>{b('批准', 'Approve')}</button><button type="button" disabled={disabled || expired} onClick={() => { decide(proposal, 'rejected') }}>{b('拒绝', 'Reject')}</button></div>{confirming?.id === proposal.id && <form className="dsh-study-management-dialog" onSubmit={event => { event.preventDefault(); if (title === proposal.title) { decide(proposal, 'approved', title); setConfirming(undefined) } }}><label className="dsh-study-management-field">{b(`输入完整标题以删除《${proposal.title}》`, `Enter the full title to delete “${proposal.title}”`)}<input aria-label={b('确认删除标题', 'Confirm deletion title')} value={title} onChange={event => { setTitle(event.target.value) }} /></label><button type="submit" disabled={disabled || title !== proposal.title}>{b('确认删除', 'Confirm deletion')}</button><button type="button" onClick={() => { setConfirming(undefined) }}>{b('取消', 'Cancel')}</button></form>}</article> })}</section>
}
