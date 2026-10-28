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
} from 'electron'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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
import { TaskService } from './services/tasks'
import { errorMessage } from './domain/errors'

let window: BrowserWindow | undefined
let tasks: TaskService, board: BoardGateway, ocr: OcrEngine
const isDevelopment = !app.isPackaged
const developmentUrl = process.env.ELECTRON_RENDERER_URL
if (process.env.COLOOP_DATA_DIR) app.setPath('userData', process.env.COLOOP_DATA_DIR)
const lock = app.requestSingleInstanceLock()
if (!lock) app.quit()
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
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
  const snapshot = (): AppSnapshot => ({
    settings: store.publicSettings(),
    device: board.state,
    tasks: store.tasks,
    version: app.getVersion(),
    ocrBusy: ocr.busy,
    ocrProgress: ocr.progress,
  })
  let notifyTimer: ReturnType<typeof setTimeout> | undefined
  const notify = () => {
    if (!notifyTimer)
      notifyTimer = setTimeout(() => {
        notifyTimer = undefined
        if (window && !window.isDestroyed()) window.webContents.send('app:snapshot', snapshot())
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
  )

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
        return { ok: false, error: errorMessage(error) }
      }
    })
  }
  handle('app:get', () => snapshot())
  handle('settings:save', (input: unknown) => {
    if (tasks.running) throw new Error('任务运行期间无法修改配置')
    const parsed = settingsSchema.parse(input)
    if (JSON.stringify(parsed.board) !== JSON.stringify(store.config.board)) board.disconnect()
    const result = store.saveSettings(parsed)
    notify()
    return result
  })
  handle('settings:import-rk', () => {
    if (tasks.running) throw new Error('请先等待任务结束')
    const result = store.saveSettings({ ...store.config, board: importRkBoard() })
    board.disconnect()
    notify()
    return result
  })
  handle('device:connect', (password: unknown) =>
    board.connect(store.config.board, z.string().max(1024).parse(password)),
  )
  handle('device:disconnect', () => {
    if (tasks.running && store.tasks[0]?.target === 'rk') throw new Error('请先停止端侧任务')
    board.disconnect()
  })
  handle('device:refresh', () => board.refresh())
  handle('screen:displays', () =>
    screen.getAllDisplays().map((d) => ({ id: String(d.id), name: d.label || `显示器 ${d.id}` })),
  )
  handle('screen:capture', (displayId: unknown) =>
    captureScreen(z.string().max(50).optional().parse(displayId)),
  )
  handle('screen:open', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: '选择需要识别的图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }],
    })
    if (result.canceled) return null
    const buffer = await readFile(result.filePaths[0])
    if (buffer.length > 20_000_000) throw new Error('图片超过 20 MB，请先压缩')
    return remember(buffer, result.filePaths[0].split(/[\\/]/).pop() || '图片')
  })
  handle('ocr:recognize', (id: unknown) => {
    const buffer = captures.get(z.string().uuid().parse(id))
    if (!buffer) throw new Error('图片已过期，请重新截取或导入')
    return ocr.recognize(buffer)
  })
  handle('task:run', (request: unknown) => tasks.start(taskRequestSchema.parse(request)))
  handle('task:cancel', (id: unknown) => tasks.cancel(z.string().uuid().parse(id)))
  handle('provider:test', async () => {
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
  window.once('ready-to-show', () => window?.show())
  if (isDevelopment && developmentUrl) await window.loadURL(developmentUrl)
  else await window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  const poll = setInterval(() => {
    if (board.state.status === 'connected') void board.refresh().catch(() => {})
  }, 15_000)
  app.on('before-quit', () => {
    clearInterval(poll)
    tasks.dispose()
    board.disconnect()
    void ocr.dispose()
  })
}
app.on('window-all-closed', () => app.quit())
