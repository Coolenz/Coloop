import type { BoardConfig, DeviceState } from '../../shared/contracts'
import type { AutoConnectionSnapshot } from '../../shared/connection'
import type { ConnectionSettings } from '../infrastructure/connection-settings'

interface Options {
  settings: ConnectionSettings
  config: () => BoardConfig
  state: () => DeviceState
  connect: (password: string) => Promise<DeviceState>
  startModel: () => Promise<unknown>
  canAttempt: () => boolean
  onChange: () => void
  now?: () => number
}
export class AutoConnectionService {
  private pending = false
  private stopped = false
  private attempt = 0
  private next = 0
  private message = ''
  private generation = 0
  private phase: AutoConnectionSnapshot['phase'] = 'needs_setup'
  constructor(private options: Options) {}
  private now() {
    return this.options.now?.() ?? Date.now()
  }
  snapshot(): AutoConnectionSnapshot {
    const device = this.options.state()
    const enabled = this.options.settings.enabled
    const ready = device.status === 'connected' && device.qwenReady && device.modelPrivacyReady
    return {
      enabled,
      hasCredential: this.options.settings.hasCredential(this.options.config()),
      phase: ready ? 'ready' : !enabled ? 'disabled' : this.phase,
      attempts: this.attempt,
      retryAt: this.next > this.now() ? new Date(this.next).toISOString() : undefined,
      message: ready
        ? 'RK 已连接，可以发送消息'
        : !enabled
          ? '自动连接已暂停，点击重新连接可恢复'
          : this.message || '首次连接 RK 后将自动重连',
    }
  }
  private update(phase: AutoConnectionSnapshot['phase'], message: string) {
    if (phase === this.phase && message === this.message) return
    this.phase = phase
    this.message = message
    this.options.onChange()
  }
  async connectManually(password: string) {
    if (this.pending) throw new Error('正在自动连接 RK，请稍候')
    this.pending = true
    const generation = this.generation
    this.update('connecting', '正在连接 RK')
    try {
      const result = await this.options.connect(password)
      if (this.stopped || generation !== this.generation) throw new Error('已取消自动连接')
      this.options.settings.remember(this.options.config(), password)
      this.attempt = 0
      this.next = 0
      if (!result.qwenReady) {
        this.update('starting_model', 'RK 已连接，正在启动本地模型')
        await this.options.startModel()
      }
      if (!this.options.state().modelPrivacyReady)
        throw new Error('RK 隐私服务尚未就绪，请检查端侧服务')
      this.update('ready', 'RK 已连接，可以发送消息')
      return this.options.state()
    } catch (error) {
      this.backoff(error)
      throw error
    } finally {
      this.pending = false
    }
  }
  retryNow() {
    this.options.settings.setEnabled(true)
    this.next = 0
    this.attempt = 0
    void this.tick()
  }
  disable() {
    this.generation++
    this.options.settings.setEnabled(false)
    this.next = 0
    this.update('disabled', '自动连接已暂停')
  }
  dispose() {
    this.generation++
    this.stopped = true
  }
  private backoff(error: unknown) {
    this.attempt++
    const delay = [1000, 2000, 5000, 10000, 20000, 30000][Math.min(this.attempt - 1, 5)]
    this.next = this.now() + delay
    const detail =
      error instanceof Error ? error.message.slice(0, 350) : '请检查 RK 的 USB 连接和供电'
    this.update('waiting', `连接未完成，将自动重试。${detail}`)
  }
  async tick() {
    if (this.stopped || this.pending || !this.options.settings.enabled) return
    const state = this.options.state()
    if (state.status === 'connected' && state.qwenReady && state.modelPrivacyReady) {
      this.attempt = 0
      this.next = 0
      this.update('ready', 'RK 已连接，可以发送消息')
      return
    }
    if (this.next > this.now() || state.status === 'connecting') return
    if (!this.options.canAttempt()) {
      this.update('paused', '当前任务结束后自动恢复连接')
      return
    }
    let password: string | undefined
    try {
      password = this.options.settings.password(this.options.config())
    } catch (error) {
      this.update('needs_setup', (error as Error).message)
      return
    }
    if (state.status !== 'connected' && password === undefined) {
      this.update('needs_setup', '请在电脑设备管理连接 RK 一次，之后会自动连接')
      return
    }
    this.pending = true
    const generation = this.generation
    try {
      if (state.status !== 'connected') {
        this.update('connecting', '正在自动连接 RK')
        await this.options.connect(password!)
      }
      if (this.stopped || generation !== this.generation) return
      const connected = this.options.state()
      if (!connected.qwenReady) {
        this.update('starting_model', 'RK 已连接，正在启动本地模型')
        await this.options.startModel()
      }
      if (!this.options.state().modelPrivacyReady)
        throw new Error('RK 隐私服务尚未就绪，请检查端侧服务')
      this.attempt = 0
      this.next = 0
      this.update('ready', 'RK 已连接，可以发送消息')
    } catch (error) {
      this.backoff(error)
    } finally {
      this.pending = false
    }
  }
}
