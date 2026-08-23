/**
 * Run the Typert generator over the single study-reader package's host face
 * and WRITE the generated artifacts: `packages/study-reader/lib/typert.host.{js,d.ts}`
 * plus, for Remote contributors, `lib/typert.remote-client.{js,d.ts,d.ts.map}`.
 *
 * Must run after `tsc -b tsconfig.host.json` (the generator analyzes the
 * host program) and before the client bundle pass (the generated `./remote`
 * artifacts feed client compilation).
 *
 * The generator's `isTypeMetaSymbol` requires TypeMeta declarations
 * (`Remote`, `TypertRemoteService`, ...) to belong to a workspace
 * registration named `@deepseek-ai/dsh-typert-protocol`. The official
 * protocol package lives in the harness checkout, not in this workspace's
 * `packages/`, so this script registers it explicitly through the
 * generator's own `WorkspaceCaches.registrations` inventory: discovery
 * fills the cache under the inventory key, the protocol registration is
 * appended (host face, root = the official package directory), and the
 * analysis then runs against the same cache. No protocol source is copied.
 */

import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FaceModelEmitter, WorkspaceAnalyzer, WorkspaceCaches } from '@deepseek-ai/dsh-typert-generator'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The official protocol package the workspace links against (harness checkout).
const protocolRoot = realpathSync(join(root, '..', 'packages', 'typert', 'protocol'))
const PROTOCOL_NAME = '@deepseek-ai/dsh-typert-protocol'

const caches = new WorkspaceCaches()
// 1) Discovery fills the registration inventory under the generator's key.
new WorkspaceAnalyzer({ root, faces: ['host'], caches }).discoverPackages()
// 2) Append the official protocol registration so TypeMeta declarations in
//    its built d.ts are attributed to the protocol package.
const inventoryKey = `${root}\0tsconfig.host.json\0tsconfig.client.json`
const inventory = caches.registrations.get(inventoryKey)
if (inventory === undefined) {
  throw new Error('gen-typert: registration inventory not populated by discovery')
}
// The registration is an attribute-only entry (isTypeMetaSymbol and
// packageExportName resolve it through allRegistrations); its project never
// runs a diagnostics program because it is not part of the selected
// packages.
inventory.push({
  face: 'host',
  name: PROTOCOL_NAME,
  root: protocolRoot,
  config: {
    path: join(protocolRoot, 'tsconfig.json'),
    parsed: {
      options: {
        target: 99, // ts.ScriptTarget.ES2024
        module: 99, // ts.ModuleKind.ESNext
        moduleResolution: 100, // ts.ModuleResolutionKind.Bundler
        strict: true,
        skipLibCheck: true,
        esModuleInterop: true,
        allowImportingTsExtensions: true,
        rewriteRelativeImportExtensions: true,
      },
      fileNames: [],
      errors: [],
      projectReferences: [],
    },
  },
  manifest: JSON.parse(readFileSync(join(protocolRoot, 'package.json'), 'utf8')),
})

// 3) Analyze the host face against the same cache. The protocol sources
//    enter the program through the aggregate tsconfig's paths (import chain),
//    while the protocol registration stays in allRegistrations only, so its
//    own package model is never analyzed (its merged types span harness
//    declaration files outside this workspace's registrations).
const workspace = new WorkspaceAnalyzer({
  root,
  faces: ['host'],
  packages: ['dsh-study-reader'],
  caches,
}).analyze()

/** Mirror of WorkspaceTypertGenerator.validateExport (the generator class does not accept caches). */
function validateExport(artifact) {
  const manifest = JSON.parse(readFileSync(join(root, artifact.packageRoot, 'package.json'), 'utf8'))
  const expected = { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' }
  const actual = manifest.exports?.['./typert']
  if (actual?.types !== expected.types || actual?.default !== expected.default) {
    throw new Error(`gen-typert: ${artifact.package} must export ./typert as ${JSON.stringify(expected)}`)
  }
  for (const file of ['lib/typert.host.js', 'lib/typert.host.d.ts']) {
    if (!manifest.files?.includes(file)) {
      throw new Error(`gen-typert: ${artifact.package} files must include ${file}`)
    }
  }
  const remoteExpected = { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' }
  const remoteFiles = ['lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts']
  if (artifact.remote === undefined) {
    if (manifest.exports?.['./remote'] !== undefined || remoteFiles.some(file => manifest.files?.includes(file))) {
      throw new Error(`gen-typert: ${artifact.package} publishes Remote artifacts but has no Remote methods`)
    }
    return
  }
  const remoteActual = manifest.exports?.['./remote']
  if (remoteActual?.types !== remoteExpected.types || remoteActual?.default !== remoteExpected.default) {
    throw new Error(`gen-typert: ${artifact.package} must export ./remote as ${JSON.stringify(remoteExpected)}`)
  }
  for (const file of remoteFiles) {
    if (!manifest.files?.includes(file)) {
      throw new Error(`gen-typert: ${artifact.package} files must include ${file}`)
    }
  }
}

let emittedRemote = false
for (const face of workspace.faces) {
  const emitter = new FaceModelEmitter(face)
  for (const packageModel of face.packages) {
    if (packageModel.name !== 'dsh-study-reader') continue
    const artifact = {
      ...emitter.emit(packageModel.name),
      packageRoot: packageModel.root,
    }
    validateExport(artifact)
    const output = join(root, artifact.packageRoot, 'lib')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, `typert.${artifact.face}.js`), artifact.js)
    writeFileSync(join(output, `typert.${artifact.face}.d.ts`), artifact.dts)
    if (artifact.remote !== undefined) {
      emittedRemote = true
      writeFileSync(join(output, 'typert.remote-client.js'), artifact.remote.js)
      writeFileSync(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
      writeFileSync(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
    }
    console.log(`typert: emitted ${artifact.face} artifacts for ${artifact.package} (${artifact.packageRoot})`)
  }
}
if (!emittedRemote && workspace.faces.some(face => face.face === 'host' && face.packages.length > 0)) {
  const output = join(root, workspace.faces[0].packages[0].root, 'lib')
  for (const file of ['typert.remote-client.js', 'typert.remote-client.d.ts', 'typert.remote-client.d.ts.map']) {
    rmSync(join(output, file), { force: true })
  }
}
