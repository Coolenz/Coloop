import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { resolve } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { DoclingService } from '../src/main/infrastructure/docling'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

let child: EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
  kill: ReturnType<typeof vi.fn>
}
const service = () =>
  new DoclingService({
    pythonPath: 'trusted-python',
    workerPath: 'trusted-worker',
    cacheDirectory: resolve('private-cache'),
    modelDirectory: resolve('offline-models'),
  })
const result = {
  ok: true,
  source_sha256: 'a'.repeat(64),
  parser_version: 'docling=2.147.0',
  document_id: 'b'.repeat(64),
  block_count: 1,
  blocks: [
    {
      id: 'block:0',
      source_id: '#/texts/0',
      kind: 'text',
      text: '中文资料',
      text_offset: 0,
      pages: [2],
      provenance: [{ page: 2 }],
    },
  ],
  truncated: false,
  next_block: null,
  cache_hit: false,
  channel: 'host_docling',
}
beforeEach(() => {
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('close', 1))
      return true
    }),
  })
  mocks.spawn.mockReset().mockReturnValue(child)
})

it('bounds results, preserves Chinese provenance and passes no provider credentials', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'do-not-forward')
  try {
    const read = service().read(resolve('source.pdf'), {}, new AbortController().signal)
    child.stdout.write(JSON.stringify(result))
    child.emit('close', 0)
    expect(await read).toEqual(result)
    const [python, args, options] = mocks.spawn.mock.calls[0]
    expect(python).toBe('trusted-python')
    expect(args).toContain('-I')
    expect(options.env.OPENAI_API_KEY).toBeUndefined()
    expect(options.env.HF_HUB_OFFLINE).toBe('1')
    expect(options.windowsHide).toBe(true)
  } finally {
    vi.unstubAllEnvs()
  }
})

it('rejects URLs and unsupported formats before starting a process', async () => {
  await expect(
    service().read('https://example.com/a.pdf', {}, new AbortController().signal),
  ).rejects.toThrow('LOCAL_PDF_DOCX')
  await expect(
    service().read(resolve('source.exe'), {}, new AbortController().signal),
  ).rejects.toThrow('LOCAL_PDF_DOCX')
  expect(mocks.spawn).not.toHaveBeenCalled()
})

it('cancels the worker and cannot accept a late successful result', async () => {
  const abort = new AbortController()
  const read = service().read(resolve('source.docx'), {}, abort.signal)
  abort.abort()
  child.stdout.write(JSON.stringify(result))
  await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  expect(child.kill).toHaveBeenCalledTimes(1)
})

it('kills an oversized worker response without resolving partial data', async () => {
  const read = service().read(resolve('source.pdf'), {}, new AbortController().signal)
  child.stdout.write('x'.repeat(1024 * 1024 + 1))
  await expect(read).rejects.toThrow('DOCLING_RESPONSE_TOO_LARGE')
  expect(child.kill).toHaveBeenCalledTimes(1)
})

it('rejects worker failures and malformed provenance', async () => {
  const read = service().read(resolve('source.pdf'), {}, new AbortController().signal)
  child.stdout.write(JSON.stringify({ ...result, blocks: [{ ...result.blocks[0], pages: [-1] }] }))
  child.emit('close', 0)
  await expect(read).rejects.toThrow()
})
