import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('development and packaged Cordis patches', () => {
  it('remain byte-identical', async () => {
    const root = resolve(import.meta.dirname, '../../..')
    await expect(readFile(resolve(root, 'cordis.patch.yml'), 'utf8')).resolves.toBe(await readFile(resolve(root, 'packages/study-reader/cordis.patch.yml'), 'utf8'))
  })
})
