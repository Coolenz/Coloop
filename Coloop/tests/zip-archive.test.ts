import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createVerifiedZip,
  verifyZipArchive,
  type ArchiveEntry,
} from '../src/main/infrastructure/zip-archive'

let root: string
const signal = () => new AbortController().signal
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'coloop-zip-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
async function source(text = '中文原文 😀'): Promise<ArchiveEntry> {
  const path = join(root, 'source.txt')
  await writeFile(path, text)
  return {
    name: '内容😀.txt',
    path,
    type: 'file',
    bytes: Buffer.byteLength(text),
    sha256: digest(text),
  }
}

it('reopens exact Unicode content, zero-byte files and empty directories', async () => {
  const entry = await source()
  const emptyPath = join(root, 'empty.txt')
  await writeFile(emptyPath, '')
  const entries = [
    entry,
    { name: '空目录', path: root, type: 'directory' },
    { name: 'empty.txt', path: emptyPath, type: 'file', bytes: 0, sha256: digest('') },
  ]
  const output = join(root, 'result.zip')
  expect(await createVerifiedZip(output, entries, signal())).toMatchObject({
    verified: true,
    entries: 3,
  })
  expect((await readFile(output)).subarray(0, 2).toString()).toBe('PK')
  await expect(verifyZipArchive(output, entries, signal())).resolves.toBeUndefined()
})

it('rejects a source changed after its manifest, including equal-length replacements', async () => {
  const entry = await source('original')
  await writeFile(entry.path, 'replaced')
  await expect(createVerifiedZip(join(root, 'changed.zip'), [entry], signal())).rejects.toThrow(
    'ARCHIVE_PAYLOAD_MISMATCH',
  )
})

it('detects a growing source without accepting extra bytes', async () => {
  const entry = await source('')
  await writeFile(entry.path, 'unexpected')
  await expect(createVerifiedZip(join(root, 'grown.zip'), [entry], signal())).rejects.toThrow()
})

it('rejects readback hashes or entry counts that differ from the source manifest', async () => {
  const entry = await source()
  const output = join(root, 'result.zip')
  await createVerifiedZip(output, [entry], signal())
  await expect(
    verifyZipArchive(output, [{ ...entry, sha256: '0'.repeat(64) }], signal()),
  ).rejects.toThrow('ARCHIVE_PAYLOAD_MISMATCH')
  await expect(verifyZipArchive(output, [], signal())).rejects.toThrow(
    'ARCHIVE_ENTRY_COUNT_MISMATCH',
  )
})

it('rejects traversal and duplicate names before creating an output', async () => {
  const entry = await source()
  for (const entries of [[{ ...entry, name: '../outside.txt' }], [entry, entry]]) {
    const output = join(root, 'invalid.zip')
    await expect(createVerifiedZip(output, entries, signal())).rejects.toThrow(
      'ARCHIVE_ENTRY_INVALID',
    )
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

it('preserves an existing destination instead of overwriting it', async () => {
  const entry = await source()
  const output = join(root, 'existing.zip')
  await writeFile(output, 'user file')
  await expect(createVerifiedZip(output, [entry], signal())).rejects.toMatchObject({
    code: 'EEXIST',
  })
  expect(await readFile(output, 'utf8')).toBe('user file')
})

it('honors cancellation and releases file handles before returning', async () => {
  const entry = await source('x'.repeat(1024 * 1024))
  const controller = new AbortController()
  const pending = createVerifiedZip(join(root, 'cancelled.zip'), [entry], controller.signal)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await rename(entry.path, join(root, 'closed-source.txt'))
})
