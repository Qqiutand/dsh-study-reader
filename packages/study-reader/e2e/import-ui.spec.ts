import { readFile, writeFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'

const BLANK_HOST_PROJECTION = {
  turns: 0,
  messageTokens: 0,
  blank: true,
  lastPromptAt: null,
} as const

const READING_PRESET_NAME = /^(?:深度研读|Deep Study Reader)/
const STANDARD_PRESET_NAME = /^(?:标准模式|Standard mode)/
const NATIVE_COMPOSER_PLACEHOLDER = /^(?:Describe what you want to build|描述你想要构建的内容|Message the agent|给智能体发消息)$/
const EPUB_FIXTURE_TITLE = '本地 EPUB 导入小册 / Local EPUB Import Primer'
const PDF_FIXTURE_TITLE = 'six-pages'
const PDF_SOURCE_TITLE = 'six pages'
const LIBRARY_ROOT_FOLDER = 'E2E Library Root'
const LIBRARY_CHILD_FOLDER = 'E2E Library Child'
const SKILL_ROOT_FOLDER = 'E2E Skill Root'
const SKILL_CHILD_FOLDER = 'E2E Skill Child'
const E2E_SKILL_NAME = 'E2E inert skill'
const E2E_SKILL_TEXT = '```ts\nthrow new Error("must remain inert")\n```\nhttps://example.invalid/e2e-inert-skill'
const E2E_SKILL_TEXT_V2 = `${E2E_SKILL_TEXT}\nversion two remains inert`

interface IsolatedE2eEnvironment {
  readonly cachePath: string
  readonly epubPath: string
  readonly pdfPath: string
  readonly workspacePath: string
  readonly secondWorkspacePath: string
}

interface HostProjectionSummary {
  readonly turns: number
  readonly messageTokens: number
  readonly blank: boolean
  readonly lastPromptAt: number | null
}

type HostProjectionObservation = HostProjectionSummary | { readonly diagnostic: string }

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new Error(`isolated runner did not provide ${name}`)
  }
  return value
}

function isolatedEnvironment(): IsolatedE2eEnvironment {
  return {
    cachePath: requiredEnvironment('DSH_STUDY_READER_E2E_SESSION_CACHE'),
    epubPath: requiredEnvironment('DSH_STUDY_READER_E2E_EPUB'),
    pdfPath: requiredEnvironment('DSH_STUDY_READER_E2E_PDF'),
    workspacePath: requiredEnvironment('DSH_STUDY_READER_E2E_WORKSPACE'),
    secondWorkspacePath: requiredEnvironment('DSH_STUDY_READER_E2E_SECOND_WORKSPACE'),
  }
}

function postUninstallRun(): boolean {
  return process.env.DSH_STUDY_READER_E2E_POST_UNINSTALL === '1'
}

function rpcCount(methods: readonly string[], method: string): number {
  return methods.filter(candidate => candidate === `study/${method}`).length
}

