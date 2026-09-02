// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalAccess } from '../src/client/studio/ExternalAccess.tsx'
import type { ExternalAccessSnapshot } from '../src/study/types.ts'

afterEach(() => cleanup())

const connection = {
  id: 'external-11111111111111111111111111111111',
  label: 'Existing Codex',
  mcpServerName: 'reader-existing',
  sourceIds: ['source-1'],
  documentTitles: ['Probability'],
  missingDocumentCount: 0,
  state: 'active' as const,
  createdAt: 1,
  expiresAt: Date.now() + 86_400_000,
  version: 1,
}

const snapshot: ExternalAccessSnapshot = {
  enabled: true,
  controlMode: 'trusted-local-user',
  mcpUrl: 'http://127.0.0.1:2026/study-reader/mcp',
  folders: [{ id: 'folder-probability', name: 'Probability' }],
  sources: [
    { id: 'source-1' as never, title: 'Probability', authors: ['E. T. Jaynes'], recordVersion: 1, kind: 'book', format: 'pdf', revisionId: 'revision-1' as never, folderId: 'folder-probability', selectedInConversation: true },
    { id: 'source-2' as never, title: 'Optics', recordVersion: 1, kind: 'book', format: 'pdf', revisionId: 'revision-2' as never, selectedInConversation: false },
    { id: 'source-3' as never, title: 'Still importing', recordVersion: 1, kind: 'book', format: 'pdf', selectedInConversation: true },
  ],
  connections: [connection],
}

describe('ExternalAccess', () => {
  it('defaults to conversation documents, creates one fixed read-only grant, and can revoke it', async () => {
    const externalAccessSnapshot = vi.fn(async () => ({ ok: true as const, value: snapshot }))
    const createExternalAccess = vi.fn(async () => ({ ok: true as const, value: {
      connection: { ...connection, id: 'external-22222222222222222222222222222222', label: 'Reading set', mcpServerName: 'reader-library' },
      token: 'dsr_v1.external-22222222222222222222222222222222.secret',
      mcpUrl: snapshot.mcpUrl,
      environmentVariable: 'DSH_STUDY_READER_LIBRARY_TOKEN',
      codexConfig: '[mcp_servers.reader-library]\nurl = "http://127.0.0.1:2026/study-reader/mcp"',
    } }))
    const revokeExternalAccess = vi.fn(async () => ({ ok: true as const, value: { ...connection, state: 'revoked' as const, revokedAt: Date.now(), version: 2 } }))

    render(<ExternalAccess sessionId="session-1" studyRemote={{ externalAccessSnapshot, createExternalAccess, revokeExternalAccess } as never} />)

    expect(await screen.findByRole('heading', { name: '外部 AI 访问' })).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: /Probability/u }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: /Optics/u }) as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByText('Still importing')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '生成连接' }))
    await waitFor(() => expect(createExternalAccess).toHaveBeenCalledTimes(1))
    expect(createExternalAccess).toHaveBeenCalledWith({
      sessionId: 'session-1',
      commandId: expect.stringMatching(/^external-access-create:/u),
      label: 'Reading set',
      mcpServerName: 'reader-library',
      sourceIds: ['source-1'],
      expiresInDays: 30,
    })
    expect(await screen.findByDisplayValue(/dsr_v1\.external-2222/u)).toBeTruthy()
    expect(screen.getByText(/mcp_servers\.reader-library/u)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(revokeExternalAccess).toHaveBeenCalledWith({
      sessionId: 'session-1',
      commandId: expect.stringMatching(/^external-access-revoke:/u),
      accessId: connection.id,
      expectedVersion: 1,
    }))
  })

  it('filters by library folder and can load the conversation or copy an existing named set', async () => {
    const externalAccessSnapshot = vi.fn(async () => ({ ok: true as const, value: snapshot }))
    render(<ExternalAccess sessionId="session-1" studyRemote={{ externalAccessSnapshot } as never} />)

    expect(await screen.findByRole('heading', { name: '外部 AI 访问' })).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: '文献分类' }), { target: { value: 'uncategorized' } })
    expect(screen.queryByRole('checkbox', { name: /Probability/u })).toBeNull()
    expect(screen.getByRole('checkbox', { name: /Optics/u })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /使用本次对话/u }))
    fireEvent.click(screen.getByRole('button', { name: '复制书单' }))
    expect(screen.getByDisplayValue('Existing Codex 副本')).toBeTruthy()
    expect(screen.getByDisplayValue('reader-existing-copy')).toBeTruthy()
  })
})
