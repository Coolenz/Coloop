import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceSession } from '../src/main/services/workspace-session'
import { DoclingService, type DoclingResult } from '../src/main/infrastructure/docling'

const directories: string[] = []
const signal = () => new AbortController().signal
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'coloop-workspace-migration-'))
  directories.push(path)
  return path
}
function result(digest: string): DoclingResult {
  return {
    ok: true,
    source_sha256: digest,
    parser_version: 'test-parser',
    document_id: 'a'.repeat(64),
    blocks: [],
    block_count: 0,
    truncated: false,
    next_block: null,
    cache_hit: false,
    channel: 'host_docling',
  }
}

it('passes only authorized canonical document paths to the structured reader', async () => {
  const root = await directory()
  const outside = await directory()
  await writeFile(join(root, 'source.pdf'), 'source')
  await writeFile(join(outside, 'secret.pdf'), 'outside')
  await symlink(outside, join(root, 'linked'), 'junction')
  const reader = vi.fn(async () => result(hash('source')))
  const session = await WorkspaceSession.open(
    root,
    'unused',
    async () => '',
    undefined,
    undefined,
    reader,
  )
  const received = await session.call(
    { operation: 'read_structured', arguments: { path: 'source.pdf' } },
    signal(),
  )
  expect(received).toMatchObject({ source_sha256: hash('source'), sha256: hash('source') })
  expect(reader.mock.calls.length).toBe(1)
  expect(reader).toHaveBeenCalledWith(
    join(root, 'source.pdf'),
    expect.objectContaining({ start_block: 0 }),
    expect.anything(),
  )
  await expect(
    session.call(
      { operation: 'read_structured', arguments: { path: join(outside, 'secret.pdf') } },
      signal(),
    ),
  ).rejects.toThrow('PATH_OUTSIDE_TASK_WORKSPACE')
  await expect(
    session.call(
      { operation: 'read_structured', arguments: { path: 'linked/secret.pdf' } },
      signal(),
    ),
  ).rejects.toThrow('PATH_OUTSIDE_TASK_WORKSPACE')
  expect(reader.mock.calls.length).toBe(1)
})

it('rejects a source that changes during structured parsing', async () => {
  const root = await directory()
  const path = join(root, 'source.docx')
  await writeFile(path, 'original')
  const session = await WorkspaceSession.open(
    root,
    'unused',
    async () => '',
    undefined,
    undefined,
    async () => {
      await writeFile(path, 'changed')
      return result(hash('original'))
    },
  )
  await expect(
    session.call({ operation: 'read_structured', arguments: { path: 'source.docx' } }, signal()),
  ).rejects.toThrow('DOCUMENT_SOURCE_CHANGED')
})

it('restores exact artifact identities but requires a fresh rendered PDF publication review', async () => {
  const root = await directory()
  await writeFile(join(root, 'output.pdf'), 'pdf')
  const session = await WorkspaceSession.open(root, 'unused', async () => '')
  const artifact = { id: randomUUID(), path: join(root, 'output.pdf'), sha256: hash('pdf') }
  await session.restoreArtifacts([artifact], signal())
  expect(session.checkpointArtifacts()).toEqual([artifact])
  expect(await session.verify(artifact.id, signal())).toMatchObject({ verified: true })
  await expect(session.attachment('output.pdf', signal())).rejects.toThrow(
    'PDF_PUBLICATION_REQUIRES_RENDERED_VERIFICATION',
  )
})

it('rejects changed artifacts and paths outside the restored workspace', async () => {
  const root = await directory()
  const other = await directory()
  await writeFile(join(root, 'output.txt'), 'changed')
  await writeFile(join(other, 'output.txt'), 'original')
  const session = await WorkspaceSession.open(root, 'unused', async () => '')
  await expect(
    session.restoreArtifacts(
      [{ id: randomUUID(), path: 'output.txt', sha256: hash('original') }],
      signal(),
    ),
  ).rejects.toThrow('RECOVERY_ARTIFACT_CHANGED')
  await expect(
    session.restoreArtifacts(
      [{ id: randomUUID(), path: join(other, 'output.txt'), sha256: hash('original') }],
      signal(),
    ),
  ).rejects.toThrow('PATH_OUTSIDE_TASK_WORKSPACE')
  expect(session.checkpointArtifacts()).toEqual([])
})

it.runIf(process.env.COLOOP_DOCLING_REAL === '1')(
  'uses the portable interpreter and models through the real WorkspaceSession read_structured path',
  async () => {
    const root = await directory()
    const home = resolve(process.env.COLOOP_DOCLING_HOME || '.cache/docling-portable')
    const python = join(home, '.venv/Scripts/python.exe')
    const fixture = join(root, 'fixture.py')
    await writeFile(
      fixture,
      `from pathlib import Path
import sys
from docx import Document
from PIL import Image, ImageDraw, ImageFont
root=Path(sys.argv[1])
doc=Document()
doc.add_paragraph('中文订单 ORDER-381')
table=doc.add_table(rows=2, cols=2)
for row,values in zip(table.rows,[('商品','金额'),('支架','120.50')]):
    for cell,value in zip(row.cells,values): cell.text=value
doc.save(root/'sample.docx')
im=Image.new('RGB',(900,1100),'white')
draw=ImageDraw.Draw(im)
font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',36)
draw.text((80,100),'ORDER-381 total 120.50',font=font,fill='black')
im.save(root/'scan.pdf','PDF',resolution=100)
`,
      'utf8',
    )
    await promisify(execFile)(python, ['-I', '-X', 'utf8', fixture, root], {
      windowsHide: true,
      timeout: 60000,
    })
    const docling = new DoclingService({
      pythonPath: python,
      workerPath: resolve('resources/docling-worker.py'),
      cacheDirectory: join(root, 'private-cache'),
      modelDirectory: join(home, 'models'),
    })
    const session = await WorkspaceSession.open(
      root,
      'unused',
      async () => '',
      undefined,
      undefined,
      (path, options, abort) => docling.read(path, options, abort),
    )
    const document = (await session.call(
      { operation: 'read_structured', arguments: { path: 'sample.docx' } },
      signal(),
    )) as DoclingResult
    expect(document.blocks.map((block) => block.text).join(' ')).toContain('中文订单 ORDER-381')
    expect(document.blocks.filter((block) => block.table)).toHaveLength(4)
    const pdf = (await session.call(
      { operation: 'read_structured', arguments: { path: 'scan.pdf' } },
      signal(),
    )) as DoclingResult
    expect(pdf.blocks.map((block) => block.text).join(' ')).toContain('120.50')
    expect(pdf.blocks.some((block) => block.pages.includes(1))).toBe(true)
    const evidence = resolve('.cache/docling/portable-validation')
    await mkdir(evidence, { recursive: true })
    await writeFile(
      join(evidence, 'workspace-read-structured.json'),
      JSON.stringify(
        {
          interpreter: python,
          modelDirectory: join(home, 'models'),
          document,
          pdf,
          docxSourceSha256: createHash('sha256')
            .update(await readFile(join(root, 'sample.docx')))
            .digest('hex'),
          pdfSourceSha256: createHash('sha256')
            .update(await readFile(join(root, 'scan.pdf')))
            .digest('hex'),
        },
        null,
        2,
      ),
    )
  },
  180000,
)