function rpcSnapshot(methods: readonly string[]): Readonly<Record<string, number>> {
  return Object.fromEntries([...new Set(methods)].sort().map(method => [method, rpcCount(methods, method.slice('study/'.length))]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} is not an object`)
  return value
}

function numberAt(value: Record<string, unknown>, key: string, path: string): number {
  const candidate = value[key]
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new Error(`${path}.${key} is not a finite number`)
  }
  return candidate
}

function booleanAt(value: Record<string, unknown>, key: string, path: string): boolean {
  const candidate = value[key]
  if (typeof candidate !== 'boolean') throw new Error(`${path}.${key} is not a boolean`)
  return candidate
}

function nullableNumberAt(value: Record<string, unknown>, key: string, path: string): number | null {
  const candidate = value[key]
  if (candidate === null) return null
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new Error(`${path}.${key} is neither null nor a finite number`)
  }
  return candidate
}

/**
 * Reads the runner-provided Host projection cache without invoking any Host
 * service. This keeps the blank-session proof independent from browser-side
 * projections while using the session id published by the real UI root.
 */
async function readHostProjection(cachePath: string, sessionId: string): Promise<HostProjectionSummary> {
  const payload: unknown = JSON.parse(await readFile(cachePath, 'utf8'))
  const tables = recordAt(recordAt(payload, 'session projection cache').tables, 'session projection cache.tables')
  const sessions = recordAt(tables.sessions, 'session projection cache.tables.sessions')
  const session = recordAt(sessions[sessionId], `session projection cache session ${JSON.stringify(sessionId)}`)
  const rows = recordAt(session.rows, `session projection cache session ${JSON.stringify(sessionId)}.rows`)
  const sessionStats = recordAt(recordAt(rows.sessionStats, 'sessionStats row').val, 'sessionStats value')
  const contextBreakdown = recordAt(recordAt(rows.contextBreakdown, 'contextBreakdown row').val, 'contextBreakdown value')
  const metadata = recordAt(recordAt(rows.sessionListMetadata, 'sessionListMetadata row').val, 'sessionListMetadata value')
  return {
    turns: numberAt(sessionStats, 'turns', 'sessionStats value'),
    messageTokens: numberAt(contextBreakdown, 'messageTokens', 'contextBreakdown value'),
    blank: booleanAt(metadata, 'blank', 'sessionListMetadata value'),
    lastPromptAt: nullableNumberAt(metadata, 'lastPromptAt', 'sessionListMetadata value'),
  }
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function expectBlankHostProjection(
  cachePath: string,
  sessionId: string,
  phase: string,
): Promise<void> {
  await expect.poll(async (): Promise<HostProjectionObservation> => {
    try {
      return await readHostProjection(cachePath, sessionId)
    } catch (error) {
      return { diagnostic: diagnostic(error) }
    }
  }, {
    message: `${phase}: expected the Host cache at ${cachePath} to retain a blank session ${sessionId}`,
    timeout: 15_000,
    intervals: [100, 250, 500, 1_000],
  }).toEqual(BLANK_HOST_PROJECTION)
}

async function rootSessionId(studyRoot: Locator): Promise<string> {
  await expect(studyRoot).toHaveAttribute('data-session-id', /.+/)
  const sessionId = await studyRoot.getAttribute('data-session-id')
  if (sessionId === null || sessionId.length === 0) throw new Error('Study root did not publish data-session-id')
  return sessionId
}

function recordReaderCheckpoint(testInfo: TestInfo, sourceId: string, position: string): void {
  testInfo.annotations.push({
    type: 'reader checkpoint',
    description: `sourceId=${sourceId}; position=${position}`,
  })
}

async function selectBookroomTab(studyRoot: Locator, name: '书库' | 'Skills' | '权限'): Promise<void> {
  const tabs = studyRoot.getByRole('navigation', { name: 'Bookroom 管理' })
  const tab = tabs.getByRole('button', { name, exact: true })
  await tab.click({ timeout: 15_000 })
  await expect(tab).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
}

async function createFolder(scope: Locator, inputName: string, name: string): Promise<void> {
  const input = scope.getByLabel(inputName)
  await input.fill(name)
  await scope.getByRole('button', { name: '新建', exact: true }).click()
  await expect(scope.getByRole('button', { name: new RegExp(`^(?:↳ )?${name}$`) })).toBeEnabled()
}

/** Select a persisted folder through the public Bookroom control with a bounded diagnostic wait. */
async function selectFolder(scope: Locator, name: string): Promise<Locator> {
  const folder = scope.getByRole('button', { name: `↳ ${name}`, exact: true })
  await expect(folder).toBeVisible({ timeout: 15_000 })
  await folder.click()
  await expect(folder).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
  return folder
}

/** The outer Bookroom tab preserves its inner reader/library mode. */
async function openLibraryMode(studyRoot: Locator): Promise<void> {
  const libraryMode = studyRoot.getByRole('button', { name: '📚 书库', exact: true })
  await expect(libraryMode).toBeVisible({ timeout: 15_000 })
  await libraryMode.click()
}

/** Open a runner-created workspace through the Host's visible directory picker. */
async function openWorkspace(page: Page, path: string): Promise<void> {
  await page.getByRole('button', { name: 'Add workspace' }).click({ timeout: 15_000 })
  const workspaceDialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await expect(workspaceDialog).toBeVisible({ timeout: 15_000 })
  await workspaceDialog.getByRole('button', { name: 'Edit path' }).click()
  const workspacePath = workspaceDialog.getByLabel('Edit path')
  await workspacePath.fill(path)
  await workspacePath.press('Enter')
  await workspaceDialog.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(workspaceDialog).toBeHidden({ timeout: 15_000 })
}

/** A newly opened workspace settles to Standard; switch that visible Host control to Reading. */
async function ensureReadingPreset(page: Page): Promise<void> {
  const standardPreset = page.getByRole('button', { name: STANDARD_PRESET_NAME })
  await expect(standardPreset).toBeVisible({ timeout: 15_000 })
  await standardPreset.click({ timeout: 15_000 })
  const readingItem = page.getByRole('menuitem', { name: READING_PRESET_NAME })
  await expect(readingItem).toBeVisible({ timeout: 15_000 })
  await readingItem.click({ timeout: 15_000 })
  await expect(standardPreset).not.toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: READING_PRESET_NAME })).toBeVisible({ timeout: 15_000 })
}

function pdfMineruLanguage(studyRoot: Locator): Locator {
  return studyRoot.getByRole('combobox', { name: 'PDF / MinerU 识别语言', exact: true })
}

/** Decode the ordinary 8-bit RGB/RGBA screenshot output Playwright emits. */
function pngPdfPaintRatios(png: Buffer): { readonly white: number; readonly red: number } {
  const signature = '89504e470d0a1a0a'
  if (png.subarray(0, 8).toString('hex') !== signature) throw new Error('canvas screenshot was not PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  const idat: Buffer[] = []
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset)
    const kind = png.subarray(offset + 4, offset + 8).toString('ascii')
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8) throw new Error(`unsupported PNG bit depth ${String(body[8])}`)
      colorType = body[9] ?? -1
    } else if (kind === 'IDAT') idat.push(body)
    offset += length + 12
  }
  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (width === 0 || height === 0 || bytesPerPixel === 0) throw new Error(`unsupported canvas PNG dimensions/color type ${width}/${height}/${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bytesPerPixel
  let cursor = 0
  let prior = Buffer.alloc(stride)
  let inspected = 0
  let white = 0
  let red = 0
  for (let row = 0; row < height; row += 1) {
    const filter = raw[cursor++]
    const current = Buffer.from(raw.subarray(cursor, cursor + stride))
    cursor += stride
    for (let index = 0; index < stride; index += 1) {
      const left = index >= bytesPerPixel ? current[index - bytesPerPixel] ?? 0 : 0
      const above = prior[index] ?? 0
      const upperLeft = index >= bytesPerPixel ? prior[index - bytesPerPixel] ?? 0 : 0
      if (filter === 1) current[index] = ((current[index] ?? 0) + left) & 0xff
      else if (filter === 2) current[index] = ((current[index] ?? 0) + above) & 0xff
      else if (filter === 3) current[index] = ((current[index] ?? 0) + Math.floor((left + above) / 2)) & 0xff
      else if (filter === 4) {
        const p = left + above - upperLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - above)
        const pc = Math.abs(p - upperLeft)
        current[index] = ((current[index] ?? 0) + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft)) & 0xff
      } else if (filter !== 0) throw new Error(`unsupported PNG filter ${String(filter)}`)
    }
    for (let index = 0; index < current.length; index += bytesPerPixel) {
      const alpha = bytesPerPixel === 4 ? current[index + 3] ?? 0 : 255
      if (row < Math.floor(height * .15) || alpha === 0) continue
      inspected += 1
      const r = current[index] ?? 0
      const g = current[index + 1] ?? 0
      const b = current[index + 2] ?? 0
      if (r > 245 && g > 245 && b > 245) white += 1
      if (r > 180 && g < 90 && b < 90) red += 1
    }
    prior = current
  }
  return inspected === 0 ? { white: 0, red: 0 } : { white: white / inspected, red: red / inspected }
}

