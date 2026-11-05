import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

export const doclingReadOptionsSchema = z
  .object({
    start_block: z.number().int().min(0).max(20000).default(0),
    max_blocks: z.number().int().min(1).max(40).default(20),
    max_characters: z.number().int().min(2000).max(16000).default(8000),
  })
  .strict()

const blockSchema = z.object({
  id: z.string().max(100),
  source_id: z.string().max(200),
  kind: z.string().max(100),
  text: z.string().max(4000),
  text_offset: z.number().int().nonnegative(),
  pages: z.array(z.number().int().positive()).max(200),
  provenance: z
    .array(
      z.object({
        page: z.number().int().positive(),
        bbox: z.object({ l: z.number(), t: z.number(), r: z.number(), b: z.number() }).optional(),
        coordinate_origin: z.string().max(100).optional(),
      }),
    )
    .max(200),
  table: z
    .object({
      id: z.string().max(200),
      rows: z.number().int().nonnegative(),
      columns: z.number().int().nonnegative(),
      row: z.number().int().nonnegative(),
      column: z.number().int().nonnegative(),
      row_span: z.number().int().positive(),
      column_span: z.number().int().positive(),
      column_header: z.boolean(),
      row_header: z.boolean(),
    })
    .optional(),
})
export const doclingResultSchema = z.object({
  ok: z.literal(true),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  parser_version: z.string().max(500),
  document_id: z.string().regex(/^[a-f0-9]{64}$/),
  block_count: z.number().int().min(0).max(20000),
  blocks: z.array(blockSchema).max(40),
  truncated: z.boolean(),
  next_block: z.number().int().nonnegative().nullable(),
  cache_hit: z.boolean(),
  channel: z.literal('host_docling'),
})
export type DoclingResult = z.infer<typeof doclingResultSchema>
export type DoclingReadOptions = z.input<typeof doclingReadOptionsSchema>

/** The caller must authorize and resolve the source inside its WorkspaceSession.
 * This service has no network/model credentials and never chooses a workspace. */
export class DoclingService {
  constructor(
    private readonly options: {
      pythonPath: string
      workerPath: string
      cacheDirectory: string
      modelDirectory: string
      timeoutMs?: number
    },
  ) {}

  async read(
    authorizedAbsolutePath: string,
    options: DoclingReadOptions,
    signal: AbortSignal,
  ): Promise<DoclingResult> {
    signal.throwIfAborted()
    if (!isAbsolute(authorizedAbsolutePath) || !/\.(pdf|docx)$/i.test(authorizedAbsolutePath))
      throw new Error('DOCLING_LOCAL_PDF_DOCX_REQUIRED')
    const range = doclingReadOptionsSchema.parse(options)
    const input =
      JSON.stringify({
        path: authorizedAbsolutePath,
        cache_directory: this.options.cacheDirectory,
        model_directory: this.options.modelDirectory,
        ...range,
      }) + '\n'
    if (Buffer.byteLength(input) > 16384) throw new Error('DOCLING_REQUEST_TOO_LARGE')
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.options.pythonPath,
        ['-I', '-X', 'utf8', '-u', this.options.workerPath],
        {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            PATH: process.env.PATH,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            USERPROFILE: process.env.USERPROFILE,
            LOCALAPPDATA: process.env.LOCALAPPDATA,
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
            HF_HUB_OFFLINE: '1',
            TRANSFORMERS_OFFLINE: '1',
            HF_HUB_DISABLE_TELEMETRY: '1',
          },
        },
      )
      let output = '',
        bytes = 0,
        failure: Error | undefined
      const stop = () => {
        failure = new DOMException('Operation stopped', 'AbortError')
        child.kill()
      }
      const timer = setTimeout(() => {
        failure = new Error('DOCLING_OPERATION_TIMEOUT')
        child.kill()
      }, this.options.timeoutMs ?? 180000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (part: string) => {
        bytes += Buffer.byteLength(part)
        if (bytes > 1024 * 1024) {
          failure = new Error('DOCLING_RESPONSE_TOO_LARGE')
          child.kill()
        } else output += part
      })
      child.stderr.on('data', () => {})
      child.stdin.on('error', () => {})
      child.on('error', () => {
        failure = new Error('DOCLING_RUNTIME_UNAVAILABLE')
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', stop)
        if (failure || signal.aborted)
          return reject(failure ?? new DOMException('Stopped', 'AbortError'))
        if (code !== 0) return reject(new Error('DOCLING_PROCESS_EXITED'))
        try {
          const result = JSON.parse(output)
          if (result.ok !== true)
            throw new Error(
              typeof result.error === 'string' && /^DOCLING_[A-Z_]+$/.test(result.error)
                ? result.error
                : 'DOCLING_OPERATION_FAILED',
            )
          const parsed = doclingResultSchema.parse(result)
          const next = range.start_block + parsed.blocks.length
          if (
            next > parsed.block_count ||
            parsed.blocks.length > range.max_blocks ||
            parsed.blocks.reduce((sum, block) => sum + Array.from(block.text).length, 0) >
              range.max_characters ||
            parsed.truncated !== next < parsed.block_count ||
            parsed.next_block !== (parsed.truncated ? next : null) ||
            (parsed.truncated && parsed.blocks.length === 0)
          )
            throw new Error('DOCLING_INVALID_CURSOR')
          resolve(parsed)
        } catch (error) {
          reject(error)
        }
      })
      signal.addEventListener('abort', stop, { once: true })
      if (signal.aborted) stop()
      else child.stdin.end(input)
    })
  }
}
