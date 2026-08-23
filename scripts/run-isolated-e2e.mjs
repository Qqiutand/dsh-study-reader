/** Run the Study Reader browser suite against a disposable installed profile. */
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const HARNESS = resolve(ROOT, '..')
const PACKAGE_NAME = 'dsh-study-reader'
const PACKAGE_VERSION = JSON.parse(await readFile(join(ROOT, 'packages/study-reader/package.json'), 'utf8')).version
if (typeof PACKAGE_VERSION !== 'string' || PACKAGE_VERSION.trim() === '') throw new Error('Study Reader package version is missing')
const TIMEOUT_MS = 90_000
// The browser acceptance deliberately covers one continuous user journey
// (install, import, reader restoration, skills, session isolation, then an
// uninstall restart).  Individual UI expectations stay short in the spec;
// this is only the finite outer budget for that complete installed-profile
// journey.
const BROWSER_ACCEPTANCE_TIMEOUT_MS = 240_000
// The disposable profile starts with an empty pnpm store. Keep browser phases
// finite, but give the public plugin CLI enough time to materialise the real
// installed profile on a cold package-manager cache.
const PLUGIN_CLI_TIMEOUT_MS = 300_000
const STOP_GRACE_MS = 10_000
const OUTPUT_TAIL_LIMIT = 20_000
const BROWSE_DIRECTORY_PICKER_PATCH = `# Playwright can operate the in-browser picker, not an OS-native chooser.\n# The shipped adaptive row selects native on a loopback server with a display.\n- id: directory-picker\n  disabled: true\n- insert:\n    - id: directory-picker-browse\n      name: '@deepseek-ai/dsh-host-directory-picker-browse'\n    - id: ui-directory-picker-browse\n      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'\n`

const home = await mkdtemp(join(tmpdir(), 'dsh-study-reader-e2e-'))
const profile = join(home, 'profiles', 'web')
const workspace = join(home, 'workspace')
const secondWorkspace = join(home, 'workspace-second')
const epub = join(home, 'minimal.epub')
const pdf = join(home, 'six-pages.pdf')
const sessionCache = join(home, 'storages', 'session_projcache.json')
const evidenceDir = process.env.DSH_STUDY_READER_E2E_ARTIFACT_DIR ?? join(ROOT, 'artifacts', 'e2e-installed')
const tgz = join(ROOT, 'dist', `dsh-study-reader-${PACKAGE_VERSION}.tgz`)
const xdgConfig = join(home, 'xdg-config')
const xdgData = join(home, 'xdg-data')
const xdgCache = join(home, 'xdg-cache')
const env = {
  ...process.env,
  HOME: home,
  DSH_HOME: home,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_DATA_HOME: xdgData,
  XDG_CACHE_HOME: xdgCache,
}
const e2eEnv = {
  ...env,
  DSH_STUDY_READER_E2E_BASE_URL: '',
  DSH_STUDY_READER_E2E_EPUB: epub,
  DSH_STUDY_READER_E2E_PDF: pdf,
  DSH_STUDY_READER_E2E_WORKSPACE: workspace,
  DSH_STUDY_READER_E2E_SECOND_WORKSPACE: secondWorkspace,
  DSH_STUDY_READER_E2E_SESSION_CACHE: sessionCache,
  DSH_STUDY_READER_E2E_POST_UNINSTALL: '0',
}

let web

/** Keep useful diagnostics without holding every browser response in memory. */
function appendTail(current, chunk) {
  const next = current + chunk
  return next.length <= OUTPUT_TAIL_LIMIT ? next : next.slice(-OUTPUT_TAIL_LIMIT)
}

function formatCommand(command, args) {
  return [command, ...args].map(argument => /\s/u.test(argument) ? JSON.stringify(argument) : argument).join(' ')
}

