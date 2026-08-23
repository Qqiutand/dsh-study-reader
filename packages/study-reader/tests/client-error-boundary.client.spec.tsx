// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ClientErrorBoundary } from '../src/client/ClientErrorBoundary.tsx'
import { zh, type StudyReaderLocaleKey } from '../src/client/locales.ts'

function t(key: StudyReaderLocaleKey): string { return zh[key] }

describe('ClientErrorBoundary', () => {
  it('contains a workspace render failure and can retry without replacing the surrounding root', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let fail = true
    function Child() {
      if (fail) throw new Error('broken panel')
      return <p>recovered</p>
    }
    render(<div data-testid="host"><ClientErrorBoundary resetKey="session" t={t}><Child /></ClientErrorBoundary></div>)
    expect(screen.getByRole('alert').textContent).toContain('书房暂时无法显示')
    expect(screen.getByTestId('host')).toBeTruthy()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(screen.getByText('recovered')).toBeTruthy()
    consoleError.mockRestore()
  })
})
