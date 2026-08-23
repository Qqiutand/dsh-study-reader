// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OriginalDocumentFrame } from '../src/client/OriginalDocumentFrame.tsx'

const epubMock = vi.hoisted(() => {
  const display = vi.fn(async () => undefined)
  const spread = vi.fn()
  const fontSize = vi.fn()
  const defaultTheme = vi.fn((_rules: Record<string, Record<string, string>>) => undefined)
  const rendition = {
    hooks: { content: { register: vi.fn() } },
    themes: { fontSize, default: defaultTheme },
    on: vi.fn(), display, spread,
    prev: vi.fn(async () => undefined), next: vi.fn(async () => undefined),
    destroy: vi.fn(),
  }
  const renderTo = vi.fn((_host: HTMLElement, _options: Record<string, unknown>) => rendition)
  const createBook = vi.fn(() => ({
    ready: Promise.resolve(),
    renderTo,
    spine: { spineItems: [{ href: 'Text/chapter-1.xhtml' }, { href: 'Text/chapter-2.xhtml' }] },
    destroy: vi.fn(),
  }))
  return { createBook, renderTo, rendition, display, spread, fontSize, defaultTheme }
})

vi.mock('epubjs', () => ({ default: epubMock.createBook, 'module.exports': undefined }))

describe('EPUB native rendition', () => {
  beforeEach(() => {
    for (const mock of [epubMock.createBook, epubMock.renderTo, epubMock.display, epubMock.spread, epubMock.fontSize, epubMock.defaultTheme]) mock.mockClear()
  })

  it('uses continuous single-column scrolling across spine items and navigates to a selected href', async () => {
    const sections = [
      { id: 'one', title: 'Chapter one', startOrdinal: 0, endOrdinalExclusive: 2, href: 'Text/chapter-1.xhtml', spineIndex: 0 },
      { id: 'two', title: 'Chapter two', startOrdinal: 2, endOrdinalExclusive: 4, href: 'Text/chapter-2.xhtml', spineIndex: 1 },
    ]
    const view = render(<OriginalDocumentFrame format="epub" url="/book.epub" page={1} onPage={vi.fn()} pageCount={2} sections={sections} zoom={100} height={700} />)

    await waitFor(() => expect(epubMock.renderTo).toHaveBeenCalledTimes(1))
    expect(epubMock.renderTo.mock.calls[0]?.[1]).toMatchObject({ flow: 'scrolled', manager: 'continuous', spread: 'none' })
    expect(epubMock.spread).toHaveBeenCalledWith('none')
    const theme = epubMock.defaultTheme.mock.calls[0]?.[0] as Record<string, Record<string, string>>
    expect(theme.html).toMatchObject({ 'overflow-x': 'hidden !important', 'column-count': '1 !important' })
    expect(theme.body).toMatchObject({ 'margin': '0 auto !important', 'max-width': '860px !important', 'column-count': '1 !important' })
    await waitFor(() => expect(epubMock.display).toHaveBeenCalledWith('Text/chapter-1.xhtml'))

    view.rerender(<OriginalDocumentFrame format="epub" url="/book.epub" page={2} onPage={vi.fn()} pageCount={2} sections={sections} zoom={100} height={700} />)
    await waitFor(() => expect(epubMock.display).toHaveBeenLastCalledWith('Text/chapter-2.xhtml'))
  })

  it('falls back to the EPUB spine when legacy preview sections have no href', async () => {
    const sections = [
      { id: 'legacy-one', title: 'Chapter one', startOrdinal: 0, endOrdinalExclusive: 2, spineIndex: 0 },
      { id: 'legacy-two', title: 'Chapter two', startOrdinal: 2, endOrdinalExclusive: 4, spineIndex: 1 },
    ]
    const view = render(<OriginalDocumentFrame format="epub" url="/legacy.epub" page={1} onPage={vi.fn()} pageCount={2} sections={sections} zoom={100} height={700} />)

    await waitFor(() => expect(epubMock.display).toHaveBeenCalledWith('Text/chapter-1.xhtml'))
    view.rerender(<OriginalDocumentFrame format="epub" url="/legacy.epub" page={2} onPage={vi.fn()} pageCount={2} sections={sections} zoom={100} height={700} />)
    await waitFor(() => expect(epubMock.display).toHaveBeenLastCalledWith('Text/chapter-2.xhtml'))
  })
})
