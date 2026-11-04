import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AppStore } from '../infrastructure/store'
import type { BoardGateway } from '../infrastructure/board'
import type { CloudGateway } from '../infrastructure/cloud'
import type { Task, TaskRequest } from '../../shared/contracts'
import { errorMessage } from '../domain/errors'
import { CooperativeAgent } from './cooperative'
import { reviewTaskCandidate } from './workspace-dispatch'

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
    private executeDesktop?: (
      id: string,
      goal: string,
      signal: AbortSignal,
      stage: (text: string) => void,
    ) => Promise<string>,
  ) {}
  start(request: TaskRequest): string {
    if (this.active) throw new Error('已有任务正在运行，请等待或停止后重试')
    if (!this.board.state.qwenReady) throw new Error('请先在「设备管理」连接 RK 并启动端侧服务')
    if (request.target !== 'rk' && !this.board.state.modelPrivacyReady)
      throw new Error('协作模式需要 RK 服务启用请求级日志隐私保护')
    const task: Task = {
      id: randomUUID(),
      prompt: request.prompt,
      target: request.target,
      source: request.source,
      status: 'running',
      createdAt: new Date().toISOString(),
      answer: '',
      stage: request.source === 'screen' ? '正在读取屏幕' : '正在连接模型',
      model:
        request.target === 'rk'
          ? `${this.board.state.model} · RK3588`
          : 'RK 隐私 Agent · 按需云端分析',
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
      const readScreen = async () => {
        while (true) {
          try {
            return await this.screenContext(controller.signal)
          } catch (error) {
            if (!this.executeDesktop || controller.signal.aborted) throw error
            task.stage = '屏幕观察暂不可用，正在重新读取'
            this.onChange()
            await delay(500, undefined, { signal: controller.signal })
          }
        }
      }
      const context =
        request.source === 'screen'
          ? [request.context, await readScreen()].filter(Boolean).join('\n\n')
          : request.context
      if (context.length > 50_000) throw new Error('参考文本超过 50000 字，请缩短后重试')
      controller.signal.throwIfAborted()
      task.stage = '正在生成回答'
      this.onChange()
      const update = (text: string) => {
        if (!controller.signal.aborted) {
          if (!this.executeDesktop) task.answer = text
          this.onChange()
        }
      }
      let answer = ''
      let feedback = ''
      while (true) {
        controller.signal.throwIfAborted()
        try {
          if (this.executeDesktop) {
            task.stage = answer ? '正在核验目标是否完成' : '正在规划任务所需工具'
            this.onChange()
            const review = await reviewTaskCandidate(
              { goal: request.prompt, context, candidate: answer, feedback },
              (system, content) => this.board.privacyAgent(system, content, controller.signal, 16),
            )
            controller.signal.throwIfAborted()
            console.info(
              '[task-loop]',
              JSON.stringify({ id: task.id, event: 'review', decision: review.decision }),
            )
            if (review.decision === 'complete' && answer.trim()) break
            feedback = review.feedback
            if (review.decision === 'execute') {
              task.model = 'RK 桌面执行 Agent'
              answer = await this.executeDesktop(
                task.id,
                [request.prompt, context ? `参考资料：\n${context}` : '', `检查反馈：${feedback}`]
                  .filter(Boolean)
                  .join('\n\n'),
                controller.signal,
                (stage) => {
                  task.stage = stage
                  this.onChange()
                },
              )
              // The desktop loop returns only after verified completion, not after generating text.
              break
            }
          }
          const planningPrompt = feedback
            ? `${request.prompt}\n\n任务检查反馈（继续原任务）：\n${feedback}`
            : request.prompt
          if (request.target === 'rk') {
            answer = await this.board.generate(planningPrompt, context, controller.signal, update)
          } else {
            // Legacy cloud requests use the same guarded route; they cannot bypass RK.
            const result = await new CooperativeAgent(this.board, this.cloud).run(
              planningPrompt,
              context,
              this.store.config.provider,
              () => this.store.apiKey,
              controller.signal,
              (stage) => {
                if (!controller.signal.aborted) {
                  task.stage = stage
                  this.onChange()
                }
              },
            )
            answer = result.answer
            task.model = result.cloudUsed
              ? `${this.board.state.model} + ${this.store.config.provider.model} · 协作`
              : `${this.board.state.model} · RK 本地处理`
          }
          if (!this.executeDesktop) break
          task.stage = '正在根据反馈继续处理'
          this.onChange()
        } catch (error) {
          if (
            !this.executeDesktop ||
            controller.signal.aborted ||
            (error instanceof Error && error.name === 'AbortError')
          )
            throw error
          console.info(
            '[task-loop]',
            JSON.stringify({ id: task.id, event: 'retry', error: errorMessage(error) }),
          )
          task.stage = `本轮未完成，正在恢复：${errorMessage(error)}`
          this.onChange()
          answer = ''
          feedback =
            '上轮生成、检查或执行未正常完成。原任务仍在继续；核对实际进度，不要把文字回复当作完成，不要盲目重放已发送的动作。'
          await delay(500, undefined, { signal: controller.signal })
        }
      }
      controller.signal.throwIfAborted()
      task.answer = answer
      task.status = 'completed'
      task.stage = '已完成'
    } catch (error) {
      const cancelled =
        controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      task.status = cancelled ? 'cancelled' : 'failed'
      task.stage = cancelled ? '已停止等待，板端推理可能仍在运行' : '运行失败'
      task.error = cancelled ? undefined : errorMessage(error)
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
