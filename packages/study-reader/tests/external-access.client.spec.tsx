// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalAccess } from '../src/client/studio/ExternalAccess.tsx'
import type { ExternalAccessSnapshot } from '../src/study/types.ts'

afterEach(() => cleanup())

const readingSet = {
  setRef: 'set_default',
  label: 'Probability',
  sourceIds: ['source-1'],
  documentTitles: ['Probability'],
  missingDocumentCount: 0,
  createdAt: 1,
  updatedAt: 1,
}

const connection = {
  id: 'external-11111111111111111111111111111111',
  label: 'Codex',
  mcpServerName: 'study-reader',
  sourceIds: ['source-1'],
  documentTitles: ['Probability'],
  missingDocumentCount: 0,
  readingSets: [readingSet],
  state: 'active' as const,
  createdAt: 1,
  expiresAt: Date.now() + 100_000,
  version: 1,
}

const baseSnapshot: ExternalAccessSnapshot = {
  enabled: true,
  controlMode: 'trusted-local-user',
  mcpUrl: 'http://127.0.0.1:2026/study-reader/mcp',
  folders: [{ id: 'folder-probability', name: 'Probability' }],
  sources: [
    { id: 'source-1' as never, title: 'Probability', authors: ['E. T. Jaynes'], recordVersion: 1, kind: 'book', format: 'pdf', revisionId: 'revision-1' as never, folderId: 'folder-probability', selectedInConversation: true },
    { id: 'source-2' as never, title: 'Optics', recordVersion: 1, kind: 'book', format: 'epub', revisionId: 'revision-2' as never, selectedInConversation: false },
    { id: 'source-3' as never, title: 'Still importing', recordVersion: 1, kind: 'book', format: 'pdf', selectedInConversation: true },
  ],
  connections: [],
}

function renderAccess(remote: object) {
  return render(<ExternalAccess sessionId="session-1" studyRemote={remote as never} />)
}

