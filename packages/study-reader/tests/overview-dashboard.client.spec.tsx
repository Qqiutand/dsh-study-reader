// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OverviewDashboard } from '../src/client/studio/OverviewDashboard.tsx'

afterEach(() => cleanup())

describe('OverviewDashboard', () => {
  it('summarizes the current conversation and changes document availability in place', async () => {
    const setSourceAccess = vi.fn(async () => ({ ok: true as const, value: { granted: false, selection: { schemaVersion: 1 as const, sessionId: 's', version: 1, updatedAt: 2 } } }))
    const remote = {
      studioSnapshot: vi.fn(async () => ({ ok: true as const, value: { immutableBaseline: { id: 'baseline' }, prompts: [], profiles: [], skills: [], folders: [] } })),
      listToolCatalog: vi.fn(async () => ({ ok: true as const, value: [] })),
      listAssets: vi.fn(async (request: { namespace: string }) => ({ ok: true as const, value: { assets: request.namespace === 'library' ? [{ id: 'source-1', kind: 'source' as const, namespace: 'library' as const, folderId: 'probability', name: 'Probability', recordVersion: 1, badges: [], source: { id: 'source-1', title: 'Probability', recordVersion: 1, kind: 'book' as const, format: 'pdf' as const, revisionId: 'revision-1', granted: true } }, { id: 'source-2', kind: 'source' as const, namespace: 'library' as const, name: 'Hidden notes', recordVersion: 1, badges: [], source: { id: 'source-2', title: 'Hidden notes', recordVersion: 1, kind: 'paper' as const, format: 'pdf' as const, revisionId: 'revision-2', granted: false } }] : [], total: request.namespace === 'library' ? 2 : 0 } })),
      listTreeChildren: vi.fn(async (request: { namespace: string; parentId?: string }) => ({ ok: true as const, value: { folders: request.namespace === 'library' && request.parentId === undefined ? [{ id: 'probability', namespace: 'library' as const, name: '概率论', sortKey: 'probability', version: 1, createdAt: 1, updatedAt: 1, origin: 'managed' as const, capabilities: { canCreateChild: true, canRename: true, canMove: true, canDelete: true, canAcceptAssets: true } }] : [], assets: [], total: request.namespace === 'library' && request.parentId === undefined ? 1 : 0 } })),
      getWorkspaceDefault: vi.fn(async () => ({ ok: true as const, value: { available: false as const } })),
      setSourceAccess,
    }
    const changed = vi.fn()
    render(<OverviewDashboard sessionId="s" studyRemote={remote as never} onNavigate={vi.fn()} onChanged={changed} />)
    expect(await screen.findByRole('heading', { name: '本次对话正在使用什么' })).toBeTruthy()
    expect(screen.getAllByText('对话资料')).toHaveLength(2)
    const row = screen.getByText('Probability').closest('article')!
    expect(row.textContent).toContain('文献库 / 概率论')
    expect(screen.queryByText('Hidden notes')).toBeNull()
    fireEvent.click(row.querySelector('button')!)
    await waitFor(() => expect(setSourceAccess).toHaveBeenCalledWith({ sessionId: 's', sourceId: 'source-1', granted: false }))
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('shows the six preset tools as available when no work plan is selected', async () => {
    const tools = Array.from({ length: 6 }, (_, index) => ({ name: `study_tool_${index}`, title: `工具 ${index + 1}`, description: '默认文献工具', enabledInCurrentProfile: true }))
    const remote = {
      studioSnapshot: vi.fn(async () => ({ ok: true as const, value: { immutableBaseline: { id: 'baseline' }, prompts: [], profiles: [], skills: [], folders: [] } })),
      listToolCatalog: vi.fn(async () => ({ ok: true as const, value: tools })),
      listAssets: vi.fn(async () => ({ ok: true as const, value: { assets: [], total: 0 } })),
      listTreeChildren: vi.fn(async () => ({ ok: true as const, value: { folders: [], assets: [], total: 0 } })),
      getWorkspaceDefault: vi.fn(async () => ({ ok: true as const, value: { available: false as const } })),
    }
    render(<OverviewDashboard sessionId="s" studyRemote={remote as never} onNavigate={vi.fn()} onChanged={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Tools/ }))
    expect(await screen.findByText('工具 1')).toBeTruthy()
    expect(screen.getAllByText('默认可用')).toHaveLength(6)
    expect(screen.queryByText('未启用')).toBeNull()
  })

  it('saves the current effective settings as a new plan without activating it', async () => {
    const executeStudioCommand = vi.fn(async () => ({ ok: true as const, value: { accepted: true as const, profile: { name: 'My setup' } } }))
    const remote = {
      studioSnapshot: vi.fn(async () => ({ ok: true as const, value: { immutableBaseline: { id: 'baseline' }, prompts: [], profiles: [], skills: [], folders: [] } })),
      listToolCatalog: vi.fn(async () => ({ ok: true as const, value: [{ name: 'reader_get_context', title: 'Context', description: '', enabledInCurrentProfile: true }] })),
      listAssets: vi.fn(async () => ({ ok: true as const, value: { assets: [], total: 0 } })),
      listTreeChildren: vi.fn(async () => ({ ok: true as const, value: { folders: [], assets: [], total: 0 } })),
      getWorkspaceDefault: vi.fn(async () => ({ ok: true as const, value: { available: false as const } })),
      executeStudioCommand,
    }
    render(<OverviewDashboard sessionId="s" studyRemote={remote as never} onNavigate={vi.fn()} onChanged={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '保存为配置预设' }))
    fireEvent.change(screen.getByLabelText('预设名称'), { target: { value: 'My setup' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(executeStudioCommand).toHaveBeenCalledTimes(1))
    const request = (executeStudioCommand.mock.calls as unknown as readonly [readonly [{ readonly command: Record<string, unknown> }]])[0]![0]
    expect(request.command).toMatchObject({ kind: 'create-profile', name: 'My setup', toolPolicies: [{ toolName: 'reader_get_context', enabled: true }] })
    expect(request.command.kind).not.toBe('activate-profile')
  })

  it('saves the current documents and Reader configuration as this folder’s new-session default', async () => {
    const saveWorkspaceDefault = vi.fn(async () => ({ ok: true as const, value: {
      available: true as const,
      workspacePath: '/home/reader/research-project',
      active: true,
      version: 1,
      sourceCount: 2,
      profileName: 'Careful reading',
      matchesCurrent: true,
      updatedAt: 20,
    } }))
    const remote = {
      studioSnapshot: vi.fn(async () => ({ ok: true as const, value: { immutableBaseline: { id: 'baseline' }, prompts: [], profiles: [], skills: [], folders: [] } })),
      listToolCatalog: vi.fn(async () => ({ ok: true as const, value: [] })),
      listAssets: vi.fn(async () => ({ ok: true as const, value: { assets: [], total: 0 } })),
      listTreeChildren: vi.fn(async () => ({ ok: true as const, value: { folders: [], assets: [], total: 0 } })),
      getWorkspaceDefault: vi.fn(async () => ({ ok: true as const, value: {
        available: true as const,
        workspacePath: '/home/reader/research-project',
        active: false,
        version: 0,
        sourceCount: 0,
        matchesCurrent: false,
      } })),
      saveWorkspaceDefault,
    }
    const changed = vi.fn()
    render(<OverviewDashboard sessionId="s" studyRemote={remote as never} onNavigate={vi.fn()} onChanged={changed} />)

    expect(await screen.findByText('research-project')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '设为当前工作区默认' }))

    await waitFor(() => expect(saveWorkspaceDefault).toHaveBeenCalledTimes(1))
    expect(saveWorkspaceDefault).toHaveBeenCalledWith({
      sessionId: 's',
      commandId: expect.stringMatching(/^overview:save-workspace-default:/u),
      expectedVersion: 0,
    })
    expect((await screen.findByRole('button', { name: '当前已是默认' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('新会话默认')
    expect(changed).toHaveBeenCalledTimes(1)
  })
})
