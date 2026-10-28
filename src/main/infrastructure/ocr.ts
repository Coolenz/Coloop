import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import type { OcrResult } from '../../shared/contracts'

const resultSchema = z.object({
  text: z.string().max(200_000),
  confidence: z.number().min(0).max(100),
  durationMs: z.number().nonnegative(),
  language: z.string(),
  items: z
    .array(
      z.object({
        text: z.string(),
        confidence: z.number(),
        box: z.array(z.array(z.number())),
        rect: z.array(z.number()).length(4),
        center: z.array(z.number()).length(2),
      }),
    )
    .max(10000),
  coordinateSpace: z.literal('image_pixels'),
  engine: z.literal('RapidOCR'),
})
export class OcrEngine {
  busy = false
  progress = 0
  private process?: ChildProcessWithoutNullStreams
  private workspace = ''
  private pending?: {
    id: string
    resolve: (result: OcrResult) => void
    reject: (error: Error) => void
  }
  constructor(
    private getWorkspace: () => string,
    private bridgePath: string,
    private onChange: () => void,
  ) {}
  private ensureWorker() {
    const workspace = resolve(this.getWorkspace())
    if (this.process && this.workspace === workspace) return this.process
    this.dispose()
    const python = join(workspace, 'deployment/screen-ocr/.venv/Scripts/python.exe')
    const module = join(workspace, 'tools/screen_ocr.py')
    if (!existsSync(python) || !existsSync(module))
      throw new Error(
        `没有找到已安装的 RapidOCR 环境，请在「模型连接」设置正确的 RK 项目路径：${workspace}`,
      )
    this.workspace = workspace
    const child = spawn(python, ['-u', this.bridgePath, workspace], {
      cwd: workspace,
      windowsHide: true,
      stdio: 'pipe',
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    })
    this.process = child
    let stderr = '',
      outputBytes = 0
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-1500)
    })
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > 4_000_000) {
        this.pending?.reject(new Error('OCR 输出过大'))
        this.dispose()
      }
    })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      if (!this.pending || this.process !== child) return
      try {
        const message = JSON.parse(line)
        if (message.id !== this.pending.id) return
        const pending = this.pending
        this.pending = undefined
        outputBytes = 0
        if (!message.ok)
          pending.reject(new Error(String(message.error || 'OCR 识别失败').slice(0, 1000)))
        else {
          const parsed = resultSchema.safeParse(message.result)
          parsed.success
            ? pending.resolve(parsed.data)
            : pending.reject(new Error('OCR 工具返回的数据格式无效'))
        }
      } catch {
        this.pending?.reject(new Error('OCR 工具返回了无效响应'))
        this.pending = undefined
      }
    })
    child.once('error', (error) => {
      this.pending?.reject(new Error(`无法启动 RapidOCR：${error.message}`))
      this.pending = undefined
      if (this.process === child) this.process = undefined
    })
    child.once('exit', () => {
      lines.close()
      if (this.process === child) {
        this.process = undefined
        this.pending?.reject(new Error(`RapidOCR 进程已退出：${stderr.slice(-500)}`))
        this.pending = undefined
      }
    })
    child.stdin.on('error', () => {
      this.pending?.reject(new Error('OCR 连接已断开，请重试'))
      this.pending = undefined
    })
    return child
  }
  async recognize(buffer: Buffer, signal?: AbortSignal): Promise<OcrResult> {
    if (this.busy) throw new Error('OCR 正在识别，请等待当前任务完成')
    this.busy = true
    this.progress = 0
    this.onChange()
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      this.pending?.reject(new DOMException('操作已取消', 'AbortError'))
      this.pending = undefined
      this.dispose()
    }
    try {
      signal?.throwIfAborted()
      const child = this.ensureWorker()
      const result = await new Promise<OcrResult>((resolve, reject) => {
        const id = randomUUID()
        this.pending = { id, resolve, reject }
        timer = setTimeout(() => {
          reject(new Error('OCR 识别超时，请缩小图片后重试'))
          this.pending = undefined
          this.dispose()
        }, 90_000)
        signal?.addEventListener('abort', abort, { once: true })
        child.stdin.write(JSON.stringify({ id, image: buffer.toString('base64') }) + '\n')
      })
      signal?.throwIfAborted()
      return result
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      this.busy = false
      this.progress = 0
      this.onChange()
    }
  }
  dispose() {
    const child = this.process
    this.process = undefined
    child?.kill()
    this.pending?.reject(new Error('OCR 工作进程已关闭'))
    this.pending = undefined
  }
}
