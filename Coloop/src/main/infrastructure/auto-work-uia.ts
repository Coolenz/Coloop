import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { z } from 'zod'

const nodeSchema = z.object({
  type: z.string(),
  name: z.string().max(1200),
  value: z.string().max(8192),
  automationId: z.string().max(256),
  focused: z.boolean(),
  offscreen: z.boolean(),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
})
const snapshotSchema = z.object({
  version: z.literal(1),
  source: z.literal('flaui-uia3'),
  pid: z.number().int().positive(),
  hwnd: z.string().regex(/^\d+$/),
  title: z.string().max(2000),
  revision: z.number().int().positive(),
  capturedAt: z.string(),
  complete: z.boolean(),
  nodes: z.array(nodeSchema).max(1000),
  drafts: z.array(nodeSchema).max(1000),
  messages: z.array(z.string().max(8192)).max(1000),
  identityVerified: z.literal(false),
})
export type AutoWorkUiaSnapshot = z.infer<typeof snapshotSchema>

/** A selected-window reader. Execution and user-input ownership remain with the existing CUA layer. */
export class AutoWorkUiaObservation {
  private child?: ChildProcessWithoutNullStreams
  constructor(private runtimeDirectory: string) {}
  async verifyRuntime() {
    const files = [
      'Coloop.AutoWork.Uia.exe',
      'FlaUI.Core.dll',
      'FlaUI.UIA3.dll',
      'Interop.UIAutomationClient.dll',
    ]
    const manifest = JSON.parse(
      (await readFile(join(this.runtimeDirectory, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, ''),
    ) as { file: string; sha256: string }[]
    for (const file of files) {
      const expected = manifest.find((entry) => entry.file === file)?.sha256?.toLowerCase()
      const actual = createHash('sha256')
        .update(await readFile(join(this.runtimeDirectory, file)))
        .digest('hex')
      if (!expected || actual !== expected) throw new Error('AUTO_WORK_UIA_INTEGRITY_FAILED')
    }
    return { available: true, backend: 'FlaUI.UIA3', files }
  }
  async observe(input: {
    pid: number
    hwnd: string
    watchMs?: number
    onSnapshot: (value: AutoWorkUiaSnapshot) => void
  }): Promise<void> {
    if (this.child) throw new Error('AUTO_WORK_UIA_BUSY')
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0 || !/^\d+$/.test(input.hwnd))
      throw new Error('AUTO_WORK_UIA_TARGET_REQUIRED')
    const watch = input.watchMs ?? 0
    if (!Number.isSafeInteger(watch) || watch < 0 || watch > 30_000)
      throw new Error('AUTO_WORK_UIA_DURATION_INVALID')
    await this.verifyRuntime()
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        join(this.runtimeDirectory, 'Coloop.AutoWork.Uia.exe'),
        ['--pid', String(input.pid), '--hwnd', input.hwnd, '--watch-ms', String(watch)],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env },
      )
      this.child = child
      let failure: Error | undefined
      let bytes = 0
      const timer = setTimeout(() => {
        failure = new Error('AUTO_WORK_UIA_TIMEOUT')
        child.kill()
      }, watch + 8000)
      const lines = createInterface({ input: child.stdout })
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 4 * 1024 * 1024) {
          failure = new Error('AUTO_WORK_UIA_OUTPUT_LIMIT')
          child.kill()
        }
      })
      child.stderr.resume()
      lines.on('line', (text) => {
        try {
          const value = snapshotSchema.parse(JSON.parse(text))
          if (value.pid !== input.pid || value.hwnd !== input.hwnd)
            throw new Error('AUTO_WORK_UIA_TARGET_CHANGED')
          input.onSnapshot(value)
        } catch {
          failure = new Error('AUTO_WORK_UIA_INVALID_SNAPSHOT')
          child.kill()
        }
      })
      child.on('error', (error) => {
        failure = error
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        lines.close()
        if (this.child === child) this.child = undefined
        if (failure) reject(failure)
        else if (code !== 0) reject(new Error('AUTO_WORK_UIA_READ_FAILED'))
        else resolve()
      })
      child.stdin.end()
    })
  }
  stop() {
    this.child?.kill()
  }
}
