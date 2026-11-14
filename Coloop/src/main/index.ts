import { pendingTaskApproval } from '../shared/task-approval'
import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  shell,
  dialog,
  desktopCapturer,
  clipboard,
  nativeImage,
  session,
  screen,
  net,
  Tray,
  Menu,
  powerMonitor,
} from 'electron'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { readPlaywrightExtensionToken } from './infrastructure/playwright-extension'
import { readTaskHistory } from './services/task-history'
import { ConversationService } from './services/conversations'
import { preferencesSchema } from '../shared/preferences'
import { ModelDebugService } from './services/model-debug'
import { localOutputBudget } from '../shared/local-model'
import { effectiveModelLimits } from '../shared/model-usage'
import {
  conversationResumeSchema,
  queueCancelSchema,
  type ExecutionPolicy,
} from '../shared/conversations'
import { CommandRegistry } from './services/command-registry'
import { startLocalControl } from './infrastructure/local-control'
import { createMainWindow, showMainWindow, hideMainWindow } from './infrastructure/main-window'
import { cloudModelCapacity } from '../shared/model-capacity'
import { existsSync } from 'node:fs'
import { CuaDriverClient } from './infrastructure/cua-driver'
import { CuaDesktop } from './infrastructure/cua-desktop'
import { createCuaExecution } from './infrastructure/cua-execution'
import { appendFile, readFile, writeFile, realpath, stat } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { ModelUsageLedger } from './infrastructure/model-usage'
import { modelLimitsSchema } from '../shared/model-usage'
import {
  settingsSchema,
  taskRequestSchema,
  scheduleRequestSchema,
  type AppSnapshot,
  type Capture,
  type Result,
} from '../shared/contracts'
import { AppStore } from './infrastructure/store'
import { BoardGateway, importRkBoard } from './infrastructure/board'
import { CloudGateway } from './infrastructure/cloud'
import {
  createRkTarsFetch,
  rkTarsModel,
  rkContextBudgetBytes,
} from './infrastructure/rk-tars-model'
import { OcrEngine } from './infrastructure/ocr'
import { TaskService } from './services/tasks'
import { syncRecoveredTaskHistory } from './services/recovered-task-history'
import { CoordinatorService, ReviewInputError } from './services/coordinator'
import { AgentHookService } from './services/agent-hooks'
import { ManagedApprovalAuthority } from './services/managed-approvals'
import { publishConnection } from './infrastructure/coordinator-connection'
import { errorMessage } from './domain/errors'
import { SessionControlService, SessionControlError } from './services/session-control'
import { ControlIndicatorWindow } from './infrastructure/control-indicator'
import {
  islandAnswerSchema,
  withTaskIndicatorContext,
  type ControlIndicatorSnapshot,
} from '../shared/control-indicator'
import { proactivePhaseLabels, proactiveErrorLabels } from '../shared/proactive'
import { CredentialService } from './services/credentials'
import { MemoryManagementService } from './services/memory'
import { PrivateMemoryEntryWindow } from './infrastructure/private-memory-entry'
import { RemoteGatewayService } from './services/remote-gateway'
import { RemoteTunnel } from './infrastructure/remote-tunnel'
import { RemoteRelay } from './infrastructure/remote-relay'
import { RemoteRelayConfig } from './infrastructure/remote-relay-config'
import { hostname } from 'node:os'
import QRCode from 'qrcode'
import type { MobileConnectionSnapshot } from '../shared/mobile'
import {
  DesktopTaskService,
  desktopPlannerPolicy,
  desktopRoutePolicy,
} from './services/desktop-tasks'
import { CooperativeAgent } from './services/cooperative'
import { VioloopService, violoopIntentPolicy } from './services/violoop'
import { planDesktopTask } from './services/desktop-planner'
import { ConnectionSettings } from './infrastructure/connection-settings'
import { AutoConnectionService } from './services/auto-connection'
import { TarsAgentService, type TarsAgentOptions } from './services/tars-agent'
import { WorkspaceSession } from './services/workspace-session'
import { VoiceTranscriptionService } from './services/voice'
import { WebReader } from './infrastructure/web-reader'
import { BrowserPreferences } from './services/browser-preferences'
import { browserConfigSchema } from './services/browser-preferences'
import { discoverBrowserEndpoint } from './infrastructure/browser-connection'
import { TaskScheduler } from './services/task-scheduler'
import { projectTaskProgress } from './domain/task-progress'
import { cloudConsultQuestions } from './domain/cloud-fields'
import { localSuggestionSystem } from './domain/proactive-suggestion'
import {
  autoTaskRoutePolicy,
  classifyAutoTask,
  previewAutoTaskRoute,
} from './domain/auto-task-route'
import { RkTarsBridge, rkMemoryNamespace } from './infrastructure/rk-tars-bridge'
import { inputTargetFailure } from './infrastructure/editor-binding-diagnostics'
import { createAgentRuntime } from './infrastructure/agent-runtime'
import { ExecutionCheckpointStore } from './infrastructure/execution-checkpoints'
import { DoclingService } from './infrastructure/docling'
import {
  ForegroundObservationService,
  WindowsObservationCapture,
  type ForegroundObservation,
  type ObservationAction,
} from './infrastructure/foreground-observation'
import { ClipboardLeaseService } from './infrastructure/clipboard-lease'
import { AutoAgentWorkService } from './services/auto-agent-work'
import { ChatGPTDesktopAdapter } from './services/chatgpt-desktop-adapter'
import { CodexSessionTitles } from './services/codex-session-titles'
import { AutoAgentWorkHooks } from './services/auto-agent-work-hooks'
import { AutoAgentPlanner } from './services/auto-agent-planner'
import { AutoAgentDesktop } from './services/auto-agent-desktop'
import { AutoAgentOpenCode } from './services/auto-agent-opencode'
import { AutoWorkUiaObservation } from './infrastructure/auto-work-uia'
import { testDecisionModel } from './infrastructure/decision-model-probe'
import type { AutoAgentHookStatus } from '../shared/auto-agent-work'
import {
  retrieveAutoAgentMemory,
  persistAutoAgentFeedback,
  persistAutoAgentChoice,
} from './services/auto-agent-memory'

let window: BrowserWindow | undefined
let tasks: TaskService, board: BoardGateway, ocr: OcrEngine
let coordinator: CoordinatorService | undefined
let hooks: AgentHookService | undefined
const isDevelopment = !app.isPackaged
const developmentUrl = process.env.ELECTRON_RENDERER_URL
if (process.env.COLOOP_DATA_DIR) app.setPath('userData', process.env.COLOOP_DATA_DIR)
let pendingMainShow = false
function showMain() {
  if (!window) pendingMainShow = true
  showMainWindow(window)
}
let quitFromCommandLine = (_force: boolean) => app.quit()
const lock = app.requestSingleInstanceLock()
if (!lock || process.argv.includes('--quit') || process.argv.includes('--force-quit')) app.quit()
else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--force-quit') || argv.includes('--quit')) {
      quitFromCommandLine(argv.includes('--force-quit'))
      return
    }
    if (!argv.includes('--background')) showMain()
  })
  app.on('activate', showMain)
  app
    .whenReady()
    .then(initialize)
    .catch((error) => {
      dialog.showErrorBox('Coloop 启动失败', errorMessage(error))
      app.quit()
    })
}

