import { mkdtemp, readFile, realpath, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceSession } from '../src/main/services/workspace-session'

let root: string
let session: WorkspaceSession
const signal = () => new AbortController().signal
const call = (operation: string, args: Record<string, unknown>) =>
  session.call({ operation, arguments: args }, signal())
const workbook = (path = 'result.xlsx') => ({
  path,
  sheets: [
    {
      name: 'Data',
      rows: [
        ['Title', 'Amount'],
        ['East', 250],
      ],
    },
  ],
})
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'coloop-workspace-')))
  session = await WorkspaceSession.open(
    root,
    'unused.ps1',
    vi.fn(async () => ''),
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('reads Chinese source text and inventories hashes and empty folders', async () => {
  await writeFile(join(root, 'source.csv'), '地区,金额\n华东,250')
  await mkdir(join(root, 'empty'))
  expect(await call('read_text', { path: 'source.csv' })).toMatchObject({
    text: '地区,金额\n华东,250',
  })
  expect(await call('list', { path: '.', recursive: true })).toMatchObject({
    path: root,
    entries: [
      { path: 'empty', type: 'directory' },
      { path: 'source.csv', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ],
  })
})

it('reads CSV records with exact physical source positions and bounded pagination', async () => {
  await writeFile(join(root, 'orders.csv'), '订单号,金额\r\nM001,120\r\nM002,80\r\n')
  const first = await call('read_csv', { path: 'orders.csv', max_records: 1 })
  expect(first).toMatchObject({
    columns: ['订单号', '金额'],
    records: [{ record: 1, start_line: 2, end_line: 2, cells: ['M001', '120'] }],
    truncated: true,
    next_record: 2,
  })
  expect(await call('read_csv', { path: 'orders.csv', start_record: 2 })).toMatchObject({
    records: [{ record: 2, start_line: 3, cells: ['M002', '80'] }],
    truncated: false,
  })
})

it('paginates Unicode source text without splitting surrogate pairs or changing the source digest', async () => {
  await writeFile(join(root, 'source.txt'), '中文🌤️内容')
  const first = await call('read_text', { path: 'source.txt', max_characters: 3 })
  const second = await call('read_text', { path: 'source.txt', start_character: 3 })
  expect(first).toMatchObject({ text: '中文🌤', range: [0, 3], truncated: true, next_character: 3 })
  expect(second).toMatchObject({
    text: '️内容',
    range: [3, 6],
    truncated: false,
    sha256: first.sha256,
  })
  expect(String(first.text) + String(second.text)).toBe('中文🌤️内容')
})
it('rejects traversal before touching outside files', async () => {
  await expect(call('read_text', { path: '../secret.txt' })).rejects.toThrow(
    'PATH_OUTSIDE_TASK_WORKSPACE',
  )
})
it('rejects a junction escaping the chosen directory', async () => {
  await symlink(tmpdir(), join(root, 'escape'), 'junction')
  await expect(call('read_text', { path: 'escape/secret.txt' })).rejects.toThrow(
    'PATH_OUTSIDE_TASK_WORKSPACE',
  )
})
it('requires explicit absolute directory authorization', async () => {
  await expect(WorkspaceSession.open('.', 'unused', async () => '')).rejects.toThrow(
    'WORKSPACE_MUST_BE_ABSOLUTE',
  )
})
it('returns narrow operation contracts and rejects unsupported operations', async () => {
  expect(await call('help', { subject: 'write_workbook' })).toMatchObject({
    root,
    contract: { type: 'object' },
  })
  await expect(call('execute_script', { code: 'anything' })).rejects.toThrow()
})
it('rejects executable and external-reference workbook formulas before opening WPS', async () => {
  for (const formula of [
    '=WEBSERVICE("https://example.test")',
    '=[other.xlsx]Sheet1!A1',
    '=cmd|anything',
  ]) {
    await expect(
      call('write_workbook', {
        path: 'result.xlsx',
        sheets: [{ name: 'Data', rows: [[{ formula }]] }],
      }),
    ).rejects.toThrow()
  }
})
it('rejects duplicate worksheet names and conflicting outputs', async () => {
  await expect(
    call('write_workbook', {
      path: 'result.xlsx',
      sheets: [
        { name: 'Data', rows: [[1]] },
        { name: 'data', rows: [[2]] },
      ],
    }),
  ).rejects.toThrow('DUPLICATE_WORKSHEET_NAME')
  const worker = session as unknown as {
    worker(value: { path: string }, signal: AbortSignal): Promise<Record<string, unknown>>
  }
  vi.spyOn(worker, 'worker').mockImplementation(async (value) => {
    await writeFile(value.path, 'generated workbook')
    return { ok: true, reopened: true, verified: true }
  })
  await writeFile(join(root, 'result.xlsx'), 'existing user file')
  await expect(call('write_workbook', workbook())).rejects.toThrow(
    'OUTPUT_ALREADY_EXISTS_OR_COMMIT_FAILED',
  )
  expect(await readFile(join(root, 'result.xlsx'), 'utf8')).toBe('existing user file')
})
it('commits and independently verifies artifacts, detecting later changes', async () => {
  const worker = session as unknown as {
    worker(value: { path: string }, signal: AbortSignal): Promise<Record<string, unknown>>
  }
  vi.spyOn(worker, 'worker').mockImplementation(async (value) => {
    await writeFile(value.path, 'generated workbook')
    return { ok: true, reopened: true, verified: true }
  })
  const result = await call('write_workbook', workbook())
  expect(result).toMatchObject({ committed: true, channel: 'host_wps_com' })
  expect(await session.verify(String(result.artifact_id), signal())).toMatchObject({
    verified: true,
  })
  await writeFile(join(root, 'result.xlsx'), 'changed')
  expect(await session.verify(String(result.artifact_id), signal())).toMatchObject({
    verified: false,
  })
})
it('treats an empty optional workbook template as absent and still guards nonempty paths', async () => {
  const worker = session as unknown as {
    worker(
      value: { path: string; template?: string },
      signal: AbortSignal,
    ): Promise<Record<string, unknown>>
  }
  const write = vi.spyOn(worker, 'worker').mockImplementation(async (value) => {
    expect(value.template).toBeUndefined()
    await writeFile(value.path, 'generated workbook')
    return { ok: true, reopened: true, verified: true }
  })
  expect(await call('write_workbook', { ...workbook(), template: '' })).toMatchObject({
    committed: true,
  })
  await expect(
    call('write_workbook', {
      ...workbook('another.xlsx'),
      template: '../outside.xlsx',
    }),
  ).rejects.toThrow('PATH_OUTSIDE_TASK_WORKSPACE')
  expect(write).toHaveBeenCalledOnce()
})
it('does not open arbitrary source files or another task artifact', async () => {
  await expect(call('open', { path: 'source.xlsx' })).rejects.toThrow('OPEN_REQUIRES_TASK_ARTIFACT')
  await expect(session.verify('unknown', signal())).rejects.toThrow('ARTIFACT_REFERENCE_INVALID')
})
it('honors cancellation before any operation', async () => {
  const abort = new AbortController()
  abort.abort()
  await expect(
    session.call({ operation: 'list', arguments: { path: '.' } }, abort.signal),
  ).rejects.toMatchObject({ name: 'AbortError' })
})
it('waits for a source to arrive and cancels a missing source without producing an artifact', async () => {
  const abort = new AbortController()
  const waiting = session.call(
    { operation: 'wait_file', arguments: { path: 'later.txt' } },
    abort.signal,
  )
  await writeFile(join(root, 'later.txt'), 'available source')
  expect(await waiting).toMatchObject({ ready: true, path: join(root, 'later.txt') })
  const missing = session.call(
    { operation: 'wait_file', arguments: { path: 'missing.txt' } },
    abort.signal,
  )
  const rejected = expect(missing).rejects.toMatchObject({ name: 'AbortError' })
  abort.abort()
  await rejected
})

it('copies every source byte and safely resumes an already matching copy', async () => {
  await writeFile(join(root, '原始🌤️.txt'), '不可修改的中文源文件')
  const args = { source: '原始🌤️.txt', path: '归档/文档.txt' }
  const first = await call('copy_file', args)
  const second = await call('copy_file', args)
  expect(second.sha256).toBe(first.sha256)
  expect(await readFile(join(root, '原始🌤️.txt'), 'utf8')).toBe('不可修改的中文源文件')
  await expect(call('write_text', { path: '归档/文档.txt', text: 'different' })).rejects.toThrow(
    'OUTPUT_ALREADY_EXISTS_OR_COMMIT_FAILED',
  )
})
it('does not expose a staged file when stopped before commit', async () => {
  const abort = new AbortController()
  const worker = session as unknown as {
    worker(value: { path: string }, signal: AbortSignal): Promise<Record<string, unknown>>
  }
  vi.spyOn(worker, 'worker').mockImplementation(async (value) => {
    await writeFile(value.path, 'generated workbook')
    abort.abort()
    return { ok: true, reopened: true, verified: true }
  })
  await expect(
    session.call({ operation: 'write_workbook', arguments: workbook() }, abort.signal),
  ).rejects.toMatchObject({ name: 'AbortError' })
  await expect(readFile(join(root, 'result.xlsx'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps PDF page provenance and reports an explicit page limit', async () => {
  const recognize = vi.fn(async () => ({ text: '订单 M004 金额 30', confidence: 98, items: [] }))
  session = await WorkspaceSession.open(root, 'unused.ps1', async () => '', undefined, recognize)
  await writeFile(join(root, 'scan.pdf'), 'synthetic PDF stub')
  const worker = session as unknown as {
    worker(value: { page: number }, signal: AbortSignal): Promise<Record<string, unknown>>
  }
  vi.spyOn(worker, 'worker').mockImplementation(async (value) => ({
    ok: true,
    page_count: 2,
    page: value.page,
    image: Buffer.from('page image').toString('base64'),
  }))
  expect(await call('read_pdf', { path: 'scan.pdf', max_pages: 1 })).toMatchObject({
    pages: [{ page: 1, text: '订单 M004 金额 30', confidence: 98 }],
    page_count: 2,
    truncated: true,
    source: 'windows_pdf_local_rapidocr',
  })
  expect(recognize).toHaveBeenCalledWith(Buffer.from('page image'), expect.any(AbortSignal))
})
it('detects source changes during document recognition', async () => {
  const recognize = vi.fn(async () => {
    await writeFile(join(root, 'scan.png'), 'changed source')
    return { text: 'recognized', confidence: 90, items: [] }
  })
  session = await WorkspaceSession.open(root, 'unused.ps1', async () => '', undefined, recognize)
  await writeFile(join(root, 'scan.png'), 'original source')
  await expect(call('read_image', { path: 'scan.png' })).rejects.toThrow('DOCUMENT_SOURCE_CHANGED')
})
it('requires rendered content verification before publishing a generated PDF, including after renaming it', async () => {
  session = await WorkspaceSession.open(
    root,
    'unused.ps1',
    async () => '',
    undefined,
    async () => ({ text: '报价 QUOTE-001 应付 438.50', confidence: 99, items: [] }),
  )
  await writeFile(join(root, 'source.docx'), 'source document')
  const worker = session as unknown as {
    worker(
      value: { operation: string; path: string; page: number },
      signal: AbortSignal,
    ): Promise<Record<string, unknown>>
  }
  vi.spyOn(worker, 'worker').mockImplementation(async (value) => {
    if (value.operation === 'render_pdf')
      return {
        ok: true,
        page_count: 2,
        page: value.page,
        image: Buffer.from('image').toString('base64'),
      }
    await writeFile(value.path, '%PDF-synthetic-output')
    return { ok: true, exported: true }
  })
  await call('export_pdf', { source: 'source.docx', path: 'report.pdf' })
  await expect(session.attachment('report.pdf', signal())).rejects.toThrow(
    'PDF_PUBLICATION_REQUIRES_RENDERED_VERIFICATION',
  )
  await call('read_pdf', { path: 'report.pdf', max_pages: 1 })
  await expect(
    call('verify_pdf', { path: 'report.pdf', expected_texts: ['438.50'] }),
  ).rejects.toThrow('PDF_READ_ALL_PAGES_FIRST')
  expect(await call('read_pdf', { path: 'report.pdf', start_page: 2, max_pages: 1 })).toMatchObject(
    { pages: [{ page: 2 }], truncated: false },
  )
  await expect(
    call('verify_pdf', { path: 'report.pdf', expected_texts: ['465.00'] }),
  ).rejects.toThrow('PDF_EXPECTED_TEXT_NOT_FOUND')
  await call('verify_pdf', { path: 'report.pdf', expected_texts: ['QUOTE-001', '438.50'] })
  expect(await session.attachment('report.pdf', signal())).toMatchObject({ name: 'report.pdf' })
  await call('copy_file', { source: 'report.pdf', path: 'renamed.pdf' })
  session.invalidateReviews()
  await expect(session.attachment('renamed.pdf', signal())).rejects.toThrow(
    'PDF_PUBLICATION_REQUIRES_RENDERED_VERIFICATION',
  )
})
it('distinguishes a visible workbook from a declined foreground request', async () => {
  session = await WorkspaceSession.open(
    root,
    'unused.ps1',
    async () => '',
    async () => {
      throw new Error('ARTIFACT_WINDOW_NOT_FOREGROUND')
    },
  )
  const worker = session as unknown as {
    worker(
      value: { operation: string; path: string },
      signal: AbortSignal,
    ): Promise<Record<string, unknown>>
  }
  vi.spyOn(worker, 'worker').mockImplementation(async (value) => {
    if (value.operation === 'show_workbook')
      return { ok: true, opened: true, visible: true, window_id: '12', process_id: 14 }
    await writeFile(value.path, 'workbook')
    return { ok: true, verified: true }
  })
  await call('write_workbook', workbook())
  expect(await call('open', { path: 'result.xlsx' })).toMatchObject({
    opened: true,
    visible: true,
    foreground: false,
  })
})
it('rejects archives inside their own source and executable text outputs', async () => {
  await expect(call('create_zip', { source: '.', path: 'backup.zip' })).rejects.toThrow(
    'ARCHIVE_MUST_BE_OUTSIDE_SOURCE',
  )
  await expect(call('write_text', { path: 'run.cmd', text: 'anything' })).rejects.toThrow(
    'TEXT_OUTPUT_EXTENSION_UNSUPPORTED',
  )
})
it('creates and reads back a ZIP including emoji and empty directories without a PowerShell worker', async () => {
  await call('make_directory', { path: '整理/空目录' })
  await call('write_text', { path: '整理/照片🌤️.txt', text: '中文归档内容' })
  const result = await call('create_zip', { source: '整理', path: '备份.zip' })
  expect(result).toMatchObject({
    verified: true,
    entries: 2,
    channel: 'host_filesystem',
    committed: true,
  })
  expect(await session.verify(String(result.artifact_id), signal())).toMatchObject({
    verified: true,
  })
}, 15000)

it.runIf(process.platform === 'win32' && process.env.COLOOP_OFFICE_REAL === '1')(
  'writes, reopens and exports a real WPS document while preserving its source',
  async () => {
    session = await WorkspaceSession.open(
      root,
      join(process.cwd(), 'resources/office-runtime.ps1'),
      async () => '',
    )
    const document = await call('write_document', {
      path: '报价.docx',
      blocks: [
        { type: 'paragraph', role: 'title', text: '测试报价 QUOTE-001' },
        {
          type: 'table',
          header: true,
          rows: [
            ['客户', '金额'],
            ['林悦', '438.50'],
          ],
        },
        { type: 'paragraph', text: '有效期 2026-11-30' },
      ],
    })
    expect(document).toMatchObject({
      committed: true,
      reopened: true,
      verified: true,
      channel: 'host_wps_com',
    })
    expect(await call('read_document', { path: '报价.docx', max_characters: 4 })).toMatchObject({
      text: '测试报价',
      truncated: true,
      next_character: 4,
    })
    const pdf = await call('export_pdf', { source: '报价.docx', path: '报价.pdf' })
    expect(pdf).toMatchObject({ committed: true, exported: true })
    expect(await session.verify(String(document.artifact_id), signal())).toMatchObject({
      verified: true,
    })
    expect((await readFile(join(root, '报价.pdf'))).subarray(0, 5).toString()).toBe('%PDF-')
  },
  30000,
)

it.runIf(process.platform === 'win32' && process.env.COLOOP_OFFICE_REAL === '1')(
  'keeps monetary formats and computed values in an actual exported WPS workbook',
  async () => {
    session = await WorkspaceSession.open(
      root,
      join(process.cwd(), 'resources/office-runtime.ps1'),
      async () => '',
    )
    const result = await call('write_workbook', {
      path: '报价.xlsx',
      sheets: [
        {
          name: '报价',
          rows: [
            ['QUOTE-001'],
            ['客户', '林悦'],
            ['商品原价', { formula: '=387+78' }],
            ['应付', { formula: '=ROUND(B3*0.9+20,2)' }],
            ['有效期', '2026-11-30'],
            ['文本编号', '00129'],
          ],
          formats: [{ range: 'B3:B4', format: 'money' }],
        },
      ],
    })
    expect(result).toMatchObject({ committed: true, reopened: true, verified: true })
    expect(await call('read_workbook', { path: '报价.xlsx' })).toMatchObject({
      sheets: [
        {
          rows: [
            ['QUOTE-001', null],
            ['客户', '林悦'],
            ['商品原价', 465],
            ['应付', 438.5],
            ['有效期', '2026-11-30'],
            ['文本编号', '00129'],
          ],
        },
      ],
    })
    expect(await call('export_pdf', { source: '报价.xlsx', path: '报价.pdf' })).toMatchObject({
      committed: true,
      exported: true,
    })
  },
  30000,
)

it('compares copied artifacts against the authorized source bytes and rejects a rewritten lookalike', async () => {
  const source = '本地私人便笺\r\nCANARY_PRIVATE_4827\r\n'
  await writeFile(join(root, 'source.txt'), source)
  const rewritten = await call('write_text', {
    path: 'wrong.txt',
    text: source.replace('_PRIVATE', ''),
  })
  expect(await session.verify(String(rewritten.artifact_id), signal(), 'source.txt')).toMatchObject(
    { verified: false, source_matches: false },
  )
  const copied = await call('copy_file', { source: 'source.txt', path: 'exact.txt' })
  expect(await session.verify(String(copied.artifact_id), signal(), 'source.txt')).toMatchObject({
    verified: true,
    source_matches: true,
    source_sha256: copied.source_sha256,
  })
  expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe(source)
  await expect(
    session.verify(String(copied.artifact_id), signal(), '../private.txt'),
  ).rejects.toThrow()
})
