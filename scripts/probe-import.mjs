// Isolated real-import probe. It runs the same composed Host stack as the
// integration test over a fresh temporary storage root and random local port;
// it never connects to, kills, or reuses a user's port 3080 / study library.
import { access } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { argv, exit } from 'node:process'
import { spawn } from 'node:child_process'

const positional = argv.slice(2)
if (positional[0] === '--') positional.shift()
const [rawPath] = positional
if (rawPath === undefined) {
  console.error('usage: pnpm run probe:import -- <path-to-epub>')
  exit(2)
}
const documentPath = resolve(rawPath)
if (extname(documentPath).toLowerCase() !== '.epub') {
  console.error('probe:import only accepts an EPUB fixture')
  exit(2)
}
try {
  await access(documentPath)
} catch {
  console.error(`probe: fixture does not exist: ${documentPath}`)
  exit(2)
}

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const child = spawn(command, ['exec', 'vitest', 'run', 'packages/study-reader/tests/epub-import.probe.spec.ts', '--disableConsoleIntercept'], {
  cwd: process.cwd(),
  env: { ...process.env, STUDY_IMPORT_PROBE_PATH: documentPath },
  stdio: 'inherit',
})
child.once('error', error => {
  console.error(`probe failed: ${error.message}`)
  exit(1)
})
child.once('exit', code => exit(code ?? 1))
