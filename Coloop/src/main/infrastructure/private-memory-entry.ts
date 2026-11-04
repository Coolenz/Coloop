import { app, BrowserWindow, ipcMain, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export class PrivateMemoryEntryWindow {
  readonly window: BrowserWindow
  private closed = false
  private saving = false
  private saved = false
  constructor(
    private create: (input: unknown) => Promise<{ indexed: boolean }>,
    private onSaved: (indexed: boolean) => void,
    private onClosed: () => void,
  ) {
    const isolated = session.fromPartition(`coloop-entry-${randomUUID()}`)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    // This form never needs a network connection; only its local assets may load.
    isolated.webRequest.onBeforeRequest((details, callback) =>
      callback({
        cancel:
          !details.url.startsWith('file:') &&
          (app.isPackaged || !details.url.startsWith('http://127.0.0.1:')),
      }),
    )
    this.window = new BrowserWindow({
      width: 720,
      height: 660,
      minWidth: 600,
      minHeight: 600,
      show: false,
      title: 'Coloop · 新建私密记忆',
      backgroundColor: '#ffffff',
      autoHideMenuBar: true,
      webPreferences: {
        session: isolated,
        preload: join(import.meta.dirname, '../preload/credential-entry.cjs'),
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        devTools: false,
        spellcheck: false,
      },
    })
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('will-navigate', (event) => event.preventDefault())
    this.window.webContents.on('render-process-gone', () => this.close())
    const channel = 'private-entry:action'
    ipcMain.handle(channel, async (event, action: unknown, input: unknown) => {
      if (
        event.sender !== this.window.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        this.closed
      )
        throw new Error('私密填写入口无效')
      if (action === 'close') {
        this.close()
        return
      }
      if (action !== 'save' || this.saving || this.saved) throw new Error('请等待当前保存结束')
      this.saving = true
      try {
        const result = await this.create(input)
        this.saved = true
        this.onSaved(result.indexed)
        return { ok: true, indexed: result.indexed }
      } catch {
        return { ok: false }
      } finally {
        this.saving = false
        if (this.closed) this.onClosed()
      }
    })
    this.window.once('closed', () => {
      this.closed = true
      ipcMain.removeHandler(channel)
      if (!this.saving) this.onClosed()
      void isolated.clearStorageData().catch(() => {})
      void isolated.clearCache().catch(() => {})
    })
  }
  async open(developmentUrl?: string) {
    try {
      if (!app.isPackaged && developmentUrl) {
        const url = new URL(developmentUrl)
        url.searchParams.set('surface', 'credential-entry')
        await this.window.loadURL(url.toString())
      } else
        await this.window.loadFile(join(import.meta.dirname, '../renderer/index.html'), {
          query: { surface: 'credential-entry' },
        })
      if (!this.closed) {
        this.window.show()
        this.window.focus()
      }
    } catch (error) {
      this.close()
      throw error
    }
  }
  close() {
    if (!this.closed) this.window.close()
  }
}
