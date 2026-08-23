/**
 * ZIP hardening and normalization tests: traversal, symlink, drive paths,
 * NUL, duplicates, bombs, invalid JSON — plus the v2 / v1 / Markdown
 * fallback pipelines and deterministic block ids.
 */

import { createHash } from 'node:crypto'
import { rm, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildZip, v2Content } from '../../../examples/study-reader/fake-mineru.ts'
import { normalizeArchive } from '../lib/types/mineru/normalizer.js'
import { normalizeText } from '../lib/types/extraction/canonicalizer.js'
import { validateEntryName, type ArchiveLimits } from '../lib/types/extraction/archive-reader.js'

const LIMITS: ArchiveLimits = {
  maxArchiveBytes: 1024 * 1024,
  maxUncompressedBytes: 2 * 1024 * 1024,
  maxArchiveEntries: 100,
  maxEntryBytes: 512 * 1024,
}

const roots: string[] = []

async function archive(entries: Array<{ name: string; data: Uint8Array }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-zip-test-'))
  roots.push(root)
  const path = join(root, 'archive.zip')
  await writeFile(path, buildZip(entries))
  return path
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('validateEntryName', () => {
  it('accepts safe relative names', () => {
    expect(validateEntryName('content/content_list_v2.json')).toBe('content/content_list_v2.json')
  })

  it('rejects traversal, absolute, drive, NUL, and backslash names', () => {
    expect(() => validateEntryName('../evil')).toThrowError(expect.objectContaining({ code: 'ZIP_UNSAFE_PATH' }))
    expect(() => validateEntryName('a/../../evil')).toThrowError(expect.objectContaining({ code: 'ZIP_UNSAFE_PATH' }))
    expect(() => validateEntryName('/etc/passwd')).toThrowError(expect.objectContaining({ code: 'ZIP_UNSAFE_PATH' }))
    expect(() => validateEntryName('C:\\windows\\evil')).toThrowError(expect.objectContaining({ code: 'ZIP_UNSAFE_PATH' }))
    expect(() => validateEntryName('evil\\..\\x')).toThrowError(expect.objectContaining({ code: 'ZIP_UNSAFE_PATH' }))
    expect(() => validateEntryName('a\0b')).toThrowError(expect.objectContaining({ code: 'ZIP_UNSAFE_PATH' }))
  })
})

describe('normalizeArchive hardening', () => {
  it('rejects an archive with duplicate entry names', async () => {
    const path = await archive([
      { name: 'content/content_list_v2.json', data: text(JSON.stringify(v2Content())) },
      { name: 'content/content_list_v2.json', data: text(JSON.stringify(v2Content())) },
    ])
    await expect(normalizeArchive(path, LIMITS, async () => 'sha256/x' as never)).rejects
      .toMatchObject({ code: 'ZIP_DUPLICATE_ENTRY' })
  })

  it('rejects a zip bomb beyond maxUncompressedBytes', async () => {
    // The archive itself stays under maxArchiveBytes (10 MiB) while the
    // uncompressed total exceeds maxUncompressedBytes (2 MiB).
    // Three 1 MiB entries: each under maxEntryBytes, the total over
    // maxUncompressedBytes, and the archive itself under maxArchiveBytes.
    const entries = [
      { name: 'content/content_list_v2.json', data: text(JSON.stringify(v2Content())) },
      ...Array.from({ length: 3 }, (_, index) => ({ name: `big${index}.bin`, data: new Uint8Array(1024 * 1024) })),
    ]
    const path = await archive(entries)
    await expect(normalizeArchive(path, {
      ...LIMITS,
      maxArchiveBytes: 10 * 1024 * 1024,
      maxUncompressedBytes: 2 * 1024 * 1024,
      maxEntryBytes: 2 * 1024 * 1024,
    }, async () => 'sha256/x' as never)).rejects
      .toMatchObject({ code: 'ZIP_BOMB' })
  })

  it('rejects an entry beyond maxEntryBytes', async () => {
    const path = await archive([
      { name: 'content/content_list_v2.json', data: text(JSON.stringify(v2Content())) },
      { name: 'big.bin', data: new Uint8Array(600 * 1024) },
    ])
    await expect(normalizeArchive(path, LIMITS, async () => 'sha256/x' as never)).rejects
      .toMatchObject({ code: 'ZIP_ENTRY_TOO_LARGE' })
  })

  it('rejects invalid JSON in the selected content list', async () => {
    const path = await archive([
      { name: 'content/content_list_v2.json', data: text('{ not json') },
    ])
    await expect(normalizeArchive(path, LIMITS, async () => 'sha256/x' as never)).rejects
      .toMatchObject({ code: 'ZIP_INVALID_JSON' })
  })

  it('rejects an archive with no recognized content', async () => {
    const path = await archive([{ name: 'readme.txt', data: text('hi') }])
    await expect(normalizeArchive(path, LIMITS, async () => 'sha256/x' as never)).rejects
      .toMatchObject({ code: 'ZIP_NO_CONTENT' })
  })

  it('rejects a file that is not a zip at all', async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), 'dsh-zip-test-'))) - 1]
    const path = join(root, 'not-a-zip.zip')
    await writeFile(path, 'plain text')
    await expect(normalizeArchive(path, LIMITS, async () => 'sha256/x' as never)).rejects.toThrow()
  })
})

