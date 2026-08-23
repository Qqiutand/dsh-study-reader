// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToolCatalog } from '../src/client/studio/ToolCatalog.tsx'
import type { ToolDescriptorView } from '../src/study/types.ts'

const descriptor: ToolDescriptorView = {
  name: 'reader_search_passages', title: 'Search document evidence', category: 'evidence-search',
  description: 'Search evidence.', effectiveDescription: 'Search evidence.',
  whenToUse: ['Locate passages.'], whenNotToUse: ['Identity only.'], nextActions: ['Read when context is missing.'],
  risk: 'read', sideEffects: 'none', requiredCapabilities: ['passages.search'],
  sourceResolution: 'temporary-reference-or-current-document', parametersJson: '{"query":{"type":"string"}}',
  outputJson: '{"type":"object"}', limits: { queryCharacters: 512 },
  implementationChain: ['reader_search_passages', 'executeReaderTool', 'ReaderHost', 'Tool result'],
  specVersion: 2, schemaHash: 'a'.repeat(64), enabledInCurrentProfile: true,
}

describe('ToolCatalog', () => {
  it('renders the Host-projected runtime contract instead of a client-side duplicate', async () => {
    const listToolCatalog = vi.fn(async () => ({ ok: true as const, value: [descriptor] }))
    render(<ToolCatalog sessionId="session-1" studyRemote={{ listToolCatalog } as never} />)
    expect(await screen.findByRole('heading', { name: 'Search document evidence' })).toBeTruthy()
    expect(screen.getByText('Locate passages.')).toBeTruthy()
    expect(screen.getByText('passages.search')).toBeTruthy()
    expect(screen.getByText('executeReaderTool')).toBeTruthy()
    expect(listToolCatalog).toHaveBeenCalledTimes(1)
    expect(listToolCatalog).toHaveBeenCalledWith({ sessionId: 'session-1' })
  })
})
