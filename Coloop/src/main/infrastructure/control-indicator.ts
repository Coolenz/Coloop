import {
  BrowserWindow,
  ipcMain,
  screen,
  session,
  type IpcMainInvokeEvent,
  type Rectangle,
} from 'electron'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { replaceFileSync } from './atomic-file'
import { z } from 'zod'
import {
  controlIndicatorSnapshotSchema,
  islandActionSchema,
  islandAnswerSchema,
  isActiveControlMode,
  indicatorPlacementSchema,
  type IndicatorEdge,
  type IslandAnswer,
  type ControlIndicatorSnapshot,
  type ControlIndicatorView,
} from '../../shared/control-indicator'
import type { Result } from '../../shared/contracts'

interface ControlIndicatorOptions {
  preloadPath: string
  rendererPath: string
  developmentUrl?: string
  /** Requests stopping; the owner must update(hidden) only after source confirmation. */
  onStop: () => Promise<void>
  onOpenMain: (taskId?: string) => void
  placementFile?: string
  onUnavailable?: (reason: string) => void | Promise<void>
  onAcceptSuggestion?: (id: string) => Promise<void>
  onDismissSuggestion?: (id: string) => Promise<void>
  onDismissResult?: (taskId: string) => Promise<void>
  onAnswerQuestion?: (answer: IslandAnswer) => Promise<void>
  onPauseObservation?: (paused: boolean) => Promise<void>
  onStartTask?: (goal: string) => Promise<void>
  onRememberTarget?: () => Promise<void>
  onRestoreTarget?: () => Promise<void>
}

interface PaintWaiter {
  revision: number
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const CHANNELS = [
  'control-indicator:close',
  'control-indicator:get',
  'control-indicator:stop',
  'control-indicator:open',
  'control-indicator:close-preview',
  'control-indicator:accept',
  'control-indicator:dismiss',
  'control-indicator:dismiss-result',
  'control-indicator:answer',
  'control-indicator:begin-answer',
  'control-indicator:end-answer',
  'control-indicator:expand',
  'control-indicator:pause-observation',
  'control-indicator:begin-task',
  'control-indicator:start-task',
  'control-indicator:reveal',
  'control-indicator:drag',
  'control-indicator:dock',
] as const

/** Isolated, non-activating status surface. A real command must await update(). */
export class ControlIndicatorWindow {
  private window?: BrowserWindow
  private opening?: Promise<BrowserWindow>
  private current: ControlIndicatorView = { mode: 'hidden', revision: 0 }
  private paintedRevision = 0
  private paintWaiters = new Set<PaintWaiter>()
  private previewTimer?: ReturnType<typeof setTimeout>
  private stopPending?: Promise<void>
  private disposed = false
  private recovering = false
  private hiding = false
  private expectedUrl: string
  private actionPending = false
  private editingCommand = false
  private dismissed = false
  private resizeTimer?: ReturnType<typeof setInterval>
  private resizeTarget?: Rectangle
  private appliedBounds?: Rectangle
  private applyingBounds = false
  private reducedMotion = false
  private revealed = false
  private anchor?: { x: number; y: number }
  private dockEdge?: IndicatorEdge
  private snapEdge?: IndicatorEdge
  private dragging?: {
    cursor: { x: number; y: number }
    x: number
    y: number
    width: number
    height: number
  }

  private canStartTask(mode = this.current.mode) {
    return [
      'idle',
      'suggestion',
      'completed',
      'blocked',
      'failed',
      'controlling',
      'question',
    ].includes(mode)
  }