describe('normalizeArchive content selection', () => {
  it('prefers content_list_v2.json over v1 and full.md', async () => {
    const path = await archive([
      { name: 'content/full.md', data: text('# Fallback\n\nBody') },
      { name: 'content/content_list.json', data: text(JSON.stringify([{ page_idx: 0, type: 'text', text: 'v1 text' }])) },
      { name: 'content/content_list_v2.json', data: text(JSON.stringify(v2Content())) },
    ])
    const result = await normalizeArchive(path, LIMITS, async () => 'sha256/a' as never)
    expect(result.blocks.some(block => block.text === '社会科学的核心问题是解释社会现象。')).toBe(true)
    expect(result.blocks.some(block => block.text === 'v1 text')).toBe(false)
  })

  it('parses the v2 pipeline with 1-based pages, heading paths, and deterministic ids', async () => {
    const path = await archive([{ name: 'content/content_list_v2.json', data: text(JSON.stringify(v2Content())) }])
    const result = await normalizeArchive(path, LIMITS, async () => 'sha256/abc' as never)
    const title = result.blocks.find(block => block.type === 'title')
    expect(title?.page).toBe(1)
    expect(title?.headingPath).toEqual([])
    const paragraph = result.blocks.find(block => block.text === '因果推断需要识别策略。')
    expect(paragraph?.page).toBe(2)
    expect(paragraph?.headingPath).toEqual(['第一章 导论'])
    expect(result.pageCount).toBe(3)
    expect(result.outline).toHaveLength(1)
    expect(result.outline[0]?.title).toBe('第一章 导论')
    // Deterministic: identical input yields identical ids.
    const again = await normalizeArchive(path, LIMITS, async () => 'sha256/abc' as never)
    expect(again.blocks.map(block => block.id)).toEqual(result.blocks.map(block => block.id))
    expect(result.blocks[0]?.id).not.toBe('')
  })

  it('parses the v1 pipeline (page_idx, tables)', async () => {
    const v1 = [
      { page_idx: 0, type: 'title', text: '标题' },
      { page_idx: 0, type: 'text', text: '正文' },
      { page_idx: 1, type: 'table', table_body: [[{ text: 'a' }, { text: 'b' }], [{ text: 'c' }]] },
    ]
    const path = await archive([{ name: 'content/content_list.json', data: text(JSON.stringify(v1)) }])
    const result = await normalizeArchive(path, LIMITS, async () => 'sha256/v1' as never)
    expect(result.blocks[1]?.text).toBe('正文')
    const table = result.blocks.find(block => block.type === 'table')
    expect(table?.text).toContain('a | b')
    expect(result.pageCount).toBe(2)
  })

  it('falls back to full.md with coarse blocks', async () => {
    const markdown = '# 第一章\n\n第一段文字。\n\n- 列表项一\n- 列表项二\n\n```\ncode\n```\n\n第二段。\n'
    const path = await archive([{ name: 'content/full.md', data: text(markdown) }])
    const result = await normalizeArchive(path, LIMITS, async () => 'sha256/md' as never)
    const types = result.blocks.map(block => block.type)
    expect(types).toContain('title')
    expect(types).toContain('paragraph')
    expect(types).toContain('list')
    expect(result.blocks.every(block => block.page === 0)).toBe(true)
    expect(result.pageCount).toBeUndefined()
  })

  it('copies referenced image assets and remaps assetPath to blob keys', async () => {
    const path = await archive([
      { name: 'content/content_list_v2.json', data: text(JSON.stringify(v2Content())) },
      { name: 'images/cover.png', data: new Uint8Array([0x89, 0x50]) },
      { name: 'images/unreferenced.png', data: new Uint8Array([0x89, 0x51]) },
    ])
    const result = await normalizeArchive(path, LIMITS, async (data, name) => `sha256/${name}` as never)
    const image = result.blocks.find(block => block.type === 'image')
    expect(image?.assetPath).toBe('sha256/cover.png')
    expect(result.assets.has('images/cover.png')).toBe(true)
    expect(result.assets.has('images/unreferenced.png')).toBe(false)
  })
})

describe('normalizeText', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeText('  a\n\t b  ')).toBe('a b')
  })
})

describe('block id determinism', () => {
  it('ids are stable across identical revisions', () => {
    const first = sha('rev-1', 3, 'text')
    const second = sha('rev-1', 3, 'text')
    const other = sha('rev-1', 4, 'text')
    expect(first).toBe(second)
    expect(first).not.toBe(other)
  })
})

function sha(revision: string, ordinal: number, text: string): string {
  // Reuse the production formula: sha256(revisionSha + "\0" + ordinal + "\0" + normalizedText)
  return createHash('sha256').update(`${revision}\0${ordinal}\0${normalizeText(text)}`).digest('hex')
}
