// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { ManagementWorkspace } from '../src/client/ManagementWorkspace.tsx'

afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks() })

function remote(snapshot: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    managementSnapshot: vi.fn(async () => ({ ok: true, value: snapshot })),
    executeManagementCommand: vi.fn(async () => ({ ok: true, value: { accepted: true } })),
    executeStudioCommand: vi.fn(async () => ({ ok: true, value: { accepted: true } })),
    executeSkillCommand: vi.fn(async () => ({ ok: true, value: { accepted: true } })),
    getManagementSkill: vi.fn(async () => ({ ok: true, value: { id: 'skill-1', name: 'S', description: '', instructions: 'const x = 1', source: 'user', version: 1, recordVersion: 1, archived: false, revisions: [], createdAt: 1, updatedAt: 1 } })),
    decideManagementProposal: vi.fn(async () => ({ ok: true, value: {} })),
    ...overrides,
  } as never
}

const managedFolderCapabilities = { canCreateChild: true, canRename: true, canMove: true, canDelete: true, canAcceptSkills: true } as const
const managedSkillCapabilities = { canClone: true, canEdit: true, canMove: true, canArchive: true, canDelete: false } as const
const managedSkill = (skill: Record<string, unknown>) => ({ ...skill, origin: { kind: 'managed' as const }, capabilities: skill.capabilities ?? managedSkillCapabilities })

const base = {
  controlMode: 'trusted-local-user' as const, grants: [] as string[], grantVersion: 7,
  folders: [{ id: 'skill-root', kind: 'skill' as const, name: '研究', version: 2, createdAt: 1, updatedAt: 1, origin: 'managed' as const, capabilities: managedFolderCapabilities }, { id: 'skill-child', kind: 'skill' as const, name: '方法', parentId: 'skill-root', version: 1, createdAt: 1, updatedAt: 1, origin: 'managed' as const, capabilities: { ...managedFolderCapabilities, canCreateChild: false } }],
  skills: [managedSkill({ id: 'skill-1', name: 'S', description: '', instructions: '', folderId: 'skill-root', source: 'user' as const, version: 1, recordVersion: 1, archived: false, revisions: [], createdAt: 1, updatedAt: 1 })], proposals: [], sources: [], registrySkills: { available: false, complete: true },
}