  constructor(private readonly options: ControlIndicatorOptions) {
    if (options.placementFile && existsSync(options.placementFile)) {
      try {
        const saved = z
          .object({
            edge: z.enum(['top', 'left', 'right']).optional(),
            anchor: z.object({ x: z.number().finite(), y: z.number().finite() }),
          })
          .parse(JSON.parse(readFileSync(options.placementFile, 'utf8')))
        this.dockEdge = saved.edge
        this.anchor = saved.anchor
      } catch {
        /* An obsolete display placement falls back to the primary display. */
      }
    }
    const url = options.developmentUrl
      ? new URL(options.developmentUrl)
      : pathToFileURL(options.rendererPath)
    url.searchParams.set('surface', 'control')
    url.hash = ''
    this.expectedUrl = url.href
    this.handle('control-indicator:get', (_event, args) => {
      if (args.length > 1) throw new Error('控制提示参数无效')
      const revision = args[0]
      if (revision !== undefined) {
        if (
          typeof revision !== 'number' ||
          !Number.isSafeInteger(revision) ||
          revision < 0 ||
          revision > this.current.revision
        )
          throw new Error('控制提示参数无效')
        if (this.window?.isVisible() && this.current.mode !== 'hidden') {
          this.paintedRevision = Math.max(this.paintedRevision, revision)
          for (const waiter of this.paintWaiters) {
            if (waiter.revision <= this.paintedRevision) {
              clearTimeout(waiter.timer)
              this.paintWaiters.delete(waiter)
              waiter.resolve()
            }
          }
        }
      }
      return { ...this.current }
    })
    this.handle('control-indicator:close', async (_event, args) => {
      this.noArguments(args)
      if (this.isActualControl()) await this.stop()
      if (this.isActualControl()) throw new Error('控制期间不能隐藏提示，请先停止控制')
      this.dismissed = true
      this.revealed = false
      this.editingCommand = false
      await this.update({ mode: 'hidden' })
    })
    this.handle('control-indicator:stop', (_event, args) => {
      this.noArguments(args)
      return this.stop()
    })
    this.handle('control-indicator:open', (_event, args) => {
      this.noArguments(args)
      this.options.onOpenMain(this.current.taskId)
    })
    this.handle('control-indicator:dock', (_event, args) => {
      this.noArguments(args)
      const bounds = this.window?.getBounds() ?? this.bounds()
      const area = screen.getDisplayMatching(bounds).workArea
      const closest = [
        { edge: 'top' as const, distance: bounds.y - area.y },
        { edge: 'left' as const, distance: bounds.x - area.x },
        { edge: 'right' as const, distance: area.x + area.width - bounds.x - bounds.width },
      ].sort((a, b) => a.distance - b.distance)[0].edge
      this.revealed = false
      this.editingCommand = false
      this.window?.setFocusable(false)
      this.placement({ operation: 'dock', edge: this.dockEdge ?? closest })
    })
    this.handle('control-indicator:close-preview', (_event, args) => {
      this.noArguments(args)
      if (this.current.mode !== 'preview') throw new Error('控制期间不能隐藏提示，请先停止控制')
      return this.update({ mode: 'hidden' })
    })
    for (const channel of ['control-indicator:accept', 'control-indicator:dismiss'] as const) {
      this.handle(channel, async (_event, args) => {
        if (args.length !== 1 || this.actionPending) throw new Error('控制提示参数无效')
        const input = islandActionSchema.parse(args[0])
        if (
          this.current.mode !== 'suggestion' ||
          input.id !== this.current.suggestionId ||
          input.revision !== this.current.revision
        )
          throw new Error('控制提示参数无效')
        const action = channel.endsWith(':accept')
          ? this.options.onAcceptSuggestion
          : this.options.onDismissSuggestion
        if (!action) throw new Error('控制提示参数无效')
        this.actionPending = true
        try {
          if (channel.endsWith(':accept')) {
            this.window?.setFocusable(false)
            this.window?.blur()
            await this.options.onRestoreTarget?.()
          }
          await action(input.id)
        } finally {
          this.actionPending = false
        }
      })
    }
    this.handle('control-indicator:dismiss-result', async (_event, args) => {
      if (args.length !== 1 || this.actionPending) throw new Error('控制提示参数无效')
      const input = islandActionSchema.parse(args[0])
      if (
        !['completed', 'blocked', 'failed'].includes(this.current.mode) ||
        input.id !== this.current.taskId ||
        input.revision !== this.current.revision ||
        !this.options.onDismissResult
      )
        throw new Error('控制提示参数无效')
      this.actionPending = true
      try {
        this.editingCommand = false
        this.window?.setFocusable(false)
        this.window?.blur()
        await this.options.onDismissResult(input.id)
        await this.options.onRestoreTarget?.()
      } finally {
        this.actionPending = false
        this.resize()
      }
    })
    this.handle('control-indicator:answer', async (_event, args) => {
      if (args.length !== 1 || this.actionPending) throw new Error('控制提示参数无效')
      const input = islandAnswerSchema.parse(args[0])
      if (
        this.current.mode !== 'question' ||
        input.taskId !== this.current.taskId ||
        input.questionId !== this.current.questionId ||
        !this.options.onAnswerQuestion
      )
        throw new Error('控制提示参数无效')
      this.actionPending = true
      try {
        this.window?.setFocusable(false)
        this.window?.blur()
        await this.options.onRestoreTarget?.()
        await this.options.onAnswerQuestion(input)
      } finally {
        this.actionPending = false
        this.resize()
      }
    })
    this.handle('control-indicator:begin-answer', async (_event, args) => {
      this.noArguments(args)
      if (this.current.mode !== 'question') throw new Error('控制提示参数无效')
      await this.options.onRememberTarget?.()
      this.window?.setFocusable(true)
      this.window?.focus()
    })
    this.handle('control-indicator:end-answer', async (_event, args) => {
      this.noArguments(args)
      this.editingCommand = false
      this.window?.setFocusable(false)
      this.window?.blur()
      await this.options.onRestoreTarget?.()
    })
    this.handle('control-indicator:begin-task', async (_event, args) => {
      this.noArguments(args)
      if (!this.canStartTask() || this.actionPending) throw new Error('控制提示参数无效')
      await this.options.onRememberTarget?.()
      if (!this.canStartTask() || this.actionPending) throw new Error('控制提示参数无效')
      this.editingCommand = true
      this.window?.setFocusable(true)
      this.window?.focus()
    })
    this.handle('control-indicator:start-task', async (_event, args) => {
      if (
        args.length !== 1 ||
        typeof args[0] !== 'string' ||
        !args[0].trim() ||
        args[0].length > 4000 ||
        this.actionPending ||
        !this.canStartTask() ||
        !this.options.onStartTask
      )
        throw new Error('控制提示参数无效')
      this.actionPending = true
      this.editingCommand = false
      this.window?.setFocusable(false)
      this.window?.blur()
      try {
        await this.options.onRestoreTarget?.()
        await this.options.onStartTask(args[0].trim())
      } finally {
        this.actionPending = false
        this.resize()
      }
    })
    this.handle('control-indicator:expand', (_event, args) => {
      if (args.length !== 1 || typeof args[0] !== 'boolean') throw new Error('控制提示参数无效')
      return this.update({ ...this.snapshot(), expanded: args[0] })
    })
    this.handle('control-indicator:reveal', (_event, args) => {
      if (
        (args.length !== 1 && args.length !== 2) ||
        typeof args[0] !== 'boolean' ||
        (args.length === 2 && typeof args[1] !== 'boolean')
      )
        throw new Error('控制提示参数无效')
      this.revealed = args[0]
      if (
        !this.revealed &&
        !this.actionPending &&
        !this.editingCommand &&
        !this.dragging &&
        this.current.expanded
      )
        this.assign({ ...this.current, expanded: false })
      if (typeof args[1] === 'boolean') this.reducedMotion = args[1]
      if (!this.actionPending || this.reducedMotion) this.resize()
    })
    this.handle('control-indicator:drag', (_event, args) => {
      if (args.length !== 2 || !['start', 'move', 'end'].includes(String(args[0])))
        throw new Error('控制提示参数无效')
      const window = this.window
      if (!window || window.isDestroyed()) return
      const point = args[1] as { x?: unknown; y?: unknown } | null
      if (
        !point ||
        typeof point.x !== 'number' ||
        typeof point.y !== 'number' ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        Math.abs(point.x) > 1000000 ||
        Math.abs(point.y) > 1000000
      )
        throw new Error('控制提示参数无效')
      const cursor = { x: point.x, y: point.y }
      if (args[0] === 'start') {
        this.cancelResize()
        this.appliedBounds = undefined
        const bounds = window.getBounds()
        this.anchor = { x: bounds.x + bounds.width / 2, y: bounds.y }
        this.dragging = { cursor, ...bounds }
      } else if (this.dragging) {
        const area = screen.getDisplayNearestPoint(cursor).workArea
        const bounds = window.getBounds()
        const x = Math.max(
          area.x,
          Math.min(
            this.dragging.x + cursor.x - this.dragging.cursor.x,
            area.x + area.width - bounds.width,
          ),
        )
        const y = Math.max(
          area.y,
          Math.min(
            this.dragging.y + cursor.y - this.dragging.cursor.y,
            area.y + area.height - bounds.height,
          ),
        )
        const distance = Math.hypot(
          cursor.x - this.dragging.cursor.x,
          cursor.y - this.dragging.cursor.y,
        )
        if (distance >= 4) this.dockEdge = undefined
        this.applyBounds(window, {
          x: Math.round(x),
          y: Math.round(y),
          width: this.dragging.width,
          height: this.dragging.height,
        })
        const moved = window.getBounds()
        this.anchor = { x: moved.x + moved.width / 2, y: moved.y }
        const nearby = [
          { edge: 'top' as const, distance: moved.y - area.y },
          { edge: 'left' as const, distance: moved.x - area.x },
          { edge: 'right' as const, distance: area.x + area.width - moved.x - moved.width },
        ].sort((a, b) => a.distance - b.distance)[0]
        this.snapEdge = distance >= 4 && nearby.distance <= 48 ? nearby.edge : undefined
        this.syncDockView()
        if (args[0] === 'end') {
          if (distance >= 4) {
            const edges = [
              { edge: 'top' as const, distance: moved.y - area.y },
              { edge: 'left' as const, distance: moved.x - area.x },
              { edge: 'right' as const, distance: area.x + area.width - moved.x - moved.width },
            ].sort((a, b) => a.distance - b.distance)
            this.dockEdge = edges[0].distance <= 48 ? edges[0].edge : undefined
          }
          this.dragging = undefined
          this.snapEdge = undefined
          this.savePlacement()
          this.resize()
        }
      }
    })
    this.handle('control-indicator:pause-observation', async (_event, args) => {
      if (args.length !== 1 || typeof args[0] !== 'boolean' || !this.options.onPauseObservation)
        throw new Error('控制提示参数无效')
      await this.options.onPauseObservation(args[0])
    })
    screen.on('display-added', this.reposition)
    screen.on('display-removed', this.reposition)
    screen.on('display-metrics-changed', this.reposition)
  }

