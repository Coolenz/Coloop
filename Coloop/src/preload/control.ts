import { contextBridge, ipcRenderer } from 'electron'
import type { ControlIndicatorApi, ControlIndicatorView } from '../shared/control-indicator'
const api: ControlIndicatorApi = {
  snapshot: (revision) =>
    revision === undefined
      ? ipcRenderer.invoke('control-indicator:get')
      : ipcRenderer.invoke('control-indicator:get', revision),
  stop: () => ipcRenderer.invoke('control-indicator:stop'),
  openMain: () => ipcRenderer.invoke('control-indicator:open'),
  close: () => ipcRenderer.invoke('control-indicator:close'),
  closePreview: () => ipcRenderer.invoke('control-indicator:close-preview'),
  acceptSuggestion: (id, revision) =>
    ipcRenderer.invoke('control-indicator:accept', { id, revision }),
  dismissSuggestion: (id, revision) =>
    ipcRenderer.invoke('control-indicator:dismiss', { id, revision }),
  dismissResult: (id, revision) =>
    ipcRenderer.invoke('control-indicator:dismiss-result', { id, revision }),
  answerQuestion: (input) => ipcRenderer.invoke('control-indicator:answer', input),
  beginAnswer: () => ipcRenderer.invoke('control-indicator:begin-answer'),
  beginTask: () => ipcRenderer.invoke('control-indicator:begin-task'),
  startTask: (goal) => ipcRenderer.invoke('control-indicator:start-task', goal),
  endAnswer: () => ipcRenderer.invoke('control-indicator:end-answer'),
  setExpanded: (expanded) => ipcRenderer.invoke('control-indicator:expand', expanded),
  setRevealed: (revealed, reducedMotion = false) =>
    ipcRenderer.invoke('control-indicator:reveal', revealed, reducedMotion),
  drag: (phase, point) => ipcRenderer.invoke('control-indicator:drag', phase, point),
  pauseObservation: (paused) => ipcRenderer.invoke('control-indicator:pause-observation', paused),
  onSnapshot: (callback) => {
    const listener = (_event: unknown, snapshot: ControlIndicatorView) => callback(snapshot)
    ipcRenderer.on('control-indicator:snapshot', listener)
    return () => ipcRenderer.removeListener('control-indicator:snapshot', listener)
  },
}
contextBridge.exposeInMainWorld('coloopControl', api)
