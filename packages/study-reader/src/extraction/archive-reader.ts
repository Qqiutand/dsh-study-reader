/**
 * Provider-neutral bounded ZIP reader.  It deliberately knows nothing about
 * provider file names or JSON payloads; adapters select and interpret entries.
 */
import { stat } from 'node:fs/promises'
import yauzl from 'yauzl'
import { StudyError } from '../protocol/error.ts'

/** Limits applied before an archive reaches an adapter parser. */
export interface ArchiveLimits { readonly maxArchiveBytes: number; readonly maxUncompressedBytes: number; readonly maxArchiveEntries: number; readonly maxEntryBytes: number }
/** One validated archive entry. */
export interface ArchiveEntry { readonly name: string; readonly size: number; readonly data: Uint8Array }

/** Reject ZIP-slip paths before exposing archive data. */
export function validateEntryName(name: string): string {
  if (name === '' || name.includes('\0') || name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name) || name.includes('\\') || name.split('/').includes('..')) {
    throw new StudyError('ZIP entry has an unsafe path', 'ZIP_UNSAFE_PATH')
  }
  return name
}

/** Read an archive with size, entry-count, traversal, symlink and bomb guards. */
export async function readArchive(zipPath: string, limits: ArchiveLimits): Promise<ArchiveEntry[]> {
  if ((await stat(zipPath)).size > limits.maxArchiveBytes) throw new StudyError('ZIP archive exceeds maxArchiveBytes', 'ZIP_TOO_LARGE')
  return await new Promise((resolve, reject) => {
    const entries: ArchiveEntry[] = []; const seen = new Set<string>(); let total = 0; let settled = false
    const fail = (error: unknown): void => { if (!settled) { settled = true; reject(error) } }
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError != null || zip === undefined) return fail(new StudyError('ZIP cannot be opened', 'ZIP_INVALID', { cause: openError ?? undefined }))
      zip.on('error', fail); zip.on('end', () => { if (!settled) { settled = true; resolve(entries) } })
      zip.on('entry', entry => {
        try {
          if (entries.length >= limits.maxArchiveEntries) throw new StudyError('ZIP exceeds maxArchiveEntries', 'ZIP_TOO_MANY_ENTRIES')
          const name = validateEntryName(entry.fileName)
          if (seen.has(name)) throw new StudyError('ZIP has duplicate entry', 'ZIP_DUPLICATE_ENTRY')
          seen.add(name)
          if (((entry.externalFileAttributes >>> 16) & 0xF000) === 0xA000) throw new StudyError('ZIP has symlink entry', 'ZIP_SYMLINK')
          if (entry.uncompressedSize === 0xFFFFFFFF || entry.uncompressedSize > limits.maxEntryBytes) throw new StudyError('ZIP entry exceeds maxEntryBytes', 'ZIP_ENTRY_TOO_LARGE')
          total += entry.uncompressedSize
          if (total > limits.maxUncompressedBytes) throw new StudyError('ZIP exceeds maxUncompressedBytes', 'ZIP_BOMB')
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError != null || stream === undefined) return fail(new StudyError('ZIP entry cannot be read', 'ZIP_INVALID', { cause: streamError ?? undefined }))
            const chunks: Uint8Array[] = []; let size = 0
            stream.on('data', (chunk: Buffer) => { size += chunk.byteLength; if (size > limits.maxEntryBytes) { stream.destroy(); fail(new StudyError('ZIP entry exceeded maxEntryBytes while streaming', 'ZIP_ENTRY_TOO_LARGE')) } else chunks.push(new Uint8Array(chunk)) })
            stream.on('error', fail); stream.on('end', () => { if (size !== entry.uncompressedSize) return fail(new StudyError('ZIP entry size mismatch', 'ZIP_SIZE_MISMATCH')); const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }; entries.push({ name, size, data }); zip.readEntry() })
          })
        } catch (error) { fail(error) }
      })
      zip.readEntry()
    })
  })
}