  get visible() {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible())
  }

  get isInteracting() {
    return this.revealed || this.actionPending || Boolean(this.dragging) || this.editingCommand
  }

  get id() {
    return this.window && !this.window.isDestroyed() ? this.window.id : undefined
  }

  snapshot(): ControlIndicatorSnapshot {
    const {
      revision: _revision,
      dockEdge: _edge,
      dockCollapsed: _collapsed,
      snapEdge: _snap,
      ...snapshot
    } = this.current
    return snapshot
  }

  getBounds() {
    return this.window?.getBounds()
  }

  placement(input: unknown) {
    const request = indicatorPlacementSchema.parse(input)
    if (request.operation !== 'inspect') {
      if (this.dragging) throw new Error('浮窗正在拖动，请松开后重试')
      const bounds = this.window?.getBounds() ?? this.bounds()
      const area = screen.getDisplayMatching(bounds).workArea
      this.anchor = { x: bounds.x + bounds.width / 2, y: bounds.y }
      this.dockEdge = request.operation === 'dock' ? request.edge : undefined
      if (request.operation === 'dock') {
        this.revealed = false
        this.assign({ ...this.current, expanded: false })
      }
      if (request.operation === 'undock')
        this.anchor = { x: area.x + area.width / 2, y: area.y + 48 }
      this.resize()
      this.savePlacement()
    }
    return {
      edge: this.dockEdge ?? null,
      collapsed: this.dockCollapsed(),
      bounds: this.window?.getBounds(),
      visible: this.visible,
    }
  }

