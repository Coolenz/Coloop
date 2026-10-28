import { randomUUID } from 'node:crypto'
import type { AppStore } from '../infrastructure/store'
import type { BoardGateway } from '../infrastructure/board'
import type { CloudGateway } from '../infrastructure/cloud'
import type { Task, TaskRequest } from '../../shared/contracts'
import { errorMessage } from '../domain/errors'

export class TaskService {
  private active?: { id: string; controller: AbortController }
  get running() {
    return !!this.active
  }
  constructor(
    private store: AppStore,
    private cloud: CloudGateway,
    private board: BoardGateway,
    private screenContext: (signal: AbortSignal) => Promise<string>,
    private onChange: () => void,
  ) {}
  start(request: TaskRequest): string {
    if (this.active) throw new Error('已有任务正在运行，请等待或停止后重试')
    const task: Task = {
      id: randomUUID(),
      prompt: request.prompt,
      target: request.target,
      source: request.source,
      status: 'running',
      createdAt: new Date().toISOString(),
      answer: '',
      stage: request.source === 'screen' ? '正在读取屏幕' : '正在连接模型',
      model: request.target === 'rk' ? 'Qwen3.5-9B · RK3588' : this.store.config.provider.model,
    }
    const controller = new AbortController()
    this.active = { id: task.id, controller }
    const previousTasks = this.store.tasks
    this.store.tasks = [task, ...previousTasks].slice(0, 200)
    try {
      this.store.persist()
    } catch (error) {
      this.store.tasks = previousTasks
      this.active = undefined
      throw error
    }
    this.onChange()
    void this.execute(task, request, controller)
    return task.id
  }
  private async execute(task: Task, request: TaskRequest, controller: AbortController) {
    try {
      const context =
        request.source === 'screen'
          ? [request.context, await this.screenContext(controller.signal)]
              .filter(Boolean)
              .join('\n\n')
          : request.context
      if (context.length > 50_000) throw new Error('参考文本超过 50000 字，请缩短后重试')
      controller.signal.throwIfAborted()
      task.stage = '正在生成回答'
      this.onChange()
      const update = (text: string) => {
        if (!controller.signal.aborted) {
          task.answer = text
          this.onChange()
        }
      }
      const answer =
        request.target === 'rk'
          ? await this.board.generate(request.prompt, context, controller.signal, update)
          : await this.cloud.generate(
              this.store.config.provider,
              this.store.apiKey,
              request.prompt,
              context,
              controller.signal,
              update,
            )
      controller.signal.throwIfAborted()
      task.answer = answer
      task.status = 'completed'
      task.stage = '已完成'
    } catch (error) {
      task.status = controller.signal.aborted ? 'cancelled' : 'failed'
      task.stage = controller.signal.aborted ? '已停止' : '运行失败'
      task.error = controller.signal.aborted ? undefined : errorMessage(error)
    } finally {
      task.finishedAt = new Date().toISOString()
      this.active = undefined
      try {
        this.store.persist()
      } catch {
        task.error = [task.error, '任务记录保存失败，请检查本地磁盘空间'].filter(Boolean).join('；')
      }
      this.onChange()
    }
  }
  cancel(id: string) {
    if (!this.active || this.active.id !== id) throw new Error('该任务已结束')
    this.active.controller.abort()
  }
  dispose() {
    this.active?.controller.abort()
  }
}
