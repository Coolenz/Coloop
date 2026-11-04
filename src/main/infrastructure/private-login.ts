import { app, BrowserWindow, WebContentsView, ipcMain, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  credentialFieldSchema,
  type CredentialRecord,
  type PrivateLoginState,
} from '../../shared/credentials'
import { allowedLoginUrl, focusProbe } from '../domain/credential-policy'
import type { BoardGateway } from './board'
import { PrivateLoginFocus } from './private-login-focus'

export class PrivateLoginWindow {
  readonly window: BrowserWindow
  private view: WebContentsView
  private closed = false
  private generation = 0
  private operation = 0
  private native: PrivateLoginFocus
  private state: PrivateLoginState
  constructor(
    record: CredentialRecord,
    private board: BoardGateway,
    private onClosed: () => void,
  ) {
    this.state = {
      recordId: record.id,
      origin: record.origin,
      busy: false,
      message: '先点选网页中的账号或密码框，再点击对应的填入按钮。登录由你在网页中提交。',
    }
    const isolated = session.fromPartition(`coloop-private-${randomUUID()}`)
    isolated.setPermissionRequestHandler((_w, _p, cb) => cb(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    isolated.on('will-download', (event) => event.preventDefault())
    isolated.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !allowedLoginUrl(details.url, record.origin) })
    })
    this.window = new BrowserWindow({
      width: 1120,
      height: 860,
      minWidth: 800,
      minHeight: 650,
      show: false,
      title: 'Coloop · 私密登录',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/credential-login.cjs'),
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        devTools: false,
      },
    })
    this.native = new PrivateLoginFocus(
      app.isPackaged
        ? join(process.resourcesPath, 'private-login-focus.ps1')
        : join(app.getAppPath(), 'resources/private-login-focus.ps1'),
      this.window.getNativeWindowHandle(),
    )
    this.view = new WebContentsView({
      webPreferences: {
        session: isolated,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        devTools: false,
        spellcheck: false,
      },
    })
    this.window.contentView.addChildView(this.view)
    const resize = () => {
      const [width, height] = this.window.getContentSize()
      this.view.setBounds({ x: 0, y: 144, width, height: Math.max(1, height - 144) })
    }
    this.window.on('resize', resize)
    resize()
    const contents = this.view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-navigate', (event, url) => {
      this.generation++
      if (!allowedLoginUrl(url, record.origin)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      this.generation++
      if (!allowedLoginUrl(url, record.origin)) event.preventDefault()
    })
    contents.on('did-start-navigation', () => {
      this.generation++
    })
    contents.on('render-process-gone', () => this.window.close())
    this.window.on('blur', () => {
      this.generation++
    })
    const channel = 'private-login:action'
    ipcMain.handle(channel, async (event, input: unknown) => {
      if (event.sender !== this.window.webContents || event.senderFrame !== event.sender.mainFrame)
        throw new Error('私密登录入口无效')
      if (input === 'state') return this.state
      if (input === 'close') {
        this.window.close()
        return
      }
      const field = credentialFieldSchema.parse(input)
      return this.fill(field)
    })
    this.window.once('closed', () => {
      this.closed = true
      this.native.dispose()
      this.generation++
      ipcMain.removeHandler(channel)
      if (!contents.isDestroyed()) contents.close()
      // Keep global observation protection until a possibly in-flight HID call drains.
      if (!this.operation) this.onClosed()
      void isolated.clearStorageData().catch(() => {})
      void isolated.clearCache().catch(() => {})
    })
  }
  async open(developmentUrl?: string) {
    if (developmentUrl) {
      const url = new URL(developmentUrl)
      url.searchParams.set('surface', 'credential-login')
      await this.window.loadURL(url.toString())
    } else
      await this.window.loadFile(join(import.meta.dirname, '../renderer/index.html'), {
        query: { surface: 'credential-login' },
      })
    this.window.show()
    await this.view.webContents.loadURL(this.state.origin).catch(() => {
      this.update('网站加载失败或跳转到了其他网站。请检查网址；跨域登录暂不支持。')
    })
  }
  close() {
    if (!this.closed) this.window.close()
  }
  private update(message: string) {
    this.state = { ...this.state, message }
    if (!this.closed) this.window.webContents.send('private-login:state', this.state)
  }
  private async probe(field: 'username' | 'password', initial = false): Promise<boolean> {
    if (
      this.closed ||
      !this.window.isFocused() ||
      !this.view.webContents.isFocused() ||
      !allowedLoginUrl(this.view.webContents.getURL(), this.state.origin)
    )
      return false
    if (!(await this.native.probe(initial))) return false
    return (
      (await this.view.webContents.executeJavaScriptInIsolatedWorld(999, [
        { code: focusProbe(field, initial) },
      ])) === true
    )
  }
  private async fill(field: 'username' | 'password') {
    if (this.closed || this.operation) throw new Error('正在填入，请等待本次操作结束')
    this.operation++
    this.state = { ...this.state, busy: true }
    this.update('正在检查输入框…')
    try {
      this.window.focus()
      this.view.webContents.focus()
      await new Promise((resolve) => setTimeout(resolve, 30))
      const generation = this.generation
      if (!(await this.probe(field, true))) {
        this.update(
          '请点选对应的输入框，并切换为美式英文键盘、关闭 Caps Lock，松开快捷键后再填入。',
        )
        return this.state
      }
      const response = await this.board.credentials(
        {
          op: 'fill',
          id: this.state.recordId,
          origin: this.state.origin,
          field,
          requestId: randomUUID(),
        },
        async () => this.generation === generation && (await this.probe(field)),
      )
      if (
        !response ||
        typeof response !== 'object' ||
        (response as { state?: string }).state !== 'input_sent'
      )
        throw new Error('填入结果未确认')
      this.update('已发送键盘输入。请检查页面，再由你提交登录；这不代表已经登录成功。')
    } catch {
      this.update('填入未完成或结果不确定。请检查页面内容，清空后再按需手动发起，勿重复点击。')
    } finally {
      this.operation--
      this.state = { ...this.state, busy: false }
      if (this.closed) this.onClosed()
      else this.update(this.state.message)
    }
    return this.state
  }
}
