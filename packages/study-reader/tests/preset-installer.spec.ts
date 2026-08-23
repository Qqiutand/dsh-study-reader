import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const homes: string[] = []
const installer = resolve(import.meta.dirname, '../install-reading-preset.mjs')
afterEach(() => { while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true }) })

describe('reading preset installer', () => {
  it('updates an owned preset atomically without copying bundled Skills', () => {
    const home = mkdtempSync(join(tmpdir(), 'reading-preset-')); homes.push(home)
    execFileSync(process.execPath, [installer, home, 'reading'])
    const destination = join(home, '.agent-presets', 'reading')
    expect(existsSync(join(destination, 'skills'))).toBe(false)
    writeFileSync(join(destination, 'stale.txt'), 'stale')
    execFileSync(process.execPath, [installer, home, 'reading'])
    expect(existsSync(join(destination, 'stale.txt'))).toBe(false)
    expect(existsSync(join(destination, '.dsh-study-reader-preset.json'))).toBe(true)
  })

  it('requires an explicit one-time migration for legacy copies and retains a backup', () => {
    const home = mkdtempSync(join(tmpdir(), 'reading-preset-')); homes.push(home)
    const destination = join(home, '.agent-presets', 'reading')
    mkdirSync(join(destination, 'skills', 'study-old'), { recursive: true })
    writeFileSync(join(destination, 'skills', 'study-old', 'SKILL.md'), 'old')
    expect(spawnSync(process.execPath, [installer, home, 'reading'], { encoding: 'utf8' })).toMatchObject({ status: 1 })
    execFileSync(process.execPath, [installer, home, 'reading', '--migrate'])
    expect(existsSync(join(destination, 'skills'))).toBe(false)
    expect(readdirSync(join(home, '.agent-presets')).some(name => name.startsWith('reading.before-native-skills-'))).toBe(true)
  })

  it('adopts a preset owned by the pre-rename package without requiring migration', () => {
    const home = mkdtempSync(join(tmpdir(), 'reading-preset-')); homes.push(home)
    const destination = join(home, '.agent-presets', 'reading')
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, '.dsh-study-reader-preset.json'), JSON.stringify({
      owner: '@deepseek-ai/dsh-study-reader',
      preset: 'reading',
      version: '0.5.0',
    }))
    writeFileSync(join(destination, 'stale.txt'), 'stale')

    execFileSync(process.execPath, [installer, home, 'reading'])

    expect(existsSync(join(destination, 'stale.txt'))).toBe(false)
    expect(JSON.parse(readFileSync(join(destination, '.dsh-study-reader-preset.json'), 'utf8'))).toMatchObject({
      owner: 'dsh-study-reader',
      preset: 'reading',
    })
    expect(readdirSync(join(home, '.agent-presets')).some(name => name.startsWith('reading.before-'))).toBe(false)
  })
})
