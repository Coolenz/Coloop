import { contextBridge, ipcRenderer } from 'electron'
import type { AppSnapshot, DesktopApi } from '../shared/contracts'

const api: DesktopApi = {
  snapshot: () => ipcRenderer.invoke('app:get'),
  saveSettings: (input) => ipcRenderer.invoke('settings:save', input),
  importRk: () => ipcRenderer.invoke('settings:import-rk'),
  connect: (password) => ipcRenderer.invoke('device:connect', password),
  disconnect: () => ipcRenderer.invoke('device:disconnect'),
  refreshDevice: () => ipcRenderer.invoke('device:refresh'),
  startRkService: () => ipcRenderer.invoke('device:start-service'),
  captureScreen: (displayId) => ipcRenderer.invoke('screen:capture', displayId),
  listDisplays: () => ipcRenderer.invoke('screen:displays'),
  openImage: () => ipcRenderer.invoke('screen:open'),
  recognize: (id) => ipcRenderer.invoke('ocr:recognize', id),
  runTask: (request) => ipcRenderer.invoke('task:run', request),
  cancelTask: (id) => ipcRenderer.invoke('task:cancel', id),
  testProvider: () => ipcRenderer.invoke('provider:test'),
  exportHistory: () => ipcRenderer.invoke('history:export'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  onSnapshot: (callback) => {
    const listener = (_event: unknown, data: AppSnapshot) => callback(data)
    ipcRenderer.on('app:snapshot', listener)
    return () => ipcRenderer.removeListener('app:snapshot', listener)
  },
}
contextBridge.exposeInMainWorld('coloop', api)
