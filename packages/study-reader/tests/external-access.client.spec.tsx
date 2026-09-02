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
    { id: 'source-2' as never, title: 'Optics', recordVersion: 1, kind: 'book', format: 'pdf', revisionId: 'revision-2' as never, selectedInConversation: false },
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
    } }))
    renderAccess({ externalAccessSnapshot, createExternalAccess })

    expect(await screen.findByRole('heading', { name: '外部 AI 访问' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('书单名称'), { target: { value: 'Probability' } })
    fireEvent.click(screen.getByRole('button', { name: '创建连接' }))

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
    expect(await screen.findByDisplayValue(/dsr_v1\.external-1111/u)).toBeTruthy()
    expect(screen.getByText(/mcp_servers\.study-reader/u)).toBeTruthy()
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
    expect((screen.getByLabelText('所属连接') as HTMLSelectElement).value).toBe(connection.id)
    fireEvent.change(screen.getByRole('combobox', { name: '文献分类' }), { target: { value: 'uncategorized' } })
    expect(screen.queryByRole('checkbox', { name: /Probability/u })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: /Optics/u }))
    fireEvent.change(screen.getByLabelText('书单名称'), { target: { value: 'Optics' } })
    fireEvent.click(screen.getAllByRole('button', { name: '添加书单' })[0]!)

    await waitFor(() => expect(saveExternalReadingSet).toHaveBeenCalledWith(expect.objectContaining({ accessId: connection.id, expectedVersion: 1, label: 'Optics', sourceIds: ['source-1', 'source-2'] })))
    expect(screen.queryByLabelText('新连接凭据')).toBeNull()
    expect(await screen.findByText(/Token 不需要修改/u)).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!)
    expect(screen.getByDisplayValue('Probability')).toBeTruthy()
  })
})
