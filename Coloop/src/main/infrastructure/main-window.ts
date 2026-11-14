import { BrowserWindow } from 'electron'

const readiness = new WeakMap<BrowserWindow, { painted: boolean; showRequested: boolean }>()

export function showMainWindow(window?: BrowserWindow) {
  if (!window || window.isDestroyed()) return
  const state = readiness.get(window)
  if (state) state.showRequested = true
  if (window.webContents.isCrashed()) {
    window.webContents.reload()
    return
  }
  if (state && !state.painted) return
  if (window.isMinimized()) window.restore()
  window.show()
  // External launchers can force SW_HIDE on the first native show request.
  if (!window.isVisible()) window.show()
  window.focus()
  window.webContents.invalidate()
}

export function hideMainWindow(window?: BrowserWindow) {
  if (!window || window.isDestroyed()) return
  const state = readiness.get(window)
  if (state) state.showRequested = false
  window.hide()
}

export function createMainWindow(options: { preload: string; icon: string; showOnReady: boolean }) {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1060,
    minHeight: 720,
    title: 'Coloop',
    backgroundColor: '#f6f7f9',
    icon: options.icon,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: options.preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  })
  const state = { painted: false, showRequested: options.showOnReady }
  readiness.set(window, state)
  const repaint = () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.invalidate()
  }
  window.on('show', repaint)
  window.on('restore', repaint)
  window.on('hide', () => {
    state.showRequested = false
  })
  window.webContents.on('did-start-loading', () => {
    state.painted = false
  })
  // Electron can paint the empty HTML shell before React has mounted the workspace.
  // Only the main frame's post-render acknowledgment unlocks the first reveal.
  window.webContents.ipc.on('app:renderer-ready', (event) => {
    if (event.senderFrame !== window.webContents.mainFrame || state.painted) return
    state.painted = true
    if (state.showRequested) showMainWindow(window)
  })
  return window
}
