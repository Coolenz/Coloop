import { contextBridge, ipcRenderer } from 'electron'
import type { AppSnapshot, DesktopApi } from '../shared/contracts'

const api: DesktopApi = {
  startProactiveTask: (goal) => ipcRenderer.invoke('proactive:start', goal),
  stopProactiveTask: () => ipcRenderer.invoke('proactive:stop'),
  pauseProactiveObservation: (paused) => ipcRenderer.invoke('proactive:pause', paused),
  acceptProactiveSuggestion: (id) => ipcRenderer.invoke('proactive:accept', id),
  dismissProactiveSuggestion: (id) => ipcRenderer.invoke('proactive:dismiss', id),
  answerProactiveQuestion: (input) => ipcRenderer.invoke('proactive:answer', input),
  browseMemories: (input) => ipcRenderer.invoke('memory:browse', input),
  saveMemory: (input) => ipcRenderer.invoke('memory:save', input),
  reviseMemory: (input) => ipcRenderer.invoke('memory:revise', input),
  removeMemory: (input) => ipcRenderer.invoke('memory:remove', input),
  openPrivateMemory: (id) => ipcRenderer.invoke('memory:open-private', id),
  openPrivateMemoryEditor: () => ipcRenderer.invoke('memory:open-private-editor'),
  closePrivateMemoryEditor: () => ipcRenderer.invoke('memory:close-private-editor'),
  onMemorySaved: (callback) => {
    const listener = (_event: unknown, indexed: boolean) => callback(indexed)
    ipcRenderer.on('memory:saved', listener)
    return () => ipcRenderer.removeListener('memory:saved', listener)
  },
  listDesktopWindows: () => ipcRenderer.invoke('desktop:windows'),
  startDesktopTask: (request) => ipcRenderer.invoke('desktop:start', request),
  stopDesktopTask: () => ipcRenderer.invoke('desktop:stop'),
  protectCredentials: (active) => ipcRenderer.invoke('credentials:protect', active),
  listCredentials: () => ipcRenderer.invoke('credentials:list'),
  createCredential: (input) => ipcRenderer.invoke('credentials:create', input),
  deleteCredential: (id) => ipcRenderer.invoke('credentials:delete', id),
  openCredentialLogin: (id) => ipcRenderer.invoke('credentials:open', id),
  snapshot: () => ipcRenderer.invoke('app:get'),
  saveSettings: (input) => ipcRenderer.invoke('settings:save', input),
  importRk: () => ipcRenderer.invoke('settings:import-rk'),
  connect: (password) => ipcRenderer.invoke('device:connect', password),
  retryRkConnection: () => ipcRenderer.invoke('device:auto-reconnect'),
  disconnect: () => ipcRenderer.invoke('device:disconnect'),
  refreshDevice: () => ipcRenderer.invoke('device:refresh'),
  startRkService: () => ipcRenderer.invoke('device:start-service'),
  captureScreen: (displayId) => ipcRenderer.invoke('screen:capture', displayId),
  listDisplays: () => ipcRenderer.invoke('screen:displays'),
  openImage: () => ipcRenderer.invoke('screen:open'),
  recognize: (id) => ipcRenderer.invoke('ocr:recognize', id),
  dispatchTask: (request) => ipcRenderer.invoke('task:dispatch', request),
  runTask: (request) => ipcRenderer.invoke('task:run', request),
  cancelTask: (id) => ipcRenderer.invoke('task:cancel', id),
  controlSession: (input) => ipcRenderer.invoke('sessions:command', input),
  stopSessionControl: () => ipcRenderer.invoke('sessions:stop-all'),
  resumeSessionControl: () => ipcRenderer.invoke('sessions:resume'),
  previewControlIndicator: () => ipcRenderer.invoke('sessions:preview-indicator'),
  enableMobile: () => ipcRenderer.invoke('mobile:enable'),
  importMobileServer: () => ipcRenderer.invoke('mobile:import-server'),
  disableMobile: () => ipcRenderer.invoke('mobile:disable'),
  createMobilePairing: () => ipcRenderer.invoke('mobile:pair'),
  revokeMobileDevice: (id) => ipcRenderer.invoke('mobile:revoke', id),
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