/** Persist passing-run evidence in Playwright's output tree before attaching it. */
async function attachEvidence(testInfo: TestInfo, name: string, body: Buffer, contentType: string): Promise<void> {
  const extension = contentType === 'image/png' ? 'png' : 'json'
  const path = testInfo.outputPath(`${name}.${extension}`)
  await writeFile(path, body)
  await testInfo.attach(name, { path, contentType })
}

test('Reading preset provides a bounded document library without reader state', async ({ page }, testInfo) => {
  test.skip(postUninstallRun(), 'the post-uninstall runner only exercises absent-plugin assertions')
  const environment = isolatedEnvironment()
  const studyRoot = page.locator('[data-dsh-study-root]')
  const rpcMethods: string[] = []
  page.on('request', request => {
    const body = request.postData()
    if (body === null || !body.includes('study/')) return
    for (const match of body.matchAll(/study\/[A-Za-z0-9_-]+/g)) rpcMethods.push(match[0])
  })

  await page.goto('/')
  const notice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
  await expect(notice).toBeVisible()
  await notice.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: STANDARD_PRESET_NAME }).click()
  await page.getByRole('menuitem', { name: READING_PRESET_NAME }).click()
  await openWorkspace(page, environment.workspacePath)
  await expect(studyRoot).toHaveCount(1)
  const sessionId = await rootSessionId(studyRoot)
  await expectBlankHostProjection(environment.cachePath, sessionId, 'after the lightweight Reading workspace opens')

  await expect(studyRoot.getByRole('heading', { name: '文献库', level: 1 })).toBeVisible()
  expect(rpcCount(rpcMethods, 'getLibrarySnapshot'), 'opening Bookroom should load one consistent library snapshot').toBe(1)
  expect(rpcCount(rpcMethods, 'bootstrap'), 'the snapshot replaces a separate bootstrap request').toBe(0)
  expect(rpcCount(rpcMethods, 'getSessionSourceSelection'), 'the snapshot replaces a separate selection request').toBe(0)
  expect(rpcCount(rpcMethods, 'setSessionSourceSelection'), 'hydration must not persist selection').toBe(0)
  expect(rpcCount(rpcMethods, 'getSourcePreview'), 'an empty selection must not load a preview').toBe(0)
  expect(rpcCount(rpcMethods, 'listImportStatuses'), 'an empty snapshot should not trigger a duplicate import-status read').toBe(0)
  await attachEvidence(testInfo, 'library-empty-selection', await page.screenshot(), 'image/png')
  await studyRoot.getByRole('button', { name: '导入文献', exact: true }).click()
  await expect(pdfMineruLanguage(studyRoot)).toHaveValue('ch')
  await pdfMineruLanguage(studyRoot).selectOption('en')
  await studyRoot.getByLabel('选择要导入的文献').setInputFiles(environment.epubPath)
  const importStatus = studyRoot.getByRole('region', { name: '导入状态' })
  if (await importStatus.isVisible().catch(() => false)) await attachEvidence(testInfo, 'active-import', await importStatus.screenshot(), 'image/png')
  const source = studyRoot.getByRole('button', { name: new RegExp(`^${EPUB_FIXTURE_TITLE}`) })
  await expect(source).toBeEnabled({ timeout: 60_000 })
  await expect(source).toHaveAttribute('aria-pressed', 'true')
  await expect(studyRoot.getByRole('heading', { name: EPUB_FIXTURE_TITLE })).toBeVisible()
  const epubFrame = studyRoot.locator('.dsh-reader-epub iframe')
  await expect(epubFrame).toBeVisible()
  const epubDocument = epubFrame.contentFrame()
  await expect(epubDocument.getByRole('img', { name: '红色测试图示' })).toBeVisible()
  await attachEvidence(testInfo, 'epub-semantic-preview', await studyRoot.locator('.dsh-library-document').screenshot(), 'image/png')
  const chapterHeading = epubDocument.getByRole('heading', { level: 1 })
  const nextPage = studyRoot.getByRole('button', { name: '下一页', exact: true }).first()
  const previousPage = studyRoot.getByRole('button', { name: '上一页', exact: true }).first()
  const chapterCounter = nextPage.locator('..')
  await expect(chapterHeading).toHaveText(/第一章：起点 \/ Beginnings/)
  await expect(chapterCounter).toContainText(/章节\s*1\s*\/\s*2/)
  expect(rpcCount(rpcMethods, 'getSourcePreview'), 'the completed first import should load one bounded preview').toBe(1)
  expect(rpcCount(rpcMethods, 'openSourceForSession'), 'Host completion should select-if-empty without a browser open command').toBe(0)
  await nextPage.click()
  await expect(chapterHeading).not.toHaveText(/第一章：起点 \/ Beginnings/)
  await expect(chapterCounter).toContainText(/章节\s*2\s*\/\s*2/)
  expect(rpcCount(rpcMethods, 'getSourcePreview'), 'original EPUB page turns must stay inside the transient reader').toBe(1)
  await previousPage.click()
  await expect(chapterHeading).toHaveText(/第一章：起点 \/ Beginnings/)
  expect(rpcCount(rpcMethods, 'getSourcePreview'), 'returning a page must not fetch semantic preview data').toBe(1)
  await nextPage.click()
  await expect(chapterHeading).not.toHaveText(/第一章：起点 \/ Beginnings/)
  expect(rpcCount(rpcMethods, 'getSourcePreview'), 'a second page turn must remain local').toBe(1)

  await page.reload()
  await expect(studyRoot).toHaveCount(1)
  await expect(studyRoot.getByRole('heading', { name: EPUB_FIXTURE_TITLE })).toBeVisible({ timeout: 15_000 })
  await expect(studyRoot.locator('.dsh-reader-epub iframe').contentFrame().getByRole('heading', { level: 1 })).toHaveText(/第一章：起点 \/ Beginnings/)
  await studyRoot.getByRole('button', { name: '导入文献', exact: true }).click()
  await expect(pdfMineruLanguage(studyRoot)).toHaveValue('ch')
  await studyRoot.getByRole('button', { name: '关闭导入文献', exact: true }).click()
  await expect(studyRoot.getByText('当前上下文', { exact: true })).toHaveCount(0)
  await expect(studyRoot.getByText(/ReaderState|BookState|阅读位置/)).toHaveCount(0)

  await studyRoot.getByRole('button', { name: '导入文献', exact: true }).click()
  await studyRoot.getByLabel('选择要导入的文献').setInputFiles(environment.pdfPath)
  const pdfSource = studyRoot.getByRole('button', { name: new RegExp(`^${PDF_SOURCE_TITLE}`) })
  await expect(pdfSource).toBeEnabled({ timeout: 60_000 })
  await expect(pdfSource).toContainText('打开文献')
  await pdfSource.click()
  const pdfFrame = studyRoot.locator('.dsh-reader-scroll')
  await expect(pdfFrame).toBeVisible({ timeout: 15_000 })
  await expect(pdfFrame.getByLabel('原版 PDF 第 1 页')).toBeVisible({ timeout: 15_000 })
  await expect.poll(async () => {
    const ratios = pngPdfPaintRatios(await pdfFrame.screenshot())
    return ratios.white > 0.08 && ratios.red > 0.002
  }, {
    message: 'the native PDF surface should paint a white page and the fixture red marker, not only viewer chrome',
    timeout: 15_000,
  }).toBe(true)
  const pdfPaint = await pdfFrame.screenshot()
  await attachEvidence(testInfo, 'pdf-painted-preview', pdfPaint, 'image/png')
  const originalUrl = await studyRoot.getByRole('link', { name: '打开原文件' }).getAttribute('href')
  expect(originalUrl, 'PDF preview should expose the original asset URL').not.toBeNull()
  const originalResponse = await page.request.get(originalUrl!)
  expect(originalResponse.ok(), 'PDF original asset should resolve').toBe(true)
  expect(originalResponse.headers()['content-type']).toContain('application/pdf')
  const beforePdfScroll = rpcSnapshot(rpcMethods)
  await pdfFrame.hover()
  await page.mouse.wheel(0, 900)
  await page.waitForTimeout(300)
  expect(rpcSnapshot(rpcMethods), 'scrolling the native PDF preview must not invoke Study Remote').toEqual(beforePdfScroll)

  for (const width of [1440, 1024, 760]) {
    await page.setViewportSize({ width, height: 900 })
    await attachEvidence(testInfo, `library-${String(width)}px`, await page.screenshot(), 'image/png')
  }
  await page.emulateMedia({ colorScheme: 'dark' })
  await attachEvidence(testInfo, 'library-dark', await page.screenshot(), 'image/png')

  for (const forbidden of ['getCurrentReadingContext', 'getReaderState', 'getBookState', 'executeReadingContextCommand', 'getReaderPosition', 'saveReaderPosition', 'listStudyEvents', 'executeStudyCommand', 'rememberMemory', 'getOutline']) {
    expect(rpcCount(rpcMethods, forbidden), `${forbidden} must remain outside the lightweight Bookroom`).toBe(0)
  }
  await attachEvidence(testInfo, 'lightweight-library', await page.screenshot(), 'image/png')
  await attachEvidence(testInfo, 'observed-study-rpcs', Buffer.from(JSON.stringify(rpcMethods, null, 2)), 'application/json')
})

test('post-uninstall profile has no Study Reader UI or routes', async ({ page, request }) => {
  test.skip(!postUninstallRun(), 'the isolated runner enables this only after plugin removal and restart')

  await page.goto('/')
  await expect(page.locator('[data-dsh-study-root]')).toHaveCount(0)
  const [bundle, asset] = await Promise.all([
    request.get('/plugins/dsh-study-reader/client.js'),
    request.get('/study-reader/assets/probe'),
  ])
  expect(bundle.status(), 'removed Study Reader client bundle should not resolve').toBe(404)
  // An unregistered route falls through to the Harness SPA document rather
  // than its former Study Reader handler.  The plugin handler would own this
  // prefix and return an asset response/error; HTML proves it no longer does.
  expect(asset.status(), 'removed Study Reader asset prefix should fall through to the SPA').toBe(200)
  expect(asset.headers()['content-type'], 'removed Study Reader asset prefix should not have a service response').toContain('text/html')
})