describe('ManagementWorkspace', () => {
  it('checks a grant immediately while its command is pending', async () => {
    let resolveCommand: ((value: unknown) => void) | undefined
    const executeManagementCommand = vi.fn(() => new Promise(resolve => { resolveCommand = resolve }))
    const api = remote(base, { executeManagementCommand })
    render(<ManagementWorkspace tab="permissions" sessionId="one" studyRemote={api} />)
    const organize = await screen.findByRole('checkbox', { name: '整理书库' }) as HTMLInputElement
    fireEvent.click(organize)
    await waitFor(() => expect(executeManagementCommand).toHaveBeenCalledTimes(1))
    expect(organize.checked).toBe(true)
    expect(organize.disabled).toBe(true)
    resolveCommand?.({ ok: true, value: { accepted: true, grants: ['library.organize'], grantVersion: 8 } })
    await waitFor(() => expect(organize.checked).toBe(true))
  })

  it('keeps a successful grant checked while its refresh snapshot is still pending', async () => {
    let snapshotCalls = 0
    let resolveRefresh: ((value: unknown) => void) | undefined
    const managementSnapshot = vi.fn(() => {
      snapshotCalls += 1
      if (snapshotCalls === 1) return Promise.resolve({ ok: true, value: { ...base, grants: [], grantVersion: 0 } })
      return new Promise(resolve => { resolveRefresh = resolve })
    })
    const executeManagementCommand = vi.fn(async () => ({ ok: true, value: { accepted: true as const, grants: ['library.organize'], grantVersion: 1 } }))
    const api = remote(base, { managementSnapshot, executeManagementCommand })
    render(<ManagementWorkspace tab="permissions" sessionId="one" studyRemote={api} />)
    const organize = await screen.findByRole('checkbox', { name: '整理书库' }) as HTMLInputElement
    fireEvent.click(organize)
    await waitFor(() => expect(executeManagementCommand).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(managementSnapshot).toHaveBeenCalledTimes(2))
    expect(organize.checked).toBe(true)
    resolveRefresh?.({ ok: true, value: { ...base, grants: ['library.organize'], grantVersion: 1 } })
    await waitFor(() => expect(organize.checked).toBe(true))
  })

  it('keeps a successful session-local grant when a stale snapshot arrives', async () => {
    const snapshots = new Map([
      ['one', { ...base, grants: [], grantVersion: 7 }],
      ['two', { ...base, grants: [], grantVersion: 7 }],
    ])
    const executeManagementCommand = vi.fn(async () => ({ ok: true, value: { accepted: true as const, grants: ['library.organize'], grantVersion: 8 } }))
    const api = remote(base, {
      managementSnapshot: vi.fn(async ({ sessionId }: { readonly sessionId: string }) => ({ ok: true, value: snapshots.get(sessionId)! })),
      executeManagementCommand,
    })
    const view = render(<ManagementWorkspace tab="permissions" sessionId="one" studyRemote={api} />)
    const organize = await screen.findByRole('checkbox', { name: '整理书库' }) as HTMLInputElement
    fireEvent.click(organize)
    await waitFor(() => expect(organize.checked).toBe(true))
    await waitFor(() => expect(executeManagementCommand).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'one', command: expect.objectContaining({ grants: ['library.organize'], expectedVersion: 7 }) })))
    view.rerender(<ManagementWorkspace tab="permissions" sessionId="two" studyRemote={api} />)
    await waitFor(() => expect((screen.getByRole('checkbox', { name: '整理书库' }) as HTMLInputElement).checked).toBe(false))
  })

  it('delegates reading-method activation exclusively to work profiles', async () => {
    const api = remote(base)
    render(<ManagementWorkspace tab="skills" sessionId="one" studyRemote={api} />)
    expect(await screen.findByText('我创建的')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /启用此版本|取消启用|升级到/ })).toBeNull()
  })

  it('uses the outer unified tree selection without rendering a second folder navigator', async () => {
    const api = remote(base)
    render(<ManagementWorkspace tab="skills" sessionId="one" folderId="skill-child" studyRemote={api} />)
    await screen.findByText('此文件夹没有 Skill。')
    expect(screen.queryByLabelText('新建 Skill 文件夹')).toBeNull()
    expect(screen.queryByLabelText('重命名 Skill 文件夹')).toBeNull()
  })

  it('sends versioned Skill moves through the unified asset-tree command', async () => {
    const executeStudioCommand = vi.fn(async () => ({ ok: true, value: { accepted: true } }))
    const api = remote(base, { executeStudioCommand })
    render(<ManagementWorkspace tab="skills" sessionId="one" folderId="skill-root" studyRemote={api} />)
    await screen.findByText('我创建的')
    fireEvent.click(screen.getByRole('button', { name: '移动到…' }))
    fireEvent.change(screen.getByRole('combobox', { name: '移动 S' }), { target: { value: 'skill-child' } })
    fireEvent.click(screen.getByRole('button', { name: '确认移动' }))
    await waitFor(() => expect(executeStudioCommand).toHaveBeenCalledWith(expect.objectContaining({ command: { kind: 'apply-asset-tree', treeCommand: { kind: 'move-asset', namespace: 'skill', assetId: 'skill-1', expectedVersion: 1, folderId: 'skill-child' } } })))
  })

  it('offers permanent deletion only for archived user Skills', async () => {
    const executeSkillCommand = vi.fn(async () => ({ ok: true, value: { accepted: true as const, deletedSkillId: 'skill-archived' } }))
    const archived = managedSkill({ id: 'skill-archived', name: 'Old method', description: '', instructions: '', source: 'user' as const, version: 1, recordVersion: 2, archived: true, revisions: [], createdAt: 1, updatedAt: 2, capabilities: { ...managedSkillCapabilities, canDelete: true } })
    const api = remote({ ...base, skills: [archived] }, { executeSkillCommand })
    render(<ManagementWorkspace tab="skills" sessionId="one" studyRemote={api} />)
    fireEvent.click(await screen.findByRole('button', { name: '查看已归档' }))
    await screen.findByText('已归档')
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }))
    fireEvent.click(screen.getByRole('button', { name: '确认永久删除' }))
    await waitFor(() => expect(executeSkillCommand).toHaveBeenCalledWith(expect.objectContaining({ command: { kind: 'delete-skill', skillId: 'skill-archived', expectedRecordVersion: 2 } })))
  })

  it('sends grant version with CAS', async () => {
    const executeManagementCommand = vi.fn(async () => ({ ok: true, value: { accepted: true } }))
    const api = remote(base, { executeManagementCommand })
    render(<ManagementWorkspace tab="permissions" sessionId="one" studyRemote={api} />)
    await screen.findByRole('checkbox', { name: '导入文献' })
    fireEvent.click(screen.getByRole('checkbox', { name: '导入文献' }))
    await waitFor(() => expect(executeManagementCommand).toHaveBeenLastCalledWith(expect.objectContaining({ command: expect.objectContaining({ kind: 'set-agent-grants', expectedVersion: 7 }) })))
  })

  it('shows registry reading methods as read-only virtual folders and only offers an explicit copy', async () => {
    const executeSkillCommand = vi.fn(async () => ({ ok: true, value: { accepted: true } }))
    const registryRoot = { id: 'registry-skill-folder-root', kind: 'skill' as const, name: '内置 / 已安装 Skills', origin: 'registry' as const, capabilities: { canCreateChild: false, canRename: false, canMove: false, canDelete: false, canAcceptSkills: false } }
    const registryFolder = { ...registryRoot, id: 'registry-skill-folder-x', name: 'study-guided-reading', parentId: registryRoot.id }
    const registrySkill = {
      id: 'registry-skill-x', name: 'study-guided-reading', description: '依据当前文献与本轮对话中明确提供的信息引导阅读。', folderId: registryFolder.id,
      source: 'registry' as const, origin: { kind: 'registry' as const, registryName: 'study-guided-reading', provider: 'filesystem', sourceCategory: 'custom' as const, resourceKind: 'directory' as const },
      archived: false as const, invocation: { modelInvocable: true, userInvocable: false },
      capabilities: { canClone: true, canEdit: false, canMove: false, canArchive: false, canDelete: false },
    }
    const api = remote({ ...base, folders: [...base.folders, registryRoot, registryFolder], skills: [...base.skills, registrySkill], registrySkills: { available: true, complete: true } }, { executeSkillCommand })
    render(<ManagementWorkspace tab="skills" sessionId="one" folderId="registry-skill-folder-x" studyRemote={api} />)
    expect(await screen.findByText('类别：custom')).toBeTruthy()
    expect(screen.getByText('不可手动使用')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(screen.queryByLabelText('重命名 Skill 文件夹')).toBeNull()
    expect(screen.queryByLabelText('新建 Skill 文件夹')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '复制为可编辑 Skill' }))
    await waitFor(() => expect(executeSkillCommand).toHaveBeenCalledWith(expect.objectContaining({ command: { kind: 'clone-skill', skillId: 'registry-skill-x' } })))
  })

  it('requires the exact title for deletion proposals and disables expired proposals', async () => {
    const decideManagementProposal = vi.fn(async () => ({ ok: true, value: {} }))
    const api = remote({ ...base, proposals: [
      { id: 'delete', sessionId: 'one', kind: 'delete-source', targetId: 'book', title: '完整标题', targetVersion: 1, commandPayloadHash: 'x', expiresAt: Date.now() + 60_000, createdAt: 1, state: 'pending', version: 3 },
      { id: 'expired', sessionId: 'one', kind: 'delete-source', targetId: 'old', title: '过期', targetVersion: 1, commandPayloadHash: 'x', expiresAt: Date.now() - 1, createdAt: 1, state: 'pending', version: 1 },
    ] }, { decideManagementProposal })
    render(<ManagementWorkspace tab="permissions" sessionId="one" studyRemote={api} />)
    await screen.findByText('删除文献：完整标题')
    fireEvent.click(screen.getAllByRole('button', { name: '批准' })[0]!)
    const input = screen.getByLabelText('确认删除标题') as HTMLInputElement
    fireEvent.change(input, { target: { value: '错误' } })
    expect((screen.getByRole('button', { name: '确认删除' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '完整标题' } })
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(decideManagementProposal).toHaveBeenCalledWith(expect.objectContaining({ commandId: expect.stringMatching(/^proposal-decision-/), proposalId: 'delete', expectedTitle: '完整标题' })))
    expect((screen.getAllByRole('button', { name: '批准' })[1] as HTMLButtonElement).disabled).toBe(true)
  })
})
