// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetTree } from '../src/client/studio/AssetTree.tsx'

afterEach(() => { cleanup(); window.localStorage.clear() })

describe('Studio AssetTree', () => {
  it('exposes Uncategorized as a fixed virtual library folder', () => {
    const onSelect = vi.fn()
    render(<AssetTree sessionId="uncategorized" studyRemote={undefined} selected={{ section: 'library' }} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: '未分类' }))
    expect(onSelect).toHaveBeenCalledWith({ section: 'library', folderId: '' })
  })

  it('loads typed roots from Host and expands children only on demand', async () => {
    const listTreeChildren = vi.fn(async (request: { namespace: string; parentId?: string }) => ({ ok: true as const, value: {
      folders: request.namespace === 'prompt' && request.parentId === undefined ? [{ id: 'prompt-root', namespace: 'prompt' as const, name: 'Research', sortKey: 'research', version: 1, createdAt: 1, updatedAt: 1, origin: 'managed' as const, capabilities: { canCreateChild: true, canRename: true, canMove: true, canDelete: true, canAcceptAssets: true } }]
        : request.parentId === 'prompt-root' ? [{ id: 'prompt-child', namespace: 'prompt' as const, parentId: 'prompt-root', name: 'Proofs', sortKey: 'proofs', version: 1, createdAt: 1, updatedAt: 1, origin: 'managed' as const, capabilities: { canCreateChild: true, canRename: true, canMove: true, canDelete: true, canAcceptAssets: true } }] : [],
      assets: [], total: request.namespace === 'prompt' ? 1 : 0,
    } }))
    const onSelect = vi.fn()
    const executeStudioCommand = vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } }))
    render(<AssetTree sessionId="s1" studyRemote={{ listTreeChildren, executeStudioCommand } as never} selected={{ section: 'prompts' }} onSelect={onSelect} />)
    expect(await screen.findByText('Research')).toBeTruthy()
    expect(listTreeChildren).not.toHaveBeenCalledWith(expect.objectContaining({ parentId: 'prompt-root' }))
    fireEvent.click(screen.getByRole('button', { name: '展开 Research' }))
    expect(await screen.findByText('Proofs')).toBeTruthy()
    await waitFor(() => expect(listTreeChildren).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'prompt', parentId: 'prompt-root', limit: 40 })))
    fireEvent.click(screen.getByRole('button', { name: 'Proofs' }))
    expect(onSelect).toHaveBeenCalledWith({ section: 'prompts', folderId: 'prompt-child' })
    fireEvent.click(screen.getByRole('button', { name: '管理 Research' }))
    fireEvent.change(screen.getByLabelText('文件夹名称'), { target: { value: 'Research archive' } })
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    await waitFor(() => expect(executeStudioCommand).toHaveBeenCalledWith(expect.objectContaining({ command: { kind: 'apply-asset-tree', treeCommand: { kind: 'rename-folder', folderId: 'prompt-root', name: 'Research archive', expectedVersion: 1 } } })))
  })

  it('creates a root folder through the same typed tree gateway', async () => {
    const listTreeChildren = vi.fn(async () => ({ ok: true as const, value: { folders: [], assets: [], total: 0 } }))
    const executeStudioCommand = vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } }))
    const onTreeChanged = vi.fn()
    render(<AssetTree sessionId="s2" studyRemote={{ listTreeChildren, executeStudioCommand } as never} selected={{ section: 'library' }} onSelect={vi.fn()} onTreeChanged={onTreeChanged} />)
    fireEvent.click(screen.getByRole('button', { name: '新建 全部文献 文件夹' }))
    fireEvent.change(screen.getByLabelText('文件夹名称'), { target: { value: '论文' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(executeStudioCommand).toHaveBeenCalledWith(expect.objectContaining({ command: { kind: 'apply-asset-tree', treeCommand: { kind: 'create-folder', namespace: 'library', name: '论文' } } })))
    expect(onTreeChanged).toHaveBeenCalledTimes(1)
  })

  it('keeps the complete Bookroom tree when assistant settings are collapsed', () => {
    const onToggleCollapsed = vi.fn()
    const onSelect = vi.fn()
    render(<AssetTree sessionId="s3" studyRemote={undefined} selected={{ section: 'library' }} collapsed onToggleCollapsed={onToggleCollapsed} onSelect={onSelect} />)
    expect(screen.getByRole('button', { name: '展开助手设置' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^全部文献/u })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '文献库' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^总览/u })).toBeNull()
    expect(screen.queryByRole('button', { name: /^配置预设/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^全部文献/u }))
    expect(onSelect).toHaveBeenCalledWith({ section: 'library' })
    fireEvent.click(screen.getByRole('button', { name: '展开助手设置' }))
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1)
  })

  it('returns a hidden assistant-settings route to Bookroom when collapsing', () => {
    const onToggleCollapsed = vi.fn()
    const onSelect = vi.fn()
    render(<AssetTree sessionId="s4" studyRemote={undefined} selected={{ section: 'profiles' }} collapsed={false} onToggleCollapsed={onToggleCollapsed} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: '收起助手设置' }))

    expect(onSelect).toHaveBeenCalledWith({ section: 'library' })
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1)
  })
})
