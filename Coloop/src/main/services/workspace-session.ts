import { constants, createReadStream } from 'node:fs'
import {
  copyFile,
  link,
  mkdir,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { parseCsv } from '../domain/csv'
import { runJsonWorker } from '../infrastructure/json-worker'
import { setTimeout as delay } from 'node:timers/promises'
import type { Readable } from 'node:stream'
import { basename, extname } from 'node:path'

const filePath = z.string().trim().min(1).max(2048)
const documentText = z
  .string()
  .max(16000)
  .regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f]*$/)
const documentBlock = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('paragraph'),
      text: documentText,
      role: z.enum(['title', 'heading', 'body']).default('body'),
    })
    .strict(),
  z
    .object({
      type: z.literal('table'),
      rows: z
        .array(z.array(documentText).min(1).max(12))
        .min(1)
        .max(100)
        .refine(
          (rows) => rows.every((row) => row.length === rows[0].length),
          'Table rows must have equal column counts',
        ),
      header: z.boolean().default(true),
    })
    .strict(),
])
const cell = z.union([
  z.string().max(32000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z
    .object({
      formula: z
        .string()
        .min(2)
        .max(2000)
        .regex(/^=[^\[\]|\r\n]+$/)
        .refine(
          (formula) =>
            [...formula.matchAll(/([a-z_][a-z0-9_.]*)\s*\(/gi)].every((match) =>
              /^(SUM|SUMIF|SUMIFS|COUNT|COUNTA|COUNTIF|COUNTIFS|AVERAGE|MIN|MAX|ROUND|IF|IFS|IFERROR|ABS|AND|OR|NOT|SUBTOTAL|SUMPRODUCT|XLOOKUP|VLOOKUP|INDEX|MATCH|ISBLANK|ISNUMBER|ISTEXT|VALUE|TEXT|DATE|YEAR|MONTH|DAY)$/i.test(
                match[1],
              ),
            ),
          'Formula function is not supported by this file capability',
        ),
    })
    .strict(),
])
const sheet = z
  .object({
    name: z
      .string()
      .min(1)
      .max(31)
      .regex(/^[^\[\]:*?/\\]+$/),
    rows: z.array(z.array(cell).max(256)).min(1).max(5000),
    formats: z
      .array(
        z
          .object({
            range: z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,5}(?::[A-Z]{1,3}[1-9]\d{0,5})?$/),
            format: z.enum(['money', 'integer', 'percent', 'text']),
          })
          .strict(),
      )
      .max(64)
      .default([]),
  })
  .strict()
