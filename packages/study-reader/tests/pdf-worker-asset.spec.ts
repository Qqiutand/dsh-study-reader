import { afterEach, describe, expect, it } from 'vitest'
import { disposeHarnesses, setupStudy } from './helpers.ts'

afterEach(async () => { await disposeHarnesses() })

describe('PDF worker asset', () => {
  it('serves the real PDF.js worker from the Host asset route', async () => {
    const { ctx } = await setupStudy()
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}/study-reader/assets/_pdfjs/worker/pdf.worker.mjs`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(1_000_000)
  })
})