  private dockCollapsed() {
    return Boolean(
      this.dockEdge &&
      !this.revealed &&
      !this.actionPending &&
      !this.editingCommand &&
      !this.dragging,
    )
  }
  private savePlacement() {
    if (!this.options.placementFile || !this.anchor) return
    const temporary = this.options.placementFile + '.tmp'
    writeFileSync(temporary, JSON.stringify({ edge: this.dockEdge, anchor: this.anchor }), {
      mode: 0o600,
    })
    replaceFileSync(temporary, this.options.placementFile)
  }

  private syncDockView() {
    const collapsed = this.dockCollapsed()
    if (
      this.current.dockEdge === this.dockEdge &&
      this.current.dockCollapsed === collapsed &&
      this.current.snapEdge === this.snapEdge
    )
      return
    this.current = {
      ...this.current,
      dockEdge: this.dockEdge,
      dockCollapsed: collapsed,
      snapEdge: this.snapEdge,
      revision: this.current.revision + 1,
    }
    this.window?.webContents.send('control-indicator:snapshot', { ...this.current })
  }

  private noArguments(args: unknown[]) {
    if (args.length) throw new Error('控制提示参数无效')
  }

  private trusted(event: IpcMainInvokeEvent) {
    const window = this.window
    const frame = event.senderFrame
    return (
      !this.disposed &&
      window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      frame === window.webContents.mainFrame &&
      frame.url === this.expectedUrl
    )
  }

