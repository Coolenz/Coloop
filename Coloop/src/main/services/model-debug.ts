import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { LocalInferenceResult } from '../../shared/local-model'
import {
  modelDebugRequestSchema,
  diagnosticQuerySchema,
  type ModelDebugRequest,
  type ModelDebugRun,
  type ModelDiagnostic,
  type RoutePreview,
} from '../../shared/model-debug'

interface Options {
  budget?(request: ModelDebugRequest): { tokens: number; source: string }
  model(target: 'local' | 'cloud'): string
  localBusy(): boolean
  complete(
    request: ModelDebugRequest,
    signal: AbortSignal,
    text: (value: string) => void,
  ): Promise<string | LocalInferenceResult>
  route(prompt: string, signal: AbortSignal): Promise<RoutePreview>
  changed(): void
}
export class ModelDebugService {
  private jobs = new Map<string, { run: ModelDebugRun; abort: AbortController }>()
  private directory: string
  private previewAbort?: AbortController
  constructor(
    directory: string,
    private options: Options,
  ) {
    this.directory = directory
  }
  start(input: unknown) {
    const request = modelDebugRequestSchema.parse(input)
    this.options.budget?.(request)
    if (
      this.previewAbort ||
      [...this.jobs.values()].some(({ run }) => ['waiting', 'running'].includes(run.state))
    )
      throw new Error('请先停止或等待当前模型测试')
    const id = randomUUID()
    const run: ModelDebugRun = {
      id,
      target: request.target,
      model: this.options.model(request.target),
      state: 'waiting',
      text: '',
      createdAt: Date.now(),
      inputBytes: Buffer.byteLength(request.prompt + (request.system ?? ''), 'utf8'),
    }
    const job = { run, abort: new AbortController() }
    this.jobs.set(id, job)
    if (this.jobs.size > 100) this.jobs.delete(this.jobs.keys().next().value!)
    void this.execute(request, job)
    this.options.changed()
    return id
  }
  get(id: string) {
    const job = this.jobs.get(id)
    if (!job) throw new Error('测试记录不存在')
    return structuredClone(job.run)
  }
  current() {
    const run = [...this.jobs.values()].at(-1)?.run
    return run ? structuredClone(run) : undefined
  }
  cancel(id: string) {
    const job = this.jobs.get(id)
    if (job && ['waiting', 'running'].includes(job.run.state)) job.abort.abort()
  }
  busy() {
    return (
      !!this.previewAbort ||
      [...this.jobs.values()].some(({ run }) => run.target === 'local' && run.state === 'running')
    )
  }
  private async execute(
    request: ModelDebugRequest,
    job: { run: ModelDebugRun; abort: AbortController },
  ) {
    const { run, abort } = job
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      while (request.target === 'local' && this.options.localBusy())
        await delay(250, undefined, { signal: abort.signal })
      abort.signal.throwIfAborted()
      run.state = 'running'
      run.startedAt = Date.now()
      timer = setTimeout(() => abort.abort(new Error('MODEL_TEST_TIMEOUT')), request.timeoutMs)
      this.options.changed()
      const budget = this.options.budget?.(request)
      run.requestedOutputTokens = budget?.tokens ?? request.maxTokens
      run.budgetSource = budget?.source
      const result = await this.options.complete(
        { ...request, maxTokens: run.requestedOutputTokens },
        abort.signal,
        (text) => {
          if (text && run.firstTextMs === undefined) run.firstTextMs = Date.now() - run.startedAt!
          run.text = text
          this.options.changed()
        },
      )
      run.text = typeof result === 'string' ? result : result.text
      run.finishReason = typeof result === 'string' ? 'stop' : result.finishReason
      if (typeof result !== 'string') {
        run.promptTokens = result.promptTokens
        run.completionTokens = result.completionTokens
      }
      if (run.finishReason === 'length') throw new Error('MODEL_OUTPUT_TRUNCATED')
      abort.signal.throwIfAborted()
      run.outputBytes = Buffer.byteLength(run.text)
      run.state = 'completed'
    } catch (error) {
      const timeout =
        abort.signal.reason instanceof Error && abort.signal.reason.message === 'MODEL_TEST_TIMEOUT'
      run.state = abort.signal.aborted && !timeout ? 'cancelled' : 'failed'
      const message = error instanceof Error ? error.message : ''
      const status = /HTTP (\d{3})/.exec(message)?.[1]
      run.error = timeout
        ? '模型测试超时'
        : run.state === 'cancelled'
          ? '测试已停止'
          : status
            ? `模型服务返回 HTTP ${status}`
            : message === 'MODEL_OUTPUT_TRUNCATED'
              ? '输出达到请求上限，回答未完整完成'
              : /预算|CONTEXT/.test(message)
                ? '模型上下文超出预算'
                : '模型调用失败，请检查连接与服务状态'
    } finally {
      clearTimeout(timer)
      run.elapsedMs = run.startedAt ? Date.now() - run.startedAt : undefined
      const { text: _text, ...metadata } = run
      try {
        await mkdir(this.directory, { recursive: true })
        await appendFile(
          join(this.directory, 'model-debug.jsonl'),
          JSON.stringify({ ...metadata, at: Date.now(), event: run.state, source: 'model-test' }) +
            '\n',
          { mode: 0o600 },
        )
      } catch {
        run.error = [run.error, '诊断记录保存失败'].filter(Boolean).join('；')
      }
      this.options.changed()
    }
  }
  async preview(prompt: string) {
    if (this.options.localBusy() || this.busy())
      throw new Error('本地模型正在处理任务或测试，请等待资源释放后再预览')
    const abort = new AbortController()
    this.previewAbort = abort
    this.options.changed()
    try {
      return await this.options.route(prompt, abort.signal)
    } finally {
      this.previewAbort = undefined
      this.options.changed()
    }
  }
  async diagnostics(input: unknown = {}) {
    const query = diagnosticQuerySchema.parse(input)
    const results: ModelDiagnostic[] = []
    for (const source of ['model-debug', 'rk-model-metrics', 'model-usage', 'model-route-events']) {
      const stream = createReadStream(join(this.directory, source + '.jsonl'), { encoding: 'utf8' })
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      try {
        for await (const line of lines) {
          let item: Record<string, any>
          try {
            item = JSON.parse(line)
          } catch {
            continue
          }
          const at = typeof item.at === 'number' ? item.at : Date.parse(item.at ?? '')
          if (query.taskId && item.taskId !== query.taskId) continue
          if (query.model && !String(item.model ?? item.provider ?? source).includes(query.model))
            continue
          if (query.since && (!Number.isFinite(at) || at < query.since)) continue
          results.push({
            id: item.id ?? `${source}-${results.length}`,
            at: Number.isFinite(at) ? at : 0,
            taskId: item.taskId,
            model: item.model ?? item.provider,
            source,
            event: item.event ?? item.type ?? item.state,
            elapsedMs: item.elapsedMs ?? item.elapsed_ms,
            startedAt: item.startedAt,
            firstTextMs: item.firstTextMs,
            inputBytes:
              item.inputBytes ??
              item.input_bytes ??
              (typeof item.system_bytes === 'number'
                ? item.system_bytes + (item.turns_bytes ?? 0)
                : undefined),
            outputBytes: item.outputBytes ?? item.output_bytes,
            status: item.status,
            tokenUnits: item.chargedTokenUnits ?? item.reservedTokenUnits ?? item.tokenUnits,
            usageSource: item.usageSource,
            promptTokens: item.promptTokens,
            completionTokens: item.completionTokens,
            contextBudgetBytes: item.context_budget_bytes,
            maxOutputTokens: item.maxOutputTokens ?? item.max_tokens,
            budgetSource: item.budgetSource,
            finishReason: item.finishReason,
            from: item.from,
            to: item.to,
            reason: /^[A-Z_]+$/.test(item.reason ?? item.code ?? '')
              ? (item.reason ?? item.code)
              : undefined,
            phase: item.phase,
            durationKind: item.durationKind,
            estimatedCostYuan: item.estimatedCostYuan,
            error: source === 'model-debug' ? item.error : undefined,
          })
          if (results.length > 2000) {
            results.sort((a, b) => b.at - a.at)
            results.splice(1000)
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      } finally {
        lines.close()
        stream.destroy()
      }
    }
    results.sort((a, b) => b.at - a.at)
    results.splice(1000)
    if (query.path) {
      if (!isAbsolute(query.path)) throw new Error('请提供诊断报告的绝对路径')
      await writeFile(
        query.path,
        JSON.stringify({ createdAt: new Date().toISOString(), events: results }, null, 2),
        { flag: 'wx', mode: 0o600 },
      )
    }
    return results
  }
  dispose() {
    this.previewAbort?.abort()
    for (const job of this.jobs.values()) job.abort.abort()
  }
}
