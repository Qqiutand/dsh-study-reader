import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
const trackedPackage = git('ls-files', '--error-unmatch', 'package.json')
if (trackedPackage !== 'package.json') throw new Error('pack:source requires the standalone Git repository')
// The archive is produced exclusively from Git's tracked tree. Local ignored or
// untracked notes cannot enter it, so only tracked modifications would break the
// commit-to-archive identity.
if (git('status', '--porcelain', '--untracked-files=no') !== '') throw new Error('pack:source requires a clean tracked working tree so the archive matches one commit')

const commit = git('rev-parse', 'HEAD')
const createdAt = git('show', '-s', '--format=%cI', 'HEAD')
const version = JSON.parse(readFileSync(join(root, 'packages/study-reader/package.json'), 'utf8')).version
const output = join(root, `dsh-study-reader-${version}-source.tar.gz`)
const temp = mkdtempSync(join(tmpdir(), 'dsh-study-reader-source-'))
try {
  const tarPath = join(temp, 'source.tar')
  execFileSync('git', ['-C', root, 'archive', '--format=tar', '--prefix=dsh-study-reader/', `--output=${tarPath}`, 'HEAD'])
  const manifestRoot = join(temp, 'dsh-study-reader')
  mkdirSync(manifestRoot)
  writeFileSync(join(manifestRoot, 'SOURCE-MANIFEST.json'), `${JSON.stringify({ commit, version, createdAt }, null, 2)}\n`)
  execFileSync('tar', ['-rf', tarPath, '-C', temp, 'dsh-study-reader/SOURCE-MANIFEST.json'])
  const compressed = execFileSync('gzip', ['-n', '-c', tarPath])
  writeFileSync(output, compressed)
  console.log(`pack-source: ${output}`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
