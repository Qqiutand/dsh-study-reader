import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
for (const target of [
  'packages/study-reader/lib',
  'packages/study-reader/tsconfig.tsbuildinfo',
  'packages/study-reader/tsconfig.client.tsbuildinfo',
]) rmSync(resolve(root, target), { recursive: true, force: true })
