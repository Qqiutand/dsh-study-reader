import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { STUDY_READER_SKILL_IDS } from '../src/ai/skill-catalog.ts'
import { BUNDLED_READER_SKILL_PROVIDER, bundledReaderSkillProvider } from '../src/study/bundled-reader-skill-provider.ts'

const roots: string[] = []
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('bundled Reader Skill provider', () => {
  it('discovers the exact plugin-owned catalog and progressively loads bodies', async () => {
    const provider = bundledReaderSkillProvider()
    const candidates = await provider.list({})
    expect(candidates.map(candidate => candidate.name)).toEqual([...STUDY_READER_SKILL_IDS])
    expect(candidates.every(candidate => candidate.source === 'bundled' && candidate.provider === BUNDLED_READER_SKILL_PROVIDER)).toBe(true)
    const selected = candidates.find(candidate => candidate.name === 'reconstruct-proof')!
    expect((await provider.get(selected, {}))?.content).toContain('# 重建证明')
  })

  it('loads the active package file rather than a copied preset snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reader-skills-')); roots.push(root)
    for (const id of STUDY_READER_SKILL_IDS) {
      mkdirSync(join(root, id), { recursive: true })
      writeFileSync(join(root, id, 'SKILL.md'), `---\nname: ${id}\ndescription: test\n---\n\n# ${id}\nfirst\n`)
    }
    const provider = bundledReaderSkillProvider(root)
    const selected = (await provider.list({})).find(candidate => candidate.name === 'trace-argument')!
    writeFileSync(join(root, 'trace-argument', 'SKILL.md'), '---\nname: trace-argument\ndescription: test\n---\n\n# trace-argument\nsecond\n')
    expect((await provider.get(selected, {}))?.content).toContain('second')
  })
})
