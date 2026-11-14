import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AppStore } from '../infrastructure/store'
import type { BoardGateway } from '../infrastructure/board'
import type { CloudGateway } from '../infrastructure/cloud'
import type { Task, TaskRequest } from '../../shared/contracts'
import { errorMessage } from '../domain/errors'
import { CooperativeAgent } from './cooperative'
import { localOutputBudget, legacyLocalCapacity } from '../../shared/local-model'
import { effectiveModelLimits } from '../../shared/model-usage'
import { cloudTaskPolicy, parseCloudTaskPlan } from '../domain/cloud-task-plan'

export class TaskService {
  private active?: { id: string; controller: AbortController; supplements: string[] }
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
      stage: (text: string, model?: string) => void,
      target: TaskRequest['target'],
      workspace?: string,
      cloudFields?: TaskRequest['cloudFields'],
      policy?: TaskRequest['policy'],
    ) => Promise<string>,
    private chooseRoute?: (
      id: string,
      goal: string,
      signal: AbortSignal,
      mode: NonNullable<TaskRequest['policy']>['mode'],
    ) => Promise<'rk' | 'cloud'>,
  ) {}
  start(request: TaskRequest, taskId: string = randomUUID()): string {
    request = {
      ...request,
      policy: structuredClone(
        request.policy ?? {
          mode:
            request.target === 'rk'
              ? 'local'
              : request.target === 'cloud'
                ? 'cloud'
                : (this.store.config.executionMode ?? this.store.config.autoTaskRouting ?? 'cloud'),
          cloudFallback: request.target !== 'rk' && this.store.config.allowCloudFallback !== false,
        },
      ),
    }
    if (this.store.tasks.some((task) => task.id === taskId))
      throw new Error('TASK_ID_ALREADY_EXISTS')
    if (this.active) throw new Error('已有任务正在运行，请等待或停止后重试')
    if (this.executeDesktop) {
      if (this.board.state.status !== 'connected') throw new Error('请先在「设备管理」连接 RK 设备')
    } else {
      if (!this.board.state.qwenReady) throw new Error('请先在「设备管理」连接 RK 并启动端侧服务')
      if (request.target !== 'rk' && !this.board.state.modelPrivacyReady)
        throw new Error('协作模式需要 RK 服务启用请求级日志隐私保护')
    }
    const task: Task = {
      policy: request.policy,
      id: taskId,
      prompt: request.prompt,
      target: request.target,
      source: request.source,
      status: 'running',
      createdAt: new Date().toISOString(),
      answer: '',
      stage: request.source === 'screen' ? '正在读取屏幕' : '正在连接模型',
      model:
        this.executeDesktop && request.target === 'cloud'
          ? `${this.store.config.provider.model} · 桌面任务`
          : request.target === 'rk'
            ? `${this.board.state.model} · RK3588`
            : 'RK 隐私 Agent · 按需云端分析',
    }
    const controller = new AbortController()
    this.active = { id: task.id, controller, supplements: [] }
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
  append(taskId: string, text: string) {
    if (
      !this.active ||
      this.active.id !== taskId ||
      !this.executeDesktop ||
      this.active.controller.signal.aborted
    )
      throw new Error('该任务当前无法接收补充')
    this.active.supplements.push(text)
  }
  takeSupplements(taskId: string) {
    return this.active?.id === taskId ? this.active.supplements.splice(0) : []
  }
  private async execute(task: Task, request: TaskRequest, controller: AbortController) {
    try {
      this.cloud.bindTask?.(controller.signal, task.id)
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
      if (request.target === 'hybrid' && this.chooseRoute) {
        task.stage = '正在判断任务分配'
        this.onChange()
        const target = await this.chooseRoute(
          task.id,
          request.prompt,
          controller.signal,
          request.policy!.mode,
        )
        controller.signal.throwIfAborted()
        request = { ...request, target }
      }
      task.stage = '正在生成回答'
      this.onChange()
      let answer: string
      if (this.executeDesktop) {
        let plan: Awaited<ReturnType<TaskService['planTask']>>
        try {
          plan =
            request.intent === 'execute'
              ? { type: 'execute' }
              : await this.planTask(task, request, context, controller.signal)
        } catch (error) {
          controller.signal.throwIfAborted()
          if (
            request.target === 'cloud' ||
            !request.policy?.cloudFallback ||
            !/CONTEXT|预算|timeout|超时|RK_CONNECTION_CLOSED|ECONNRESET|ECONNREFUSED/i.test(
              error instanceof Error ? error.message : '',
            )
          )
            throw error
          request = { ...request, target: 'cloud', policy: { ...request.policy, mode: 'cloud' } }
          task.stage = '本地模型暂不可用，正在转交云端理解'
          this.onChange()
          plan = await this.planTask(task, request, context, controller.signal)
        }
        controller.signal.throwIfAborted()
        while (this.active?.id === task.id && this.active.supplements.length) {
          const supplements = this.active.supplements.splice(0)
          request = { ...request, prompt: [request.prompt, ...supplements].join('\n\n') }
          plan =
            request.intent === 'execute'
              ? { type: 'execute' }
              : await this.planTask(task, request, context, controller.signal)
          controller.signal.throwIfAborted()
        }
        if (plan.type === 'answer') {
          answer = plan.answer
        } else {
          task.execution = 'desktop'
          task.stage = '正在执行并核验结果'
          this.onChange()
          // The RK task loop owns recovery after dispatch. A rejected or uncertain
          // execution must never be replayed by this outer task service.
          answer = await this.executeDesktop(
            task.id,
            [request.prompt, context ? `参考资料：\n${context}` : ''].filter(Boolean).join('\n\n'),
            controller.signal,
            (stage, model) => {
              if (controller.signal.aborted) return
              task.stage = stage
              if (model) task.model = `${model} · 桌面任务`
              this.onChange()
            },
            request.target,
            request.workspace,
            request.cloudFields,
            request.policy,
          )
        }
      } else if (request.target === 'rk') {
        const limits = effectiveModelLimits(this.store.config.modelLimits)
        const budget = localOutputBudget(
          this.board.localCapacity?.() ?? legacyLocalCapacity,
          undefined,
          this.store.config.localModel?.outputTokens,
          limits.mode === 'custom' ? limits.maxOutputTokens : undefined,
        )
        answer = await this.board.generate(
          request.prompt,
          context,
          controller.signal,
          (text) => {
            if (controller.signal.aborted) return
            task.answer = text
            this.onChange()
          },
          budget.tokens,
        )
      } else {
        const result = await new CooperativeAgent(this.board, this.cloud).run(
          request.prompt,
          context,
          this.store.config.provider,
          () => this.store.apiKey,
          controller.signal,
          (stage) => {
            if (controller.signal.aborted) return
            task.stage = stage
            this.onChange()
          },
          {
            answerMode: 'direct',
            ...(request.target === 'cloud' ? { route: 'cloud' as const } : {}),
          },
        )
        answer = result.answer
        task.model = result.cloudUsed
          ? `${this.board.state.model} + ${this.store.config.provider.model} · 协作`
          : `${this.board.state.model} · RK 本地处理`
      }
      controller.signal.throwIfAborted()
      task.answer = answer
      task.status = 'completed'
      task.stage = '已完成'
    } catch (error) {
      const unknown =
        task.execution === 'desktop' &&
        error instanceof Error &&
        error.message === 'INPUT_OUTCOME_UNKNOWN'
      const cancelled =
        !unknown &&
        (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
      task.status = cancelled ? 'cancelled' : 'failed'
      task.stage = unknown
        ? '输入结果未确认，请检查目标窗口'
        : cancelled
          ? task.execution === 'desktop'
            ? '操作已停止'
            : '已停止等待，板端推理可能仍在运行'
          : '运行失败'
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
  private async planTask(task: Task, request: TaskRequest, context: string, signal: AbortSignal) {
    const local = async () => {
      task.stage = '正在本地理解任务'
      task.model = `${this.board.state.model} · RK3588`
      this.onChange()
      const output = await this.board.privacyAgent(
        cloudTaskPolicy,
        JSON.stringify({ goal: request.prompt, context }),
        signal,
        1024,
      )
      signal.throwIfAborted()
      return parseCloudTaskPlan(output)
    }
    if (request.target === 'rk' || request.target === 'hybrid') return local()
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      try {
        const output = await this.cloud.generate(
          this.store.config.provider,
          this.store.apiKey,
          JSON.stringify({ goal: request.prompt }),
          context,
          signal,
          () => {},
          cloudTaskPolicy,
        )
        signal.throwIfAborted()
        return parseCloudTaskPlan(output)
      } catch (error) {
        signal.throwIfAborted()
        if (attempt >= 2) throw error
        task.stage = '云端理解暂未完成，正在重试'
        this.onChange()
        await delay(500, undefined, { signal })
      }
    }
  }
  cancel(id: string) {
    if (!this.active || this.active.id !== id) throw new Error('该任务已结束')
    const task = this.store.tasks.find((item) => item.id === id)
    if (task?.execution === 'desktop') {
      task.stage = '正在停止操作，等待 RK 释放确认'
      this.onChange()
    }
    this.active.controller.abort()
  }
  dispose() {
    this.active?.controller.abort()
  }
}