function describeProcess(processRecord, outcome, timedOut = false) {
  const status = outcome.error === undefined
    ? `exitCode=${String(outcome.code)}, signal=${String(outcome.signal)}`
    : `spawnError=${outcome.error.message}`
  return [
    `${processRecord.label}: ${status}, timedOut=${String(timedOut)}`,
    `command: ${formatCommand(processRecord.command, processRecord.args)}`,
    'stdout tail:', processRecord.stdout || '(none)',
    'stderr tail:', processRecord.stderr || '(none)',
  ].join('\n')
}

/** Start a command while mirroring and retaining its output for failure diagnostics. */
function startProcess(label, command, args, { cwd = HARNESS, childEnv = env } = {}) {
  process.stderr.write(`\n> ${label}: ${formatCommand(command, args)}\n`)
  const child = spawn(command, args, {
    cwd,
    env: childEnv,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let settled = false
  let closed = false
  const outputListeners = new Set()
  const notifyOutput = () => {
    for (const listener of outputListeners) listener()
  }
  child.stdout?.on('data', chunk => {
    const text = String(chunk)
    stdout = appendTail(stdout, text)
    process.stdout.write(text)
    notifyOutput()
  })
  child.stderr?.on('data', chunk => {
    const text = String(chunk)
    stderr = appendTail(stderr, text)
    process.stderr.write(text)
    notifyOutput()
  })
  let finish
  const done = new Promise(resolveDone => { finish = resolveDone })
  let finishClosed
  const closedDone = new Promise(resolveClosed => { finishClosed = resolveClosed })
  const settle = outcome => {
    if (settled) return
    settled = true
    finish(outcome)
  }
  child.once('error', error => settle({ code: null, signal: null, error }))
  // `exit` is the command's actual lifecycle boundary. `close` may be held
  // open by a pnpm descendant that inherited stdout/stderr after the CLI has
  // already reconciled the profile, so track it separately for group cleanup.
  child.once('exit', (code, signal) => settle({ code, signal, error: undefined }))
  child.once('close', (code, signal) => {
    closed = true
    finishClosed()
    settle({ code, signal, error: undefined })
  })
  return {
    label,
    command,
    args,
    child,
    done,
    closedDone,
    outputListeners,
    get stdout() { return stdout },
    get stderr() { return stderr },
    get output() { return stdout + stderr },
    get settled() { return settled },
    get closed() { return closed },
  }
}

async function settlesWithin(processRecord, timeoutMs) {
  return new Promise(resolveSettled => {
    const timer = setTimeout(() => resolveSettled(false), timeoutMs)
    void processRecord.done.then(() => {
      clearTimeout(timer)
      resolveSettled(true)
    })
  })
}

async function closesWithin(processRecord, timeoutMs) {
  if (processRecord.closed) return true
  return new Promise(resolveClosed => {
    const timer = setTimeout(() => resolveClosed(false), timeoutMs)
    void processRecord.closedDone.then(() => {
      clearTimeout(timer)
      resolveClosed(true)
    })
  })
}

function signalProcess(processRecord, signal) {
  if (processRecord.closed || processRecord.child.pid === undefined) return
  try {
    if (process.platform === 'win32') processRecord.child.kill(signal)
    else process.kill(-processRecord.child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

/** Stop the whole command group and wait for its terminal outcome. */
async function stopProcess(processRecord, reason) {
  if (!processRecord.closed) {
    const action = processRecord.settled
      ? 'draining inherited child handles'
      : 'stopping'
    process.stderr.write(`${processRecord.label}: ${action} (${reason})\n`)
    signalProcess(processRecord, 'SIGTERM')
    if (!await closesWithin(processRecord, STOP_GRACE_MS)) {
      process.stderr.write(`${processRecord.label}: SIGTERM grace period elapsed; sending SIGKILL\n`)
      signalProcess(processRecord, 'SIGKILL')
      await processRecord.closedDone
    }
  }
  return processRecord.done
}

/** Run a finite command and fail with its exit, signal, timeout, and output facts. */
async function run(label, command, args, { cwd = HARNESS, childEnv = env, timeoutMs = TIMEOUT_MS } = {}) {
  const processRecord = startProcess(label, command, args, { cwd, childEnv })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    process.stderr.write(`${label}: exceeded ${String(timeoutMs)}ms\n`)
    void stopProcess(processRecord, 'command timeout').catch(error => {
      process.stderr.write(`${label}: teardown error: ${String(error)}\n`)
    })
  }, timeoutMs)
  const outcome = await processRecord.done
  clearTimeout(timeout)
  if (timedOut || outcome.error !== undefined || outcome.code !== 0 || outcome.signal !== null) {
    throw new Error(describeProcess(processRecord, outcome, timedOut))
  }
  // A finite command may have exited successfully while a pnpm descendant
  // still owns its pipes. Do not let that descendant leak into the next
  // profile phase; this is distinct from the CLI's exit status above.
  if (!await closesWithin(processRecord, STOP_GRACE_MS)) {
    await stopProcess(processRecord, 'successful command left inherited handles open')
  }
  return processRecord
}

/**
 * Run the public `dsh plugin` CLI through a real PTY.
 *
 * The CLI itself delegates to pnpm with inherited stdio. pnpm 11 can leave
 * that synchronous child live after printing `Done` when all three streams
 * are anonymous pipes; a PTY matches a human CLI invocation without changing
 * the command, package source, or profile state. This runner is Linux-only
 * (it also fixes Chromium to `/usr/bin/chromium`), so util-linux `script` is
 * an available test dependency here.
 */
async function runPluginCli(label, pluginArgs) {
  const dshCommand = formatCommand('pnpm', ['dsh', 'plugin', '--profile', 'web', ...pluginArgs])
  return await run(label, 'script', ['-qefc', dshCommand, '/dev/null'], { timeoutMs: PLUGIN_CLI_TIMEOUT_MS })
}

/** Wait for the web app's documented ready URL, or stop it before reporting diagnostics. */
async function waitForWebReady(processRecord) {
  const readyUrl = () => /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(processRecord.output)?.[1]
  const existing = readyUrl()
  if (existing !== undefined) return existing
  return new Promise((resolveReady, rejectReady) => {
    let finished = false
    const cleanUp = () => {
      clearTimeout(timeout)
      processRecord.outputListeners.delete(onOutput)
    }
    const fail = error => {
      if (finished) return
      finished = true
      cleanUp()
      rejectReady(error)
    }
    const succeed = url => {
      if (finished) return
      finished = true
      cleanUp()
      resolveReady(url)
    }
    const onOutput = () => {
      const url = readyUrl()
      if (url !== undefined) succeed(url)
    }
    const timeout = setTimeout(() => {
      if (finished) return
      finished = true
      cleanUp()
      void stopProcess(processRecord, 'readiness timeout').then(outcome => {
        rejectReady(new Error(`${describeProcess(processRecord, outcome, true)}\nweb did not report a ready URL within ${String(TIMEOUT_MS)}ms`))
      }, rejectReady)
    }, TIMEOUT_MS)
    processRecord.outputListeners.add(onOutput)
    void processRecord.done.then(outcome => {
      fail(new Error(`${describeProcess(processRecord, outcome)}\nweb exited before reporting readiness`))
    })
    onOutput()
  })
}

async function startWeb() {
  if (web !== undefined) throw new Error('web server is already running')
  web = startProcess('start installed web profile', 'pnpm', ['dsh', 'web', '--port', '0', '--no-open'], { childEnv: e2eEnv })
  try {
    return await waitForWebReady(web)
  } catch (error) {
    web = undefined
    throw error
  }
}

async function stopWeb(reason) {
  const runningWeb = web
  web = undefined
  if (runningWeb !== undefined) await stopProcess(runningWeb, reason)
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label}: could not read ${path}: ${String(error)}`)
  }
}

async function configureProfileInstallPolicy() {
  await run('initialize disposable web profile', 'pnpm', ['dsh', '--profile', 'web', '--dump-default-config'])
  const manifest = await readJson(join(profile, 'package.json'), 'profile initialization')
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) {
    throw new Error(`profile initialization did not create a web profile manifest: ${join(profile, 'package.json')}`)
  }
  const policyPath = join(profile, 'pnpm-workspace.yaml')
  // Keep native canvas out of the disposable profile. The lightweight client
  // does not depend on it, and no optional native build is needed for E2E.
  const policy = `packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nignoredOptionalDependencies:\n  - '@napi-rs/canvas'\nallowBuilds:\n  core-js: false\n  es5-ext: false\n`
  await writeFile(policyPath, policy, { mode: 0o600 })
  const written = await readFile(policyPath, 'utf8')
  if (!written.includes("- '@napi-rs/canvas'")
    || !written.includes('core-js: false')
    || !written.includes('es5-ext: false')) {
    throw new Error(`profile install policy is not auditable: ${policyPath}`)
  }
  process.stderr.write(`profile install policy: ${policyPath} denies core-js/es5-ext builds and excludes EPUB-unneeded canvas\n`)
  const patchPath = join(profile, 'cordis.patch.yml')
  await writeFile(patchPath, BROWSE_DIRECTORY_PICKER_PATCH, { mode: 0o600 })
  const patch = await readFile(patchPath, 'utf8')
  if (!patch.includes("name: '@deepseek-ai/dsh-host-directory-picker-browse'")
    || !patch.includes("name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'")) {
    throw new Error(`profile browser-picker composition is not auditable: ${patchPath}`)
  }
  process.stderr.write(`profile browser-picker composition: ${patchPath} pins the in-browser directory picker\n`)
}

async function assertPackedArtifactInstalled() {
  const profileManifest = await readJson(join(profile, 'package.json'), 'packed artifact install')
  const spec = profileManifest.dependencies?.[PACKAGE_NAME]
  if (typeof spec !== 'string' || !spec.includes('.tgz') || spec.startsWith('link:')) {
    throw new Error(`Harness CLI did not record ${PACKAGE_NAME} as a packed tarball dependency: ${String(spec)}`)
  }
  const installed = await readJson(join(profile, 'node_modules', PACKAGE_NAME, 'package.json'), 'packed artifact install')
  if (installed.name !== PACKAGE_NAME || installed.version !== PACKAGE_VERSION) {
    throw new Error(`installed package differs from ${PACKAGE_NAME}@${PACKAGE_VERSION}: ${JSON.stringify({ name: installed.name, version: installed.version })}`)
  }
  process.stderr.write(`installed packed artifact: ${PACKAGE_NAME}@${PACKAGE_VERSION} (${spec})\n`)
}

async function reportSessionCache(phase) {
  let data
  try {
    data = await readFile(sessionCache, 'utf8')
  } catch (error) {
    throw new Error(`${phase}: Study Reader persistence evidence is missing at ${sessionCache}: ${String(error)}`)
  }
  if (data.trim().length === 0) throw new Error(`${phase}: Study Reader persistence evidence is empty at ${sessionCache}`)
  process.stderr.write(`${phase}: retaining ${String(Buffer.byteLength(data))} bytes of session persistence evidence at ${sessionCache}\n`)
}

/** Verify removal through the same supported profile-composition path the runner uses. */
async function assertPostUninstallProfile() {
  const profileManifest = await readJson(join(profile, 'package.json'), 'post-uninstall profile')
  if (profileManifest.dependencies?.[PACKAGE_NAME] !== undefined) {
    throw new Error(`post-uninstall profile still declares ${PACKAGE_NAME} as a dependency`)
  }
  if (profileManifest.dsh?.profile?.bundles?.includes(PACKAGE_NAME)) {
    throw new Error(`post-uninstall profile still composes ${PACKAGE_NAME}`)
  }
  const dump = await run('verify post-uninstall profile composition', 'pnpm', ['dsh', '--profile', 'web', '--dump-default-config'])
  if (dump.output.includes(PACKAGE_NAME)) {
    throw new Error(`post-uninstall profile composition still references ${PACKAGE_NAME}`)
  }
}

let primaryFailure
try {
  // Exercise exactly the artifact produced from this checkout.  A prior
  // developer tarball is not evidence for the current browser acceptance
  // suite, and the temporary profile below still installs it through the
  // public Harness plugin CLI.
  await run('build and pack Study Reader tarball', 'pnpm', ['run', 'pack:dist'], { cwd: ROOT, timeoutMs: PLUGIN_CLI_TIMEOUT_MS })
  const archive = await stat(tgz)
  if (!archive.isFile() || archive.size === 0) throw new Error(`packed Study Reader artifact is missing or empty: ${tgz}`)
  await Promise.all([
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(secondWorkspace, { recursive: true, mode: 0o700 }),
    mkdir(xdgConfig, { recursive: true, mode: 0o700 }),
    mkdir(xdgData, { recursive: true, mode: 0o700 }),
    mkdir(xdgCache, { recursive: true, mode: 0o700 }),
    mkdir(dirname(sessionCache), { recursive: true, mode: 0o700 }),
  ])
  await run('build minimal EPUB fixture', process.execPath, [join(ROOT, 'packages/study-reader/fixtures/build-minimal-epub.mjs'), epub], { cwd: ROOT })
  await run('build six-page PDF fixture', process.execPath, [join(ROOT, 'packages/study-reader/fixtures/build-six-page-pdf.mjs'), pdf], { cwd: ROOT })
  await configureProfileInstallPolicy()
  await runPluginCli('install packed Study Reader through Harness CLI', ['add', tgz])
  await assertPackedArtifactInstalled()
  await run('install packaged reading preset', process.execPath, [join(profile, 'node_modules', PACKAGE_NAME, 'install-reading-preset.mjs'), home, 'reading'], { cwd: profile })
  const baseURL = await startWeb()
  await run('run installed Study Reader browser acceptance', 'pnpm', ['exec', 'playwright', 'test', '--config', join(ROOT, 'playwright.import-ui.config.ts')], {
    cwd: ROOT,
    childEnv: { ...e2eEnv, DSH_STUDY_READER_E2E_BASE_URL: baseURL },
    timeoutMs: BROWSER_ACCEPTANCE_TIMEOUT_MS,
  })
  await rm(evidenceDir, { recursive: true, force: true })
  await cp(join(ROOT, 'test-results'), evidenceDir, { recursive: true })
  process.stdout.write(`retained installed-browser evidence: ${evidenceDir}\n`)
  await reportSessionCache('before plugin removal')
  await stopWeb('browser acceptance completed')
  await runPluginCli('remove Study Reader through Harness CLI', ['remove', PACKAGE_NAME])
  await assertPostUninstallProfile()
  const postUninstallBaseURL = await startWeb()
  await run('verify Study Reader is absent in the restarted browser', 'pnpm', ['exec', 'playwright', 'test', '--config', join(ROOT, 'playwright.import-ui.config.ts')], {
    cwd: ROOT,
    childEnv: {
      ...e2eEnv,
      DSH_STUDY_READER_E2E_BASE_URL: postUninstallBaseURL,
      DSH_STUDY_READER_E2E_POST_UNINSTALL: '1',
    },
    timeoutMs: BROWSER_ACCEPTANCE_TIMEOUT_MS,
  })
  await reportSessionCache('after post-uninstall restart')
  await stopWeb('post-uninstall restart verified')
} catch (error) {
  primaryFailure = error
  throw error
} finally {
  try {
    await stopWeb('runner cleanup')
  } catch (error) {
    if (primaryFailure === undefined) throw error
    process.stderr.write(`runner cleanup could not stop web: ${String(error)}\n`)
  }
  try {
    await rm(home, { recursive: true, force: true })
  } catch (error) {
    if (primaryFailure === undefined) throw error
    process.stderr.write(`runner cleanup could not remove ${home}: ${String(error)}\n`)
  }
}
