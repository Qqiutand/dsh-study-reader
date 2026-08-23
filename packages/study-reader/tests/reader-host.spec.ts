import { afterEach, describe, expect, it } from 'vitest'
import { createStudyReaderHost } from '../lib/types/study/reader-host.js'
import { disposeHarnesses, setupStudy } from './helpers.ts'

afterEach(async () => { await disposeHarnesses() })

describe('principal-bound ReaderHost', () => {
  it('re-authorizes every operation against both the captured and current principal', async () => {
    const harness = await setupStudy()
    const host = createStudyReaderHost(harness.ctx.study, 'reader-a')
    const signal = new AbortController().signal

    await expect(harness.agents.runAs('reader-a', async () =>
      await host.getContext({ principalId: 'reader-a', signal }),
    )).resolves.toMatchObject({ private: { principalId: 'reader-a' } })

    const operations = [
      () => host.getContext({ principalId: 'reader-a', signal }),
      () => host.listDocuments!({ principalId: 'reader-a', limit: 1, signal }),
      () => host.getOutline!({ principalId: 'reader-a', documentId: 'foreign-source', maxDepth: 1, signal }),
      () => host.searchPassages!({ principalId: 'reader-a', query: 'evidence', documentIds: ['foreign-source'], limit: 1, signal }),
      () => host.readPassage!({ principalId: 'reader-a', documentId: 'foreign-source', anchor: { kind: 'page', page: 1 }, window: 0, signal }),
      () => host.saveNote!({ principalId: 'reader-a', content: 'note', documentId: 'foreign-source', sourcePassages: [], signal }),
    ]

    for (const operation of operations) {
      await expect(harness.agents.runAs('reader-b', operation)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    }

    await expect(harness.agents.runAs('reader-a', async () =>
      await host.getContext({ principalId: 'reader-b', signal }),
    )).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })
})
