import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const installer = resolve(import.meta.dirname, '../../../scripts/install-dsh.mjs')

describe('one-command DSH installer', () => {
  it('accepts the argument separator preserved by pnpm 11', () => {
    const result = spawnSync(process.execPath, [installer, '--', '--help'], { encoding: 'utf8' })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('pnpm run install:dsh')
  })

  it('rejects a relative DSH home before running installation commands', () => {
    const result = spawnSync(process.execPath, [installer, '--dsh-home', '.dsh'], { encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--dsh-home must be an absolute path')
  })

  it('installs a durable, explicitly named profile package without dependency lifecycle scripts', () => {
    const source = readFileSync(installer, 'utf8')

    expect(source).toContain("join(dshHome, '.plugin-packages', sourceManifest.name)")
    expect(source).toContain('copyFileSync(tarball, cachedTarball)')
    expect(source).toContain('`${sourceManifest.name}@file:${cachedTarball}`')
    expect(source).toContain("'add', '--ignore-scripts', packageSpec")
  })
})