async function initialize() {
  const directory = app.getPath('userData')
  const commands = new CommandRegistry()
  let localControl: Awaited<ReturnType<typeof startLocalControl>> | undefined
  let exiting = false
  let scheduler: TaskScheduler | undefined
  let tray: Tray | undefined
  let sessionControl: SessionControlService | undefined
  let credentials: CredentialService | undefined
  let memories: MemoryManagementService | undefined
  let privateEntryWindow: PrivateMemoryEntryWindow | undefined
  let desktop: DesktopTaskService | undefined
  let violoop: VioloopService | undefined
  let autoConnection: AutoConnectionService | undefined
  let coordinatedTaskId: string | undefined
  let proactive: TarsAgentService | undefined
  let autoAgentWork: AutoAgentWorkService | undefined
  let chatgptAdapter: ChatGPTDesktopAdapter | undefined
  const codexSessionTitles = new CodexSessionTitles()
  let openCodeAuto: AutoAgentOpenCode | undefined
  let mobileTarsTaskId: string | undefined
  let foreground: ForegroundObservationService | undefined
  let foregroundCapture: WindowsObservationCapture | undefined
  let clipboardLeases: ClipboardLeaseService | undefined
  let observationPaused = false
  let mobileGateway: RemoteGatewayService | undefined
  let mobileTunnel: RemoteTunnel | undefined
  let mobileRelay: RemoteRelay | undefined
  let mobileRelayConfig: RemoteRelayConfig | undefined
  let mobileStarting: Promise<MobileConnectionSnapshot> | undefined
  let mobileGeneration = 0
  let indicator: ControlIndicatorWindow | undefined
  let conversations: ConversationService | undefined
  let modelDebug: ModelDebugService | undefined
  let indicatorKey = ''
  let indicatorUpdate: Promise<void> = Promise.resolve()
  let stopUnconfirmed = false
  let settingsChanging = false
  let controlAdmissions = 0
  let connection: ReturnType<typeof publishConnection> | undefined
  let coordinationError: string | undefined
  let coordinatorAccess: { url: string; token: string } | undefined
  const store = new AppStore(directory, {
    encrypt(value) {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error('Windows 凭据加密不可用，无法保存 API Key')
      return safeStorage.encryptString(value).toString('base64')
    },
    decrypt(value) {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    },
  })
  const connectionSettings = new ConnectionSettings(directory, {
    encrypt(value) {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error('Windows 加密存储不可用，无法保存自动连接凭据')
      return safeStorage.encryptString(value).toString('base64')
    },
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  })
  const modelUsage = new ModelUsageLedger(directory, () => store.config.modelLimits)
  const snapshot = (): AppSnapshot => ({
    conversations: conversations?.snapshot(),
    autoAgentWork: codexSessionTitles.snapshot(autoAgentWork?.snapshot()),
    modelUsage: modelUsage.snapshot(),
    settings: store.publicSettings(),
    device: board.state,
    tasks: store.tasks,
    version: app.getVersion(),
    ocrBusy: ocr.busy,
    ocrProgress: ocr.progress,
    coordinator: {
      ...(coordinator?.snapshot() ?? { status: 'stopped' as const, reviewing: false, audit: [] }),
      connectionPath: connection?.path,
      error: coordinationError,
    },
    hooks: hooks?.snapshot(),
    sessionControl: sessionControl?.snapshot(),
    credentials: credentials?.snapshot(),
    desktop: desktop?.snapshot(),
    violoop: violoop?.snapshot(),
    autoConnection: autoConnection?.snapshot(),
    proactive: proactive ? { ...proactive.snapshot(), observationPaused } : undefined,
    schedules: scheduler?.snapshot(),
    mobile:
      mobileGateway && mobileTunnel
        ? {
            gateway: mobileGateway.snapshot(),
            tunnel: mobileRelayConfig?.error()
              ? { status: 'error', error: mobileRelayConfig.error() }
              : mobileRelayConfig?.configured()
                ? mobileRelay!.snapshot()
                : mobileTunnel.snapshot(),
            transport: mobileRelayConfig?.configured() ? 'relay' : 'cloudflare',
            configuredEndpoint: mobileRelayConfig?.endpoint(),
          }
        : undefined,
  })
  let notifyTimer: ReturnType<typeof setTimeout> | undefined
  const notify = () => {
    // Task title and phase updates bypass the heavier home snapshot batching.
    void syncControlIndicator().catch(() => {})
    if (!notifyTimer)
      notifyTimer = setTimeout(() => {
        notifyTimer = undefined
        conversations?.tick()
        if (foreground) {
          if (canObserveForeground() && !proactive?.active) foreground.resume('unavailable')
          else foreground.pause('unavailable')
        }
        if (window && !window.isDestroyed()) window.webContents.send('app:snapshot', snapshot())
        void syncControlIndicator().catch(() => {})
      }, 70)
  }
  board = new BoardGateway(notify)
  ocr = new OcrEngine(
    () => store.config.ocrWorkspace,
    app.isPackaged
      ? join(process.resourcesPath, 'rapidocr-worker.py')
      : join(app.getAppPath(), 'resources/rapidocr-worker.py'),
    notify,
  )
  const cloud = new CloudGateway(net.fetch as typeof fetch, modelUsage)
  const desktopCooperation = new CooperativeAgent(board, cloud, { routePolicy: desktopRoutePolicy })
  const captures = new Map<string, Buffer>()
  const remember = (buffer: Buffer, name: string): Capture => {
    const img = nativeImage.createFromBuffer(buffer)
    if (img.isEmpty()) throw new Error('无法读取图片，请选择有效的 PNG、JPEG、BMP 或 WebP 图片')
    const size = img.getSize()
    if (size.width * size.height > 40_000_000) throw new Error('图片超过 4000 万像素，请先缩小图片')
    const png = img.toPNG()
    const id = randomUUID()
    if (captures.size >= 4) captures.delete(captures.keys().next().value!)
    captures.set(id, png)
    return { id, name, dataUrl: `data:image/png;base64,${png.toString('base64')}`, ...size }
  }
  const captureScreen = async (displayId?: string): Promise<Capture | null> => {
    credentials?.assertObservationAllowed()
    const wasVisible = window?.isVisible()
    if (wasVisible) {
      hideMainWindow(window)
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    try {
      const displays = screen.getAllDisplays()
      const display = displays.find((d) => String(d.id) === displayId) || screen.getPrimaryDisplay()
      // Capture the actual physical resolution (up to 4K) for readable OCR.
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.min(3840, Math.round(display.size.width * display.scaleFactor)),
          height: Math.min(2160, Math.round(display.size.height * display.scaleFactor)),
        },
      })
      const source = sources.find((s) => s.display_id === String(display.id)) || sources[0]
      if (!source || source.thumbnail.isEmpty())
        throw new Error('无法捕获屏幕，请检查屏幕是否已解锁')
      credentials?.assertObservationAllowed()
      return remember(source.thumbnail.toPNG(), display.label || source.name)
    } finally {
      if (wasVisible && window && !window.isDestroyed()) window.show()
    }
  }
  tasks = new TaskService(
    store,
    cloud,
    board,
    async (signal) => {
      const capture = await captureScreen()
      if (!capture) throw new Error('没有可用的屏幕')
      const result = await ocr.recognize(captures.get(capture.id)!, signal)
      if (!result.text) throw new Error('屏幕中没有识别到文字，请尝试导入清晰图片')
      return result.text
    },
    notify,
    async (id, goal, signal, stage, target, workspace, cloudFields, policy) => {
      coordinatedTaskId = id
      const stop = () => {
        void proactive?.stop()
      }
      signal.addEventListener('abort', stop, { once: true })
      try {
        signal.throwIfAborted()
        if (proactive!.snapshot().taskId !== id) {
          await foregroundCapture!.rememberTarget()
          window?.minimize()
          await foregroundCapture!.restoreTarget()
          signal.throwIfAborted()
          await proactive!.startTask(
            goal,
            id,
            target === 'hybrid' ? 'auto' : target,
            workspace ?? store.config.taskWorkspace,
            cloudFields,
            undefined,
            policy,
          )
        }
        for (const supplement of tasks.takeSupplements(id)) proactive!.appendMessage(supplement)
        while (true) {
          signal.throwIfAborted()
          const state = proactive!.snapshot()
          if (state.taskId !== id) throw new Error('执行任务标识不匹配')
          stage(proactivePhaseLabels[state.phase] ?? '正在操作并回读实际结果', state.model)
          if (!state.active) {
            if (state.phase === 'completed') return state.summary ?? '任务已通过屏幕结果核验'
            if (state.phase === 'cancelled') throw new DOMException('操作已停止', 'AbortError')
            throw new Error(state.error ?? 'TARS_VERIFICATION_FAILED')
          }
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      } catch (error) {
        if (signal.aborted && proactive!.snapshot().taskId === id) {
          await proactive!.stop()
          while (proactive!.active && proactive!.snapshot().phase !== 'input_unknown')
            await new Promise((resolve) => setTimeout(resolve, 50))
          if (proactive!.snapshot().phase === 'input_unknown')
            throw new Error('INPUT_OUTCOME_UNKNOWN')
        }
        throw error
      } finally {
        signal.removeEventListener('abort', stop)
        coordinatedTaskId = undefined
      }
    },
    async (taskId, goal, signal, mode) => {
      if (mode !== 'local-auto') return mode === 'local' ? 'rk' : 'cloud'
      const result = await previewAutoTaskRoute(goal, signal, (content, bounded) =>
        board.privacyAgent(autoTaskRoutePolicy, content, bounded, 16),
      )
      await appendFile(
        join(directory, 'model-route-events.jsonl'),
        JSON.stringify({
          taskId,
          at: Date.now(),
          model: board.state.model,
          event: 'route-selected',
          to: result.route,
          source: result.source,
          elapsedMs: result.elapsedMs,
        }) + '\n',
        { mode: 0o600 },
      ).catch(() => {})
      return result.route
    },
  )
  const workspaceRoots = () => [
    store.config.ocrWorkspace,
    join(store.config.ocrWorkspace, '..', 'Coloop'),
  ]
  sessionControl = new SessionControlService({
    workspaceRoots,
    journalPath: join(directory, 'session-control', 'commands.json'),
    onChange: notify,
  })
  credentials = new CredentialService(
    board,
    () =>
      !tasks.running &&
      !desktop?.active &&
      !violoop?.active &&
      !proactive?.active &&
      !autoAgentWork?.active &&
      (!ocr.busy || !!foreground?.isWorking) &&
      !coordinator?.snapshot().reviewing &&
      !sessionControl?.snapshot().controlActive &&
      !controlAdmissions &&
      !settingsChanging,
    notify,
    () => captures.clear(),
  )
  memories = new MemoryManagementService(board, credentials)
  desktop = new DesktopTaskService({
    agentLocation: 'rk',
    forwardCloud: (system, content, signal) =>
      cloud.relayText(store.config.provider, store.apiKey, system, content, signal),
    board,
    workspace: () => store.config.ocrWorkspace,
    resources: app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'),
    directory: join(directory, 'desktop-runtime'),
    onChange: () => {
      violoop?.observeDesktop()
      notify()
    },
    assertObservation: () => credentials!.assertObservationAllowed(),
    assertStart: () => {
      credentials!.assertObservationAllowed()
      if (sessionControl!.snapshot().stopped) throw new Error('CONTROL_STOPPED')
      if (
        settingsChanging ||
        proactive?.active ||
        tasks.running ||
        board.busy ||
        ocr.busy ||
        coordinator?.snapshot().reviewing ||
        sessionControl!.snapshot().controlActive ||
        controlAdmissions
      )
        throw new Error('请先等待当前任务、审批或其他电脑控制结束')
      if (
        board.state.status !== 'connected' ||
        !board.state.qwenReady ||
        !board.state.modelPrivacyReady
      )
        throw new Error('请先连接 RK 并确认端侧模型及隐私服务就绪')
    },
    prepareInput: syncControlIndicator,
    plan: (request, input, signal) =>
      planDesktopTask(request, input, signal, {
        board,
        onSource: (source) => desktop!.recordPlanningSource(source),
        cooperate: (content, abort, forceCloud) =>
          desktopCooperation.run(
            desktopPlannerPolicy,
            content,
            store.config.provider,
            () => store.apiKey,
            abort,
            () => {},
            forceCloud ? { route: 'cloud' } : {},
          ),
      }),
  })
  violoop = new VioloopService({
    directory: join(directory, 'violoop'),
    encrypt(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('VIOLOOP_STORAGE_UNAVAILABLE')
      return safeStorage.encryptString(value).toString('base64')
    },
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    desktop,
    assertAvailable: (continuingTaskId) => {
      credentials!.assertObservationAllowed()
      if (exiting || settingsChanging) throw new Error('电脑服务正在退出或更新设置，请稍后重试')
      if (sessionControl!.snapshot().stopped) throw new Error('CONTROL_STOPPED')
      if (
        (proactive?.active &&
          (!continuingTaskId ||
            continuingTaskId !== mobileTarsTaskId ||
            proactive.snapshot().taskId !== continuingTaskId)) ||
        tasks.running ||
        ocr.busy ||
        coordinator?.snapshot().reviewing ||
        sessionControl!.snapshot().controlActive ||
        controlAdmissions
      )
        throw new Error('电脑正在处理其他任务，请等待结束')
      if (board.state.status !== 'connected')
        throw new Error(
          autoConnection?.snapshot().message ?? '请在电脑连接 RK，并确认端侧模型与隐私服务就绪',
        )
    },
    understand: (content, signal) => board.privacyAgent(violoopIntentPolicy, content, signal, 512),
    browserAgentLocation: 'rk',
    execution: {
      start: async (goal, taskId, target = 'hybrid') => {
        mobileTarsTaskId = taskId
        try {
          await foregroundCapture!.rememberTarget()
          await foregroundCapture!.restoreTarget()
          await proactive!.startTask(
            goal,
            taskId,
            target === 'hybrid' ? 'auto' : target,
            store.config.taskWorkspace,
          )
        } catch (error) {
          mobileTarsTaskId = undefined
          throw error
        }
      },
      snapshot: () =>
        proactive?.snapshot() ?? { connected: false, active: false, phase: 'offline' },
      stop: async () => {
        await proactive?.stopAndWait()
      },
      answer: (taskId, questionId, answer) => proactive!.answer(taskId, questionId, answer),
    },
    onChange: notify,
  })
  async function syncControlIndicator() {
    if (!indicator || !sessionControl || exiting) return
    const control = sessionControl.snapshot()
    const desktopState = desktop?.snapshot()
    const desktopActive = !!desktopState?.active
    const active = control.sessions.filter((item) => item.controlActive)
    const uncertain =
      control.unconfirmedCount > 0 ||
      desktopState?.phase === 'unconfirmed' ||
      active.some((item) => !item.connected || item.state === 'error') ||
      ((stopUnconfirmed || !!control.journalError) && control.controlActive)
    const mode: ControlIndicatorSnapshot['mode'] =
      active.length || control.controlActive || desktopActive
        ? uncertain
          ? 'unconfirmed'
          : active.some((item) => item.stopping) || desktopState?.phase === 'stopping'
            ? 'stopping'
            : 'controlling'
        : 'hidden'
    let state: ControlIndicatorSnapshot = {
      mode,
      detail:
        mode === 'unconfirmed'
          ? '操作状态待确认'
          : mode === 'stopping'
            ? '等待停止确认'
            : '正在操作电脑',
      sessionCount: active.length + (desktopActive ? 1 : 0),
      startedAt: active
        .map((item) => item.controlStartedAt)
        .filter(Boolean)
        .sort()[0],
    }
    const ai = proactive?.snapshot()
    if (mode === 'hidden' && ai) {
      if (ai.active) {
        const question = ai.question
        state = {
          mode: stopUnconfirmed
            ? 'unconfirmed'
            : ai.phase === 'stopping'
              ? 'stopping'
              : question
                ? 'question'
                : 'controlling',
          taskId: ai.taskId,
          phase: ai.phase,
          title: (conversations?.titleOf(ai.taskId) ?? 'Coloop').slice(0, 100),
          startedAt: store.tasks.find((task) => task.id === ai.taskId)?.createdAt,
          detail: ai.summary?.includes('转交云端')
            ? `${ai.summary} · ${proactivePhaseLabels[ai.phase] ?? '正在处理任务'}`
            : (proactivePhaseLabels[ai.phase] ?? '正在处理任务'),
          content: ai.summary?.slice(0, 12000),
          ...(question
            ? {
                questionId: String(question.question_id),
                questionKind: question.kind === 'approval' ? 'approval' : 'business',
                detail: question.kind === 'approval' ? '等待你批准操作' : '等待你补充信息',
                content: [
                  question.question,
                  question.kind === 'approval' ? question.details : undefined,
                ]
                  .filter(Boolean)
                  .join('\n\n')
                  .slice(0, 12000),
                choices: Array.isArray(question.options)
                  ? question.options
                      .map(String)
                      .slice(0, 8)
                      .map((x) => x.slice(0, 300))
                  : [],
              }
            : {}),
        }
      } else if (ai.suggestion) {
        state = {
          mode: 'suggestion',
          title: String(ai.suggestion.title).slice(0, 100),
          content: String(ai.suggestion.text).slice(0, 12000),
          suggestionId: String(ai.suggestion.suggestion_id),
          detail: '当前窗口的下一步建议',
        }
      } else if (ai.phase === 'input_unknown') {
        state = {
          mode: 'unconfirmed',
          title: 'Coloop',
          detail: proactivePhaseLabels.input_unknown,
          error: ai.error?.slice(0, 180),
        }
      } else if (['completed', 'blocked', 'failed', 'cancelled'].includes(ai.phase)) {
        state = {
          taskId: ai.taskId,
          mode:
            ai.phase === 'completed' ? 'completed' : ai.phase === 'blocked' ? 'blocked' : 'failed',
          title: 'Coloop',
          content: ai.summary?.slice(0, 12000),
          detail:
            ai.phase === 'completed'
              ? ai.memorySaved === false
                ? '任务已完成 · 记忆保存未完成'
                : ai.memorySaved
                  ? '任务已完成 · 记忆已保存'
                  : '任务已完成 · 正在后台整理记忆'
              : proactivePhaseLabels[ai.phase],
          error: ai.error?.slice(0, 180),
        }
      } else {
        state = {
          mode: 'idle',
          title: 'Coloop',
          detail: observationPaused
            ? '屏幕观察已暂停'
            : board.state.status === 'connected'
              ? 'RK 已连接 · 等待任务'
              : board.state.status === 'connecting'
                ? '正在连接 RK'
                : '等待连接 RK',
          observationPaused,
          error: ai.recommendationError ? proactiveErrorLabels[ai.recommendationError] : undefined,
        }
      }
    }
    const supervised = autoAgentWork
      ?.snapshot()
      .tasks.find((task) => ['watching', 'deciding', 'waiting_receipt'].includes(task.state))
    if (supervised && !desktopActive && !control.controlActive && !ai?.active) {
      state = {
        mode: supervised.actions.some((action) => action.status === 'unknown')
          ? 'unconfirmed'
          : 'controlling',
        title: 'Auto Agent Work',
        taskId: supervised.id,
        detail:
          supervised.state === 'deciding'
            ? '正在判断下一步'
            : supervised.state === 'waiting_receipt'
              ? '正在核对原会话回执'
              : '等待原 Agent 的新进展',
        content: supervised.goal.slice(0, 12000),
        sessionCount: 1,
      }
    }
    state.model = ai?.model?.slice(0, 160)
    const runningTask = store.tasks.find((task) => task.status === 'running')
    const displayedTask =
      runningTask && (!supervised || state.taskId !== supervised.id)
        ? runningTask
        : store.tasks.find((task) => task.id === state.taskId)
    state = withTaskIndicatorContext(
      state,
      displayedTask,
      conversations?.titleOf(displayedTask?.id),
    )
    state.attention = store.config.islandAttention !== false
    state.previewDetails = store.config.islandDetailedNotifications !== false
    if (state.mode === 'question') {
      state.detail =
        store.config.islandDetailedNotifications === false
          ? '有问题等待你的选择'
          : state.content?.slice(0, 70)
    }
    if (!state.previewDetails && state.mode !== 'question')
      state.detail = proactivePhaseLabels[state.phase ?? state.mode] ?? '任务状态已更新'
    if (store.config.islandEnabled === false) state = { mode: 'hidden' }
    const key = JSON.stringify(state)
    if (
      key !== indicatorKey ||
      ((!indicator.visible || indicator.snapshot().mode === 'hidden') && state.mode !== 'hidden')
    ) {
      indicatorKey = key
      indicatorUpdate = indicator.update(state).catch(async (error) => {
        indicatorKey = ''
        autoAgentWork?.pauseAll('控制提示无法显示，已暂停自动推进')
        await Promise.allSettled([
          sessionControl?.stopAll(),
          violoop?.stop(),
          desktop?.stop(),
          proactive?.stop(),
        ])
        throw error
      })
    }
    await indicatorUpdate
  }
  async function stopControl() {
    autoAgentWork?.pauseAll('用户停止了 Coloop 自动控制；外部 Agent 停止另行操作')
    stopUnconfirmed = false
    const runningTask = store.tasks.find((task) => task.status === 'running')
    if (runningTask && tasks.running) tasks.cancel(runningTask.id)
    await Promise.allSettled([sessionControl!.stopAll(), violoop?.stop(), proactive?.stopAndWait()])
    await desktop?.stop().catch(() => {})
    await syncControlIndicator().catch(() => {})
    const deadline = Date.now() + 8000
    while (
      (sessionControl!.snapshot().controlActive ||
        desktop?.active ||
        violoop?.active ||
        proactive?.active) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100))
    if (
      sessionControl!.snapshot().controlActive ||
      desktop?.active ||
      violoop?.active ||
      proactive?.active
    ) {
      stopUnconfirmed = true
      await syncControlIndicator().catch(() => {})
      throw new Error('停止控制尚未确认，请检查原会话')
    }
    proactive?.acknowledgeStopped()
    await syncControlIndicator()
  }
  async function submitSessionCommand(input: unknown) {
    credentials!.assertObservationAllowed()
    if (desktop?.active || violoop?.active || proactive?.active)
      throw new Error('请先停止当前 RK 电脑操作')
    if (settingsChanging) throw new Error('正在更新工作区配置，请稍后发送控制指令')
    controlAdmissions++
    try {
      const command = await sessionControl!.submit(input)
      await syncControlIndicator()
      return command
    } finally {
      controlAdmissions--
    }
  }
  mobileGateway = new RemoteGatewayService({
    directory: join(directory, 'mobile-remote'),
    encrypt(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('REMOTE_STORAGE_UNAVAILABLE')
      return safeStorage.encryptString(value).toString('base64')
    },
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    hostName: hostname(),
    onChange: notify,
    getSnapshot: () => {
      credentials!.assertObservationAllowed()
      return {
        hostName: hostname(),
        approval: pendingTaskApproval(
          proactive?.snapshot(),
          conversations?.titleOf(proactive?.snapshot().taskId),
        ),
        sessionControl: {
          ...sessionControl!.snapshot(),
          controlActive:
            sessionControl!.snapshot().controlActive || !!desktop?.active || !!violoop?.active,
          unconfirmedCount:
            sessionControl!.snapshot().unconfirmedCount +
            (desktop?.snapshot().phase === 'unconfirmed' ? 1 : 0),
        },
        progress: [
          ...projectTaskProgress(store.tasks, scheduler?.snapshot().entries ?? []),
          ...sessionControl!.projectProgress(hooks?.snapshot(true)),
        ].slice(0, 64),
        violoop: violoop!.snapshot(),
        connection: {
          rk:
            board.state.status === 'connected' &&
            board.state.qwenReady &&
            board.state.modelPrivacyReady
              ? 'ready'
              : autoConnection?.snapshot().phase === 'needs_setup'
                ? 'needs_setup'
                : ['connecting', 'starting_model', 'waiting'].includes(
                      autoConnection?.snapshot().phase ?? '',
                    )
                  ? 'connecting'
                  : autoConnection?.snapshot().phase === 'paused'
                    ? 'paused'
                    : 'offline',
          message: autoConnection?.snapshot().message ?? '正在检查 RK 连接',
          autoConnect: connectionSettings.enabled,
          phase: autoConnection?.snapshot().phase,
        },
      }
    },
    answerApproval: async (input) => {
      credentials!.assertObservationAllowed()
      const pending = pendingTaskApproval(proactive?.snapshot())
      if (!pending || pending.taskId !== input.taskId || pending.questionId !== input.questionId)
        throw new Error('APPROVAL_STALE')
      await foregroundCapture!.restoreTarget()
      const answer = input.decision === 'allowed-once' ? '允许本次' : '拒绝本次'
      proactive!.answer(input.taskId, input.questionId, answer)
      conversations?.recordAnswer(input.taskId, answer)
    },
    command: submitSessionCommand,
    reconnect: () => {
      credentials!.assertObservationAllowed()
      autoConnection!.retryNow()
    },
    violoopMessage: (input, deviceId) => violoop!.submit(input, deviceId),
    stop: stopControl,
    resume: async () => {
      if (desktop?.active || violoop?.active || proactive?.active)
        throw new Error('请先确认 RK 停止状态')
      await sessionControl!.resume()
      stopUnconfirmed = false
    },
  })
  mobileTunnel = new RemoteTunnel({
    executable: app.isPackaged
      ? join(process.resourcesPath, 'runtime/cloudflared.exe')
      : join(app.getAppPath(), '.cache/cloudflared/cloudflared.exe'),
    directory: join(directory, 'mobile-tunnel'),
    onChange: notify,
  })
  mobileRelay = new RemoteRelay(notify)
  mobileRelayConfig = new RemoteRelayConfig(directory, {
    encrypt(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用')
      return safeStorage.encryptString(value).toString('base64')
    },
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  })
  indicator = new ControlIndicatorWindow({
    preloadPath: join(import.meta.dirname, '../preload/control.cjs'),
    rendererPath: join(import.meta.dirname, '../renderer/index.html'),
    developmentUrl: isDevelopment ? developmentUrl : undefined,
    onStop: stopControl,
    onOpenMain: (taskId) => {
      showMain()
      if (taskId) window?.webContents.send('app:open-task', taskId)
    },
    placementFile: join(directory, 'island-placement.json'),
    onRememberTarget: () => foregroundCapture!.rememberTarget(),
    onRestoreTarget: async () => {
      await foregroundCapture!.restoreTarget()
    },
    onAcceptSuggestion: async (id) => {
      await proactive!.acceptSuggestion(id)
    },
    onDismissSuggestion: async (id) => {
      proactive!.dismissSuggestion(id)
    },
    onDismissResult: async (taskId) => {
      proactive!.dismissResult(taskId)
      await syncControlIndicator()
    },
    onAnswerQuestion: async (answer) => {
      proactive!.answer(answer.taskId, answer.questionId, answer.answer)
      conversations?.recordAnswer(answer.taskId, answer.answer)
    },
    onStartTask: async (goal) => {
      await foregroundCapture!.rememberTarget()
      window?.minimize()
      await foregroundCapture!.restoreTarget()
      if (!conversations) throw new Error('任务聊天服务尚未就绪')
      const activeId = proactive?.active ? proactive.snapshot().taskId : undefined
      const conversationId =
        (activeId && conversations.ownerOf(activeId)) || conversations.create({})
      conversations.send({ conversationId, messageId: randomUUID(), text: goal })
    },
    onPauseObservation: async (paused) => {
      observationPaused = paused
      if (paused) foreground?.pause('user')
      else foreground?.resume('user')
      await syncControlIndicator()
      notify()
    },
    onUnavailable: async () => {
      indicatorKey = ''
      await Promise.allSettled([
        sessionControl!.stopAll(),
        violoop?.stop(),
        desktop?.stop(),
        proactive?.stop(),
      ])
    },
  })
  const resourceDirectory = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), 'resources')
  const voice = new VoiceTranscriptionService(join(resourceDirectory, 'voice-runtime.ps1'))
  const doclingHome =
    process.env.COLOOP_DOCLING_HOME ||
    (app.isPackaged
      ? join(process.resourcesPath, 'runtime', 'docling')
      : join(app.getAppPath(), '.cache', 'docling'))
  const docling = new DoclingService({
    pythonPath: join(doclingHome, '.venv', 'Scripts', 'python.exe'),
    workerPath: join(resourceDirectory, 'docling-worker.py'),
    cacheDirectory: join(directory, 'document-cache'),
    modelDirectory: join(doclingHome, 'models'),
  })
  foregroundCapture = new WindowsObservationCapture({
    recognize: (png, signal) => ocr.recognize(png, signal),
    excludedBounds: () => {
      const bounds = indicator?.getBounds()
      return bounds ? [bounds] : []
    },
  })
  const cuaExecutable =
    process.env.COLOOP_CUA_DRIVER_PATH ||
    (app.isPackaged
      ? join(resourceDirectory, 'runtime', 'cua-driver', 'cua-driver.exe')
      : join(app.getAppPath(), '.cache', 'cua-driver', 'cua-driver.exe'))
  const cuaClient =
    process.env.COLOOP_CUA !== 'off' && existsSync(cuaExecutable)
      ? new CuaDriverClient({
          executable: cuaExecutable,
          stateDirectory: join(directory, 'cua-state'),
        })
      : undefined
  const cuaDesktop = cuaClient
    ? new CuaDesktop({
        client: cuaClient,
        metadata: () => foregroundCapture!.metadata(),
        assertAllowed: () => credentials!.assertObservationAllowed(),
        guard: (view, action) => foregroundCapture!.guard(view, action),
      })
    : undefined
  clipboardLeases = new ClipboardLeaseService(join(resourceDirectory, 'clipboard-lease.ps1'))
  const canObserveForeground = () =>
    !exiting &&
    !settingsChanging &&
    !credentials!.snapshot().protected &&
    (!tasks.running || !!coordinatedTaskId) &&
    !desktop?.active &&
    (!violoop?.active || (mobileTarsTaskId !== undefined && mobileTarsTaskId === violoop.taskId)) &&
    !coordinator?.snapshot().reviewing &&
    !sessionControl!.snapshot().controlActive &&
    board.state.status === 'connected'
  let autoInputGuard:
    | ((op: string, view: ForegroundObservation, value: Record<string, unknown>) => Promise<void>)
    | undefined
  let autoPasteVerification: AutoAgentDesktop['verifyPaste'] | undefined
  const tarsInput: TarsAgentOptions['input'] = async (op, observation, value) => {
    credentials!.assertObservationAllowed()
    const view = observation as unknown as ForegroundObservation
    await autoInputGuard?.(op, view, value)
    const action = value.action as ObservationAction & { text?: string }
    if (op === 'clipboard.verify')
      return (
        (await autoPasteVerification?.(view, value)) ??
        foregroundCapture!.verifyText(view, action.text ?? '')
      )
    if (op === 'completion.verify')
      return value.evidence_mode === 'control_state'
        ? foregroundCapture!.verifyControlState(view, value.expected_state)
        : value.evidence_mode === 'visible_text'
          ? foregroundCapture!.verifyVisibleText(view, String(value.expected_text ?? ''))
          : foregroundCapture!.verifyCurrentText(
              view,
              String(value.expected_text ?? ''),
              value.exact === true,
            )
    const checked =
      op === 'input.guard'
        ? await foregroundCapture!.guard(view, action)
        : await foregroundCapture!.validate(view, action)
    if (!checked.allowed) throw inputTargetFailure(checked.checks)
    return checked
  }
  const tarsBridge = new RkTarsBridge({
    namespace: rkMemoryNamespace(process.env.COLOOP_DATA_DIR ? directory : undefined),
    executorScript: join(resourceDirectory, 'rk-execution-adapter.py'),
    memoryScript: join(resourceDirectory, 'rk-memory-worker.py'),
    supportScript: join(resourceDirectory, 'rk-proactive-agent.py'),
    openRuntime: (source) => board.openDesktopRuntime(source),
    input: tarsInput,
    clipboard: (op, value) => clipboardLeases!.call(op, value),
    releaseClipboard: (taskId) => clipboardLeases!.releaseTask(taskId),
    prepareInput: syncControlIndicator,
    onMemorySaved: (taskId, saved) => proactive?.memorySaved(taskId, saved),
    onDisconnected: () => proactive?.disconnected(),
  })
  const tarsModel: TarsAgentOptions['model'] = () => {
    if (store.config.provider.protocol !== 'openai')
      throw new Error('电脑操作需要 OpenAI 兼容协议，请在设置中选择兼容的云端模型')
    if (!store.apiKey) throw new Error('请先在设置中保存云端模型 API Key')
    const capacity = cloudModelCapacity(store.config.provider)
    return {
      provider: 'openai',
      id: store.config.provider.model,
      apiKey: store.apiKey,
      baseURL: store.config.provider.baseUrl,
      contextWindow: capacity.contextWindow,
      maxOutputTokens: capacity.maxOutputTokens,
    }
  }
  const agentEngine = 'harness'
  const browserPreferences = new BrowserPreferences(tarsBridge)
  const webReader = new WebReader(
    false,
    browserPreferences,
    process.env.COLOOP_DATA_DIR
      ? join(directory, 'browser-profiles')
      : 'D:/Coloop/runtime-data/browser-profiles',
    !process.env.COLOOP_DATA_DIR,
  )
  let lastPhase: { taskId: string; phase: string; at: number; model?: string } | undefined
  proactive = new TarsAgentService({
    createRuntime: (options) =>
      createAgentRuntime(agentEngine, {
        ...options,
        runtimeResources: join(resourceDirectory, 'harness'),
        playwrightToken: readPlaywrightExtensionToken,
        nodePath: app.isPackaged
          ? join(resourceDirectory, 'runtime', 'node', 'node.exe')
          : join(app.getAppPath(), '.cache', 'node-runtime', 'node.exe'),
      }),
    runtimeName: agentEngine,
    checkpoints: new ExecutionCheckpointStore(join(directory, 'execution-checkpoints')),
    modelUsage,
    modelLimits: () => store.config.modelLimits,
    workspace: directory,
    useBrowserExtension:
      !process.env.COLOOP_DATA_DIR || process.env.COLOOP_BROWSER_EXTENSION === '1',
    resolveBrowser: async (goal, taskId) =>
      (await browserPreferences.resolve(goal, taskId)).settings,
    readWeb: (request, goal, signal) => webReader.read(request, goal, signal),
    configureBrowser: (input, goal, taskId) => browserPreferences.configure(input, goal, taskId),
    openWeb: (goal, signal, complete, taskId, settings) =>
      webReader.session(
        goal,
        signal,
        process.env.COLOOP_BROWSER_RUNTIME === 'playwright' ||
          store.config.browserEngine === 'playwright'
          ? undefined
          : complete,
        taskId,
        settings,
      ),
    schedule: async (input) => {
      if (!scheduler) throw new Error('SCHEDULER_NOT_READY')
      return scheduler.create(input)
    },
    openWorkspace: (root) =>
      WorkspaceSession.open(
        root,
        join(resourceDirectory, 'office-runtime.ps1'),
        (path) => shell.openPath(path),
        (windowId, processId) => foregroundCapture!.focusTaskWindow(windowId, processId),
        (bytes, signal) => ocr.recognize(bytes, signal),
        (path, options, signal) => docling.read(path, options, signal),
      ),
    model: tarsModel,
    recommendLocal: async (content, signal) => {
      credentials!.assertObservationAllowed()
      const started = performance.now()
      let completed = false
      try {
        const answer = await board.privacyAgent(localSuggestionSystem, content, signal, 256)
        completed = true
        return answer
      } finally {
        await appendFile(
          join(directory, 'rk-model-metrics.jsonl'),
          JSON.stringify({
            event: 'recommendation',
            at: Date.now(),
            elapsed_ms: Math.round(performance.now() - started),
            input_bytes: Buffer.byteLength(localSuggestionSystem + content),
            max_tokens: 256,
            completed,
            aborted: signal.aborted,
          }) + '\n',
          { encoding: 'utf8', mode: 0o600 },
        ).catch(() => {})
      }
    },
    consult: (kind, facts, signal) =>
      cloud.analyze(
        store.config.provider,
        store.apiKey,
        { question: cloudConsultQuestions[kind], facts: facts.map((fact) => JSON.stringify(fact)) },
        signal,
      ),
    localModel: () => {
      if (!board.state.qwenReady || !board.state.modelPrivacyReady) return undefined
      const capacity = board.localCapacity()
      const limits = effectiveModelLimits(store.config.modelLimits)
      const extra = limits.mode === 'custom' ? limits.maxOutputTokens : undefined
      const budget = localOutputBudget(
        capacity,
        undefined,
        store.config.localModel?.outputTokens,
        extra,
      )
      return {
        model: {
          ...rkTarsModel,
          contextWindow: capacity.contextWindow,
          maxOutputTokens: budget.tokens,
          maximumOutputTokens: Math.min(
            capacity.maximumOutputTokens,
            extra ?? capacity.maximumOutputTokens,
          ),
        },
        fetch: createRkTarsFetch(async (system, messages, signal, maxTokens) => {
          const id = randomUUID()
          const started = Date.now()
          const metric = (value: Record<string, unknown>) =>
            appendFile(
              join(directory, 'rk-model-metrics.jsonl'),
              JSON.stringify({
                id,
                taskId: proactive?.snapshot().taskId,
                model: rkTarsModel.id,
                at: Date.now(),
                ...value,
              }) + '\n',
              { encoding: 'utf8', mode: 0o600 },
            ).catch(() => {})
          await metric({
            event: 'request',
            system_bytes: Buffer.byteLength(system),
            turns_bytes: Buffer.byteLength(JSON.stringify(messages)),
            turns: messages.length,
            context_budget_bytes: rkContextBudgetBytes,
            max_tokens: maxTokens,
          })
          try {
            const answer = await board.privacyConversationResult(
              system,
              messages,
              signal,
              maxTokens,
            )
            await metric({
              event: 'response',
              elapsed_ms: Date.now() - started,
              output_bytes: Buffer.byteLength(answer.text),
              finishReason: answer.finishReason,
              budgetSource: maxTokens === budget.tokens ? budget.source : 'dsh-compaction',
              promptTokens: answer.promptTokens,
              completionTokens: answer.completionTokens,
            })
            return answer
          } catch (error) {
            await metric({
              event: 'error',
              elapsed_ms: Date.now() - started,
              aborted: signal.aborted,
              context_limit: error instanceof Error && error.message.includes('预算不足'),
            })
            throw error
          }
        }, capacity),
      }
    },
    preferLocal: () => (store.config.executionMode ?? store.config.autoTaskRouting) !== 'cloud',
    allowCloudContextFallback: () => store.config.allowCloudFallback !== false,
    executionPolicy: () => ({
      mode: store.config.executionMode ?? store.config.autoTaskRouting ?? 'cloud',
      cloudFallback: store.config.allowCloudFallback !== false,
    }),
    conversationHistory: (id, offset, limit) => conversations!.contextPage(id, offset, limit),
    onHandoff: (value) =>
      appendFile(
        join(directory, 'model-route-events.jsonl'),
        JSON.stringify({ ...value, model: value.to, event: 'handoff' }) + '\n',
        { mode: 0o600 },
      ),
    selectAutoRoute: (goal, signal, mode) =>
      (mode ?? store.config.executionMode ?? store.config.autoTaskRouting) === 'local'
        ? Promise.resolve('rk')
        : (mode ?? store.config.executionMode ?? store.config.autoTaskRouting) !== 'local-auto'
          ? Promise.resolve('cloud')
          : classifyAutoTask(goal, signal, (content, boundedSignal) =>
              board.privacyAgent(autoTaskRoutePolicy, content, boundedSignal, 16),
            ),
    fetch: async (input, init) => {
      credentials!.assertObservationAllowed()
      const response = await (net.fetch as typeof fetch)(input, init)
      return response
    },
    execution:
      cuaDesktop && process.env.COLOOP_MOUSE_BACKEND !== 'rk'
        ? createCuaExecution({
            fallback: tarsBridge,
            journalDirectory: join(directory, 'cua-input-journal'),
            mouse: cuaDesktop,
            prepareInput: syncControlIndicator,
            validate: async (view, action) => {
              credentials!.assertObservationAllowed()
              return foregroundCapture!.validate(view as unknown as ForegroundObservation, action)
            },
            guard: async (view, action) => {
              credentials!.assertObservationAllowed()
              return foregroundCapture!.guard(view as unknown as ForegroundObservation, action)
            },
          })
        : tarsBridge,
    memory: tarsBridge,
    onObservationRetry: (id) => foreground?.retryObservation(id),
    available: () => board.state.status === 'connected',
    assertStart: () => {
      credentials!.assertObservationAllowed()
      if (!board.state.qwenReady || !board.state.modelPrivacyReady) tarsModel()
      if (
        !canObserveForeground() ||
        board.busy ||
        modelDebug?.busy() ||
        stopUnconfirmed ||
        sessionControl!.snapshot().stopped
      )
        throw new Error('请先连接 RK 并结束其他任务或恢复控制')
    },
    observe: async () => {
      credentials!.assertObservationAllowed()
      foreground!.pause('task')
      const deadline = Date.now() + 10000
      while (ocr.busy && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20))
      if (ocr.busy) throw new Error('OBSERVATION_RETRY')
      let view: ForegroundObservation | null
      try {
        view = await foregroundCapture!.capture(undefined, true)
      } catch (error) {
        // Capturing/OCR is read-only. A transient failure needs a fresh capture,
        // not termination of the task. Privacy and stop checks stay outside this catch.
        if (error instanceof Error && error.message === 'OBSERVATION_TARGET_UNAVAILABLE')
          throw new Error(
            'OBSERVATION_TARGET_UNAVAILABLE: 当前前台是助手窗口，无法恢复目标应用。网页任务请启用web工具；原生窗口任务请用户切到目标应用后再观察。',
          )
        throw new Error('OBSERVATION_RETRY')
      }
      credentials!.assertObservationAllowed()
      if (!view) throw new Error('OBSERVATION_RETRY')
      if (cuaDesktop) view = await cuaDesktop.enrich(view)
      credentials!.assertObservationAllowed()
      return view as unknown as import('./services/proactive-agent').ProactiveObservation
    },
    input: tarsInput,
    prepareInput: syncControlIndicator,
    readEditor: (observation, targetId) =>
      foregroundCapture!.readEditor(observation as unknown as ForegroundObservation, targetId),
    onChange: () => {
      const current = proactive?.snapshot()
      if (
        current?.taskId &&
        (lastPhase?.taskId !== current.taskId || lastPhase.phase !== current.phase)
      ) {
        const at = Date.now()
        const previous = lastPhase?.taskId === current.taskId ? lastPhase : undefined
        const phase = previous?.phase ?? current.phase
        void appendFile(
          join(directory, 'model-route-events.jsonl'),
          JSON.stringify({
            taskId: current.taskId,
            model: previous?.model ?? current.model,
            at,
            event: previous ? 'phase-ended' : 'phase-started',
            phase,
            elapsedMs: previous ? at - previous.at : undefined,
            durationKind:
              phase === 'waiting_user' || phase === 'input_unknown'
                ? 'user_wait'
                : phase === 'planning'
                  ? 'model_wait'
                  : ['executing', 'observing', 'verifying'].includes(phase)
                    ? 'tool_execution'
                    : 'lifecycle',
          }) + '\n',
          { mode: 0o600 },
        ).catch(() => {})
        lastPhase = { taskId: current.taskId, phase: current.phase, at, model: current.model }
      }
      if (proactive && !tasks.running) {
        const state = proactive.snapshot()
        try {
          syncRecoveredTaskHistory(store, state, proactivePhaseLabels[state.phase] ?? state.phase)
        } catch (error) {
          console.error('RECOVERED_TASK_HISTORY_SAVE_FAILED', error)
        }
      }
      violoop?.observeDesktop()
      if (proactive?.active) foreground?.pause('task')
      else foreground?.resume('task')
      notify()
    },
  })
  void proactive
    .refreshRecoverable()
    .catch((error) => console.error('TASK_RECOVERY_LOAD_FAILED', error))
  foreground = new ForegroundObservationService({
    capture: (signal) => foregroundCapture!.captureFrame(signal),
    recognize: (frame, signal) => foregroundCapture!.recognize(frame, signal),
    isOcrBusy: () => ocr.busy,
    minRecommendationIntervalMs: 5000,
    // A passive recommendation owns RK inference. Skip capture while the model
    // is busy without pausing/invalidation, which would abort that same request.
    canObserve: () =>
      canObserveForeground() &&
      !board.busy &&
      !modelDebug?.busy() &&
      !proactive!.active &&
      !autoAgentWork?.bound,
    isInteracting: () => indicator?.isInteracting ?? false,
    onInvalidated: () => proactive?.cancelObservation(),
    onObservation: (view) =>
      proactive!.submitObservation(
        view as unknown as import('./services/proactive-agent').ProactiveObservation,
      ),
  })
  const autoHooks = new AutoAgentWorkHooks()
  let autoHookStatus: AutoAgentHookStatus = { installed: false, trust: 'unknown' }
  const autoRoots = new Set(workspaceRoots())
  if (store.config.taskWorkspace) autoRoots.add(store.config.taskWorkspace)
  try {
    const saved: unknown = JSON.parse(
      await readFile(join(directory, 'auto-agent-roots.json'), 'utf8'),
    )
    for (const root of z.array(z.string().min(1).max(2048)).max(64).parse(saved))
      autoRoots.add(root)
  } catch {
    /* No installed project hooks yet. */
  }
  const autoNode = app.isPackaged
    ? join(resourceDirectory, 'runtime', 'node', 'node.exe')
    : join(app.getAppPath(), '.cache', 'node-runtime', 'node.exe')
  await codexSessionTitles.refresh()
  chatgptAdapter = new ChatGPTDesktopAdapter({
    workspaceRoots: () => [...autoRoots],
    onChange: notify,
    onEvent: (event, session) => {
      void codexSessionTitles.refresh().then(notify)
      autoHooks.markObserved(session.workspace)
      if (
        autoHookStatus.installed &&
        autoHookStatus.workspace?.toLowerCase() === session.workspace.toLowerCase()
      )
        autoHookStatus = { ...autoHookStatus, trust: 'observed' }
      void autoAgentWork
        ?.observe(event, codexSessionTitles.session(session))
        .catch((error) => console.error('AUTO_AGENT_EVENT_FAILED', error))
    },
    claimContinuation: (action) =>
      autoAgentWork?.claimNative(action.actionId, action.sessionId, action.taskVersion) ?? false,
    onNativeContinuation: (receipt) =>
      autoAgentWork?.receipt(
        receipt.actionId,
        receipt.status === 'submitted' ? 'accepted' : receipt.status,
        receipt.status,
      ),
  })
  try {
    const started = await chatgptAdapter.start({
      connectionDirectory: join(directory, 'auto-agent-connection'),
    })
    autoHookStatus.connectionPath = started.connectionPath
    const status = await autoHooks.status(store.config.taskWorkspace ?? app.getAppPath())
    autoHookStatus = { ...status, connectionPath: started.connectionPath }
  } catch (error) {
    autoHookStatus.error = error instanceof Error ? error.message : 'HOOK_START_FAILED'
  }
  openCodeAuto = new AutoAgentOpenCode(sessionControl, (event, session) => {
    void autoAgentWork?.observe(event, session).catch(() => {})
  })
  const autoSessions = () =>
    [...chatgptAdapter!.snapshot().sessions, ...openCodeAuto!.sessions()].map((session) =>
      codexSessionTitles.session(session),
    )
  const autoUia = new AutoWorkUiaObservation(
    app.isPackaged
      ? join(resourceDirectory, 'auto-work-uia')
      : join(app.getAppPath(), '.cache', 'auto-work-uia-runtime'),
  )
  const autoDesktop = new AutoAgentDesktop({
    capture: foregroundCapture!,
    cua: cuaDesktop,
    execution: tarsBridge,
    session: (id) => autoSessions().find((row) => row.id === id),
    assertAvailable: () => {
      credentials!.assertObservationAllowed()
      if (
        tasks.running ||
        desktop?.active ||
        violoop?.active ||
        proactive?.active ||
        sessionControl!.snapshot().controlActive ||
        stopUnconfirmed ||
        exiting
      )
        throw new Error('其他任务正在占用执行层')
    },
    registerMessage: (task, action, text) =>
      chatgptAdapter!.expectExternalMessage({
        actionId: action.id,
        sessionId: task.session.id,
        turnId: task.session.turnId ?? '',
        taskVersion: task.version,
        eventRevision: task.session.revision,
        reason: text,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      }),
    renewMessage: (task, action, text) =>
      chatgptAdapter!.renewExternalMessage(
        {
          actionId: action.id,
          sessionId: task.session.id,
          turnId: task.session.turnId ?? '',
          taskVersion: task.version,
          eventRevision: task.session.revision,
          reason: text,
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        },
        { nativeSessionId: task.session.sessionId, workspace: task.session.workspace },
      ),
    forgetMessage: (id) => chatgptAdapter!.forgetExternalMessage(id),
    structuredText: async (windowId, processId) => {
      let text = ''
      await autoUia.observe({
        pid: processId,
        hwnd: windowId,
        onSnapshot: (value) => {
          text = [value.title, ...value.messages].join('\n')
        },
      })
      return text
    },
  })
  const autoPlanner = new AutoAgentPlanner({
    workspace: directory,
    nodePath: autoNode,
    runtimeResources: join(resourceDirectory, 'harness'),
    model: () => store.decisionModel(),
    usage: modelUsage,
    fetch: net.fetch as typeof fetch,
    observe: (task, mode, signal) => autoDesktop.observe(task, mode, signal),
  })
  autoInputGuard = (op, view, value) => autoDesktop.guardInput(op, view, value)
  autoPasteVerification = (view, value) => autoDesktop.verifyPaste(view, value)
  autoAgentWork = new AutoAgentWorkService({
    directory,
    canAutoBind: () => {
      try {
        credentials!.assertObservationAllowed()
      } catch {
        return false
      }
      return !tasks.running && !proactive?.active && !desktop?.active && !violoop?.active
    },
    sessions: autoSessions,
    hooks: () => autoHookStatus,
    events: (id) => chatgptAdapter!.events(id),
    onChange: () => {
      if (autoAgentWork?.active) foreground?.pause('task')
      else if (!proactive?.active) foreground?.resume('task')
      notify()
    },
    memory: (task) => retrieveAutoAgentMemory(task, tarsBridge),
    feedback: (task, feedback) => persistAutoAgentFeedback(task, feedback, tarsBridge),
    onUserChoice: (task, event) => persistAutoAgentChoice(task, event, tarsBridge),
    usage: (id) => modelUsage.taskSnapshot(id),
    decide: (task, signal) => autoPlanner.decide(task, signal),
    invalidate: (id) => chatgptAdapter!.invalidate(id),
    recoverDraft: (task, action, signal, claim) =>
      autoDesktop.resumeDraft(task, action, signal, claim),
    channel: (task) =>
      task.session.source === 'opencode'
        ? 'opencode'
        : chatgptAdapter!.hasPendingStop(task.session.id)
          ? 'native'
          : 'desktop',
    dispatch: async (task, action, signal) => {
      signal.throwIfAborted()
      if (action.channel === 'opencode') {
        const command = await sessionControl!.submit({
          commandId: action.id,
          sessionHandle: task.session.id,
          action: 'send_message',
          text: `[Coloop Auto Agent Work:${action.id}]\n${action.message}`,
        })
        return {
          status: command.status === 'confirmed' ? 'confirmed' : 'accepted',
          receipt: command.commandId,
        }
      }
      if (action.channel === 'native') {
        const ready = await chatgptAdapter!.prepareAndWaitContinuation({
          actionId: action.id,
          sessionId: task.session.id,
          turnId: task.session.turnId ?? '',
          taskVersion: task.version,
          eventRevision: task.session.revision,
          reason: `[Coloop Auto Agent Work:${action.id}]\n${action.message}`,
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        })
        if (!ready)
          return autoDesktop.send(task, autoAgentWork!.fallbackNativeAction(action.id), signal)
        return { status: 'prepared' }
      }
      return autoDesktop.send(task, action, signal)
    },
    stopAgent: async (task) => {
      if (task.session.source === 'opencode') {
        await sessionControl!.submit({
          commandId: randomUUID(),
          sessionHandle: task.session.id,
          action: 'abort_turn',
        })
        return
      }
      throw new Error('此桌面实例尚无已验证的原生停止接口；自动推进已暂停，请在原会话停止 Agent')
    },
  })
  const managedAuthority = new ManagedApprovalAuthority({
    origin: (event) => hooks?.resolveOrigin(event),
    verifySource: (enrollment, evidence) => board.verifyManagedSource(enrollment, evidence),
  })
  coordinator = new CoordinatorService({
    managedAuthority,
    generate: (prompt, signal, compact) => board.review(prompt, signal, compact),
    isBusy: () =>
      tasks.running || board.busy || !!desktop?.active || !!violoop?.active || !!proactive?.active,
    workspaceRoots,
    onChange: notify,
    auditPath: join(directory, 'agent-coordinator', 'audit.jsonl'),
    resolveContext: (event) => hooks?.resolveContext(event),
    beforeGenerate: (event) =>
      hooks ? hooks.prepareReview(event) : Promise.reject(new Error('HOOK_SERVICE_UNAVAILABLE')),
    hookHandler: async (path, input) => {
      if (!hooks) throw new Error('HOOK_SERVICE_UNAVAILABLE')
      const result = await (path === '/v1/hooks/review'
        ? hooks.reviewHook(input)
        : hooks.ingest(input))
      if (path === '/v1/hooks') {
        await sessionControl!.observeHook(input).catch(() => {})
        openCodeAuto?.observe(input)
      }
      return result
    },
    controlHandler: async (path, input) => {
      try {
        if (settingsChanging) throw new ReviewInputError('CONTROL_CONFIG_CHANGING', 503)
        if (path === '/v1/control/register') return await sessionControl!.register(input)
        if (path === '/v1/control/report') return await sessionControl!.report(input)
        // A source cannot collect a write command until the visible control notice is ready.
        // If the notice fails, stopAll cancels pending writes; aborts remain deliverable.
        await syncControlIndicator().catch(() => {})
        const result = await sessionControl!.poll(input)
        if (result.commands.some((command) => command.action === 'send_message')) {
          try {
            // A submit already waiting in the service queue may have become active
            // after the first snapshot. Gate the actual HTTP delivery as well.
            await syncControlIndicator()
          } catch {
            await sessionControl!.stopAll()
          }
        }
        return {
          ...result,
          commands: result.commands.filter((command) =>
            sessionControl!.canDeliver(command.commandId),
          ),
        }
      } catch (error) {
        if (error instanceof SessionControlError)
          throw new ReviewInputError(error.reasonCode, error.status)
        throw error
      }
    },
  })
  const createHooks = () =>
    new AgentHookService({
      review: (event) => coordinator!.review(event),
      workspaceRoots,
      onChange: notify,
      onActivity: (lease, active) =>
        board.state.status === 'connected'
          ? board.setHookActivity(lease, active)
          : Promise.resolve(),
      managedCurrent: (event) => managedAuthority.isCurrent(event),
    })
  hooks = createHooks()
  try {
    const token = randomBytes(32).toString('hex')
    // Random loopback port avoids taking over another local service.
    const { url } = await coordinator.start({ port: 0, token })
    connection = publishConnection(join(directory, 'agent-coordinator'), url, token)
    coordinatorAccess = { url, token }
  } catch {
    await coordinator.dispose()
    coordinationError = '协调服务未能安全启动，请检查本地凭据目录权限后重启 Coloop'
  }

  const busyForQuit = () =>
    tasks.running ||
    proactive?.active ||
    desktop?.active ||
    violoop?.active ||
    autoAgentWork?.active ||
    sessionControl?.snapshot().controlActive ||
    coordinator?.snapshot().reviewing ||
    ocr.busy ||
    board.busy

  function handle<T>(channel: string, action: (...args: any[]) => T | Promise<T>) {
    commands.register(channel, action)
    ipcMain.handle(channel, async (event, ...args): Promise<Result<T>> => {
      try {
        const frame = event.senderFrame
        if (
          !window ||
          event.sender !== window.webContents ||
          frame !== window.webContents.mainFrame
        )
          throw new Error('调用来源无效')
        const url = frame.url
        const trusted =
          developmentUrl && isDevelopment
            ? new URL(url).origin === new URL(developmentUrl).origin
            : url === pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
        if (!trusted) throw new Error('调用来源无效')
        return { ok: true, value: await action(...args) }
      } catch (error) {
        const controlErrors: Record<string, string> = {
          SOURCE_OFFLINE: '会话已离线，请检查 OpenCode 与 Coloop 的连接',
          SESSION_BUSY: '会话正在执行，请等待当前执行结束后再发送要求',
          CONTROL_STOPPED: '控制已停止，请先在会话控制面板重新允许控制',
          WINDOWS_SESSION_REQUIRED: '当前只能控制这台 Windows 电脑上的 OpenCode 会话',
          SESSION_NOT_FOUND: '会话已失效，请重新选择已连接的会话',
          SESSION_NOT_CONTROLLED: '当前会话没有由 Coloop 发起的控制',
          UNSUPPORTED_CAPABILITY: '这个会话不支持该操作',
          INVALID_SESSION_COMMAND: '要求为空、过长或格式无效，请缩短后重试',
          CONTROL_JOURNAL_UNAVAILABLE: '控制记录无法保存，已阻止新的控制指令',
          COMMAND_CONFLICT: '这条指令的标识已被其他内容使用，请重新发起',
        }
        return {
          ok: false,
          error:
            error instanceof SessionControlError
              ? (controlErrors[error.reasonCode] ?? `会话控制未完成（${error.reasonCode}）`)
              : errorMessage(error),
        }
      }
    })
  }
  handle('app:get', () => snapshot())
  modelDebug = new ModelDebugService(directory, {
    budget: (request) => {
      const limits = effectiveModelLimits(store.config.modelLimits)
      const extra = limits.mode === 'custom' ? limits.maxOutputTokens : undefined
      if (request.target === 'local')
        return localOutputBudget(
          board.localCapacity(),
          request.maxTokens,
          store.config.localModel?.outputTokens,
          extra,
        )
      return {
        tokens: Math.min(
          request.maxTokens ?? cloudModelCapacity(store.config.provider).maxOutputTokens,
          extra ?? Infinity,
        ),
        source: request.maxTokens === undefined ? 'model' : 'request',
      }
    },
    model: (target) =>
      target === 'local' ? (board.state.model ?? 'RK 本地模型') : store.config.provider.model,
    localBusy: () => board.busy || !!proactive?.active || tasks.running || !!desktop?.active,
    complete: async (request, signal, onText) => {
      credentials!.assertObservationAllowed()
      if (request.target === 'local')
        return board.privacyConversationResult(
          request.system ?? '请按用户要求直接回复。',
          [{ role: 'user', content: request.prompt }],
          signal,
          request.maxTokens,
        )
      return cloud.generate(
        store.config.provider,
        store.apiKey,
        request.prompt,
        '',
        signal,
        onText,
        request.system,
        request.maxTokens ?? cloudModelCapacity(store.config.provider).maxOutputTokens,
      )
    },
    route: (prompt, signal) =>
      previewAutoTaskRoute(prompt, signal, (content, bounded) =>
        board.privacyAgent(autoTaskRoutePolicy, content, bounded, 16),
      ),
    changed: notify,
  })
  handle('model-debug:start', (input: unknown) => {
    credentials!.assertObservationAllowed()
    return modelDebug!.start(input)
  })
  handle('model-debug:get', (input: unknown) => modelDebug!.get(z.string().uuid().parse(input)))
  handle('model-debug:current', () => modelDebug!.current())
  handle('model-debug:cancel', (input: unknown) =>
    modelDebug!.cancel(z.string().uuid().parse(input)),
  )
  handle('model-debug:route', (input: unknown) => {
    credentials!.assertObservationAllowed()
    return modelDebug!.preview(z.string().trim().min(1).max(24000).parse(input))
  })
  handle('model-debug:diagnostics', (input: unknown) => modelDebug!.diagnostics(input))
  const currentPolicy = (): ExecutionPolicy => ({
    mode: store.config.executionMode ?? store.config.autoTaskRouting ?? 'cloud',
    cloudFallback: store.config.allowCloudFallback !== false,
  })
  conversations = new ConversationService(directory, {
    tasks: () => store.tasks,
    policy: currentPolicy,
    workspace: () => store.config.taskWorkspace,
    busy: () => {
      const state = proactive?.snapshot()
      const active = !!(
        tasks.running ||
        state?.active ||
        desktop?.active ||
        violoop?.active ||
        sessionControl?.snapshot().controlActive
      )
      return {
        active,
        taskId: state?.active
          ? state.taskId
          : store.tasks.find((task) => task.status === 'running')?.id,
        reason:
          state?.phase === 'input_unknown'
            ? '操作结果等待确认'
            : state?.phase === 'waiting_user'
              ? '等待当前任务的问题回答'
              : sessionControl?.snapshot().stopped
                ? '电脑控制已暂停，请恢复控制后继续'
                : modelDebug?.busy()
                  ? '本地模型测试正在进行'
                  : credentials?.snapshot().protected
                    ? '正在管理私密数据'
                    : board.state.status !== 'connected'
                      ? '等待 RK 设备连接'
                      : settingsChanging
                        ? '正在更新设置'
                        : undefined,
      }
    },
    start: (request, id, policy) => {
      credentials!.assertObservationAllowed()
      return tasks.start({ ...request, policy }, id)
    },
    append: (id, text) => {
      if (!proactive?.active || proactive.snapshot().taskId !== id) {
        tasks.append(id, text)
        return
      }
      if (proactive.snapshot().question) throw new Error('请先回答当前问题')
      proactive.appendMessage(text)
    },
    resume: async (id, task) => {
      credentials!.assertObservationAllowed()
      if (task && !store.tasks.some((entry) => entry.id === id)) {
        const previous = store.tasks
        store.tasks = [task, ...previous].slice(0, 200)
        try {
          store.persist()
        } catch (error) {
          store.tasks = previous
          throw error
        }
      }
      return proactive!.resumeTask(id)
    },
    history: async (id) => ({
      ...(await readTaskHistory(directory, id)),
      usage: modelUsage.taskSnapshot(id).requests ? modelUsage.taskSnapshot(id) : undefined,
    }),
    changed: notify,
  })
  handle('conversation:list', () => conversations!.snapshot())
  handle('conversation:create', (input: unknown) => conversations!.create(input))
  handle('conversation:get', (input: unknown) =>
    conversations!.detail(z.string().uuid().parse(input)),
  )
  handle('conversation:update', (input: unknown) => conversations!.update(input))
  handle('conversation:send', (input: unknown) => {
    credentials!.assertObservationAllowed()
    return conversations!.send(input)
  })
  handle('conversation:resume', (input: unknown) => {
    const value = conversationResumeSchema.parse(input)
    return conversations!.resume(value.conversationId, value.runId)
  })
  handle('queue:get', () => conversations!.snapshot())
  handle('queue:pause', (input: unknown) => conversations!.pause(z.boolean().parse(input)))
  handle('queue:cancel', (input: unknown) =>
    conversations!.cancel(queueCancelSchema.parse(input).runId),
  )
  handle('app:show', showMain)
  handle('app:hide', () => hideMainWindow(window))
  handle('app:quit', () => {
    if (busyForQuit()) throw new Error('APP_BUSY')
    // Queue shutdown after the HTTP response, then recheck concurrent admissions.
    setImmediate(() => {
      if (!busyForQuit()) app.quit()
    })
    return { requested: true }
  })
  handle('settings:get', () => store.publicSettings())
  handle('settings:preferences', (input: unknown) => {
    if (settingsChanging) throw new Error('设置正在保存，请稍后重试')
    const { modelLimitMode, ...preferences } = preferencesSchema.parse(input)
    const settings = store.saveSettings({
      ...store.config,
      ...preferences,
      ...(modelLimitMode
        ? {
            modelLimits: modelLimitsSchema.parse({
              ...store.config.modelLimits,
              mode: modelLimitMode,
            }),
          }
        : {}),
    })
    if (preferences.launchOnLogin !== undefined)
      app.setLoginItemSettings({
        openAtLogin: preferences.launchOnLogin,
        path: process.execPath,
        args: ['--background'],
      })
    notify()
    return settings
  })
  handle('browser:config', (input: unknown) => {
    const request = browserConfigSchema.parse(input)
    if (request.operation === 'configure' && (tasks.running || proactive?.active))
      throw new Error('BROWSER_TASK_ACTIVE')
    return browserPreferences.configure(
      request,
      request.operation === 'configure' ? request.source_quote : '',
      randomUUID(),
    )
  })
  handle('browser:connection', async (input: unknown) => {
    const browser = z.enum(['edge', 'chrome']).parse(input)
    const tokenConfigured = !!(await readPlaywrightExtensionToken())
    try {
      await discoverBrowserEndpoint(browser)
      return {
        browser,
        transport: 'playwright-extension',
        tokenConfigured,
        endpointAvailable: true,
        connected: false,
        instruction:
          '网页任务通过官方 Playwright 扩展连接当前浏览器；首次连接请在扩展页允许。endpointAvailable 仅描述可选 CDP 通道。',
      }
    } catch (error) {
      return {
        browser,
        transport: 'playwright-extension',
        tokenConfigured,
        endpointAvailable: false,
        connected: false,
        instruction:
          '网页任务通过官方 Playwright 扩展连接当前浏览器；首次连接请在扩展页允许。扩展连接无需 CDP 端点。',
        cdpError: error instanceof Error ? error.message : 'BROWSER_CONNECTION_REQUIRED',
      }
    }
  })
  handle('history:list', () => store.tasks)
  handle('auto-agent:create', (input: unknown) => {
    credentials!.assertObservationAllowed()
    if (tasks.running || proactive?.active || desktop?.active || violoop?.active)
      throw new Error('请先结束其他执行任务')
    return autoAgentWork!.create(input)
  })
  handle('auto-agent:update', (input: unknown) => autoAgentWork!.update(input))
  let autoSwitchPending = false
  handle('auto-agent:enabled', async (input: unknown) => {
    const enabled = z.boolean().parse(input)
    if (autoSwitchPending) throw new Error('开关正在设置，请稍后重试')
    autoSwitchPending = true
    try {
      if (enabled) {
        credentials!.assertObservationAllowed()
        if (!autoHookStatus.connectionPath) throw new Error('原生 Hook 接收服务未启动')
        const root = await realpath(store.config.taskWorkspace ?? app.getAppPath())
        const result = await autoHooks.install({
          workspace: root,
          nodePath: autoNode,
          scriptPath: join(resourceDirectory, 'auto-agent-work-hook.mjs'),
          connectionPath: autoHookStatus.connectionPath,
        })
        autoRoots.add(root)
        await writeFile(join(directory, 'auto-agent-roots.json'), JSON.stringify([...autoRoots]), {
          mode: 0o600,
        })
        autoHookStatus = { ...result, connectionPath: autoHookStatus.connectionPath }
      }
      return autoAgentWork!.setEnabled(enabled)
    } finally {
      autoSwitchPending = false
    }
  })
  handle('auto-agent:feedback', (input: unknown) => autoAgentWork!.feedback(input))
  let autoHookStatusRevision = 0
  handle('auto-agent:refresh', async (input: unknown) => {
    const parsed = z
      .object({ workspace: z.string().min(1).max(2048) })
      .strict()
      .optional()
      .parse(input)
    const revision = ++autoHookStatusRevision
    await codexSessionTitles.refresh(true)
    const workspace =
      parsed?.workspace ??
      autoHookStatus.workspace ??
      store.config.taskWorkspace ??
      app.getAppPath()
    const status = await autoHooks.status(workspace)
    if (revision === autoHookStatusRevision)
      autoHookStatus = { ...status, connectionPath: autoHookStatus.connectionPath }
    notify()
  })
  handle('auto-agent:test-provider', async () => {
    credentials!.assertObservationAllowed()
    if (autoAgentWork?.active || tasks.running || proactive?.active)
      throw new Error('请先暂停任务再测试模型')
    const route = store.decisionModel()
    const result = await testDecisionModel(route, {
      workspace: directory,
      cacheDirectory: join(
        app.isPackaged ? 'D:\\Coloop' : app.getAppPath(),
        '.cache',
        'auto-agent-probe',
      ),
      nodePath: autoNode,
      runtimeResources: join(resourceDirectory, 'harness'),
      usage: modelUsage,
      fetch: net.fetch as typeof fetch,
    })
    if (!store.recordDecisionModelProbe(route, result.image))
      throw new Error('测试期间模型配置已改变，请测试当前配置')
    notify()
    return `${result.text}；图像输入：${result.image === 'supported' ? '已通过真实测试' : result.image === 'unsupported' ? '端点不支持' : '未验证，必要时使用控件或 OCR'}`
  })
  handle('auto-agent:install-hooks', async (input: unknown) => {
    ++autoHookStatusRevision
    const { workspace } = z
      .object({ workspace: z.string().min(1).max(2048) })
      .strict()
      .parse(input)
    if (!autoHookStatus.connectionPath) throw new Error('原生 Hook 接收服务未启动')
    const root = await realpath(workspace)
    const result = await autoHooks.install({
      workspace: root,
      nodePath: autoNode,
      scriptPath: join(resourceDirectory, 'auto-agent-work-hook.mjs'),
      connectionPath: autoHookStatus.connectionPath,
    })
    autoRoots.add(root)
    await writeFile(join(directory, 'auto-agent-roots.json'), JSON.stringify([...autoRoots]), {
      mode: 0o600,
    })
    ++autoHookStatusRevision
    autoHookStatus = { ...result, connectionPath: autoHookStatus.connectionPath }
    notify()
    return autoHookStatus
  })
  handle('auto-agent:uninstall-hooks', async (input: unknown) => {
    ++autoHookStatusRevision
    const { workspace } = z
      .object({ workspace: z.string().min(1).max(2048) })
      .strict()
      .parse(input)
    autoAgentWork!.pauseAll('Hook 配置已变更')
    autoHookStatus = {
      ...(await autoHooks.uninstall(workspace)),
      connectionPath: autoHookStatus.connectionPath,
    }
    ++autoHookStatusRevision
    notify()
    return autoHookStatus
  })
  handle('voice:transcribe', (audio: unknown) => {
    credentials!.assertObservationAllowed()
    if (tasks.running || proactive!.active || desktop?.active || violoop?.active)
      throw new Error('TASK_BUSY')
    return voice.transcribe(audio)
  })
  handle('voice:cancel', () => voice.stop())
  handle('settings:task-workspace', async (input?: unknown) => {
    credentials!.assertObservationAllowed()
    if (tasks.running || proactive!.active || desktop?.active || violoop?.active)
      throw new Error('任务执行期间无法更改文件目录')
    let path = z.string().min(1).max(4096).optional().parse(input)
    if (path === undefined) {
      const selected = await dialog.showOpenDialog(window!, {
        properties: ['openDirectory'],
        title: '选择允许本次任务读写的文件目录',
      })
      if (selected.canceled || !selected.filePaths[0]) return undefined
      path = selected.filePaths[0]
    }
    const root = await realpath(path)
    if (!(await stat(root)).isDirectory()) throw new Error('任务文件目录必须是文件夹')
    if (tasks.running || proactive!.active || desktop?.active || violoop?.active)
      throw new Error('任务执行期间无法更改文件目录')
    store.saveSettings({ ...store.config, taskWorkspace: root })
    notify()
    return root
  })
  handle('proactive:start', async (goal: unknown) => {
    const parsedGoal = z.string().trim().min(1).max(4000).parse(goal)
    autoAgentWork?.pauseAll('用户启动了新的电脑任务')
    await foregroundCapture!.rememberTarget()
    window?.minimize()
    await foregroundCapture!.restoreTarget()
    return proactive!.startTask(parsedGoal, undefined, 'auto', store.config.taskWorkspace)
  })
  handle('proactive:stop', () => proactive!.stopAndWait())
  handle('proactive:resume', async (taskId: unknown) => {
    if (tasks.running || desktop?.active || violoop?.active || proactive!.active)
      throw new Error('请先结束当前任务')
    credentials!.assertObservationAllowed()
    return proactive!.resumeTask(z.string().uuid().parse(taskId))
  })
  handle('proactive:accept', async (input: unknown) => {
    const id = z.string().min(1).max(128).parse(input)
    if (proactive!.snapshot().suggestion?.suggestion_id !== id)
      throw new Error('这条建议已过期，请等待当前窗口的新建议')
    window?.minimize()
    await foregroundCapture!.restoreTarget()
    await proactive!.acceptSuggestion(id)
  })
  handle('proactive:dismiss', (input: unknown) => {
    proactive!.dismissSuggestion(z.string().min(1).max(128).parse(input))
  })
  handle('proactive:answer', async (input: unknown) => {
    const answer = islandAnswerSchema.parse(input)
    const current = proactive!.snapshot()
    if (
      !current.active ||
      current.taskId !== answer.taskId ||
      current.question?.question_id !== answer.questionId
    )
      throw new Error('问题已结束，请查看当前任务')
    window?.minimize()
    await foregroundCapture!.restoreTarget()
    proactive!.answer(answer.taskId, answer.questionId, answer.answer)
    conversations?.recordAnswer(answer.taskId, answer.answer)
  })
  handle('proactive:pause', async (input: unknown) => {
    observationPaused = z.boolean().parse(input)
    if (observationPaused) foreground!.pause('user')
    else foreground!.resume('user')
    await syncControlIndicator()
    notify()
  })
  handle('desktop:windows', () => desktop!.windows())
  handle('desktop:start', (input: unknown) => {
    autoAgentWork?.pauseAll('用户启动了新的电脑任务')
    if (violoop?.active) throw new Error('请先停止当前 Violoop 任务')
    return desktop!.start(input)
  })
  handle('desktop:stop', () => desktop!.stop())
  handle('credentials:protect', (active: unknown) => {
    const value = z.boolean().parse(active)
    if (value) foreground?.pause('credentials')
    if (!value) privateEntryWindow?.close()
    try {
      credentials!.protect(value)
    } catch (error) {
      foreground?.resume('credentials')
      throw error
    }
    if (!value) foreground?.resume('credentials')
  })
  handle('credentials:list', () => credentials!.list())
  handle('memory:browse', (input: unknown) => memories!.browse(input))
  handle('memory:save', (input: unknown) => memories!.save(input))
  handle('memory:revise', (input: unknown) => memories!.revise(input))
  handle('memory:remove', (input: unknown) => memories!.remove(input))
  handle('memory:create-private', () => {
    throw new Error('请使用私密填写窗口保存账号密码')
  })
  handle('memory:open-private-editor', async () => {
    if (privateEntryWindow || credentials!.snapshot().editorOpen)
      throw new Error('请先关闭当前私密填写窗口')
    credentials!.protectPrivateEntry(true)
    let entry: PrivateMemoryEntryWindow | undefined
    try {
      entry = new PrivateMemoryEntryWindow(
        (input) => memories!.createPrivate(input),
        (indexed) => {
          if (window && !window.isDestroyed()) window.webContents.send('memory:saved', indexed)
        },
        () => {
          if (privateEntryWindow === entry) privateEntryWindow = undefined
          credentials!.protectPrivateEntry(false)
        },
      )
      privateEntryWindow = entry
      await entry.open(isDevelopment ? developmentUrl : undefined)
    } catch (error) {
      entry?.close()
      if (!entry) credentials!.protectPrivateEntry(false)
      throw error
    }
  })
  handle('memory:close-private-editor', () => privateEntryWindow?.close())
  handle('memory:open-private', (id: unknown) =>
    memories!.openPrivate(id, isDevelopment ? developmentUrl : undefined),
  )
  handle('credentials:create', () => {
    throw new Error('请使用私密填写窗口保存账号密码')
  })
  handle('credentials:delete', (id: unknown) => credentials!.remove(id))
  handle('credentials:open', (id: unknown) =>
    credentials!.open(id, isDevelopment ? developmentUrl : undefined),
  )
  // Local authenticated clients can supply secrets without the shared renderer.
  commands.register('credentials:create', (input) => credentials!.create(input))
  commands.register('memory:create-private', (input) => memories!.createPrivate(input))
  commands.register('credentials:fill', (input) => credentials!.fill(input))
  commands.register('credentials:close', () => credentials!.close())
  handle('sessions:command', submitSessionCommand)
  handle('sessions:stop-all', stopControl)
  handle('sessions:resume', async () => {
    await sessionControl!.resume()
    if (!proactive?.active) proactive?.acknowledgeStopped()
    stopUnconfirmed = false
  })
  handle('sessions:preview-indicator', () => indicator!.preview())
  handle('sessions:indicator-placement', (input: unknown) => indicator!.placement(input))
  const mobileState = (): MobileConnectionSnapshot => ({
    gateway: mobileGateway!.snapshot(),
    tunnel: mobileRelayConfig!.error()
      ? { status: 'error', error: mobileRelayConfig!.error() }
      : mobileRelayConfig!.configured()
        ? mobileRelay!.snapshot()
        : mobileTunnel!.snapshot(),
    transport: mobileRelayConfig!.configured() ? 'relay' : 'cloudflare',
    configuredEndpoint: mobileRelayConfig!.endpoint(),
  })
  handle('mobile:import-server', async (input?: unknown) => {
    credentials!.assertObservationAllowed()
    if (mobileStarting || mobileState().tunnel.status === 'online')
      throw new Error('请先关闭手机连接，再导入服务器配置')
    let path = z.string().min(1).max(4096).optional().parse(input)
    if (path === undefined) {
      const selected = await dialog.showOpenDialog(window!, {
        title: '导入 Coloop 服务器连接配置',
        properties: ['openFile'],
        filters: [{ name: 'Coloop 连接配置', extensions: ['json'] }],
      })
      if (selected.canceled || !selected.filePaths[0]) return false
      path = selected.filePaths[0]
    }
    if ((await stat(path)).size > 16384) throw new Error('服务器连接文件过大')
    const file = await readFile(path)
    if (file.length > 16384) throw new Error('服务器连接文件过大')
    mobileRelayConfig!.import(file.toString('utf8'))
    notify()
    return true
  })
  async function enableMobile() {
    credentials!.assertObservationAllowed()
    if (mobileStarting) return mobileStarting
    if (mobileState().tunnel.status === 'online') return mobileState()
    const generation = ++mobileGeneration
    const starting = (async () => {
      const gateway = mobileGateway!.snapshot()
      const local =
        gateway.status === 'listening' && gateway.url
          ? { url: gateway.url }
          : await mobileGateway!.start()
      try {
        if (generation !== mobileGeneration || exiting) throw new Error('已取消手机连接')
        const relay = mobileRelayConfig!.current()
        if (relay) await mobileRelay!.start(local.url, relay)
        else await mobileTunnel!.start(local.url)
        if (generation !== mobileGeneration || exiting) throw new Error('已取消手机连接')
      } catch (error) {
        await mobileGateway!.stopServer()
        throw error
      }
      return mobileState()
    })()
    mobileStarting = starting
    try {
      return await starting
    } finally {
      if (mobileStarting === starting) mobileStarting = undefined
    }
  }
  handle('mobile:enable', () => {
    connectionSettings.setMobile(true)
    return enableMobile()
  })
  handle('mobile:disable', async () => {
    connectionSettings.setMobile(false)
    ++mobileGeneration
    await mobileTunnel!.stop()
    await mobileRelay!.stop()
    await mobileGateway!.stopServer()
  })
  handle('mobile:pair', async () => {
    credentials!.assertObservationAllowed()
    const state = mobileState().tunnel
    if (state.status !== 'online' || !state.endpoint) throw new Error('请先开启手机连接')
    const invitation = mobileGateway!.createPairing(
      state.endpoint,
      mobileRelayConfig!.current()?.accessKey,
    )
    return {
      uri: invitation.uri,
      qrDataUrl: await QRCode.toDataURL(invitation.uri, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 320,
      }),
      endpoint: invitation.payload.endpoint,
      expiresAt: invitation.payload.expiresAt,
    }
  })
  handle('mobile:revoke', (id: unknown) => mobileGateway!.revoke(z.string().uuid().parse(id)))
  handle('settings:save', async (input: unknown) => {
    credentials!.assertObservationAllowed()
    if (settingsChanging) throw new Error('配置正在更新，请稍候')
    if (
      tasks.running ||
      desktop?.active ||
      violoop?.active ||
      proactive?.active ||
      coordinator?.snapshot().reviewing ||
      controlAdmissions ||
      sessionControl!.snapshot().controlActive
    )
      throw new Error('任务、审批或电脑控制期间无法修改配置，请先停止当前操作')
    const parsed = settingsSchema.parse(input)
    if (
      board.state.qwenReady &&
      JSON.stringify(parsed.board) === JSON.stringify(store.config.board)
    )
      localOutputBudget(board.localCapacity(), undefined, parsed.localModel?.outputTokens)
    autoAgentWork?.pauseAll('模型或配置已修改；恢复后使用新的 DSH 会话')
    settingsChanging = true
    try {
      if (parsed.ocrWorkspace !== store.config.ocrWorkspace)
        await sessionControl!.disconnectAll('WORKSPACE_CHANGED')
      if (
        JSON.stringify(parsed.board) !== JSON.stringify(store.config.board) ||
        parsed.ocrWorkspace !== store.config.ocrWorkspace
      ) {
        await hooks?.dispose()
        await board.releaseHookActivities()
        await board.detachHookRelay()
        board.disconnect()
        hooks = createHooks()
      }
      const result = store.saveSettings(parsed)
      notify()
      return result
    } finally {
      settingsChanging = false
    }
  })
  handle('settings:import-rk', async () => {
    credentials!.assertObservationAllowed()
    if (settingsChanging) throw new Error('配置正在更新，请稍候')
    if (
      tasks.running ||
      desktop?.active ||
      violoop?.active ||
      proactive?.active ||
      coordinator?.snapshot().reviewing ||
      controlAdmissions ||
      sessionControl!.snapshot().controlActive
    )
      throw new Error('请先等待任务、审批或电脑控制结束')
    settingsChanging = true
    try {
      const result = store.saveSettings({
        ...store.config,
        board: importRkBoard(join(store.config.ocrWorkspace, 'config/board.json')),
      })
      await hooks?.dispose()
      await board.releaseHookActivities()
      await board.detachHookRelay()
      board.disconnect()
      hooks = createHooks()
      notify()
      return result
    } finally {
      settingsChanging = false
    }
  })
  async function connectBoard(password: string) {
    if (desktop?.active || violoop?.active || proactive?.active)
      throw new Error('请先停止当前 RK 电脑操作')
    credentials!.close()
    if (board.busy) throw new Error('请先等待端侧任务或审批分析结束')
    if (tasks.running) throw new Error('请先停止当前任务，协作流程仍需使用 RK')
    await hooks?.dispose()
    await board.releaseHookActivities()
    await board.detachHookRelay()
    hooks = createHooks()
    const state = await board.connect(store.config.board, password)
    if (coordinatorAccess && !(isDevelopment && process.env.COLOOP_TEST_NO_HOOKS === '1')) {
      try {
        const root = join(store.config.ocrWorkspace, 'rk-opencode')
        const [plugin, launcher] = await Promise.all([
          readFile(join(root, 'plugins', 'coloop-hook.mjs')),
          readFile(join(root, 'scripts', 'coloop-opencode.sh')),
        ])
        const managedFiles = await Promise.all(
          [
            ['plugins/coloop-managed.mjs', 0o644],
            ['agent/coloop_managed_core.mjs', 0o644],
            ['agent/coloop_managed_activity.py', 0o644],
            ['scripts/coloop-managed.sh', 0o755],
          ].map(async ([path, mode]) => ({
            path: path as string,
            mode: mode as number,
            content: await readFile(join(root, path as string)),
          })),
        )
        const managedConfig = await readFile(join(root, 'opencode-coloop-managed.json'))
        await board.attachHookRelay({
          ...coordinatorAccess,
          workspace: await realpath(store.config.ocrWorkspace),
          plugin,
          launcher,
          managed: { authority: managedAuthority, config: managedConfig, files: managedFiles },
        })
        coordinationError = undefined
        notify()
      } catch {
        coordinationError =
          '模型已连接；原生 Hook 通道未就绪，请检查 RK 插件源码及 SSH 转发后重新连接'
        notify()
      }
    }
    return { ...state, ...board.state }
  }
  autoConnection = new AutoConnectionService({
    settings: connectionSettings,
    config: () => store.config.board,
    state: () => board.state,
    connect: connectBoard,
    startModel: () => board.startModelService(),
    canAttempt: () =>
      !exiting &&
      !settingsChanging &&
      !tasks.running &&
      !board.busy &&
      !ocr.busy &&
      !desktop?.active &&
      !violoop?.active &&
      !proactive?.active &&
      !credentials?.snapshot().protected &&
      !coordinator?.snapshot().reviewing &&
      !sessionControl!.snapshot().controlActive &&
      !controlAdmissions,
    onChange: notify,
  })
  handle('device:connect', (password: unknown) =>
    autoConnection!.connectManually(z.string().max(1024).parse(password)),
  )
  handle('device:auto-reconnect', () => autoConnection!.retryNow())
  handle('device:start-service', () => {
    if (desktop?.active || violoop?.active || proactive?.active)
      throw new Error('请先停止当前 RK 电脑操作')
    if (tasks.running || board.busy) throw new Error('请先等待当前任务或审批分析结束')
    return board.startModelService()
  })
  handle('device:disconnect', async () => {
    if (desktop?.active || violoop?.active || proactive?.active)
      throw new Error('请先停止当前 RK 电脑操作')
    credentials!.close()
    if (board.busy) throw new Error('请先等待端侧任务或审批分析结束')
    if (tasks.running) throw new Error('请先停止当前任务，协作流程仍需使用 RK')
    autoConnection!.disable()
    await hooks?.dispose()
    await board.releaseHookActivities()
    await board.detachHookRelay()
    board.disconnect()
    hooks = createHooks()
  })
  handle('device:refresh', () => board.refresh())
  handle('screen:displays', () =>
    screen.getAllDisplays().map((d) => ({ id: String(d.id), name: d.label || `显示器 ${d.id}` })),
  )
  handle('screen:capture', (displayId: unknown) =>
    captureScreen(z.string().max(50).optional().parse(displayId)),
  )
  handle('screen:open', async (input?: unknown) => {
    credentials!.assertObservationAllowed()
    let path = z.string().min(1).max(4096).optional().parse(input)
    if (path === undefined) {
      const result = await dialog.showOpenDialog(window!, {
        title: '选择需要识别的图片',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }],
      })
      if (result.canceled || !result.filePaths[0]) return null
      path = result.filePaths[0]
    }
    if ((await stat(path)).size > 20_000_000) throw new Error('图片超过 20 MB，请先压缩')
    const buffer = await readFile(path)
    credentials!.assertObservationAllowed()
    if (buffer.length > 20_000_000) throw new Error('图片超过 20 MB，请先压缩')
    return remember(buffer, path.split(/[\\/]/).pop() || '图片')
  })
  handle('ocr:recognize', (id: unknown) => {
    credentials!.assertObservationAllowed()
    const buffer = captures.get(z.string().uuid().parse(id))
    if (!buffer) throw new Error('图片已过期，请重新截取或导入')
    return ocr.recognize(buffer)
  })
  scheduler = new TaskScheduler({
    directory,
    runtime: { resources: join(resourceDirectory, 'harness'), node: autoNode },
    available: (request) =>
      (request.target === 'cloud' ||
        (!!board.state.qwenReady && !!board.state.modelPrivacyReady)) &&
      !exiting &&
      !settingsChanging &&
      board.state.status === 'connected' &&
      !tasks.running &&
      !proactive?.active &&
      !desktop?.active &&
      !violoop?.active &&
      !credentials!.snapshot().protected &&
      !sessionControl!.snapshot().stopped,
    findTask: (id) => store.tasks.find((task) => task.id === id),
    dispatch: (request, id) => tasks.start(request, id),
    onChange: notify,
  })
  handle('task:schedule', (input: unknown) => {
    credentials!.assertObservationAllowed()
    const parsed = scheduleRequestSchema.parse(input)
    return scheduler!.create({
      ...parsed,
      request: {
        ...parsed.request,
        workspace: parsed.request.workspace ?? store.config.taskWorkspace,
      },
    })
  })
  handle('task:schedule-cancel', (input: unknown) =>
    scheduler!.cancel(z.string().uuid().parse(input)),
  )
  scheduler.start()
  handle('task:dispatch', async (input: unknown) => {
    autoAgentWork?.pauseAll('用户发起了新的任务')
    credentials!.assertObservationAllowed()
    const request = taskRequestSchema.parse(input)
    if (proactive?.active) {
      const message = [
        request.prompt,
        request.context,
        request.source === 'screen' ? '请重新观察当前屏幕，结合本条消息继续。' : '',
      ]
        .filter(Boolean)
        .join('\n\n')
      return { id: proactive.appendMessage(message) }
    }
    if (desktop?.active || violoop?.active) throw new Error('请先结束当前任务')
    await sessionControl!.resume()
    stopUnconfirmed = false
    return { id: tasks.start(request) }
  })
  handle('task:run', (request: unknown) => {
    autoAgentWork?.pauseAll('用户发起了新的任务')
    credentials!.assertObservationAllowed()
    if (desktop?.active || violoop?.active || proactive?.active)
      throw new Error('请先停止当前 RK 电脑操作')
    return tasks.start(taskRequestSchema.parse(request))
  })
  handle('task:cancel', (id: unknown) => tasks.cancel(z.string().uuid().parse(id)))
  handle('provider:test', async () => {
    if (desktop?.active || violoop?.active || proactive?.active)
      throw new Error('请先停止当前 RK 电脑操作')
    if (tasks.running) throw new Error('请等待当前任务结束后再测试')
    try {
      const answer = await cloud.generate(
        store.config.provider,
        store.apiKey,
        '仅回复：连接成功',
        '',
        AbortSignal.timeout(30_000),
        () => {},
      )
      return `连接成功：${answer.slice(0, 100)}`
    } finally {
      notify()
    }
  })
  handle('history:task', async (value: unknown) => {
    const id = z.string().uuid().parse(value)
    if (!store.tasks.some((task) => task.id === id) && !conversations?.ownerOf(id))
      throw new Error('任务记录已不存在')
    return {
      ...(await readTaskHistory(directory, id)),
      usage: modelUsage.taskSnapshot(id).requests ? modelUsage.taskSnapshot(id) : undefined,
    }
  })
  handle('history:open-artifact', async (input: unknown) => {
    const { taskId, artifactId } = z
      .object({ taskId: z.string().uuid(), artifactId: z.string().min(1).max(200) })
      .strict()
      .parse(input)
    const saved = await new ExecutionCheckpointStore(join(directory, 'execution-checkpoints')).get(
      taskId,
    )
    const artifact = saved?.artifacts.find((item) => item.id === artifactId)
    if (!saved?.workspace || !artifact) throw new Error('任务产物不存在')
    const root = await realpath(saved.workspace)
    const path = await realpath(resolve(root, artifact.path))
    const location = relative(root, path)
    if (location.startsWith('..') || isAbsolute(location)) throw new Error('产物已离开授权目录')
    if (!/\.(txt|csv|tsv|md|json|xlsx|docx|zip|pdf|jpe?g|png)$/i.test(path))
      throw new Error('此类产物不支持直接打开')
    const error = await shell.openPath(path)
    if (error) throw new Error('无法打开产物，请检查文件及关联程序')
  })
  handle('history:export', async (input?: unknown) => {
    let path = z.string().min(1).max(4096).optional().parse(input)
    if (path === undefined) {
      const result = await dialog.showSaveDialog(window!, {
        title: '导出任务历史',
        defaultPath: `Coloop-history-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return false
      path = result.filePath
    }
    await writeFile(path, JSON.stringify(store.tasks, null, 2), 'utf8')
    return true
  })
  handle('history:clear', () => {
    if (tasks.running) throw new Error('请先停止当前任务')
    store.tasks = []
    store.persist()
    notify()
  })
  handle('clipboard:write', (text: unknown) => {
    clipboard.writeText(z.string().max(200_000).parse(text))
  })

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  window = createMainWindow({
    preload: join(import.meta.dirname, '../preload/index.cjs'),
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(app.getAppPath(), 'resources/icon.png'),
    showOnReady:
      pendingMainShow || (!process.argv.includes('--background') && !store.config.startHidden),
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('render-process-gone', (_event, details) => {
    privateEntryWindow?.close()
    credentials!.protect(false)
    // Keep only the latest exit metadata; never persist page contents or credentials.
    void writeFile(
      join(directory, 'window-diagnostic.json'),
      JSON.stringify({
        event: 'render-process-gone',
        time: new Date().toISOString(),
        version: app.getVersion(),
        reason: details.reason,
        exitCode: details.exitCode,
      }),
    ).catch(() => {})
  })
  if (isDevelopment && developmentUrl) await window.loadURL(developmentUrl)
  else await window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  try {
    const trayIcon = app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(app.getAppPath(), 'resources/icon.png')
    tray = new Tray(nativeImage.createFromPath(trayIcon).resize({ width: 20, height: 20 }))
    tray.setToolTip('Coloop · 关闭窗口后在后台驻留')
    tray.on('click', showMain)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开 Coloop', click: showMain },
        { label: '重新打开灵动岛', click: () => void indicator!.preview().catch(() => {}) },
        {
          label: '停止全部控制',
          click: () => void stopControl().catch(() => {}),
        },
        { type: 'separator' },
        { label: '退出 Coloop', click: () => app.quit() },
      ]),
    )
  } catch {
    // If this Windows shell has no tray, retain the normal close-to-exit behavior.
    tray = undefined
  }
  window.on('close', (event) => {
    if (exiting) return
    event.preventDefault()
    if (tray && store.config.closeToTray !== false) hideMainWindow(window)
    else app.quit()
  })
  app.on('window-all-closed', () => {
    if (!tray) app.quit()
  })
  const handleSuspend = () => {
    autoAgentWork?.pauseAll('电脑已休眠或锁定；待明确恢复')
    foreground?.pause('suspended')
    privateEntryWindow?.close()
    credentials!.close()
    void (async () => {
      await violoop?.stop().catch(() => {})
      await desktop?.stop().catch(() => {})
      await proactive?.stop().catch(() => {})
    })()
    void sessionControl!.disconnectAll('HOST_SUSPENDED').catch(() => {})
  }
  powerMonitor.on('suspend', handleSuspend)
  powerMonitor.on('lock-screen', handleSuspend)
  const handleResume = () => foreground?.resume('suspended')
  powerMonitor.on('resume', handleResume)
  powerMonitor.on('unlock-screen', handleResume)
  foreground.start()
  await syncControlIndicator()
  if (process.argv.includes('--preview-control')) await indicator.preview()
  // The island is resident even when the main window is minimized or no task is active.
  // Recover passive windows hidden by the shell or a renderer recovery path.
  const islandResident = setInterval(() => {
    if (!exiting && indicator && !indicator.visible) void syncControlIndicator().catch(() => {})
  }, 2000)
  const poll = setInterval(() => {
    if (board.state.status === 'connected') void board.refresh().catch(() => {})
  }, 15_000)
  let mobileRetryAt = 0
  const automatic = setInterval(() => {
    void autoConnection!.tick()
    if (
      !exiting &&
      connectionSettings.mobileEnabled &&
      (mobileRelayConfig!.configured() || connectionSettings.mobileSelected) &&
      !mobileStarting &&
      mobileState().tunnel.status !== 'online' &&
      Date.now() >= mobileRetryAt &&
      !credentials!.snapshot().protected
    ) {
      mobileRetryAt = Date.now() + 15000
      void enableMobile().catch(() => {})
    }
  }, 1000)
  // A setup launcher may supply this once through its process environment.
  // It is consumed before spawning children and never included in snapshots.
  const bootstrapPassword = process.env.COLOOP_AUTOCONNECT_PASSWORD
  delete process.env.COLOOP_AUTOCONNECT_PASSWORD
  if (bootstrapPassword) void autoConnection.connectManually(bootstrapPassword).catch(() => {})
  else void autoConnection.tick()
  quitFromCommandLine = (force) => {
    if (!force && busyForQuit()) {
      showMain()
      return
    }
    app.quit()
  }
  app.on('before-quit', (event) => {
    if (exiting) return
    event.preventDefault()
    exiting = true
    conversations?.dispose()
    modelDebug?.dispose()
    localControl?.close()
    autoAgentWork?.dispose()
    autoUia.stop()
    const stopScheduler = scheduler?.dispose()
    ++mobileGeneration
    clearInterval(poll)
    clearInterval(islandResident)
    clearInterval(automatic)
    autoConnection!.dispose()
    powerMonitor.removeListener('suspend', handleSuspend)
    powerMonitor.removeListener('lock-screen', handleSuspend)
    powerMonitor.removeListener('resume', handleResume)
    powerMonitor.removeListener('unlock-screen', handleResume)
    foreground?.dispose()
    foregroundCapture?.dispose()
    cuaClient?.dispose()
    credentials!.close()
    tasks.dispose()
    privateEntryWindow?.close()
    connection?.remove()
    // OCR owns an independent child process and must close even if an SSH cleanup
    // step rejects or foreground maintenance takes longer than the quit budget.
    const stopOcr = Promise.resolve()
      .then(async () => {
        await voice.stop()
        ocr.dispose()
      })
      .catch(() => {})
    void Promise.race([
      (async () => {
        if (sessionControl!.snapshot().controlActive) {
          await sessionControl!.stopAll().catch(() => {})
          const deadline = Date.now() + 2500
          while (sessionControl!.snapshot().controlActive && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
        for (const cleanup of [
          () => stopScheduler,
          () => proactive!.dispose(),
          () => chatgptAdapter!.dispose(),
          () => webReader.dispose(),
          () => clipboardLeases!.dispose(),
          () => violoop!.stop(),
          () => desktop!.stop(),
          () => mobileTunnel!.stop(),
          () => mobileRelay!.stop(),
          () => mobileGateway!.dispose(),
          () => indicator!.dispose(),
          () => sessionControl!.dispose(),
          () => coordinator?.dispose(),
          () => hooks?.dispose(),
          () => board.releaseHookActivities(),
          () => board.detachHookRelay(),
        ]) {
          try {
            await cleanup()
          } catch {
            /* Continue ordered cleanup after a peer failure. */
          }
        }
        await stopOcr
      })(),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ])
      .catch(() => {})
      .finally(() => {
        tray?.destroy()
        board.disconnect()
        app.quit()
      })
  })
  localControl = await startLocalControl(directory, commands)
}
