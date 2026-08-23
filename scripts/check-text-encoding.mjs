import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TEXT_EXTENSIONS = new Set(['.md', '.yml', '.yaml', '.json', '.ts', '.tsx', '.css', '.html', '.txt'])
const SKIP_DIRECTORIES = new Set(['.git', '.tools', 'coverage', 'dist', 'lib', 'node_modules', 'test-results'])
const decoder = new TextDecoder('utf-8', { fatal: true })

function assertUtf8(bytes, label) {
  try {
    decoder.decode(bytes)
  } catch {
    throw new Error(`invalid UTF-8: ${label}`)
  }
}

function scanDirectory(directory) {
  for (const name of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(name) || name.startsWith('.tmp-dsh.')) continue
    const path = join(directory, name)
    const entry = statSync(path)
    if (entry.isDirectory()) scanDirectory(path)
    else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(name))) {
      assertUtf8(readFileSync(path), relative(ROOT, path))
    }
  }
}

function scanTarball(path) {
  const members = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).split('\n').filter(Boolean)
  for (const member of members) {
    if (!TEXT_EXTENSIONS.has(extname(member))) continue
    assertUtf8(execFileSync('tar', ['-xOzf', path, member]), member)
  }
}

const tarball = process.argv[2]
if (tarball === undefined) scanDirectory(ROOT)
else scanTarball(resolve(tarball))
console.log(`check-text-encoding: all checked text is valid UTF-8${tarball === undefined ? '' : ' in ' + tarball}`)
