import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface RemoteTunnelSnapshot {
  status: 'stopped' | 'starting' | 'online' | 'error'
  endpoint?: string
  error?: string
}

/** Publishes only the dedicated encrypted gateway, never the native Hook service. */
export class RemoteTunnel {
  private process?: ChildProcessWithoutNullStreams
  private state: RemoteTunnelSnapshot = { status: 'stopped' }
  private generation = 0
  private starting?: Promise<string>
  constructor(private options: { executable: string; directory: string; onChange: () => void }) {}

  snapshot(): RemoteTunnelSnapshot {
    return { ...this.state }
  }

  start(localUrl: string): Promise<string> {
    if (this.starting) return this.starting
    if (this.state.status === 'online' && this.state.endpoint)
      return Promise.resolve(this.state.endpoint)
    this.starting = this.launch(localUrl).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async launch(localUrl: string): Promise<string> {
    const target = new URL(localUrl)
    if (
      target.protocol !== 'http:' ||
      target.hostname !== '127.0.0.1' ||
      !target.port ||
      target.pathname !== '/' ||
      target.search ||
      target.username ||
      target.password
    )
      throw new Error('远程网关地址无效')
    const generation = ++this.generation
    const previous = this.process
    this.process = undefined
    if (previous && previous.exitCode === null) {
      previous.kill()
      await Promise.race([
        new Promise<void>((resolve) => previous.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ])
    }
    if (generation !== this.generation) throw new Error('已取消公网连接')
    try {
      await access(this.options.executable)
    } catch {
      if (generation !== this.generation) throw new Error('已取消公网连接')
      this.state = {
        status: 'error',
        error: '缺少公网连接组件，请运行 npm run setup:remote 或使用完整程序包',
      }
      this.options.onChange()
      throw new Error(this.state.error)
    }
    if (generation !== this.generation) throw new Error('已取消公网连接')
    await mkdir(this.options.directory, { recursive: true })
    const configuration = join(this.options.directory, 'cloudflared.yml')
    await writeFile(configuration, '{}\n', { mode: 0o600 })
    if (generation !== this.generation) throw new Error('已取消公网连接')
    this.state = { status: 'starting' }
    this.options.onChange()
    const child = spawn(
      this.options.executable,
      [
        'tunnel',
        '--config',
        configuration,
        '--no-autoupdate',
        '--protocol',
        'http2',
        '--url',
        target.href,
        '--loglevel',
        'info',
      ],
      {
        windowsHide: true,
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: this.options.directory,
          USERPROFILE: this.options.directory,
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
      },
    )
    this.process = child
    return new Promise<string>((resolve, reject) => {
      let endpoint: string | undefined
      let connected = false
      let settled = false
      let pending = ''
      const timer = setTimeout(() => fail('公网隧道连接超时，请检查网络后重试'), 65_000)
      const fail = (message: string) => {
        if (settled || this.generation !== generation) return
        settled = true
        clearTimeout(timer)
        this.state = { status: 'error', error: message }
        this.options.onChange()
        child.kill()
        reject(new Error(message))
      }
      const ready = () => {
        if (!endpoint || !connected || settled || this.generation !== generation) return
        settled = true
        clearTimeout(timer)
        this.state = { status: 'online', endpoint }
        this.options.onChange()
        resolve(endpoint)
      }
      const read = (chunk: Buffer) => {
        if (this.generation !== generation) return
        pending = (pending + chunk.toString('utf8')).slice(-16_384)
        const match = pending.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)
        if (match) endpoint = match[0].toLowerCase()
        if (/Registered tunnel connection|"event"\s*:\s*"registered"/.test(pending))
          connected = true
        if (
          /failed to request quick Tunnel|Error unmarshaling|failed to unmarshal quick Tunnel/.test(
            pending,
          )
        )
          fail('无法创建临时公网连接，请稍后重试')
        ready()
      }
      child.stdout.on('data', read)
      child.stderr.on('data', read)
      child.once('error', () => fail('公网连接组件无法启动'))
      child.once('exit', () => {
        clearTimeout(timer)
        if (this.process === child) this.process = undefined
        if (this.generation !== generation) {
          if (!settled) {
            settled = true
            reject(new Error('已取消公网连接'))
          }
          return
        }
        if (!settled) fail('公网连接已退出，请检查网络后重试')
        else if (this.state.status === 'online') {
          this.state = { status: 'error', error: '公网连接已断开，重新连接后需更新手机中的地址' }
          this.options.onChange()
        }
      })
    })
  }

  async stop(): Promise<void> {
    ++this.generation
    const child = this.process
    this.process = undefined
    this.state = { status: 'stopped' }
    this.options.onChange()
    if (!child || child.exitCode !== null) return
    child.kill()
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ])
  }
}
