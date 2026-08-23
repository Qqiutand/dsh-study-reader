#!/usr/bin/env node
/** Build the deterministic public-domain EPUB import fixture with yazl. */
import { mkdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import yazl from 'yazl'
import { EPUB_FIXTURE_MTIME, minimalEpubEntries } from './minimal-epub-source.mjs'

/**
 * Build one EPUB with stable entry order, timestamps, modes, and compression.
 * @param {string} outputPath absolute or relative destination
 * @returns {Promise<string>} resolved output path
 */
export async function buildMinimalEpub(outputPath) {
  const target = resolve(outputPath)
  await mkdir(dirname(target), { recursive: true })
  const archive = new yazl.ZipFile()
  for (const entry of minimalEpubEntries()) {
    archive.addBuffer('base64' in entry ? Buffer.from(entry.base64, 'base64') : Buffer.from(entry.text, 'utf8'), entry.name, {
      compress: entry.compress,
      mtime: EPUB_FIXTURE_MTIME,
      mode: 0o100644,
      forceZip64Format: false,
    })
  }
  await new Promise((resolveOutput, rejectOutput) => {
    archive.outputStream.once('error', rejectOutput)
    archive.outputStream.pipe(createWriteStream(target))
      .once('error', rejectOutput)
      .once('close', resolveOutput)
    archive.end({ forceZip64Format: false })
  })
  return target
}

const positional = process.argv.slice(2)
if (positional[0] === '--') positional.shift()
const requested = positional[0]
if (requested !== undefined) {
  const output = await buildMinimalEpub(requested)
  process.stdout.write(`${output}\n`)
}
