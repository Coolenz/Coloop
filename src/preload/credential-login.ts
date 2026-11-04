import { contextBridge, ipcRenderer } from 'electron'
import type { PrivateLoginApi, PrivateLoginState } from '../shared/credentials'

const api: PrivateLoginApi = {
  state: () => ipcRenderer.invoke('private-login:action', 'state'),
  fill: (field) => ipcRenderer.invoke('private-login:action', field),
  close: () => ipcRenderer.invoke('private-login:action', 'close'),
  onChange(callback) {
    const listener = (_event: unknown, state: PrivateLoginState) => callback(state)
    ipcRenderer.on('private-login:state', listener)
    return () => ipcRenderer.removeListener('private-login:state', listener)
  },
}
contextBridge.exposeInMainWorld('coloopPrivateLogin', api)
