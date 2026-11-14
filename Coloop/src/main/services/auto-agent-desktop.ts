import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  AutoAgentAction,
  AutoAgentDraftRecoveryProof,
  AutoAgentSession,
  AutoAgentTask,
} from '../../shared/auto-agent-work'
import type {
  WindowsObservationCapture,
  ForegroundObservation,
} from '../infrastructure/foreground-observation'
import type { CuaDesktop } from '../infrastructure/cua-desktop'
import type { RkTarsBridge } from '../infrastructure/rk-tars-bridge'
import type { ProactiveObservation } from './proactive-agent'
import type { AutoAgentObservation } from './auto-agent-planner'
import { safeInputDiagnostics } from '../infrastructure/editor-binding-diagnostics'

interface Options {
  capture: WindowsObservationCapture
  cua?: CuaDesktop
  execution: Pick<RkTarsBridge, 'begin' | 'execute' | 'stop' | 'status' | 'resumeDraft'>
  assertAvailable(): void
  session(id: string): AutoAgentSession | undefined
  registerMessage(task: AutoAgentTask, action: AutoAgentAction, text: string): void
  renewMessage?(task: AutoAgentTask, action: AutoAgentAction, text: string): boolean
  forgetMessage(actionId: string): void
  structuredText?(windowId: string, processId: number): Promise<string>
}
const normalize = (text: string) => text.replace(/\s+/g, '').toLocaleLowerCase()
const notSent = (message: string) => Object.assign(new Error(message), { notSent: true })

