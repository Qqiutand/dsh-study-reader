// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OriginalDocumentFrame } from '../src/client/OriginalDocumentFrame.tsx'

const pdfMock = vi.hoisted(() => {
  const getPage = vi.fn(async (_page: number) => ({
    getViewport: ({ scale }: { readonly scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    getTextContent: async () => ({ items: [] }),
  }))
  const destroy = vi.fn()
  const getDocument = vi.fn(() => ({
    promise: Promise.resolve({ numPages: 718, getPage }),
    destroy,
  }))
  return { getDocument, getPage, destroy, GlobalWorkerOptions: { workerSrc: '' } }
})

vi.mock('pdfjs-dist/build/pdf.mjs', () => ({
  getDocument: pdfMock.getDocument,
  GlobalWorkerOptions: pdfMock.GlobalWorkerOptions,
}))

describe('virtualized PDF preview', () => {
  beforeEach(() => {
    pdfMock.getDocument.mockClear()
    pdfMock.getPage.mockClear()
    pdfMock.destroy.mockClear()
    pdfMock.GlobalWorkerOptions.workerSrc = ''
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('mounts only the nearby page window for a long document and uses the Host worker URL', async () => {
    const onPage = vi.fn()
    const view = render(<OriginalDocumentFrame
      format="pdf"
      url="/assets/source/revision/original"
      pdfjsWasmUrl="/assets/_pdfjs/wasm/"
      pdfjsWorkerUrl="/assets/_pdfjs/worker/pdf.worker.mjs"
      page={1}
      onPage={onPage}
      pageCount={718}
      sections={[]}
      zoom={100}
      height={700}
    />)

    await waitFor(() => expect(view.container.querySelectorAll('[data-pdf-page]').length).toBe(3))
    expect(view.container.querySelectorAll('.placeholder')).toHaveLength(0)
    expect(pdfMock.getPage.mock.calls.map(call => call[0])).toEqual([1, 2, 3])
    expect(pdfMock.GlobalWorkerOptions.workerSrc).toBe('/assets/_pdfjs/worker/pdf.worker.mjs')

    view.rerender(<OriginalDocumentFrame
      format="pdf"
      url="/assets/source/revision/original"
      pdfjsWasmUrl="/assets/_pdfjs/wasm/"
      pdfjsWorkerUrl="/assets/_pdfjs/worker/pdf.worker.mjs"
      page={400}
      onPage={onPage}
      pageCount={718}
      sections={[]}
      zoom={100}
      height={700}
    />)
    await waitFor(() => expect([...view.container.querySelectorAll('[data-pdf-page]')].map(node => node.getAttribute('data-pdf-page'))).toEqual(['398', '399', '400', '401', '402']))
    expect(pdfMock.getDocument).toHaveBeenCalledTimes(1)
    expect(view.container.querySelectorAll('[data-pdf-page]').length).toBeLessThanOrEqual(5)
  })
})
