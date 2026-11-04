import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
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
import { join } from 'node:path'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  settingsSchema,
  taskRequestSchema,
  type AppSnapshot,
  type Capture,
  type Result,
} from '../shared/contracts'
import { AppStore } from './infrastructure/store'
import { BoardGateway, importRkBoard } from './infrastructure/board'
import { CloudGateway } from './infrastructure/cloud'
import { OcrEngine } from './infrastructure/ocr'
import { TaskScriptExecutor } from './infrastructure/task-scripts'
import { TaskService } from './services/tasks'
import { CoordinatorService, ReviewInputError } from './services/coordinator'
import { AgentHookService } from './services/agent-hooks'
import { ManagedApprovalAuthority } from './services/managed-approvals'
import { publishConnection } from './infrastructure/coordinator-connection'
import { errorMessage } from './domain/errors'
import { SessionControlService, SessionControlError } from './services/session-control'
import { ControlIndicatorWindow } from './infrastructure/control-indicator'
import type { ControlIndicatorSnapshot } from '../shared/control-indicator'
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
import { ProactiveAgentService } from './services/proactive-agent'
import {
  ForegroundObservationService,
  WindowsObservationCapture,
  type ForegroundObservation,
  type ObservationAction,
} from './infrastructure/foreground-observation'
import { ClipboardLeaseService } from './infrastructure/clipboard-lease'

