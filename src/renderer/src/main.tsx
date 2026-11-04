import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ControlIndicator } from './ControlIndicator'
import { PrivateLogin } from './PrivateLogin'
import { PrivateMemoryEntry } from './PrivateMemoryEntry'
import './system.css'

const controlSurface = new URLSearchParams(location.search).get('surface') === 'control'
const privateLoginSurface =
  new URLSearchParams(location.search).get('surface') === 'credential-login'
const privateEntrySurface =
  new URLSearchParams(location.search).get('surface') === 'credential-entry'
if (privateEntrySurface) document.body.classList.add('private-entry-surface')
if (privateLoginSurface) document.body.classList.add('private-login-surface')
if (controlSurface) {
  document.body.classList.add('control-surface')
  document.title = 'Coloop · Control status'
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  componentDidCatch() {
    if (controlSurface) void window.coloopControl?.stop().catch(() => {})
  }
  render() {
    if (this.state.error && controlSurface)
      return (
        <main className="control-indicator" data-mode="unconfirmed">
          <div className="control-copy" role="alert">
            <strong className="control-title">Coloop</strong>
            <span className="control-detail">Stop requested. Open Coloop to check.</span>
          </div>
          <button
            className="control-stop"
            onClick={() => void window.coloopControl?.stop().catch(() => {})}
          >
            Stop
          </button>
        </main>
      )
    return this.state.error ? (
      <main className="startup">
        <h1>界面暂时无法显示</h1>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>重新加载</button>
      </main>
    ) : (
      this.props.children
    )
  }
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {controlSurface ? (
        <ControlIndicator />
      ) : privateLoginSurface ? (
        <PrivateLogin />
      ) : privateEntrySurface ? (
        <PrivateMemoryEntry />
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </React.StrictMode>,
)
