import { contextBridge, ipcRenderer } from 'electron'
import type { PrivateMemoryEntryApi } from '../shared/credentials'

const api: PrivateMemoryEntryApi = {
  save: (input) => ipcRenderer.invoke('private-entry:action', 'save', input),
  close: () => ipcRenderer.invoke('private-entry:action', 'close'),
}
contextBridge.exposeInMainWorld('coloopPrivateEntry', api)