let window: BrowserWindow | undefined
let tasks: TaskService, board: BoardGateway, ocr: OcrEngine
let coordinator: CoordinatorService | undefined
let hooks: AgentHookService | undefined
const isDevelopment = !app.isPackaged
const developmentUrl = process.env.ELECTRON_RENDERER_URL
if (process.env.COLOOP_DATA_DIR) app.setPath('userData', process.env.COLOOP_DATA_DIR)
function showMain() {
  if (!window || window.isDestroyed()) return
  if (window.webContents.isCrashed()) window.webContents.reload()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
const lock = app.requestSingleInstanceLock()
if (!lock) app.quit()
else {
  app.on('second-instance', showMain)
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
  let exiting = false
  let tray: Tray | undefined
  let sessionControl: SessionControlService | undefined
  let credentials: CredentialService | undefined
  let memories: MemoryManagementService | undefined
  let privateEntryWindow: PrivateMemoryEntryWindow | undefined
  let desktop: DesktopTaskService | undefined
  let violoop: VioloopService | undefined
  let autoConnection: AutoConnectionService | undefined
  let coordinatedTaskId: string | undefined
  let proactive: ProactiveAgentService | undefined
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
  const snapshot = (): AppSnapshot => ({
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
    proactive: proactive?.snapshot(),
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
    if (!notifyTimer)
      notifyTimer = setTimeout(() => {
        notifyTimer = undefined
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
  const cloud = new CloudGateway(net.fetch as typeof fetch)
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
      window?.hide()
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
    async (id, goal, signal, stage) => {
      coordinatedTaskId = id
      const stop = () => { void proactive?.stop() }
      signal.addEventListener('abort', stop, { once: true })
      try {
        signal.throwIfAborted()
        if (proactive!.snapshot().taskId !== id || !proactive!.active) {
          await foregroundCapture!.restoreTarget()
          await proactive!.startTask(goal, id)
          window?.hide()
        }
        while (true) {
          signal.throwIfAborted()
          const state = proactive!.snapshot()
          if (state.taskId !== id) throw new Error('执行任务标识不匹配')
          stage(state.phase === 'waiting_user' ? '等待你回答后继续原任务' : '正在操作并回读实际结果')
          if (!state.active) {
            if (state.phase === 'completed') return state.summary ?? '任务已通过屏幕结果核验'
            if (state.phase === 'cancelled') throw new DOMException('操作已停止', 'AbortError')
            throw new Error(state.error ?? '执行器连接中断，未确认完成')
          }
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      } finally {
        signal.removeEventListener('abort', stop)
        coordinatedTaskId = undefined
      }
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
    assertAvailable: () => {
      credentials!.assertObservationAllowed()
      if (exiting || settingsChanging) throw new Error('电脑服务正在退出或更新设置，请稍后重试')
      if (sessionControl!.snapshot().stopped) throw new Error('CONTROL_STOPPED')
      if (
        proactive?.active ||
        tasks.running ||
        ocr.busy ||
        coordinator?.snapshot().reviewing ||
        sessionControl!.snapshot().controlActive ||
        controlAdmissions
      )
        throw new Error('电脑正在处理其他任务，请等待结束')
      if (
        board.state.status !== 'connected' ||
        !board.state.qwenReady ||
        !board.state.modelPrivacyReady
      )
        throw new Error(
          autoConnection?.snapshot().message ?? '请在电脑连接 RK，并确认端侧模型与隐私服务就绪',
        )
    },
    understand: (content, signal) => board.privacyAgent(violoopIntentPolicy, content, signal, 512),
    browserAgentLocation: 'rk',
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
          ? 'Control status unconfirmed'
          : mode === 'stopping'
            ? 'Waiting for stop confirmation'
            : 'Controlling your computer',
      sessionCount: active.length + (desktopActive ? 1 : 0),
      startedAt: active
        .map((item) => item.controlStartedAt)
        .filter(Boolean)
        .sort()[0],
    }
    const ai = proactive?.snapshot()
    if (mode === 'hidden' && ai) {
      const phaseLabels: Record<string, string> = {
        queued: 'Preparing task',
        cloud_planning: 'Planning next step',
        validating: 'Checking cloud actions',
        dispatching: 'Controlling your computer',
        verifying: 'Checking result',
        reviewing: 'Task verified · Saving useful memory',
        waiting_user: 'Your answer is needed',
        stopping: 'Waiting for RK to stop',
      }
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
          title: 'Coloop',
          detail: phaseLabels[ai.phase] ?? 'Working on your task',
          ...(question
            ? {
                questionId: String(question.question_id),
                content: String(question.question ?? '').slice(0, 12000),
                choices: Array.isArray(question.options)
                  ? question.options
                      .map(String)
                      .slice(0, 8)
                      .map((x) => x.slice(0, 300))
                  : [],
                expanded: true,
              }
            : {}),
        }
      } else if (ai.suggestion) {
        state = {
          mode: 'suggestion',
          title: String(ai.suggestion.title).slice(0, 100),
          content: String(ai.suggestion.text).slice(0, 12000),
          suggestionId: String(ai.suggestion.suggestion_id),
          detail: 'Suggested for your current work',
        }
      } else if (ai.phase === 'input_unknown') {
        state = {
          mode: 'unconfirmed',
          title: 'Coloop',
          detail: 'Input result unknown. Check the target before retrying.',
          error: ai.error?.slice(0, 180),
        }
      } else if (['completed', 'blocked', 'failed', 'cancelled'].includes(ai.phase)) {
        state = {
          mode:
            ai.phase === 'completed' ? 'completed' : ai.phase === 'blocked' ? 'blocked' : 'failed',
          title: 'Coloop',
          content: ai.summary?.slice(0, 12000),
          detail:
            ai.phase === 'completed'
              ? ai.memorySaved === false
                ? 'Task completed · Memory not saved'
                : ai.memorySaved
                  ? 'Task completed · Memory saved'
                  : 'Task completed'
              : 'Task stopped',
          error: ai.error?.slice(0, 180),
        }
      } else {
        state = {
          mode: 'idle',
          title: 'Coloop',
          detail: observationPaused
            ? 'Screen observation paused'
            : ai.connected
              ? 'Ready · Watching your current window'
              : 'Waiting for RK connection',
          observationPaused,
        }
      }
    }
    const key = JSON.stringify(state)
    if (
      key !== indicatorKey ||
      ((!indicator.visible || indicator.snapshot().mode === 'hidden') && state.mode !== 'hidden')
    ) {
      indicatorKey = key
      indicatorUpdate = indicator.update(state).catch(async (error) => {
        indicatorKey = ''
        await sessionControl?.stopAll()
        await desktop?.stop().catch(() => {})
        throw error
      })
    }
    await indicatorUpdate
  }
  async function stopControl() {
    stopUnconfirmed = false
    if (coordinatedTaskId && tasks.running) tasks.cancel(coordinatedTaskId)
    await Promise.allSettled([sessionControl!.stopAll(), violoop?.stop(), proactive?.stop()])
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
        sessionControl: {
          ...sessionControl!.snapshot(),
          controlActive:
            sessionControl!.snapshot().controlActive || !!desktop?.active || !!violoop?.active,
          unconfirmedCount:
            sessionControl!.snapshot().unconfirmedCount +
            (desktop?.snapshot().phase === 'unconfirmed' ? 1 : 0),
        },
        progress: sessionControl!.projectProgress(hooks?.snapshot(true)),
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
    onOpenMain: showMain,
    onRememberTarget: () => foregroundCapture!.rememberTarget(),
    onRestoreTarget: async () => { await foregroundCapture!.restoreTarget() },
    onAcceptSuggestion: (id) => proactive!.acceptSuggestion(id),
    onDismissSuggestion: async (id) => {
      proactive!.dismissSuggestion(id)
    },
    onAnswerQuestion: async (answer) => {
      proactive!.answer(answer.taskId, answer.questionId, answer.answer)
    },
    onStartTask: async (goal) => {
      await proactive!.startTask(goal)
    },
    onPauseObservation: async (paused) => {
      observationPaused = paused
      if (paused) foreground?.pause('user')
      else foreground?.resume('user')
      await syncControlIndicator()
    },
    onUnavailable: async () => {
      indicatorKey = ''
      await Promise.allSettled([sessionControl!.stopAll(), violoop?.stop()])
      await desktop?.stop().catch(() => {})

    },
  })
  const resourceDirectory = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), 'resources')
  foregroundCapture = new WindowsObservationCapture({
    recognize: (png, signal) => ocr.recognize(png, signal),
    excludedBounds: () => {
      const bounds = indicator?.getBounds()
      return bounds ? [bounds] : []
    },
  })
  clipboardLeases = new ClipboardLeaseService(join(resourceDirectory, 'clipboard-lease.ps1'))
  const canObserveForeground = () =>
    !exiting &&
    !settingsChanging &&
    !credentials!.snapshot().protected &&
    (!tasks.running || !!coordinatedTaskId) &&
    !desktop?.active &&
    !violoop?.active &&
    !coordinator?.snapshot().reviewing &&
    !sessionControl!.snapshot().controlActive &&
    !board.busy &&
    board.state.status === 'connected' &&
    !!board.state.modelPrivacyReady
  const taskScripts = new TaskScriptExecutor(join(directory, 'task-scripts'), join(app.getAppPath(), 'node_modules'))
  proactive = new ProactiveAgentService({
    script: join(resourceDirectory, 'rk-proactive-agent.py'),
    executeScript: (taskId, script, signal) => {
      credentials!.assertObservationAllowed()
      return taskScripts.execute(taskId, script, signal)
    },
    openRuntime: (source) => board.openDesktopRuntime(source),
    available: () =>
      board.state.status === 'connected' && !!board.state.modelPrivacyReady,
    assertStart: () => {
      credentials!.assertObservationAllowed()
      if (!canObserveForeground() || stopUnconfirmed || sessionControl!.snapshot().stopped)
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
        view = await foregroundCapture!.capture()
      } catch {
        // Capturing/OCR is read-only. A transient failure needs a fresh capture,
        // not termination of the task. Privacy and stop checks stay outside this catch.
        throw new Error('OBSERVATION_RETRY')
      }
      credentials!.assertObservationAllowed()
      if (!view) throw new Error('OBSERVATION_RETRY')
      return view as unknown as import('./services/proactive-agent').ProactiveObservation
    },
    cloud: (system, content, signal) => {
      credentials!.assertObservationAllowed()
      return cloud.relayText(store.config.provider, store.apiKey, system, content, signal, {
        maxTokens: 8192,
        maxResponseBytes: 32768,
      })
    },
    input: async (op, observation, value) => {
      credentials!.assertObservationAllowed()
      const view = observation as unknown as ForegroundObservation
      const action = value.action as ObservationAction & { text?: string }
      if (op === 'clipboard.verify') return foregroundCapture!.verifyText(view, action.text ?? '')
      if (op === 'completion.verify')
        return value.evidence_mode === 'control_state'
          ? foregroundCapture!.verifyControlState(view, value.expected_state)
          : value.evidence_mode === 'visible_text'
          ? foregroundCapture!.verifyVisibleText(view, String(value.expected_text ?? ''))
          : foregroundCapture!.verifyCurrentText(view, String(value.expected_text ?? ''))
      const checked =
        op === 'input.guard'
          ? await foregroundCapture!.guard(view, action)
          : await foregroundCapture!.validate(view, action)
      if (!checked.allowed) throw new Error('INPUT_TARGET_CHANGED')
      return checked
    },
    clipboard: (op, value) => clipboardLeases!.call(op, value),
    releaseClipboard: (taskId) => clipboardLeases!.releaseTask(taskId),
    prepareInput: syncControlIndicator,
    onChange: () => {
      if (proactive?.active) foreground?.pause('task')
      else foreground?.resume('task')
      notify()
    },
  })
  foreground = new ForegroundObservationService({
    capture: (signal) => foregroundCapture!.captureFrame(signal),
    recognize: (frame, signal) => foregroundCapture!.recognize(frame, signal),
    isOcrBusy: () => ocr.busy,
    canObserve: () => canObserveForeground() && !proactive!.active,
    onObservation: (view) =>
      proactive!.submitObservation(
        view as unknown as import('./services/proactive-agent').ProactiveObservation,
      ),
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
      if (path === '/v1/hooks') await sessionControl!.observeHook(input).catch(() => {})
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

  function handle<T>(channel: string, action: (...args: any[]) => T | Promise<T>) {
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
  handle('proactive:start', (goal: unknown) =>
    proactive!.startTask(z.string().trim().min(1).max(4000).parse(goal)),
  )
  handle('proactive:stop', () => proactive!.stop())
  handle('proactive:pause', async (input: unknown) => {
    observationPaused = z.boolean().parse(input)
    if (observationPaused) foreground!.pause('user')
    else foreground!.resume('user')
    await syncControlIndicator()
  })
  handle('desktop:windows', () => desktop!.windows())
  handle('desktop:start', (input: unknown) => {
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
  handle('sessions:command', submitSessionCommand)
  handle('sessions:stop-all', stopControl)
  handle('sessions:resume', async () => {
    await sessionControl!.resume()
    stopUnconfirmed = false
  })
  handle('sessions:preview-indicator', () => indicator!.preview())
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
  handle('mobile:import-server', async () => {
    credentials!.assertObservationAllowed()
    if (mobileStarting || mobileState().tunnel.status === 'online')
      throw new Error('请先关闭手机连接，再导入服务器配置')
    const selected = await dialog.showOpenDialog(window!, {
      title: '导入 Coloop 服务器连接配置',
      properties: ['openFile'],
      filters: [{ name: 'Coloop 连接配置', extensions: ['json'] }],
    })
    if (selected.canceled || !selected.filePaths[0]) return false
    const file = await readFile(selected.filePaths[0])
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
  handle('screen:open', async () => {
    credentials!.assertObservationAllowed()
    const result = await dialog.showOpenDialog(window!, {
      title: '选择需要识别的图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }],
    })
    if (result.canceled) return null
    const buffer = await readFile(result.filePaths[0])
    credentials!.assertObservationAllowed()
    if (buffer.length > 20_000_000) throw new Error('图片超过 20 MB，请先压缩')
    return remember(buffer, result.filePaths[0].split(/[\\/]/).pop() || '图片')
  })
  handle('ocr:recognize', (id: unknown) => {
    credentials!.assertObservationAllowed()
    const buffer = captures.get(z.string().uuid().parse(id))
    if (!buffer) throw new Error('图片已过期，请重新截取或导入')
    return ocr.recognize(buffer)
  })
  handle('task:dispatch', async (input: unknown) => {
    credentials!.assertObservationAllowed()
    if (desktop?.active || violoop?.active || proactive?.active) throw new Error('请先结束当前任务')
    const request = taskRequestSchema.parse(input)
    await sessionControl!.resume()
    stopUnconfirmed = false
    return { id: tasks.start(request) }
  })
  handle('task:run', (request: unknown) => {
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
    const answer = await cloud.generate(
      store.config.provider,
      store.apiKey,
      '仅回复：连接成功',
      '',
      AbortSignal.timeout(30_000),
      () => {},
    )
    return `连接成功：${answer.slice(0, 100)}`
  })
  handle('history:export', async () => {
    const result = await dialog.showSaveDialog(window!, {
      title: '导出任务历史',
      defaultPath: `Coloop-history-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, JSON.stringify(store.tasks, null, 2), 'utf8')
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
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1060,
    minHeight: 720,
    title: 'Coloop',
    backgroundColor: '#f6f7f9',
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(app.getAppPath(), 'resources/icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
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
  window.once('ready-to-show', () => window?.show())
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
        { label: '预览顶部控制提示', click: () => void indicator!.preview().catch(() => {}) },
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
    if (tray) window?.hide()
    else app.quit()
  })
  app.on('window-all-closed', () => {
    if (!tray) app.quit()
  })
  const handleSuspend = () => {
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
  app.on('before-quit', (event) => {
    if (exiting) return
    event.preventDefault()
    exiting = true
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
    credentials!.close()
    tasks.dispose()
    privateEntryWindow?.close()
    connection?.remove()
    // OCR owns an independent child process and must close even if an SSH cleanup
    // step rejects or foreground maintenance takes longer than the quit budget.
    const stopOcr = Promise.resolve()
      .then(() => ocr.dispose())
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
          () => proactive!.dispose(),
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
}
