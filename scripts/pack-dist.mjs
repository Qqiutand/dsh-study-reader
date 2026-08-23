/**
 * Build the self-contained study-reader distribution: ONE tarball in `dist/`
 * that the web profile installs through its own pnpm, with no `workspace:`
 * specs, no `link:` specs, and no `file:` references.
 *
 * The single package exports every Cordis plugin as a subpath
 * (`./extraction`, `./mineru`, `./study`, `./tools`), the client bundle as
 * `./client` (the `dsh.client` row is the bare package name), and the bundle
 * patch as `./cordis.patch.yml` (`dsh.bundle.patch`). Harness platform
 * packages (cordis, schemastery, storage-domain, credentials, tools, the
 * client platform modules, react, the vendored typert protocol) become
 * peerDependencies: with `autoInstallPeers: false` the profile does not
 * fetch them, and at runtime they resolve from the profile's flat module
 * fallback (the dsh app closure). Registry ranges (zod, minisearch, pdf-lib,
 * parse5, yauzl)
 * stay in dependencies. Dev-only tools and the browser-bundled graph
 * libraries (@xyflow/react, @dagrejs/dagre) never enter the dist manifest.
 *
 * Usage: `pnpm run pack:dist` (builds first, then packs and verifies).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const STAGE = join(ROOT, 'dist', '.stage')
const PACKAGE = 'packages/study-reader'

// Sandbox-friendly stores: every npm child uses workspace-local caches.
process.env.npm_config_cache = join(ROOT, '.tools', 'npm-cache')

/** Harness platform packages: peer dependencies resolved from the profile fallback. */
const HARNESS_PEERS = new Map([
  ['@deepseek-ai/cordis', '^4.0.1'],
  ['@deepseek-ai/schemastery', '^2.0.0'],
  ['@deepseek-ai/dsh-brand', '^0.1.0'],
  ['@deepseek-ai/dsh-credentials', '^0.1.0'],
  ['@deepseek-ai/dsh-storage-domain', '^0.1.0'],
  ['@deepseek-ai/dsh-tools', '^0.1.0'],
  ['@deepseek-ai/dsh-typert-protocol', '^0.1.0-rc.5'],
  ['@deepseek-ai/dsh-client-runtime', '^0.1.0'],
  ['@deepseek-ai/dsh-client-locale', '^0.1.0'],
  ['@deepseek-ai/dsh-client-ui-conversation', '^0.1.0'],
  ['@deepseek-ai/dsh-client-ui-tool', '^0.1.0'],
  ['@deepseek-ai/dsh-client-ui-slots', '^0.1.0'],
  ['@deepseek-ai/dsh-client-ui-settings', '^0.1.0'],
  ['@deepseek-ai/dsh-client-ui-primitives', '^0.1.0'],
  ['react', '^18.2.0'],
  ['react-dom', '^18.2.0'],
])

/** Registry (non-harness) dependency ranges preserved from the source manifest. */
const REGISTRY_RANGES = new Map([
  ['zod', '^4.4.3'],
  ['minisearch', '^7.1.2'],
  ['pdf-lib', '^1.17.1'],
  ['pdfjs-dist', '6.2.108'],
  ['epubjs', '0.3.93'],
  ['parse5', '7.3.0'],
  ['yauzl', '^3.2.0'],
  ['yazl', '^3.3.1'],
])

