import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { open, readFile, realpath, mkdir, rename, rm } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { z } from 'zod'

const files = [
  'src/main/infrastructure/browser-executable.ts',
  'src/main/infrastructure/stagehand-runtime.ts',
  'src/main/infrastructure/web-reader.ts',
  'src/main/services/browser-preferences.ts',
  'tests/browser-executable.test.ts',
  'tests/browser-preferences.test.ts',
  'tests/stagehand-runtime.test.ts',
] as const
export const browserRepairSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('read'),
      path: z.enum(files),
      start: z.number().int().nonnegative().default(0),
      length: z.number().int().min(1).max(8000).default(4000),
    })
    .strict(),
  z
    .object({
      operation: z.literal('patch'),
      path: z.enum(files),
      expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      old_text: z.string().min(1).max(32000),
      new_text: z.string().max(64000),
      source_quote: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({ operation: z.literal('validate'), source_quote: z.string().min(1).max(2000) })
    .strict(),
  z.object({ operation: z.literal('commit'), source_quote: z.string().min(1).max(2000) }).strict(),
])
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const execute = promisify(execFile)
export class BrowserAdapterMaintenance {
  private changed = new Set<string>()
  private validated?: string
  constructor(private root: string) {}
  private async run(command: string, args: string[], signal: AbortSignal) {
    const result = await execute(command, args, {
      cwd: this.root,
      windowsHide: true,
      signal,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 600000,
    })
    return result.stdout
  }
  private async fingerprint(signal: AbortSignal) {
    const diff = await this.run(
      'git',
      ['diff', 'HEAD', '--', 'src', 'tests', 'scripts', 'package.json', 'package-lock.json'],
      signal,
    )
    const contents = await Promise.all(files.map((path) => readFile(join(this.root, path), 'utf8')))
    return hash(diff + contents.join('\n'))
  }
  async call(input: unknown, goal: string, signal: AbortSignal) {
    const request = browserRepairSchema.parse(input)
    signal.throwIfAborted()
    const root = await realpath(this.root)
    const repository = (await this.run('git', ['rev-parse', '--show-toplevel'], signal)).trim()
    if (resolve(repository).toLowerCase() !== root.toLowerCase())
      throw new Error('BROWSER_REPAIR_REQUIRES_REPOSITORY_ROOT')
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    if (metadata.name !== 'coloop') throw new Error('BROWSER_REPAIR_REQUIRES_COLOOP_SOURCE')
    if (
      request.operation !== 'read' &&
      (!goal.includes(request.source_quote) ||
        !/(修复|修改|维护|repair|modify|fix)/i.test(request.source_quote) ||
        !/(浏览器|stagehand|browser)/i.test(request.source_quote) ||
        !/(代码|源码|适配|code|source|adapter)/i.test(request.source_quote))
    )
      throw new Error('BROWSER_REPAIR_REQUIRES_USER_INSTRUCTION')
    const cache = join(root, '.cache', 'browser-adapter-repair')
    await mkdir(cache, { recursive: true })
    if (relative(root, await realpath(cache)).startsWith('..'))
      throw new Error('BROWSER_REPAIR_CACHE_OUTSIDE_WORKSPACE')
    const lock = join(cache, 'active.lock')
    const lease = await open(lock, 'wx')
    try {
      if (request.operation === 'read' || request.operation === 'patch') {
        const path = await realpath(join(root, request.path))
        if (relative(root, path).replaceAll('\\', '/') !== request.path)
          throw new Error('BROWSER_REPAIR_LINKED_SOURCE')
        const text = await readFile(path, 'utf8')
        if (request.operation === 'read') {
          if (request.start > text.length) throw new Error('BROWSER_REPAIR_READ_OFFSET_INVALID')
          const end = Math.min(text.length, request.start + request.length)
          return {
            path: request.path,
            text: text.slice(request.start, end),
            sha256: hash(text),
            start: request.start,
            total: text.length,
            next: end < text.length ? end : undefined,
          }
        }
        if (hash(text) !== request.expected_sha256) throw new Error('BROWSER_REPAIR_SOURCE_CHANGED')
        if (text.split(request.old_text).length !== 2)
          throw new Error('BROWSER_REPAIR_REQUIRES_UNIQUE_MATCH')
        if (
          !this.changed.has(request.path) &&
          (await this.run('git', ['status', '--porcelain', '--', request.path], signal)).trim()
        )
          throw new Error('BROWSER_REPAIR_SOURCE_HAS_UNCOMMITTED_CHANGES')
        const next = text.replace(request.old_text, request.new_text)
        const temporary = join(cache, 'patch.tmp')
        const file = await open(temporary, 'wx')
        try {
          await file.writeFile(next, 'utf8')
          await file.sync()
        } finally {
          await file.close()
        }
        try {
          signal.throwIfAborted()
          if (hash(await readFile(path, 'utf8')) !== request.expected_sha256)
            throw new Error('BROWSER_REPAIR_SOURCE_CHANGED')
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true })
        }
        this.changed.add(request.path)
        this.validated = undefined
        return {
          path: request.path,
          sha256: hash(next),
          patched: true,
          validated: false,
          installed: false,
        }
      }
      if (request.operation === 'validate') {
        this.validated = undefined
        const before = await this.fingerprint(signal)
        const output = await this.run(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            join(root, 'scripts', 'validate-browser-adapter.ps1'),
          ],
          signal,
        )
        if (before !== (await this.fingerprint(signal)))
          throw new Error('BROWSER_REPAIR_CHANGED_DURING_VALIDATION')
        this.validated = before
        return { validated: true, installed: false, output: output.slice(-12000) }
      }
      if (!this.validated || this.validated !== (await this.fingerprint(signal)))
        throw new Error('BROWSER_REPAIR_REQUIRES_CURRENT_VALIDATION')
      if (!this.changed.size) throw new Error('BROWSER_REPAIR_NO_OWNED_CHANGES')
      await this.run(
        'git',
        [
          'commit',
          '--only',
          '-m',
          'fix: repair browser adapter after validation',
          '--',
          ...this.changed,
        ],
        signal,
      )
      const commit = (await this.run('git', ['rev-parse', 'HEAD'], signal)).trim()
      this.changed.clear()
      this.validated = undefined
      return {
        committed: true,
        commit,
        installed: false,
        next_step: 'package_and_installed_path_acceptance',
      }
    } finally {
      await lease.close()
      await rm(lock, { force: true })
    }
  }
}