/** One guarded RK input sequence. No model calls and no retry after an uncertain input. */
export class AutoAgentDesktop {
  private busy = false
  private inputGuard?: {
    taskId: string
    commandId: string
    text: string
    targetId: number
    signal: AbortSignal
    windowId: string
    processId: number
    observationId: string
    pasteText?: string
  }
  constructor(private options: Options) {}
  private async withAgentWindow<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    // Clicking Resume naturally foregrounds Coloop. Give the user a short chance
    // to return to the bound conversation; never activate a window or call a model.
    const deadline = Date.now() + 10000
    while (true) {
      signal.throwIfAborted()
      this.options.assertAvailable()
      try {
        return await this.options.capture.withAgentWindow(run)
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== '请将绑定的 ChatGPT / Codex 会话置于前台' ||
          Date.now() >= deadline
        )
          throw error
        await delay(200, undefined, { signal })
      }
    }
  }
  async guardInput(op: string, view: ForegroundObservation, value: Record<string, unknown>) {
    const guard = this.inputGuard
    if (
      !guard ||
      value.task_id !== guard.taskId ||
      value.command_id !== guard.commandId ||
      !['input.validate', 'input.guard'].includes(op)
    )
      return
    // Clipboard preparation also invokes input.guard. Recheck on every callback,
    // including the actual key-down. RK HID releases bypass callbacks in send().
    guard.signal.throwIfAborted()
    if (view.window_id !== guard.windowId || view.process_id !== guard.processId)
      throw new Error('AUTO_AGENT_WINDOW_CHANGED')
    const draft = await this.options.capture.readDraft(view, guard.targetId)
    if (draft.text.replace(/\r\n/g, '\n') !== guard.text) throw new Error('USER_DRAFT_CHANGED')
  }
  async verifyPaste(view: ForegroundObservation, value: Record<string, unknown>) {
    const guard = this.inputGuard
    if (!guard?.pasteText || value.task_id !== guard.taskId || value.command_id !== guard.commandId)
      return undefined
    guard.signal.throwIfAborted()
    this.options.assertAvailable()
    const action = value.action as
      { action?: string; target_id?: number; text?: string } | undefined
    const checks = {
      window: view.window_id === guard.windowId,
      process: view.process_id === guard.processId,
      view: view.observation_id === guard.observationId,
      observation: value.observation_id === guard.observationId,
      action: action?.action === 'paste',
      target: action?.target_id === guard.targetId,
      expectedText: action?.text === guard.pasteText,
    }
    if (!Object.values(checks).every(Boolean))
      return { verified: false, source: 'uia', checks, failure: 'paste_scope_changed' }
    // A contenteditable composer can grow after a multiline paste. This scoped
    // check still requires the whole window, focused editor and exact draft.
    return this.options.capture.verifyCurrentText(view, guard.pasteText, true, 'editor-height')
  }
  private assertSession(task: AutoAgentTask, signal: AbortSignal) {
    signal.throwIfAborted()
    this.options.assertAvailable()
    const session = this.options.session(task.session.id)
    if (
      !session ||
      session.instanceId !== task.session.instanceId ||
      session.revision !== task.session.revision ||
      session.state === 'running'
    )
      throw notSent('绑定会话已变化，取消待发送操作')
  }
  private matches(task: AutoAgentTask, text: string) {
    const recent = [...task.events]
      .reverse()
      .find((event) => event.type === 'stopped' && (event.text?.length ?? 0) >= 80)?.text
    if (!recent) return false
    const reference = normalize(recent)
    const visible = normalize(text)
    // Exact long output excerpt plus the end makes accidentally matching another
    // conversation substantially harder than matching a generic window title.
    return (
      reference.length >= 80 &&
      visible.includes(reference.slice(0, 80)) &&
      visible.includes(reference.slice(-80))
    )
  }
  private async capture(task: AutoAgentTask, mode: 'text' | 'image' | 'ocr', signal: AbortSignal) {
    this.options.assertAvailable()
    signal.throwIfAborted()
    const frame = await this.options.capture.captureFrame(signal)
    if (!frame) throw new Error('无法读取绑定的前台 Agent 窗口')
    let view: ForegroundObservation
    if (mode === 'ocr') view = await this.options.capture.recognize(frame, signal)
    else
      view = {
        ...frame,
        observation_id: randomUUID(),
        captured_at: Date.now(),
        content_hash: frame.fingerprint,
        ocr_text: '',
        ocr_items: [],
        targets: [],
      }
    if (this.options.cua) view = await this.options.cua.enrich(view)
    const structured = await this.options
      .structuredText?.(frame.window_id, frame.process_id)
      .catch(() => '')
    const text = [
      structured,
      view.cua?.text,
      view.ocr_text,
      ...(frame.control_targets ?? []).map((row) => row.name),
    ]
      .filter(Boolean)
      .join('\n')
    if (!this.matches(task, text))
      throw new Error('当前窗口未匹配绑定会话的原生回执；请切回原会话并显示最近结果')
    return {
      view,
      observation: {
        id: view.observation_id,
        text,
        source: mode === 'ocr' ? 'bound_window_ocr' : 'bound_window_controls',
        ...(mode === 'image'
          ? { dataUrl: 'data:image/png;base64,' + frame.png.toString('base64') }
          : {}),
      } satisfies AutoAgentObservation,
    }
  }
  async observe(task: AutoAgentTask, mode: 'text' | 'image' | 'ocr', signal: AbortSignal) {
    if (this.busy) throw new Error('AUTO_AGENT_DESKTOP_BUSY')
    this.busy = true
    try {
      return await this.withAgentWindow(
        signal,
        async () => (await this.capture(task, mode, signal)).observation,
      )
    } finally {
      this.busy = false
    }
  }
  async send(
    task: AutoAgentTask,
    action: AutoAgentAction,
    signal: AbortSignal,
  ): Promise<{ status: AutoAgentAction['status']; receipt?: string }> {
    if (this.busy) throw notSent('桌面输入正在使用')
    this.busy = true
    let began = false,
      submitted = false
    let focusFailure: unknown
    const identity = { task_id: task.id, generation: action.id }
    try {
      return await this.withAgentWindow(signal, async () => {
        this.assertSession(task, signal)
        let { view } = await this.capture(task, 'ocr', signal)
        const windowId = view.window_id,
          processId = view.process_id
        const assertWindow = () => {
          if (view.window_id !== windowId || view.process_id !== processId)
            throw new Error('AUTO_AGENT_WINDOW_CHANGED')
        }
        let editors = (
          view.targets as { id: number; type: string; runtime_id?: number[] }[]
        ).filter((row) => ['Edit', 'Document'].includes(row.type))
        let target = editors.find(
          (row) =>
            row.runtime_id?.length &&
            view.editable_runtime_id?.length &&
            row.runtime_id.join() === view.editable_runtime_id.join(),
        )
        this.assertSession(task, signal)
        await this.options.execution.begin(identity)
        began = true
        if (!target && editors.length === 1) {
          try {
            await this.options.execution.execute({
              ...identity,
              command_id: `${action.id}:focus`,
              observation: view as unknown as ProactiveObservation,
              action: { action: 'click', target_id: editors[0].id },
            })
          } catch (error) {
            focusFailure = error
            throw error
          }
          view = (await this.capture(task, 'ocr', signal)).view
          assertWindow()
          editors = (view.targets as typeof editors).filter((row) =>
            ['Edit', 'Document'].includes(row.type),
          )
          target = editors.find(
            (row) =>
              row.runtime_id?.length &&
              view.editable_runtime_id?.length &&
              row.runtime_id.join() === view.editable_runtime_id.join(),
          )
        }
        if (!target) throw notSent('无法唯一定位原会话输入框；请将光标放入该输入框')
        const draft = await this.options.capture.readDraft(view, target.id)
        if (draft.text.length) throw notSent('输入框已有未发送草稿，已保留；清空或发送后再恢复')
        this.assertSession(task, signal)
        const message = `[Coloop Auto Agent Work:${action.id}]\n${action.message}`
        this.options.registerMessage(task, action, message)
        this.inputGuard = {
          taskId: task.id,
          commandId: `${action.id}:paste`,
          text: '',
          targetId: target.id,
          signal,
          windowId,
          processId,
          observationId: view.observation_id,
          pasteText: message,
        }
        submitted = true // Any transport failure from now on requires reconciliation.
        const paste = await this.options.execution.execute({
          ...identity,
          command_id: `${action.id}:paste`,
          observation: view as unknown as ProactiveObservation,
          action: { action: 'paste', target_id: target.id, text: message },
        })
        signal.throwIfAborted()
        // Read back exact draft before Enter. Never replace another person's input.
        view = (await this.capture(task, 'ocr', signal)).view
        assertWindow()
        const editor = (view.targets as { id: number; runtime_id?: number[] }[]).find(
          (row) =>
            row.runtime_id?.length &&
            view.editable_runtime_id?.length &&
            row.runtime_id.join() === view.editable_runtime_id.join(),
        )
        if (!editor) throw new Error('粘贴后的输入框已变化；未自动发送')
        const after = await this.options.capture.readDraft(view, editor.id)
        if (after.text.replace(/\r\n/g, '\n') !== message)
          throw new Error('输入框内容与待发送消息不符；停止回写')
        this.assertSession(task, signal)
        this.inputGuard = {
          taskId: task.id,
          commandId: `${action.id}:send`,
          text: message,
          targetId: editor.id,
          signal,
          windowId,
          processId,
          observationId: view.observation_id,
        }
        const receipt = await this.options.execution.execute({
          ...identity,
          command_id: `${action.id}:send`,
          observation: view as unknown as ProactiveObservation,
          action: { action: 'hotkey', target_id: editor.id, keys: 'ENTER' },
        })
        return { status: 'accepted', receipt: JSON.stringify({ paste, send: receipt }) }
      })
    } catch (error) {
      if (!submitted) {
        this.options.forgetMessage(action.id)
        const failure = notSent(error instanceof Error ? error.message : '界面发送前校验失败')
        const diagnostics = safeInputDiagnostics(error)
        if (diagnostics) Object.assign(failure, { diagnostics })
        // Only this action's actual RK focus failure may supply a pre-submit
        // receipt. Capture/session errors must not impersonate execution results.
        const receipt = (error as { receipt?: unknown } | null)?.receipt
        if (error === focusFailure && receipt && typeof receipt === 'object') {
          const row = receipt as Record<string, unknown>
          if (
            row.task_id === task.id &&
            row.generation === action.id &&
            row.command_id === `${action.id}:focus`
          ) {
            try {
              const serialized = JSON.stringify(receipt)
              if (Buffer.byteLength(serialized) <= 16384) {
                const copy = JSON.parse(serialized) as Record<string, unknown>
                const safeDiagnostics = safeInputDiagnostics(
                  Object.assign(new Error(failure.message), { diagnostics: copy.diagnostics }),
                )
                delete copy.diagnostics
                if (safeDiagnostics) {
                  copy.diagnostics = safeDiagnostics
                  Object.assign(failure, { diagnostics: safeDiagnostics })
                }
                Object.assign(failure, { receipt: copy })
              }
            } catch {
              /* Malformed diagnostics must not change the send outcome. */
            }
          }
        }
        throw failure
      }
      throw error
    } finally {
      this.inputGuard = undefined
      if (began) await this.options.execution.stop(identity).catch(() => {})
      this.busy = false
    }
  }

  /** Explicit resume only: finish an exactly-owned draft after proving Enter was
   * never journaled. The durable RK session permits this one command only. */
  async resumeDraft(
    task: AutoAgentTask,
    action: AutoAgentAction,
    signal: AbortSignal,
    claim: (proof: AutoAgentDraftRecoveryProof) => void,
  ): Promise<{ status: AutoAgentAction['status']; receipt?: string }> {
    if (this.busy) throw new Error('AUTO_AGENT_DESKTOP_BUSY')
    if (action.channel !== 'desktop' || action.status !== 'unknown')
      throw new Error('AUTO_AGENT_DRAFT_RECOVERY_UNAVAILABLE')
    this.busy = true
    let began = false
    const identity = { task_id: task.id, generation: action.id }
    const commandId = `${action.id}:send`
    const pasteCommandId = `${action.id}:paste`
    const message = `[Coloop Auto Agent Work:${action.id}]\n${action.message}`
    try {
      return await this.withAgentWindow(signal, async () => {
        this.assertSession(task, signal)
        if (task.session.state !== 'idle') throw new Error('原会话尚未空闲，不能恢复草稿发送')
        const { view } = await this.capture(task, 'ocr', signal)
        const editor = (view.targets as { id: number; runtime_id?: number[] }[]).find(
          (row) =>
            row.runtime_id?.length &&
            view.editable_runtime_id?.length &&
            row.runtime_id.join() === view.editable_runtime_id.join(),
        )
        if (!editor) throw new Error('请将光标放入原会话的待核对草稿')
        const draft = await this.options.capture.readDraft(view, editor.id)
        if (draft.text.replace(/\r\n/g, '\n') !== message)
          throw new Error('待核对草稿已变化；已保留，未补发')
        const paste = await this.options.execution.status({
          ...identity,
          command_id: pasteCommandId,
        })
        const receipt = paste.receipt as Record<string, unknown> | undefined
        if (
          !receipt ||
          receipt.task_id !== task.id ||
          receipt.generation !== action.id ||
          receipt.command_id !== pasteCommandId ||
          receipt.action !== 'paste' ||
          receipt.release_confirmed !== true ||
          !['unknown', 'input_sent', 'effect_verified'].includes(String(receipt.outcome))
        )
          throw new Error('RK 粘贴回执不足，不能恢复草稿发送')
        try {
          await this.options.execution.status({ ...identity, command_id: commandId })
        } catch (error) {
          if (
            !(error instanceof Error) ||
            (error as Error & { code?: string }).code !== 'COMMAND_NOT_FOUND'
          )
            throw error
          // Only the executor's precise absence result permits the remaining key.
          this.assertSession(task, signal)
          if (!this.options.renewMessage?.(task, action, message))
            throw new Error('原会话的回执归属无法续期，未补发')
          await this.options.execution.resumeDraft({
            ...identity,
            command_id: commandId,
            paste_command_id: pasteCommandId,
          })
          began = true
          this.assertSession(task, signal)
          const finalDraft = await this.options.capture.readDraft(view, editor.id)
          if (finalDraft.text.replace(/\r\n/g, '\n') !== message)
            throw new Error('待核对草稿已变化；已保留，未补发')
          claim({
            draftSha256: createHash('sha256').update(message).digest('hex'),
            draftLength: message.length,
            pasteReceipt: JSON.stringify(receipt),
            sendAbsent: true,
          })
          signal.throwIfAborted()
          this.inputGuard = {
            taskId: task.id,
            commandId,
            text: message,
            targetId: editor.id,
            signal,
            windowId: view.window_id,
            processId: view.process_id,
            observationId: view.observation_id,
          }
          const send = await this.options.execution.execute({
            ...identity,
            command_id: commandId,
            observation: view as unknown as ProactiveObservation,
            action: { action: 'hotkey', target_id: editor.id, keys: 'ENTER' },
          })
          return {
            status: 'accepted',
            receipt: JSON.stringify({ recoveredDraft: true, paste, send }),
          }
        }
        throw new Error('RK 已记录发送动作；先核对实际结果，不能再次按 Enter')
      })
    } finally {
      this.inputGuard = undefined
      if (began) await this.options.execution.stop(identity).catch(() => {})
      this.busy = false
    }
  }
}