const operations = [
  z
    .object({
      operation: z.literal('read_structured'),
      path: filePath,
      start_block: z.number().int().nonnegative().default(0),
      max_blocks: z.number().int().min(1).max(40).default(20),
      max_characters: z.number().int().min(2000).max(16000).default(8000),
    })
    .strict(),
  z
    .object({
      operation: z.literal('write_document'),
      path: filePath,
      blocks: z.array(documentBlock).min(1).max(100),
    })
    .strict(),
  z
    .object({
      operation: z.literal('read_document'),
      path: filePath,
      start_character: z.number().int().nonnegative().default(0),
      max_characters: z.number().int().min(1).max(4000).default(2000),
    })
    .strict(),
  z.object({ operation: z.literal('export_pdf'), source: filePath, path: filePath }).strict(),
  z.object({ operation: z.literal('wait_file'), path: filePath }).strict(),
  z
    .object({
      operation: z.literal('read_csv'),
      path: filePath,
      encoding: z.enum(['utf-8', 'utf-16le', 'gb18030']).default('utf-8'),
      delimiter: z.enum([',', ';', '\t']).default(','),
      start_record: z.number().int().min(1).default(1),
      max_records: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  z
    .object({
      operation: z.literal('read_pdf'),
      path: filePath,
      start_page: z.number().int().min(1).default(1),
      max_pages: z.number().int().min(1).max(20).default(10),
    })
    .strict(),
  z
    .object({
      operation: z.literal('verify_pdf'),
      path: filePath,
      expected_texts: z.array(z.string().trim().min(1).max(500)).min(1).max(32),
    })
    .strict(),
  z.object({ operation: z.literal('read_image'), path: filePath }).strict(),
  z.object({ operation: z.literal('copy_file'), source: filePath, path: filePath }).strict(),
  z.object({ operation: z.literal('make_directory'), path: filePath }).strict(),
  z
    .object({ operation: z.literal('write_text'), path: filePath, text: z.string().max(128000) })
    .strict(),
  z.object({ operation: z.literal('create_zip'), source: filePath, path: filePath }).strict(),
  z
    .object({ operation: z.literal('list'), path: filePath, recursive: z.boolean().default(false) })
    .strict(),
  z
    .object({
      operation: z.literal('read_text'),
      path: filePath,
      encoding: z.enum(['utf-8', 'utf-16le', 'gb18030']).default('utf-8'),
      start_character: z.number().int().nonnegative().default(0),
      max_characters: z.number().int().min(1).max(4000).default(2000),
    })
    .strict(),
  z
    .object({
      operation: z.literal('read_workbook'),
      path: filePath,
      max_rows: z.number().int().min(1).max(5000).default(1000),
    })
    .strict(),
  z
    .object({
      operation: z.literal('write_workbook'),
      path: filePath,
      template: filePath.or(z.literal('')).optional(),
      sheets: z.array(sheet).min(1).max(32),
      charts: z
        .array(
          z
            .object({
              sheet: z.string().min(1).max(31),
              source_sheet: z.string().min(1).max(31),
              range: z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,5}:[A-Z]{1,3}[1-9]\d{0,5}$/),
              title: z.string().max(200),
              type: z.literal('column'),
            })
            .strict(),
        )
        .max(32)
        .default([]),
    })
    .strict(),
] as const
const requestSchema = z.discriminatedUnion('operation', operations)
export const workspaceToolSchema = z
  .object({
    operation: z.enum([
      'help',
      'read_structured',
      'write_document',
      'read_document',
      'export_pdf',
      'wait_file',
      'read_pdf',
      'verify_pdf',
      'read_image',
      'list',
      'read_text',
      'read_csv',
      'read_workbook',
      'write_workbook',
      'copy_file',
      'make_directory',
      'write_text',
      'create_zip',
      'open',
    ]),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict()
export const workspaceOperationNames = Object.freeze([
  ...operations.map((operation) => operation.shape.operation.value),
  'open',
])

export function workspaceOperationParameters(operation: string) {
  if (operation === 'open') return z.object({ path: filePath }).strict()
  const schema = operations.find((item) => item.shape.operation.value === operation)
  if (!schema) throw new Error('WORKSPACE_OPERATION_UNSUPPORTED')
  const { operation: _operation, ...shape } = schema.shape
  return z.object(operation === 'list' ? { ...shape, path: filePath.default('.') } : shape).strict()
}

type Artifact = { path: string; sha256: string }
export type StructuredDocumentReader = (
  path: string,
  options: { start_block: number; max_blocks: number; max_characters: number },
  signal: AbortSignal,
) => Promise<Record<string, unknown>>

/** A task-scoped directory capability. Model arguments cannot choose its root,
 * execute code, overwrite a different file, or inspect another task's artifacts. */
export class WorkspaceSession {
  private artifacts = new Map<string, Artifact>()
  private generatedPdfs = new Set<string>()
  private reviewedPdfs = new Set<string>()
  private pdfReadbacks = new Map<
    string,
    { sha256: string; count: number; pages: Map<number, string> }
  >()
  checkpointArtifacts() {
    return [...this.artifacts].map(([id, artifact]) => ({ id, ...artifact }))
  }
  async restoreArtifacts(
    artifacts: { id: string; path: string; sha256: string }[],
    signal: AbortSignal,
  ) {
    for (const artifact of artifacts) {
      z.string().uuid().parse(artifact.id)
      const path = await this.path(artifact.path)
      if ((await this.hash(path, signal)) !== artifact.sha256)
        throw new Error('RECOVERY_ARTIFACT_CHANGED')
      this.artifacts.set(artifact.id, { path, sha256: artifact.sha256 })
      if (/\.pdf$/i.test(path)) this.generatedPdfs.add(artifact.sha256)
    }
  }
  private constructor(
    readonly root: string,
    private script: string,
    private openPath: (path: string) => Promise<string>,
    private focusWindow?: (windowId: string, processId: number) => Promise<void>,
    private recognize?: (
      bytes: Buffer,
      signal: AbortSignal,
    ) => Promise<{ text: string; confidence: number; items: unknown[] }>,
    private readStructured?: StructuredDocumentReader,
  ) {}

  static async open(
    root: string,
    script: string,
    openPath: (path: string) => Promise<string>,
    focusWindow?: (windowId: string, processId: number) => Promise<void>,
    recognize?: (
      bytes: Buffer,
      signal: AbortSignal,
    ) => Promise<{ text: string; confidence: number; items: unknown[] }>,
    readStructured?: StructuredDocumentReader,
  ) {
    if (!isAbsolute(root)) throw new Error('WORKSPACE_MUST_BE_ABSOLUTE')
    const canonical = await realpath(root)
    if (!(await stat(canonical)).isDirectory()) throw new Error('WORKSPACE_NOT_DIRECTORY')
    return new WorkspaceSession(canonical, script, openPath, focusWindow, recognize, readStructured)
  }
  private inside(path: string) {
    const part = relative(this.root, path)
    return (
      part === '' ||
      (!isAbsolute(part) && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../'))
    )
  }
  private async path(value: string) {
    const absolute = resolve(this.root, value)
    if (!this.inside(absolute)) throw new Error('PATH_OUTSIDE_TASK_WORKSPACE')
    let ancestor = absolute
    while (true) {
      try {
        const canonical = resolve(await realpath(ancestor), relative(ancestor, absolute))
        if (!this.inside(canonical)) throw new Error('PATH_OUTSIDE_TASK_WORKSPACE')
        return canonical
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const parent = dirname(ancestor)
        if (parent === ancestor) throw error
        ancestor = parent
      }
    }
  }
  private async hash(path: string, signal: AbortSignal) {
    const hash = createHash('sha256')
    const stream = createReadStream(path, { signal })
    let bytes = 0
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > 100 * 1024 * 1024) throw new Error('ARTIFACT_EXCEEDS_100_MB')
      hash.update(chunk)
    }
    return hash.digest('hex')
  }
  private async officeCopy(
    source: string,
    signal: AbortSignal,
    extension: 'xlsx' | 'docx' = 'xlsx',
  ) {
    if (!source.toLowerCase().endsWith(`.${extension}`))
      throw new Error(`SOURCE_MUST_BE_${extension.toUpperCase()}`)
    const destination = join(this.root, `.coloop-source-${randomUUID()}.${extension}`)
    try {
      signal.throwIfAborted()
      await copyFile(source, destination, constants.COPYFILE_EXCL)
      if ((await this.hash(source, signal)) !== (await this.hash(destination, signal)))
        throw new Error('WORKBOOK_SOURCE_CHANGED_DURING_COPY')
      return destination
    } catch (error) {
      await rm(destination, { force: true }).catch(() => {})
      throw error
    }
  }
  private async list(path: string, recursive: boolean, signal: AbortSignal) {
    const entries: { path: string; type: string; bytes?: number; sha256?: string }[] = []
    const walk = async (folder: string) => {
      const children = await readdir(folder, { withFileTypes: true })
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        signal.throwIfAborted()
        if (entries.length >= 500) throw new Error('DIRECTORY_EXCEEDS_500_ENTRIES')
        const full = await this.path(join(folder, child.name))
        if (child.isDirectory()) {
          entries.push({ path: relative(this.root, full), type: 'directory' })
          if (recursive) await walk(full)
        } else if (child.isFile()) {
          entries.push({
            path: relative(this.root, full),
            type: 'file',
            bytes: (await stat(full)).size,
            sha256: await this.hash(full, signal),
          })
        } else entries.push({ path: relative(this.root, full), type: 'link_or_special' })
      }
    }
    await walk(path)
    return { entries }
  }
  private worker(value: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const operation = (value as { operation: string }).operation
    const independent = ['create_zip', 'render_pdf'].includes(operation)
    const script =
      operation === 'create_zip'
        ? join(dirname(this.script), 'file-runtime.ps1')
        : operation === 'render_pdf'
          ? join(dirname(this.script), 'pdf-runtime.ps1')
          : ['write_document', 'read_document', 'export_document_pdf', 'show_document'].includes(
                operation,
              )
            ? join(dirname(this.script), 'document-runtime.ps1')
            : this.script
    // COM work drains before cancellation is acknowledged so owned books close.
    return runJsonWorker(script, value, {
      signal,
      drainOnAbort: !independent,
      errorPrefix: 'OFFICE',
    })
  }
  private textPage(text: string, start: number, maximum: number) {
    const characters = Array.from(text)
    if (start > characters.length) throw new Error('TEXT_OFFSET_OUT_OF_RANGE')
    const end = Math.min(characters.length, start + maximum)
    return {
      text: characters.slice(start, end).join(''),
      range: [start, end],
      character_count: characters.length,
      truncated: end < characters.length,
      next_character: end < characters.length ? end : undefined,
    }
  }
  private async commit(
    staged: string,
    path: string,
    result: Record<string, unknown>,
    channel: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted()
    const sha256 = await this.hash(staged, signal)
    signal.throwIfAborted()
    try {
      await link(staged, path)
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await this.hash(path, signal)) !== sha256
      )
        throw new Error('OUTPUT_ALREADY_EXISTS_OR_COMMIT_FAILED')
    }
    const id = randomUUID()
    this.artifacts.set(id, { path, sha256 })
    return { ...result, artifact_id: id, path, sha256, committed: true, channel }
  }
  async attachment(value: string, signal: AbortSignal) {
    const path = await this.path(filePath.parse(value))
    if (!/\.(txt|csv|tsv|md|json|xlsx|docx|zip|pdf|jpe?g|png)$/i.test(path))
      throw new Error('ATTACHMENT_EXTENSION_UNSUPPORTED')
    if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error('ATTACHMENT_EXCEEDS_32_MB')
    signal.throwIfAborted()
    const buffer = await readFile(path)
    if (buffer.length > 32 * 1024 * 1024) throw new Error('ATTACHMENT_EXCEEDS_32_MB')
    signal.throwIfAborted()
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const artifacts = [...this.artifacts.values()].filter((artifact) => artifact.path === path)
    if (artifacts.length && !artifacts.some((artifact) => artifact.sha256 === sha256))
      throw new Error('ATTACHMENT_ARTIFACT_CHANGED')
    if (this.generatedPdfs.has(sha256) && !this.reviewedPdfs.has(sha256))
      throw new Error('PDF_PUBLICATION_REQUIRES_RENDERED_VERIFICATION')
    return {
      name: basename(path),
      mimeType: 'application/octet-stream',
      buffer,
      sha256,
    }
  }
  async receiveFile(value: string, stream: Readable, signal: AbortSignal) {
    const path = await this.path(filePath.parse(value))
    if (!/\.(txt|csv|tsv|md|json|xlsx|docx|zip|pdf|jpe?g|png)$/i.test(path))
      throw new Error('DOWNLOAD_EXTENSION_UNSUPPORTED')
    await mkdir(dirname(path), { recursive: true })
    const staged = join(dirname(path), `.coloop-download-${randomUUID()}${extname(path)}`)
    const stop = () => {
      stream.destroy(new Error('DOWNLOAD_ABORTED'))
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      signal.throwIfAborted()
      const file = await openFile(staged, 'wx')
      try {
        let length = 0
        for await (const chunk of stream) {
          signal.throwIfAborted()
          length += chunk.length
          if (length > 32 * 1024 * 1024) throw new Error('DOWNLOAD_EXCEEDS_32_MB')
          await file.writeFile(chunk)
        }
        await file.sync()
      } finally {
        await file.close()
      }
      return await this.commit(staged, path, { downloaded: true }, 'host_browser', signal)
    } finally {
      signal.removeEventListener('abort', stop)
      stream.destroy()
      await rm(staged, { force: true }).catch(() => {})
    }
  }
  async call(input: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    if (Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024)
      throw new Error('WORKSPACE_REQUEST_TOO_LARGE')
    const value = workspaceToolSchema.parse(input)
    if (value.operation === 'help') {
      const subject = String(value.arguments.subject ?? 'write_workbook')
      const schema = operations.find((operation) => operation.shape.operation.value === subject)
      if (!schema) throw new Error('WORKSPACE_HELP_SUBJECT_UNKNOWN')
      return {
        root: this.root,
        contract: z.toJSONSchema(schema, { target: 'draft-7' }),
        note: 'Paths are relative to root or absolute within it. Existing different outputs are preserved. Formula cells use {formula:"=SUM(...)"}.',
      }
    }
    if (value.operation === 'open') {
      const path = await this.path(filePath.parse(value.arguments.path))
      const directory = await stat(path)
        .then((info) => info.isDirectory())
        .catch(() => false)
      if (!directory && ![...this.artifacts.values()].some((artifact) => artifact.path === path))
        throw new Error('OPEN_REQUIRES_TASK_ARTIFACT')
      if (!directory && !/\.(txt|csv|tsv|md|json|xlsx|docx|zip|pdf|jpe?g|png)$/i.test(path))
        throw new Error('ARTIFACT_TYPE_CANNOT_BE_OPENED')
      signal.throwIfAborted()
      if (/\.(xlsx|docx)$/i.test(path)) {
        const result = await this.worker(
          { operation: /\.docx$/i.test(path) ? 'show_document' : 'show_workbook', path },
          signal,
        )
        if (result.opened !== true || result.visible !== true)
          throw new Error('ARTIFACT_OPEN_FAILED')
        signal.throwIfAborted()
        let foreground = false
        if (this.focusWindow) {
          try {
            await this.focusWindow(String(result.window_id), Number(result.process_id))
            foreground = true
          } catch {
            signal.throwIfAborted()
          }
        }
        return { ...result, path, foreground }
      }
      const error = await this.openPath(path)
      if (error) throw new Error('ARTIFACT_OPEN_FAILED')
      return { opened: true, path }
    }
    const request = requestSchema.parse({ ...value.arguments, operation: value.operation })
    const path = await this.path(request.path)
    if (request.operation === 'read_structured') {
      if (!this.readStructured) throw new Error('DOCLING_NOT_CONFIGURED')
      if (!/\.(pdf|docx)$/i.test(path)) throw new Error('STRUCTURED_DOCUMENT_TYPE_UNSUPPORTED')
      const sha256 = await this.hash(path, signal)
      const result = await this.readStructured(
        path,
        {
          start_block: request.start_block,
          max_blocks: request.max_blocks,
          max_characters: request.max_characters,
        },
        signal,
      )
      signal.throwIfAborted()
      if (result.source_sha256 !== sha256 || (await this.hash(path, signal)) !== sha256)
        throw new Error('DOCUMENT_SOURCE_CHANGED')
      return { ...result, path, sha256 }
    }
    if (request.operation === 'read_document') {
      const copy = await this.officeCopy(path, signal, 'docx')
      try {
        const result = await this.worker({ operation: 'read_document', source: copy }, signal)
        return {
          ...result,
          ...this.textPage(
            z.string().parse(result.text),
            request.start_character,
            request.max_characters,
          ),
          path,
          sha256: await this.hash(copy, signal),
        }
      } finally {
        await rm(copy, { force: true }).catch(() => {})
      }
    }
    if (request.operation === 'write_document' || request.operation === 'export_pdf') {
      const extension = request.operation === 'write_document' ? 'docx' : 'pdf'
      if (!path.toLowerCase().endsWith(`.${extension}`))
        throw new Error('DOCUMENT_OUTPUT_EXTENSION_INVALID')
      const staged = join(dirname(path), `.coloop-${randomUUID()}.${extension}`)
      let source: string | undefined
      try {
        await mkdir(dirname(path), { recursive: true })
        let result: Record<string, unknown>
        if (request.operation === 'write_document') {
          const characters = request.blocks.reduce(
            (sum, block) =>
              sum +
              (block.type === 'paragraph'
                ? block.text.length
                : block.rows.flat().reduce((n, text) => n + text.length, 0)),
            0,
          )
          if (characters > 100000) throw new Error('DOCUMENT_EXCEEDS_100000_CHARACTERS')
          result = await this.worker({ ...request, path: staged }, signal)
        } else {
          const original = await this.path(request.source)
          if (!/\.(xlsx|docx)$/i.test(original)) throw new Error('PDF_SOURCE_MUST_BE_DOCX_OR_XLSX')
          const document = /\.docx$/i.test(original)
          source = await this.officeCopy(original, signal, document ? 'docx' : 'xlsx')
          result = await this.worker(
            {
              operation: document ? 'export_document_pdf' : 'export_workbook_pdf',
              source,
              path: staged,
            },
            signal,
          )
          const file = await openFile(staged, 'r')
          try {
            const header = Buffer.alloc(5)
            await file.read(header, 0, 5, 0)
            if (header.toString('ascii') !== '%PDF-') throw new Error('PDF_OUTPUT_INVALID')
          } finally {
            await file.close()
          }
        }
        const { text, source_text, ...metadata } = result
        const body = text ?? source_text
        const artifact = await this.commit(
          staged,
          path,
          {
            ...metadata,
            ...(typeof body === 'string'
              ? request.operation === 'export_pdf'
                ? { source_character_count: Array.from(body).length }
                : { character_count: Array.from(body).length }
              : {}),
          },
          'host_wps_com',
          signal,
        )
        if (request.operation === 'export_pdf') this.generatedPdfs.add(String(artifact.sha256))
        return { ...artifact, requires_pdf_review: request.operation === 'export_pdf' }
      } finally {
        await rm(staged, { force: true }).catch(() => {})
        if (source) await rm(source, { force: true }).catch(() => {})
      }
    }
    if (request.operation === 'wait_file') {
      while (true) {
        signal.throwIfAborted()
        const candidate = await this.path(request.path)
        try {
          const file = await openFile(candidate, 'r')
          try {
            const info = await file.stat()
            if (!info.isFile()) throw new Error('WAIT_TARGET_MUST_BE_FILE')
            signal.throwIfAborted()
            return { ready: true, path: candidate, bytes: info.size }
          } finally {
            await file.close()
          }
        } catch (error) {
          if (
            !['ENOENT', 'EBUSY', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))
          )
            throw error
        }
        await delay(1000, undefined, { signal })
      }
    }
    if (request.operation === 'read_pdf' || request.operation === 'read_image') {
      if (!this.recognize) throw new Error('WORKSPACE_OCR_UNAVAILABLE')
      if ((await stat(path)).size > 30 * 1024 * 1024) throw new Error('DOCUMENT_EXCEEDS_30_MB')
      const sourceHash = await this.hash(path, signal)
      if (request.operation === 'read_image') {
        if (!/\.(png|jpe?g|bmp)$/i.test(path)) throw new Error('IMAGE_TYPE_UNSUPPORTED')
        const result = await this.recognize(await readFile(path), signal)
        if ((await this.hash(path, signal)) !== sourceHash)
          throw new Error('DOCUMENT_SOURCE_CHANGED')
        return {
          path,
          sha256: sourceHash,
          text: result.text,
          confidence: result.confidence,
          source: 'local_rapidocr',
        }
      }
      if (!/\.pdf$/i.test(path)) throw new Error('DOCUMENT_MUST_BE_PDF')
      const pages = []
      let count = request.start_page
      const end = request.start_page + request.max_pages - 1
      for (let page = request.start_page; page <= Math.min(count, end); page++) {
        const image = await this.worker({ operation: 'render_pdf', path, page }, signal)
        count = z.number().int().positive().parse(image.page_count)
        const result = await this.recognize(
          Buffer.from(z.string().parse(image.image), 'base64'),
          signal,
        )
        pages.push({ page, text: result.text, confidence: result.confidence })
      }
      if ((await this.hash(path, signal)) !== sourceHash) throw new Error('DOCUMENT_SOURCE_CHANGED')
      const previous = this.pdfReadbacks.get(path)
      const readback =
        previous?.sha256 === sourceHash
          ? previous
          : { sha256: sourceHash, count, pages: new Map<number, string>() }
      for (const page of pages) readback.pages.set(page.page, page.text)
      this.pdfReadbacks.set(path, readback)
      return {
        path,
        sha256: sourceHash,
        pages,
        page_count: count,
        truncated: count > end,
        next_page: count > end ? end + 1 : undefined,
        source: 'windows_pdf_local_rapidocr',
      }
    }
    if (request.operation === 'verify_pdf') {
      const sha256 = await this.hash(path, signal)
      const readback = this.pdfReadbacks.get(path)
      if (!readback || readback.sha256 !== sha256 || readback.pages.size !== readback.count)
        throw new Error('PDF_READ_ALL_PAGES_FIRST')
      const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/gu, '')
      const text = normalize(
        [...readback.pages]
          .sort(([a], [b]) => a - b)
          .map(([, text]) => text)
          .join('\n'),
      )
      if (!request.expected_texts.every((expected) => text.includes(normalize(expected))))
        throw new Error('PDF_EXPECTED_TEXT_NOT_FOUND')
      this.reviewedPdfs.add(sha256)
      return {
        verified: true,
        path,
        sha256,
        page_count: readback.count,
        source: 'rendered_pdf_local_ocr',
        checked_texts: request.expected_texts,
      }
    }
    if (request.operation === 'make_directory') {
      await mkdir(path, { recursive: true })
      return { created: true, path, channel: 'host_filesystem' }
    }
    if (request.operation === 'list') return this.list(path, request.recursive, signal)
    if (['copy_file', 'write_text', 'create_zip'].includes(request.operation)) {
      if (request.operation === 'write_text' && !/\.(txt|csv|tsv|md|json)$/i.test(path))
        throw new Error('TEXT_OUTPUT_EXTENSION_UNSUPPORTED')
      await mkdir(dirname(path), { recursive: true })
      const staged = join(dirname(path), `.coloop-${randomUUID()}.tmp`)
      try {
        let result: Record<string, unknown> = {}
        if (request.operation === 'copy_file') {
          const source = await this.path(request.source)
          const sourceHash = await this.hash(source, signal)
          await copyFile(source, staged, constants.COPYFILE_EXCL)
          if (
            (await this.hash(source, signal)) !== sourceHash ||
            (await this.hash(staged, signal)) !== sourceHash
          )
            throw new Error('COPY_SOURCE_CHANGED')
          result = { source, source_sha256: sourceHash }
        } else if (request.operation === 'write_text') {
          await writeFile(staged, request.text, { encoding: 'utf8', flag: 'wx', signal })
        } else if (request.operation === 'create_zip') {
          if (!/\.zip$/i.test(path)) throw new Error('ARCHIVE_OUTPUT_MUST_BE_ZIP')
          const source = await this.path(request.source)
          const part = relative(source, path)
          if (
            part === '' ||
            (!isAbsolute(part) &&
              part !== '..' &&
              !part.startsWith('..\\') &&
              !part.startsWith('../'))
          )
            throw new Error('ARCHIVE_MUST_BE_OUTSIDE_SOURCE')
          const { entries } = await this.list(source, true, signal)
          if (entries.some((entry) => entry.type === 'link_or_special'))
            throw new Error('ARCHIVE_LINKS_UNSUPPORTED')
          const manifest = await Promise.all(
            entries.map(async (entry) => {
              const full = await this.path(entry.path)
              return { ...entry, path: full, name: relative(source, full).replace(/\\/g, '/') }
            }),
          )
          result = await this.worker(
            { operation: 'create_zip', path: staged, entries: manifest },
            signal,
          )
        }
        return await this.commit(staged, path, result, 'host_filesystem', signal)
      } finally {
        await rm(staged, { force: true }).catch(() => {})
      }
    }
    if (request.operation === 'read_text' || request.operation === 'read_csv') {
      if ((await stat(path)).size > 128 * 1024) throw new Error('TEXT_EXCEEDS_128_KB')
      const bytes = await readFile(path)
      signal.throwIfAborted()
      const source = {
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        text: new TextDecoder(request.encoding, { fatal: true }).decode(bytes),
      }
      if (request.operation === 'read_text') {
        return {
          ...source,
          ...this.textPage(source.text, request.start_character, request.max_characters),
        }
      }
      const [header, ...data] = parseCsv(source.text, request.delimiter)
      const records = []
      let size = 0
      for (
        let index = request.start_record - 1;
        index < Math.min(data.length, request.start_record - 1 + request.max_records);
        index++
      ) {
        const item = { record: index + 1, ...data[index] }
        size += Buffer.byteLength(JSON.stringify(item))
        if (size > 8000) {
          if (!records.length) throw new Error('CSV_RECORD_EXCEEDS_CONTEXT_LIMIT')
          break
        }
        records.push(item)
      }
      const next = request.start_record + records.length
      return {
        path,
        sha256: source.sha256,
        columns: header?.cells ?? [],
        records,
        record_count: data.length,
        range: [request.start_record, next],
        truncated: next <= data.length,
        next_record: next <= data.length ? next : undefined,
      }
    }
    if (request.operation === 'read_workbook') {
      const copy = await this.officeCopy(path, signal)
      try {
        return {
          ...(await this.worker({ ...request, path: copy }, signal)),
          path,
          sha256: await this.hash(copy, signal),
        }
      } finally {
        await rm(copy, { force: true }).catch(() => {})
      }
    }
    if (request.operation !== 'write_workbook') throw new Error('WORKSPACE_OPERATION_UNSUPPORTED')
    if (
      new Set(request.sheets.map((sheet) => sheet.name.toLowerCase())).size !==
      request.sheets.length
    )
      throw new Error('DUPLICATE_WORKSHEET_NAME')
    if (
      request.sheets.reduce(
        (sum, sheet) => sum + sheet.rows.reduce((n, row) => n + row.length, 0),
        0,
      ) > 100000
    )
      throw new Error('WORKBOOK_EXCEEDS_100000_CELLS')
    if (!/\.xlsx$/i.test(path)) throw new Error('OUTPUT_MUST_BE_XLSX')
    const template = request.template
      ? await this.officeCopy(await this.path(request.template), signal)
      : undefined
    const staged = join(dirname(path), `.coloop-${randomUUID()}.xlsx`)
    try {
      await mkdir(dirname(path), { recursive: true })
      const result = await this.worker({ ...request, path: staged, template }, signal)
      return await this.commit(staged, path, result, 'host_wps_com', signal)
    } finally {
      await rm(staged, { force: true }).catch(() => {})
      if (template) await rm(template, { force: true }).catch(() => {})
    }
  }
  async verify(id: string, signal: AbortSignal, sourcePath?: string) {
    const artifact = this.artifacts.get(id)
    if (!artifact) throw new Error('ARTIFACT_REFERENCE_INVALID')
    const path = await this.path(artifact.path)
    const digest = await this.hash(path, signal)
    const source = sourcePath ? await this.path(filePath.parse(sourcePath)) : undefined
    const sourceDigest = source ? await this.hash(source, signal) : undefined
    return {
      verified:
        digest === artifact.sha256 && (sourceDigest === undefined || digest === sourceDigest),
      ...(source
        ? {
            source_path: source,
            source_sha256: sourceDigest,
            source_matches: digest === sourceDigest,
          }
        : {}),
      artifact_id: id,
      path,
      sha256: digest,
      source: 'independent_file_readback',
    }
  }
  invalidateReviews() {
    this.reviewedPdfs.clear()
  }
}
