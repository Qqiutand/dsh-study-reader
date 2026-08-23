import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(resolve(root, 'packages/study-reader/package.json'), 'utf8')).version
const archive = process.argv[2] === undefined ? resolve(root, `dsh-study-reader-${version}-source.tar.gz`) : resolve(process.argv[2])
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
const forbidden = /(^|\/)(?:node_modules|dist|lib|coverage|test-results|playwright-report|artifacts|\.git|\.tmp-[^/]*)(?:\/|$)|\.(?:tgz|tar\.gz)$|scripts\/gen-debug\/index\.js$/u
const rejected = entries.filter(entry => forbidden.test(entry))
if (rejected.length > 0) throw new Error(`source archive contains forbidden entries:\n${rejected.join('\n')}`)
const manifestText = execFileSync('tar', ['-xOzf', archive, 'dsh-study-reader/SOURCE-MANIFEST.json'], { encoding: 'utf8' })
const manifest = JSON.parse(manifestText)
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (manifest.commit !== commit || manifest.version !== version || typeof manifest.createdAt !== 'string') throw new Error('source manifest does not identify current commit/version')
console.log(`verify-source: ${entries.length} tracked source entries, commit ${commit}`)
