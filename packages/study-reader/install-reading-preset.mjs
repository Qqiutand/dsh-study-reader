#!/usr/bin/env node
/** Install one bundled agent preset into an explicitly named DSH home. */

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dshHome = process.argv[2]
const presetName = process.argv[3] ?? 'reading'
const allowLegacyMigration = process.argv.includes('--migrate')
if (dshHome === undefined || dshHome === '') {
  throw new Error('usage: dsh-study-reader-preset <DSH_HOME> [preset]')
}

const here = dirname(fileURLToPath(import.meta.url))
// The packaged tarball carries the presets beside this script. The source-tree
// fallback keeps the same explicit installer usable before packaging.
const packagedSource = resolve(here, 'presets', presetName)
const source = existsSync(packagedSource) ? packagedSource : resolve(here, '..', '..', 'presets', presetName)
const destination = resolve(dshHome, '.agent-presets', presetName)
if (!existsSync(source)) throw new Error(`bundled ${presetName} preset is missing: ${source}`)
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
const packageRoot = existsSync(resolve(here, 'package.json')) ? here : resolve(here, '..', '..')
const version = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')).version
const ownerFile = '.dsh-study-reader-preset.json'
const owner = { owner: 'dsh-study-reader', preset: presetName, version }
const legacyOwners = new Set(['@deepseek-ai/dsh-study-reader'])
const temporary = `${destination}.install-${String(process.pid)}`
rmSync(temporary, { recursive: true, force: true })
cpSync(source, temporary, { recursive: true, force: false, errorOnExist: true })
writeFileSync(resolve(temporary, ownerFile), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 })

if (!existsSync(destination)) {
  renameSync(temporary, destination)
  console.log(`installed ${presetName} preset ${version}: ${destination}`)
} else {
  let owned = false
  try {
    const previous = JSON.parse(readFileSync(resolve(destination, ownerFile), 'utf8'))
    owned = (previous.owner === owner.owner || legacyOwners.has(previous.owner)) && previous.preset === presetName
  } catch {}
  if (!owned && !allowLegacyMigration) {
    rmSync(temporary, { recursive: true, force: true })
    throw new Error(`${presetName} preset predates managed updates; rerun with --migrate to back it up and replace it`)
  }
  const backup = `${destination}.before-${owned ? 'update' : 'native-skills'}-${String(Date.now())}`
  renameSync(destination, backup)
  try {
    renameSync(temporary, destination)
    if (owned) rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (!existsSync(destination)) renameSync(backup, destination)
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
  console.log(`updated ${presetName} preset to ${version}: ${destination}`)
  if (!owned) console.log(`legacy preset backup: ${backup}`)
}