  private handle<T>(
    channel: (typeof CHANNELS)[number],
    action: (event: IpcMainInvokeEvent, args: unknown[]) => T | Promise<T>,
  ) {
    ipcMain.handle(channel, async (event, ...args): Promise<Result<T>> => {
      if (!this.trusted(event)) return { ok: false, error: '控制提示调用来源无效' }
      try {
        return { ok: true, value: await action(event, args) }
      } catch (error) {
        // Only this class's fixed messages cross the boundary; source errors may contain secrets.
        const message = error instanceof Error ? error.message : ''
        return {
          ok: false,
          error: [
            '控制提示参数无效',
            '控制期间不能隐藏提示，请先停止控制',
            '当前没有正在执行的控制',
            'Could not restore the target window; select it and retry',
            'No previous target window is available',
          ].includes(message)
            ? message
            : '停止或更新控制未确认，请打开 Coloop 检查',
        }
      }
    })
  }

  private bounds() {
    const area = this.anchor
      ? screen.getDisplayNearestPoint({
          x: Math.round(this.anchor.x),
          y: Math.round(this.anchor.y),
        }).workArea
      : screen.getPrimaryDisplay().workArea
    const revealed =
      (this.current.mode === 'preview' && !this.dockEdge) ||
      this.revealed ||
      this.actionPending ||
      this.editingCommand
    const expanded = this.current.expanded === true
    const width = Math.max(
      1,
      Math.min(
        this.current.mode === 'preview' ? 373 : revealed && expanded ? 480 : 360,
        area.width - 16,
      ),
    )
    const height = Math.max(
      1,
      Math.min(
        revealed && expanded
          ? ['suggestion', 'question', 'completed', 'blocked', 'failed'].includes(this.current.mode)
            ? 344
            : 240
          : 76,
        Math.floor(area.height * 0.65),
      ),
    )
    const bounds = {
      x: Math.round(
        Math.max(
          area.x,
          Math.min(
            this.anchor ? this.anchor.x - width / 2 : area.x + (area.width - width) / 2,
            area.x + area.width - width,
          ),
        ),
      ),
      y: Math.round(
        Math.max(area.y, Math.min(this.anchor?.y ?? area.y + 8, area.y + area.height - height)),
      ),
      width,
      height,
    }
    if (this.dockEdge) {
      if (this.dockCollapsed()) {
        bounds.width = this.dockEdge === 'top' ? 104 : 32
        bounds.height = this.dockEdge === 'top' ? 32 : 88
        bounds.x = Math.round(
          Math.max(
            area.x,
            Math.min(
              (this.anchor?.x ?? area.x + area.width / 2) - bounds.width / 2,
              area.x + area.width - bounds.width,
            ),
          ),
        )
        bounds.y = Math.round(
          Math.max(
            area.y,
            Math.min(this.anchor?.y ?? area.y + 48, area.y + area.height - bounds.height),
          ),
        )
      }
      if (this.dockEdge === 'top') bounds.y = area.y
      if (this.dockEdge === 'left') bounds.x = area.x
      if (this.dockEdge === 'right') bounds.x = area.x + area.width - bounds.width
    }
    return bounds
  }