function tarballName(name, version) {
  // npm pack filename convention: scopes become a dash (deepseek-ai-dsh-study-reader-0.1.0.tgz).
  return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`
}

function distManifest(source) {
  const dependencies = {}
  // Source peers (cordis, react, the client platform modules, ...) stay peers.
  const peerDependencies = { ...(source.peerDependencies ?? {}) }
  for (const [dep, spec] of Object.entries(source.dependencies ?? {})) {
    const peerRange = HARNESS_PEERS.get(dep)
    if (peerRange !== undefined) {
      // Harness platform packages (including the dev-time vendored-protocol
      // link target) resolve from the profile fallback; the link: spec never
      // enters the dist manifest.
      peerDependencies[dep] = peerRange
      continue
    }
    if (REGISTRY_RANGES.has(dep)) {
      dependencies[dep] = REGISTRY_RANGES.get(dep)
      continue
    }
    throw new Error(`pack-dist: dependency ${dep} (${spec}) is not registry-pinned or harness-peer`)
  }
  const manifest = {
    name: source.name,
    version: source.version,
    description: source.description ?? '',
    type: 'module',
    main: source.main,
    types: source.types,
    ...source.bin !== undefined ? { bin: source.bin } : {},
    ...source.exports !== undefined ? { exports: source.exports } : {},
    ...source.dsh !== undefined ? { dsh: source.dsh } : {},
    files: source.files,
    license: 'MIT',
  }
  if (Object.keys(dependencies).length > 0) manifest.dependencies = dependencies
  if (Object.keys(peerDependencies).length > 0) manifest.peerDependencies = peerDependencies
  return manifest
}

function stagePackage(manifest) {
  const target = join(STAGE, tarballName(manifest.name, manifest.version).replace(/\.tgz$/, ''))
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  const source = join(ROOT, PACKAGE)
  if (!existsSync(join(source, 'lib'))) {
    throw new Error(`pack-dist: ${PACKAGE} has no lib/ - run the build first`)
  }
  execFileSync('cp', ['-R', join(source, 'lib'), join(target, 'lib')], { stdio: 'inherit' })
  execFileSync('cp', ['-R', join(source, 'pdfjs-wasm'), join(target, 'pdfjs-wasm')], { stdio: 'inherit' })
  mkdirSync(join(target, 'pdfjs-worker'), { recursive: true })
  execFileSync('cp', [join(source, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs'), join(target, 'pdfjs-worker', 'pdf.worker.mjs')], { stdio: 'inherit' })
  execFileSync('cp', [join(source, 'cordis.patch.yml'), join(target, 'cordis.patch.yml')], { stdio: 'inherit' })
  execFileSync('cp', ['-R', join(source, 'skills'), join(target, 'skills')], { stdio: 'inherit' })
  execFileSync('cp', ['-R', join(ROOT, 'presets'), target], { stdio: 'inherit' })
  execFileSync('cp', [join(source, 'install-reading-preset.mjs'), join(target, 'install-reading-preset.mjs')], { stdio: 'inherit' })
  for (const file of ['README.md', 'README.zh-CN.md', 'CHANGELOG.md']) {
    const from = join(source, file)
    if (existsSync(from)) execFileSync('cp', [from, join(target, file)], { stdio: 'inherit' })
  }
  writeFileSync(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  return target
}

function build() {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'clean-build.mjs')], { cwd: ROOT, stdio: 'inherit' })
  execFileSync(join(ROOT, '.tools', 'node_modules', '.bin', 'pnpm'), ['run', 'build:host'], { cwd: ROOT, stdio: 'inherit' })
  execFileSync(join(ROOT, '.tools', 'node_modules', '.bin', 'pnpm'), ['run', 'build:client'], { cwd: ROOT, stdio: 'inherit' })
}

// A caller that has already completed both compilation faces can package those
// exact artifacts without asking pnpm to reconcile its development directory.
// Normal release packaging still builds by default.
if (process.env.DSH_STUDY_READER_SKIP_BUILD !== '1') build()

rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })
mkdirSync(STAGE, { recursive: true })

const source = JSON.parse(readFileSync(join(ROOT, PACKAGE, 'package.json'), 'utf8'))
const manifest = distManifest(source)
const target = stagePackage(manifest)
const tarball = tarballName(manifest.name, manifest.version)
execFileSync('npm', ['pack', '--pack-destination', DIST], { cwd: target, stdio: 'inherit' })
const packed = join(DIST, tarball)
console.log(`pack-dist: ${packed}`)
