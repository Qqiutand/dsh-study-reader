import { readFile, readdir } from 'node:fs/promises'
import { resolve, extname } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const toolsSource = await readFile(resolve(root, 'packages/study-reader/src/ai/contracts.ts'), 'utf8')
const declaration = toolsSource.match(/READER_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const/)
if (declaration === null) throw new Error('READER_TOOL_NAMES declaration not found')
const allowed = new Set([...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1]))
if (allowed.size === 0) throw new Error('DEFAULT_STUDY_TOOL_NAMES is empty')

const promptRoots = [resolve(root, 'presets/reading'), resolve(root, 'packages/study-reader/skills')]
const files = []
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (['.md', '.yaml', '.yml'].includes(extname(entry.name))) files.push(path)
  }
}
for (const promptRoot of promptRoots) await walk(promptRoot)

const forbidden = [
  /ReaderState|BookState/u,
  /当前阅读位置|当前位置|用户态|书本态/u,
  /EPUB\s+CFI|\bCFI\b/iu,
  /。，|。；/u,
  /未经我确认不要写入|保存(?:阅读|学习)状态/u,
]
const failures = []
for (const path of files) {
  const text = await readFile(path, 'utf8')
  for (const pattern of forbidden) if (pattern.test(text)) failures.push(`${path}: forbidden prompt contract ${pattern}`)
  for (const match of text.matchAll(/\bstudy_[a-z0-9_]+\b/g)) {
    if (!allowed.has(match[0])) failures.push(`${path}: unregistered tool ${match[0]}`)
  }
  for (const match of text.matchAll(/\breader_[a-z0-9_]+\b/g)) {
    if (!allowed.has(match[0])) failures.push(`${path}: unregistered Reader tool ${match[0]}`)
  }
  if (/(?:调用|使用|切换到)\s+study-[a-z0-9-]+/u.test(text)) failures.push(`${path}: pseudo Skill-to-Skill invocation`)
}
if (failures.length > 0) throw new Error(`prompt contract failed:\n${failures.join('\n')}`)
console.log(`check-prompt-contract: ${files.length} prompt files match ${allowed.size} default tools`)