  private sameBounds(a: Rectangle, b: Rectangle, tolerance = 0) {
    return (
      Math.abs(a.x - b.x) <= tolerance &&
      Math.abs(a.y - b.y) <= tolerance &&
      Math.abs(a.width - b.width) <= tolerance &&
      Math.abs(a.height - b.height) <= tolerance
    )
  }

  private cancelResize() {
    if (this.resizeTimer) clearInterval(this.resizeTimer)
    this.resizeTimer = undefined
    this.resizeTarget = undefined
  }

  private applyBounds(window: BrowserWindow, bounds: Rectangle) {
    // Native move events also fire during resizing. They must not move the user's anchor.
    this.appliedBounds = bounds
    this.applyingBounds = true
    try {
      window.setBounds(bounds, false)
      this.appliedBounds = window.getBounds()
    } finally {
      this.applyingBounds = false
    }
  }

  private resize(animate = true) {
    const window = this.window
    if (!window || window.isDestroyed() || this.dragging) return
    this.syncDockView()
    const target = this.bounds()
    const shouldAnimate = animate && !this.reducedMotion && window.isVisible()
    // Frequent status refreshes keep the current trajectory instead of restarting it.
    if (shouldAnimate && this.resizeTarget && this.sameBounds(target, this.resizeTarget)) return
    const from = window.getBounds()
    this.cancelResize()
    if (this.sameBounds(from, target, 1)) return
    if (!shouldAnimate) {
      this.applyBounds(window, target)
      return
    }
    this.resizeTarget = target
    const started = performance.now()
    const duration = target.width < from.width || target.height < from.height ? 180 : 220
    this.resizeTimer = setInterval(() => {
      if (window.isDestroyed() || this.window !== window || !window.isVisible()) {
        this.cancelResize()
        return
      }
      const progress = Math.min(1, (performance.now() - started) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      const mix = (a: number, b: number) => Math.round(a + (b - a) * eased)
      this.applyBounds(window, {
        x: mix(from.x, target.x),
        y: mix(from.y, target.y),
        width: mix(from.width, target.width),
        height: mix(from.height, target.height),
      })
      if (progress === 1) this.cancelResize()
    }, 16)
  }

  private reposition = () => this.resize(false)

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.disposed) throw new Error('控制提示已关闭')
    if (this.opening) return this.opening
    if (this.window && !this.window.isDestroyed()) return this.window
    const isolatedSession = session.fromPartition('coloop-control-indicator')
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    )
    isolatedSession.setPermissionCheckHandler(() => false)
    isolatedSession.setDevicePermissionHandler(() => false)
    const window = new BrowserWindow({
      ...this.bounds(),
      title: 'Coloop · Control status',
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      thickFrame: false,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      closable: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.options.preloadPath,
        session: isolatedSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    })
    this.window = window
    window.on('move', () => {
      if (this.applyingBounds) return
      const bounds = window.getBounds()
      // Windows may round DIP coordinates by one pixel at fractional scale factors.
      if (this.appliedBounds && this.sameBounds(bounds, this.appliedBounds, 1)) return
      this.cancelResize()
      this.appliedBounds = undefined
      this.anchor = { x: bounds.x + bounds.width / 2, y: bounds.y }
    })
    window.on('blur', () => {
      if (this.editingCommand) {
        this.editingCommand = false
        window.setFocusable(false)
      }
    })
    window.setMenu(null)
    window.setAlwaysOnTop(true, 'screen-saver')
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    window.webContents.on('render-process-gone', () => void this.unavailable('控制提示进程已退出'))
    window.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) void this.unavailable('控制提示加载失败')
    })
    window.on('unresponsive', () => void this.unavailable('控制提示无响应'))
    window.on('hide', () => {
      if (!this.hiding && this.isActualControl()) void this.unavailable('控制提示已不可见')
    })
    window.on('close', (event) => {
      if (this.disposed) return
      event.preventDefault()
      if (this.current.mode === 'preview') void this.update({ mode: 'hidden' })
      else if (this.isActualControl()) void this.stop().catch(() => {})
    })
    window.on('closed', () => {
      if (this.window === window) this.window = undefined
      if (this.isActualControl()) void this.unavailable('控制提示窗口已关闭')
    })
    const loading = (async () => {
      if (this.options.developmentUrl) await window.loadURL(this.expectedUrl)
      else await window.loadFile(this.options.rendererPath, { query: { surface: 'control' } })
      if (window.isDestroyed() || this.window !== window) throw new Error('控制提示窗口不可用')
      return window
    })()
    this.opening = loading
    try {
      return await loading
    } finally {
      if (this.opening === loading) this.opening = undefined
    }
  }

  private isActualControl() {
    return !this.disposed && isActiveControlMode(this.current.mode)
  }

  private assign(snapshot: ControlIndicatorSnapshot) {
    this.current = {
      ...snapshot,
      dockEdge: this.dockEdge,
      dockCollapsed: this.dockCollapsed(),
      revision: this.current.revision + 1,
    }
    this.window?.webContents.send('control-indicator:snapshot', { ...this.current })
    return this.current.revision
  }

  private waitForPaint(revision: number) {
    if (this.paintedRevision >= revision) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const waiter: PaintWaiter = {
        revision,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.paintWaiters.delete(waiter)
          reject(new Error('控制提示未能确认显示'))
        }, 6000),
      }
      this.paintWaiters.add(waiter)
    })
  }

  private rejectPaints(message: string) {
    for (const waiter of this.paintWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(message))
    }
    this.paintWaiters.clear()
  }

  private clearPreviewTimer() {
    if (this.previewTimer) clearTimeout(this.previewTimer)
    this.previewTimer = undefined
  }

  async update(input: ControlIndicatorSnapshot): Promise<void> {
    if (this.disposed) throw new Error('控制提示已关闭')
    const snapshot = controlIndicatorSnapshotSchema.parse(input)
    if (snapshot.expanded === undefined)
      snapshot.expanded =
        snapshot.taskId === this.current.taskId ? (this.current.expanded ?? false) : false
    if (this.dismissed && !isActiveControlMode(snapshot.mode) && snapshot.mode !== 'hidden') return
    if (isActiveControlMode(snapshot.mode)) this.dismissed = false
    if (!this.canStartTask(snapshot.mode)) this.editingCommand = false
    if (
      !this.editingCommand &&
      (snapshot.mode !== 'question' || snapshot.questionId !== this.current.questionId)
    )
      this.window?.setFocusable(false)
    this.clearPreviewTimer()
    const previous = this.current
    const revision = this.assign(snapshot)
    if (snapshot.mode === 'hidden') {
      this.cancelResize()
      this.dragging = undefined
      this.rejectPaints('控制显示已取消')
      this.hiding = true
      try {
        if (this.window && !this.window.isDestroyed()) this.window.hide()
      } finally {
        this.hiding = false
      }
      return
    }
    try {
      const window = await this.ensureWindow()
      if (this.current.mode === 'hidden') throw new Error('控制显示已取消')
      // A new active task must be fully visible before its paint acknowledgment;
      // routine refreshes and user-driven panel changes can keep moving independently.
      const enteringControl =
        isActiveControlMode(snapshot.mode) &&
        (snapshot.mode !== previous.mode || snapshot.taskId !== previous.taskId)
      this.resize(!enteringControl)
      window.webContents.send('control-indicator:snapshot', { ...this.current })
      if (!window.isVisible()) window.showInactive()
      if (!window.isVisible()) throw new Error('控制提示未能显示')
      await this.waitForPaint(revision)
    } catch (error) {
      if (this.isActualControl()) void this.unavailable('控制提示未能确认显示')
      throw error
    }
  }

  async preview(): Promise<void> {
    this.dismissed = false
    if (this.isActualControl()) throw new Error('控制期间不能替换为预览')
    await this.update({ mode: 'preview', detail: 'Preview · No actions running', sessionCount: 0 })
    if (this.current.mode === 'preview')
      this.previewTimer = setTimeout(() => {
        if (this.current.mode === 'preview') void this.update({ mode: 'hidden' }).catch(() => {})
      }, 30_000)
  }

  private stop(): Promise<void> {
    if (this.stopPending) return this.stopPending
    if (!this.isActualControl()) return Promise.reject(new Error('当前没有正在执行的控制'))
    this.stopPending = Promise.resolve()
      .then(async () => {
        const previous = this.current
        // Stopping sources never waits for rendering, the NPU, or an animation acknowledgment.
        void this.update({
          mode: 'stopping',
          startedAt: previous.startedAt,
          sessionCount: previous.sessionCount,
        }).catch(() => {})
        try {
          await this.options.onStop()
        } catch {
          await this.update({
            mode: 'unconfirmed',
            startedAt: previous.startedAt,
            sessionCount: previous.sessionCount,
            error: '停止控制未确认，请打开 Coloop 检查',
          }).catch(() => {})
          throw new Error('停止控制未确认')
        }
      })
      .finally(() => {
        this.stopPending = undefined
      })
    return this.stopPending
  }

  private async unavailable(reason: string) {
    if (this.disposed || this.recovering) return
    this.recovering = true
    this.cancelResize()
    this.appliedBounds = undefined
    this.dragging = undefined
    this.clearPreviewTimer()
    this.rejectPaints(reason)
    const actualControl = this.isActualControl()
    const window = this.window
    this.window = undefined
    this.opening = undefined
    this.paintedRevision = 0
    if (actualControl)
      this.assign({
        mode: 'unconfirmed',
        startedAt: this.current.startedAt,
        sessionCount: this.current.sessionCount,
        error: '控制提示中断，正在停止控制；请打开 Coloop 检查',
      })
    else this.assign({ mode: 'hidden' })
    if (window && !window.isDestroyed()) window.destroy()
    try {
      if (actualControl) {
        try {
          if (this.options.onUnavailable) await this.options.onUnavailable(reason)
          else if (this.stopPending) await this.stopPending
          else {
            await this.options.onStop()
          }
        } catch {
          // Unknown remains visible after recovery; failure is never converted to success.
        }
        if (this.isActualControl()) {
          try {
            const recovered = await this.ensureWindow()
            recovered.webContents.send('control-indicator:snapshot', { ...this.current })
            recovered.showInactive()
          } catch {
            // The stop callback has already been invoked even when recovery cannot display.
          }
        }
      }
    } finally {
      this.recovering = false
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.cancelResize()
    this.clearPreviewTimer()
    this.rejectPaints('控制提示已关闭')
    screen.removeListener('display-added', this.reposition)
    screen.removeListener('display-removed', this.reposition)
    screen.removeListener('display-metrics-changed', this.reposition)
    for (const channel of CHANNELS) ipcMain.removeHandler(channel)
    const window = this.window
    this.window = undefined
    if (window && !window.isDestroyed()) window.destroy()
  }
}
