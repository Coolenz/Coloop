import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { addAbortSignal, Readable, Transform } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { ZipFile as ZipWriter } from 'yazl'
import { open, type Entry, type ZipFile } from 'yauzl'

const maxBytes = 100 * 1024 * 1024
export type ArchiveEntry = {
  name: string
  path: string
  type: string
  bytes?: number
  sha256?: string
}

// yauzl 3.4 exposes these async APIs; DefinitelyTyped still describes 2.x.
interface AsyncZipFile extends ZipFile {
  eachEntry(): AsyncIterableIterator<Entry>
  openReadStreamPromise(entry: Entry): Promise<Readable>
}

function manifest(entries: ArchiveEntry[]) {
  if (entries.length > 500) throw new Error('DIRECTORY_EXCEEDS_500_ENTRIES')
  const expected = new Map<string, ArchiveEntry>()
  for (const entry of entries) {
    const name = entry.type === 'directory' ? entry.name.replace(/\/$/, '') + '/' : entry.name
    if (
      !name ||
      name.startsWith('/') ||
      /[\\:\0]/.test(name) ||
      name.split('/').some((part) => part === '..' || part === '.') ||
      (entry.type !== 'directory' && entry.type !== 'file') ||
      (entry.type === 'file' && name.endsWith('/')) ||
      expected.has(name)
    )
      throw new Error('ARCHIVE_ENTRY_INVALID')
    if (
      entry.type === 'file' &&
      (!Number.isSafeInteger(entry.bytes) ||
        entry.bytes! < 0 ||
        entry.bytes! > maxBytes ||
        !/^[a-f0-9]{64}$/.test(entry.sha256 ?? ''))
    )
      throw new Error('ARCHIVE_SOURCE_INVALID')
    expected.set(name, entry)
  }
  return expected
}

export async function verifyZipArchive(path: string, entries: ArchiveEntry[], signal: AbortSignal) {
  signal.throwIfAborted()
  const expected = manifest(entries)
  const archive = await new Promise<AsyncZipFile>((resolve, reject) => {
    open(path, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, value) =>
      error ? reject(error) : resolve(value as AsyncZipFile),
    )
  })
  try {
    if (archive.entryCount !== expected.size) throw new Error('ARCHIVE_ENTRY_COUNT_MISMATCH')
    for await (const stored of archive.eachEntry()) {
      signal.throwIfAborted()
      const entry = expected.get(stored.fileName)
      if (!entry) throw new Error('ARCHIVE_ENTRY_MISSING')
      expected.delete(stored.fileName)
      if (entry.type === 'directory') {
        if (stored.uncompressedSize !== 0) throw new Error('ARCHIVE_PAYLOAD_MISMATCH')
        continue
      }
      if (stored.uncompressedSize !== entry.bytes) throw new Error('ARCHIVE_PAYLOAD_MISMATCH')
      const stream = addAbortSignal(signal, await archive.openReadStreamPromise(stored))
      const hash = createHash('sha256')
      let size = 0
      for await (const chunk of stream) {
        size += chunk.length
        if (size > entry.bytes!) {
          stream.destroy()
          throw new Error('ARCHIVE_PAYLOAD_MISMATCH')
        }
        hash.update(chunk)
      }
      if (size !== entry.bytes || hash.digest('hex') !== entry.sha256)
        throw new Error('ARCHIVE_PAYLOAD_MISMATCH')
    }
    signal.throwIfAborted()
    if (expected.size) throw new Error('ARCHIVE_ENTRY_MISSING')
  } finally {
    const closed = once(archive, 'close')
    archive.close()
    await closed
  }
}

/** Stream a new archive, then independently reopen and hash every member before publication. */
export async function createVerifiedZip(
  path: string,
  entries: ArchiveEntry[],
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const expected = manifest(entries)
  const stop = new AbortController()
  const bounded = AbortSignal.any([signal, stop.signal, AbortSignal.timeout(120000)])
  const archive = new ZipWriter()
  const output = archive.outputStream as Readable
  const inputs = new Set<Readable>()
  archive.on('error', (error) => output.destroy(error))
  let bytes = 0
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      callback(bytes > maxBytes ? new Error('ARTIFACT_EXCEEDS_100_MB') : null, chunk)
    },
  })
  const writing = pipeline(output, limit, createWriteStream(path, { flags: 'wx' }), {
    signal: bounded,
  })
  try {
    for (const [name, entry] of expected) {
      bounded.throwIfAborted()
      if (entry.type === 'directory') archive.addEmptyDirectory(name)
      else
        archive.addReadStreamLazy(name, { size: entry.bytes }, (callback) => {
          if (bounded.aborted) return callback(bounded.reason, undefined as never)
          // At most one extra byte is read if the source grows after its manifest was made.
          const stream = createReadStream(entry.path, { signal: bounded, end: entry.bytes })
          inputs.add(stream)
          stream.once('close', () => inputs.delete(stream))
          callback(null, stream)
        })
    }
    archive.end()
    await writing
    await verifyZipArchive(path, entries, bounded)
    return { ok: true, reopened: true, verified: true, entries: entries.length }
  } catch (error) {
    output.destroy(error instanceof Error ? error : new Error('ARCHIVE_FAILED'))
    await writing.catch(() => {})
    if (signal.aborted) throw signal.reason
    throw error
  } finally {
    stop.abort()
    await Promise.all([...inputs].map((stream) => finished(stream).catch(() => {})))
  }
}
