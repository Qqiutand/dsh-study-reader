// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MinerUSettings } from '../src/client/MinerUSettings.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const localConnection = {
  id: 'provider-mineru', providerId: 'mineru', kind: 'document-extraction', displayName: 'MinerU',
  builtin: true, active: true,
  credentialRef: 'MINERU_API_KEY', endpoint: 'http://127.0.0.1:8000', enabled: true, version: 1,
  options: { apiMode: 'local-docker', localBackend: 'pipeline', language: 'ch', requestTimeoutMs: 30000 },
  health: { state: 'available', checkedAt: 1, retryable: false },
} as const

describe('MinerUSettings', () => {
  it('uses the injected credentials face directly and renders local Docker controls', async () => {
    const describe = vi.fn(async () => ({ ok: true, value: { MINERU_API_KEY: { configured: false, writable: true } } }))
    const listProviderConnections = vi.fn(async () => ({ ok: true, value: [localConnection] }))

    render(<MinerUSettings credentials={{ describe, set: vi.fn(), unset: vi.fn() } as never} studyRemote={{ listProviderConnections } as never} sessionId="session-one" />)

    await screen.findByRole('option', { name: '本地 Docker（mineru-api）' })
    expect(screen.getByText('正在使用')).toBeTruthy()
    expect(describe).toHaveBeenCalledWith(['MINERU_API_KEY'])
    expect(listProviderConnections).toHaveBeenCalledWith({ sessionId: 'session-one' })
  })

  it('still loads connection controls when the Credential Service is unavailable', async () => {
    const listProviderConnections = vi.fn(async () => ({ ok: true, value: [localConnection] }))

    render(<MinerUSettings credentials={undefined} studyRemote={{ listProviderConnections } as never} sessionId="session-one" />)

    await screen.findByRole('option', { name: '本地 Docker（mineru-api）' })
    await waitFor(() => expect(listProviderConnections).toHaveBeenCalled())
    expect(screen.getByText('正在使用')).toBeTruthy()
  })
})