describe('ExternalAccess', () => {
  it('creates one connection with its initial reading set and shows one-time credentials', async () => {
    const externalAccessSnapshot = vi.fn(async () => ({ ok: true as const, value: baseSnapshot }))
    const createExternalAccess = vi.fn(async () => ({ ok: true as const, value: {
      connection,
      token: 'dsr_v1.external-11111111111111111111111111111111.secret',
      mcpUrl: baseSnapshot.mcpUrl,
      environmentVariable: 'DSH_STUDY_READER_TOKEN',
      codexConfig: '[mcp_servers.study-reader]\nurl = "http://127.0.0.1:2026/study-reader/mcp"',
      antigravityConfig: '{\n  "mcpServers": {\n    "study-reader": {\n      "serverUrl": "http://127.0.0.1:2026/study-reader/mcp",\n      "headers": {\n        "Authorization": "Bearer dsr_v1.external-11111111111111111111111111111111.secret"\n      }\n    }\n  }\n}',
    } }))
    renderAccess({ externalAccessSnapshot, createExternalAccess })

    expect(await screen.findByRole('heading', { name: '外部 AI 访问' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('书单名称'), { target: { value: 'Probability' } })
    expect(screen.getByText('MCP 地址 + Bearer Token')).toBeTruthy()
    expect(screen.getByText('reader_list_sets → setRef')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '生成客户端授权' }))

    await waitFor(() => expect(createExternalAccess).toHaveBeenCalledTimes(1))
    expect(createExternalAccess).toHaveBeenCalledWith({
      sessionId: 'session-1',
      commandId: expect.stringMatching(/^external-access-create:/u),
      label: 'Codex',
      mcpServerName: 'study-reader',
      readingSetLabel: 'Probability',
      sourceIds: ['source-1'],
      expiresInDays: 365,
    })
    const secret = await screen.findByLabelText('访问密钥') as HTMLInputElement
    expect(secret.type).toBe('password')
    expect(secret.value).toMatch(/dsr_v1\.external-1111/u)
    expect(document.body.textContent).not.toContain(secret.value)
    fireEvent.click(screen.getByRole('button', { name: '显示' }))
    expect(secret.type).toBe('text')
    expect(screen.getByText(/mcp_servers\.study-reader/u)).toBeTruthy()
    expect(screen.getByLabelText('Antigravity')).toBeTruthy()
    expect(screen.getAllByText(/<BEARER_TOKEN>/u)).toHaveLength(2)
    expect(screen.getByText(/"serverUrl": "http:\/\/127\.0\.0\.1:2026\/study-reader\/mcp"/u)).toBeTruthy()
  })

  it('adds and edits sets on an existing connection without requesting new credentials', async () => {
    const snapshot = { ...baseSnapshot, connections: [connection] }
    const updated = { ...connection, version: 2, sourceIds: ['source-1', 'source-2'], readingSets: [...connection.readingSets, { ...readingSet, setRef: 'set_ABCDEFGH', label: 'Optics', sourceIds: ['source-2'], documentTitles: ['Optics'] }] }
    const externalAccessSnapshot = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: snapshot })
      .mockResolvedValue({ ok: true as const, value: { ...snapshot, connections: [updated] } })
    const saveExternalReadingSet = vi.fn(async () => ({ ok: true as const, value: updated }))
    renderAccess({ externalAccessSnapshot, saveExternalReadingSet })

    expect(await screen.findByRole('heading', { name: '外部 AI 访问' })).toBeTruthy()
    expect(screen.getByText('书单标识（setRef）')).toBeTruthy()
    expect(screen.getByText('AI 用它选择这份书单；需要时可复制到对话中。')).toBeTruthy()
    expect(screen.getByText('set_default')).toBeTruthy()
    expect((screen.getByLabelText('客户端授权') as HTMLSelectElement).value).toBe(connection.id)
    fireEvent.change(screen.getByRole('combobox', { name: '文献分类' }), { target: { value: 'uncategorized' } })
    expect(screen.queryByRole('checkbox', { name: /Probability/u })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: /Optics/u }))
    fireEvent.change(screen.getByRole('combobox', { name: '文献分类' }), { target: { value: 'selected' } })
    expect(screen.getByRole('option', { name: '已勾选 (2)' })).toBeTruthy()
    const selectedProbability = screen.getByRole('checkbox', { name: /Probability/u }) as HTMLInputElement
    expect(selectedProbability.checked).toBe(true)
    expect(selectedProbability.closest('label')?.dataset.selected).toBe('true')
    expect(selectedProbability.closest('label')?.querySelector('[data-kind="folder"]')?.getAttribute('data-tone')).not.toBe('neutral')
    expect((screen.getByRole('checkbox', { name: /Optics/u }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('checkbox', { name: /Optics/u }).closest('label')?.querySelector('[data-format="epub"]')).toBeTruthy()
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('书单名称'), { target: { value: 'Optics' } })
    fireEvent.click(screen.getAllByRole('button', { name: '添加书单' })[0]!)

    await waitFor(() => expect(saveExternalReadingSet).toHaveBeenCalledWith(expect.objectContaining({ accessId: connection.id, expectedVersion: 1, label: 'Optics', sourceIds: ['source-1', 'source-2'] })))
    expect(screen.queryByLabelText('新客户端授权凭据')).toBeNull()
    expect(await screen.findByText(/客户端配置和 Token 不需要修改/u)).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!)
    expect(screen.getByDisplayValue('Probability')).toBeTruthy()
  })

  it('hides revoked connections from the management list', async () => {
    const revokedConnection = { ...connection, id: 'external-22222222222222222222222222222222', label: 'SSH', state: 'revoked' as const }
    const initialSnapshot = { ...baseSnapshot, connections: [connection, revokedConnection] }
    const afterRevokeSnapshot = { ...baseSnapshot, connections: [{ ...connection, state: 'revoked' as const }, revokedConnection] }
    const externalAccessSnapshot = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: initialSnapshot })
      .mockResolvedValue({ ok: true as const, value: afterRevokeSnapshot })
    const revokeExternalAccess = vi.fn(async () => ({ ok: true as const, value: { ...connection, state: 'revoked' as const } }))
    renderAccess({ externalAccessSnapshot, revokeExternalAccess })

    expect(await screen.findByRole('button', { name: '撤销授权' })).toBeTruthy()
    expect(screen.queryByText('SSH')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '撤销授权' }))

    await waitFor(() => expect(revokeExternalAccess).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('还没有客户端授权。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '撤销授权' })).toBeNull()
  })
})
