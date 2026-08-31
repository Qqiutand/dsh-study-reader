#!/usr/bin/env node
/** Build and install Study Reader plus its reading preset in one explicit command. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const usage = `Usage: pnpm run install:dsh -- [options]

Build the distribution, install it into a DSH profile, and install the bundled
reading preset into the same DSH home.

Options:
  --dsh-home <path>       DSH data directory (default: DSH_HOME or ~/.dsh)
  --harness-root <path>   DeepSeek Harness checkout (default: plugin parent)
  --profile <name>        DSH profile (default: web)
  --migrate-preset        Back up and replace an unmanaged legacy preset
  -h, --help              Show this help
`

function optionValue(args, index, option) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) throw new Error(`${option} needs a path or name`)
  return value
}

let dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
let harnessRoot = resolve(ROOT, '..')
let profile = 'web'
let migratePreset = false
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]
  // pnpm 11 may preserve the conventional `pnpm run <script> -- ...`
  // separator in the child argv; it is not an installer option.
  if (argument === '--') continue
  if (argument === '-h' || argument === '--help') {
    process.stdout.write(usage)
    process.exit(0)
  }
  if (argument === '--dsh-home') {
    dshHome = optionValue(args, index, argument)
    index += 1
    continue
  }
  if (argument === '--harness-root') {
    harnessRoot = optionValue(args, index, argument)
    index += 1
    continue
  }
  if (argument === '--profile') {
    profile = optionValue(args, index, argument)
    index += 1
    continue
  }
  if (argument === '--migrate-preset') {
    migratePreset = true
    continue
  }
  throw new Error(`unknown option: ${argument}\n\n${usage}`)
}

if (!isAbsolute(dshHome)) throw new Error(`--dsh-home must be an absolute path: ${dshHome}`)
if (!isAbsolute(harnessRoot)) throw new Error(`--harness-root must be an absolute path: ${harnessRoot}`)
if (!/^[a-z0-9][a-z0-9._-]*$/i.test(profile)) throw new Error(`invalid profile name: ${profile}`)
dshHome = resolve(dshHome)
harnessRoot = resolve(harnessRoot)

const harnessManifestPath = join(harnessRoot, 'package.json')
if (!existsSync(harnessManifestPath)) {
  throw new Error(`DeepSeek Harness package.json not found: ${harnessManifestPath}`)
}
const harnessManifest = JSON.parse(readFileSync(harnessManifestPath, 'utf8'))
if (harnessManifest.name !== '@deepseek-ai/dsh-root') {
  throw new Error(`--harness-root is not a DeepSeek Harness checkout: ${harnessRoot}`)
}

const sourceManifest = JSON.parse(readFileSync(join(ROOT, 'packages', 'study-reader', 'package.json'), 'utf8'))
if (sourceManifest.name !== 'dsh-study-reader') {
  throw new Error(`unexpected Study Reader package name: ${sourceManifest.name}`)
}
const tarballName = `${sourceManifest.name.replace('@', '').replace('/', '-')}-${sourceManifest.version}.tgz`
const tarball = join(ROOT, 'dist', tarballName)

const npmExecPath = process.env.npm_execpath
function runPnpm(commandArgs, cwd, env = process.env) {
  process.stdout.write(`\n> pnpm ${commandArgs.join(' ')}\n`)
  if (npmExecPath !== undefined && existsSync(npmExecPath)) {
    execFileSync(process.execPath, [npmExecPath, ...commandArgs], { cwd, env, stdio: 'inherit' })
    return
  }
  execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', commandArgs, { cwd, env, stdio: 'inherit' })
}

runPnpm(['install'], ROOT)
runPnpm(['run', 'pack:dist'], ROOT)
if (!existsSync(tarball)) throw new Error(`distribution tarball was not created: ${tarball}`)

// Keep the installed file dependency inside DSH_HOME. A source checkout may
// later rebuild or remove dist/, but unrelated profile operations must still
// be able to resolve every dependency already recorded by pnpm. The content
// digest also changes the file: spec when a development build is rebuilt at
// the same package version, so pnpm cannot silently reuse an older tarball.
const packageCache = join(dshHome, '.plugin-packages', sourceManifest.name)
const tarballDigest = createHash('sha256').update(readFileSync(tarball)).digest('hex').slice(0, 12)
const cachedTarball = join(packageCache, tarballName.replace(/\.tgz$/, `-${tarballDigest}.tgz`))
mkdirSync(packageCache, { recursive: true, mode: 0o700 })
copyFileSync(tarball, cachedTarball)

const dshEnv = { ...process.env, DSH_HOME: dshHome }
// The tarball is already built and verified. Disabling dependency lifecycle
// scripts avoids pnpm's approval prompt and gives the installer no implicit
// code-execution path inside the user's profile.
// Naming the package explicitly also lets pnpm replace a prior file: spec even
// if that prior tarball has already disappeared.
const packageSpec = `${sourceManifest.name}@file:${cachedTarball}`
runPnpm(['dsh', 'plugin', '--profile', profile, 'add', '--ignore-scripts', packageSpec], harnessRoot, dshEnv)
const presetArgs = [
  'dsh', 'plugin', '--profile', profile, 'exec',
  'dsh-study-reader-preset', dshHome, 'reading',
]
if (migratePreset) presetArgs.push('--migrate')
runPnpm(presetArgs, harnessRoot, dshEnv)

process.stdout.write(`\nStudy Reader ${sourceManifest.version} installed in ${dshHome} (profile: ${profile}).\n`)
process.stdout.write('Restart `pnpm dsh web` to load the update.\n')
