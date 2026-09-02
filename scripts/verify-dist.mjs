/**
 * Distribution validation: the single tarball in `dist/` must be installable
 * by the profile's pnpm without the source workspace:
 *
 * - no `workspace:` spec in the dist manifest;
 * - no `link:` or `file:` spec (nothing outside the tarball);
 * - no absolute-path spec;
 * - every runtime artifact the loader/browser needs is inside the tarball;
 * - every bare package name in the bundle patch resolves in the manifest
 *   (host rows are package subpaths, so only the client row is bare).
 *
 * Usage: `pnpm run verify:dist`.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

const errors = []

function tarRead(tarball, member) {
  return execFileSync('tar', ['-xOzf', tarball, member], {
    encoding: 'utf8',
    // The self-contained browser bundle intentionally includes PDF.js and
    // epub.js, exceeding Node's 1 MiB child-process default.
    maxBuffer: 16 * 1024 * 1024,
  })
}

function tarList(tarball) {
  return execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean)
}

function manifestOf(tarball) {
  const prefix = tarList(tarball).find(name => name.endsWith('/package.json'))
  if (prefix === undefined) throw new Error(`verify-dist: ${tarball} has no package.json`)
  return JSON.parse(tarRead(tarball, prefix))
}

/** Every exports target (types/default/string forms) that must exist inside the tarball. */
function exportTargets(manifest) {
  const targets = []
  for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
    if (typeof value === 'string') {
      targets.push([subpath, value])
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    for (const v of Object.values(value)) {
      if (typeof v === 'string') targets.push([subpath, v])
    }
  }
  return targets
}

const tarballs = readdirSync(DIST).filter(name => name.endsWith('.tgz'))
if (tarballs.length === 0) {
  console.error('verify-dist: no tarballs in dist/ - run `pnpm run pack:dist` first')
  process.exit(1)
}
if (tarballs.length !== 1) {
  console.error(`verify-dist: expected exactly one tarball, found ${tarballs.length}`)
  process.exit(1)
}

const path = join(DIST, tarballs[0])
execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-text-encoding.mjs'), path], { stdio: 'inherit' })
const manifest = manifestOf(path)
if (manifest.name !== 'dsh-study-reader') {
  errors.push(`verify-dist: unexpected package name ${manifest.name}`)
}
const files = new Set(tarList(path))

// Dependency hygiene: no workspace:, no link:, no file:, no absolute paths.
const allSpecs = {
  ...(manifest.dependencies ?? {}),
  ...(manifest.peerDependencies ?? {}),
}
for (const [name, spec] of Object.entries(allSpecs)) {
  if (spec.includes('workspace:')) {
    errors.push(`dependency ${name} uses workspace: (${spec})`)
    continue
  }
  if (/^link:/.test(spec)) {
    errors.push(`dependency ${name} uses link: (${spec})`)
    continue
  }
  if (spec.startsWith('file:')) {
    errors.push(`dependency ${name} uses file: (${spec})`)
    continue
  }
  if (spec.startsWith('/') || /^[a-zA-Z]:\//.test(spec)) {
    errors.push(`dependency ${name} is an absolute path spec (${spec})`)
  }
}
// Dev tools and bundled graph libs never enter the dist manifest.
for (const stray of ['@xyflow/react', '@dagrejs/dagre', 'typescript', 'vitest', 'tsdown', 'react-dom']) {
  if (stray in (manifest.dependencies ?? {})) errors.push(`dev-only dependency ${stray} leaked into dist dependencies`)
}
if (manifest.peerDependencies?.['react-dom'] !== '^18.2.0') {
  errors.push('react-dom must remain a Harness peer dependency')
}
if (manifest.dependencies?.['@modelcontextprotocol/server'] !== '^2.0.0') {
  errors.push('@modelcontextprotocol/server must remain a pinned registry runtime dependency')
}

// Runtime files: every exports target and the bundle patch.
for (const [subpath, target] of exportTargets(manifest)) {
  if (subpath === './src/*' || subpath === './package.json') continue
  const member = target.replace(/^\.\//, 'package/')
  if (!files.has(member)) errors.push(`exports ${subpath} target ${target} missing from tarball`)
}
if (!files.has('package/cordis.patch.yml')) errors.push('cordis.patch.yml missing from tarball')
for (const presetFile of ['agent.cordis.yml', 'preset.yml']) {
  if (!files.has(`package/presets/reading/${presetFile}`)) {
    errors.push(`reading preset file missing from tarball: ${presetFile}`)
  }
}
if (!files.has('package/install-reading-preset.mjs')) errors.push('reading preset installer missing from tarball')
for (const wasm of ['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm']) {
  if (!files.has(`package/pdfjs-wasm/${wasm}`)) errors.push(`PDF decoder asset missing from tarball: ${wasm}`)
}
if (!files.has('package/pdfjs-worker/pdf.worker.mjs')) errors.push('PDF worker missing from tarball')

const readingSkills = [
  'assess-understanding',
  'generate-practice',
  'organize-study',
  'reconstruct-proof',
  'save-study-note',
  'synthesize-sources',
  'trace-argument',
]
for (const skill of readingSkills) {
  if (!files.has(`package/skills/${skill}/SKILL.md`)) {
    errors.push(`reading skill missing from tarball: ${skill}`)
  }
}
if (files.has('package/presets/reading/skills/')) {
  errors.push('reading preset must not carry copied Skill files')
}

// The Harness client loader fetches exactly `client.js` and supplies its
// platform imports through a module table. A relative CJS chunk cannot be
// resolved there, so dynamic EPUB/PDF dependencies must be inlined.
const clientBundle = tarRead(path, 'package/lib/client.js')
if (/require\(["']\.\/(?:[^"']*\.cjs)["']\)/.test(clientBundle)) {
  errors.push('client.js contains a relative CJS require; set client codeSplitting to false')
}

// Patch hygiene: host rows must be subpath exports of this package; the only
// bare name allowed is the package itself (the dsh.client row).
const patch = tarRead(path, 'package/cordis.patch.yml')
const rows = [...patch.matchAll(/name:\s*['"]?(dsh-study-reader(?:\/[a-z0-9-]+)?)['"]?/g)].map(match => match[1])
const exportsSet = new Set(Object.keys(manifest.exports ?? {}))
for (const row of rows) {
  if (row === manifest.name) continue
  const subpath = `.${row.slice(manifest.name.length)}`
  if (!exportsSet.has(subpath)) {
    errors.push(`patch row ${row} is not a subpath export of ${manifest.name}`)
  }
}

if (errors.length > 0) {
  console.error('verify-dist: FAILED')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
console.log(`verify-dist: ${tarballs[0]} passed (self-contained single package, runtime files present)`)
