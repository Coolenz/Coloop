import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  windows: [] as any[],
  session: undefined as any,
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {},
      setWindowOpenHandler: vi.fn(),
    })
    setContentProtection = vi.fn()
    loadFile = vi.fn().mockResolvedValue(undefined)
    loadURL = vi.fn().mockResolvedValue(undefined)
    show = vi.fn()
    focus = vi.fn()
    close() {
      this.emit('closed')
    }
    constructor(readonly options: unknown) {
      super()
      harness.windows.push(this)
    }
  }
  return {
    app: { isPackaged: true },
    BrowserWindow: Window,
    ipcMain: {
      handle: (name: string, handler: (...args: any[]) => Promise<any>) =>
        harness.handlers.set(name, handler),
      removeHandler: (name: string) => harness.handlers.delete(name),
    },
    session: {
      fromPartition: () =>
        (harness.session = {
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          setDisplayMediaRequestHandler: vi.fn(),
          clearStorageData: vi.fn().mockResolvedValue(undefined),
          clearCache: vi.fn().mockResolvedValue(undefined),
          webRequest: { onBeforeRequest: vi.fn() },
        }),
    },
  }
})
import { PrivateMemoryEntryWindow } from '../src/main/infrastructure/private-memory-entry'

beforeEach(() => {
  harness.handlers.clear()
  harness.windows.length = 0
})
function fixture(create = vi.fn().mockResolvedValue({ indexed: true })) {
  const saved = vi.fn(),
    closed = vi.fn()
  const entry = new PrivateMemoryEntryWindow(create, saved, closed)
  const native = harness.windows[0]
  const handler = harness.handlers.get('private-entry:action')!
  const event = { sender: native.webContents, senderFrame: native.webContents.mainFrame }
  return { entry, native, handler, event, saved, closed, create }
}
describe('private memory entry isolation', () => {
  it('keeps capture exclusion disabled and denies packaged network requests', async () => {
    const { entry, native } = fixture()
    expect(native.setContentProtection).not.toHaveBeenCalledWith(true)
    expect(native.show).not.toHaveBeenCalled()
    const filter = harness.session.webRequest.onBeforeRequest.mock.calls[0][0]
    for (const url of ['https://example.com', 'http://127.0.0.1:8080', 'data:text/html,x']) {
      const callback = vi.fn()
      filter({ url }, callback)
      expect(callback).toHaveBeenCalledWith({ cancel: true })
    }
    await entry.open()
    expect(native.show).toHaveBeenCalledOnce()
  })
  it('rejects another window or child frame before accessing credentials', async () => {
    const { handler, event, create } = fixture()
    await expect(handler({ ...event, sender: {} }, 'save', {})).rejects.toThrow('入口无效')
    await expect(handler({ ...event, senderFrame: {} }, 'save', {})).rejects.toThrow('入口无效')
    expect(create).not.toHaveBeenCalled()
  })
  it('sends only the indexing result to the main window and consumes a successful save once', async () => {
    const { handler, event, saved, create } = fixture()
    const input = { origin: 'https://example.com', username: 'synthetic', password: 'secret' }
    expect(await handler(event, 'save', input)).toEqual({ ok: true, indexed: true })
    expect(saved).toHaveBeenCalledExactlyOnceWith(true)
    await expect(handler(event, 'save', input)).rejects.toThrow('等待')
    expect(create).toHaveBeenCalledTimes(1)
  })
  it('holds protection after a window closes until an in-flight save drains', async () => {
    let finish!: (result: { indexed: boolean }) => void
    const create = vi.fn(
      () =>
        new Promise<{ indexed: boolean }>((resolve) => {
          finish = resolve
        }),
    )
    const { handler, event, entry, closed } = fixture(create)
    const pending = handler(event, 'save', {})
    await expect(handler(event, 'save', {})).rejects.toThrow('等待')
    entry.close()
    expect(closed).not.toHaveBeenCalled()
    expect(harness.handlers.has('private-entry:action')).toBe(false)
    finish({ indexed: false })
    await pending
    expect(closed).toHaveBeenCalledTimes(1)
  })
  it('does not echo provider errors or submitted fields and permits retry after failure', async () => {
    const { handler, event, create, saved } = fixture(
      vi.fn().mockRejectedValue(new Error('sensitive payload')),
    )
    expect(await handler(event, 'save', {})).toEqual({ ok: false })
    create.mockResolvedValueOnce({ indexed: false })
    expect(await handler(event, 'save', {})).toEqual({ ok: true, indexed: false })
    expect(saved).toHaveBeenCalledExactlyOnceWith(false)
  })
  it('closes the window and releases protection if local loading fails', async () => {
    const { entry, native, closed } = fixture()
    native.loadFile.mockRejectedValue(new Error('load failed'))
    await expect(entry.open()).rejects.toThrow('load failed')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(harness.handlers.has('private-entry:action')).toBe(false)
  })
})
