import { Client, type ClientChannel } from 'ssh2'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { boardSchema, type BoardConfig, type DeviceState } from '../../shared/contracts'
import { errorMessage } from '../domain/errors'

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
export function fingerprintOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}
export function importRkBoard(path = 'D:/RK/config/board.json'): BoardConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  return boardSchema.parse({
    host: raw.host,
    port: raw.ssh_port,
    username: raw.user,
    fingerprint: raw.host_key_sha256,
  })
}
const healthScript = `import json,os,socket,time
from pathlib import Path
memory={}
for line in Path('/proc/meminfo').read_text().splitlines():
 k,v=line.split(':',1); memory[k]=int(v.split()[0])
temps=[]
for p in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
 try: temps.append(float(p.read_text())/1000)
 except (OSError,ValueError): pass
chip=Path('/proc/device-tree/compatible')
print(json.dumps(dict(hostname=socket.gethostname(),chip=chip.read_bytes().replace(b'\\0',b' ').decode(errors='replace').strip() if chip.exists() else os.uname().machine,memoryTotalMb=round(memory.get('MemTotal',0)/1024),memoryAvailableMb=round(memory.get('MemAvailable',0)/1024),temperatureC=max(temps) if temps else None,uptimeSeconds=float(Path('/proc/uptime').read_text().split()[0]),qwenReady=all((Path.home()/'rk-edge-ai/qwen35'/p).exists() for p in ['run.sh','build/qwen35','qwen3.5-9b_w8a8_rk3588.rkllm']))))`

const healthSchema = z.object({
  hostname: z.string().max(255),
  chip: z.string().max(500),
  memoryTotalMb: z.number().nonnegative(),
  memoryAvailableMb: z.number().nonnegative(),
  temperatureC: z
    .number()
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
  uptimeSeconds: z.number().nonnegative(),
  qwenReady: z.boolean(),
})

export class BoardGateway {
  private client?: Client
  state: DeviceState = { status: 'disconnected' }
  constructor(private onChange: () => void) {}
  async connect(config: BoardConfig, password: string): Promise<DeviceState> {
    if (this.state.status === 'connecting') throw new Error('设备正在连接，请稍候')
    this.disconnect()
    this.state = { status: 'connecting' }
    this.onChange()
    const client = new Client()
    this.client = client
    const expected = config.fingerprint.replace(/^SHA256:/, '').replace(/=+$/, '')
    try {
      await new Promise<void>((resolve, reject) => {
        let ready = false
        const timer = setTimeout(() => {
          client.destroy()
          reject(new Error('连接超时，请检查 USB 数据线、设备供电和地址'))
        }, 12_000)
        client.once('ready', () => {
          ready = true
          clearTimeout(timer)
          resolve()
        })
        client.on('error', (error) => {
          clearTimeout(timer)
          if (!ready) reject(error)
          else if (this.client === client) {
            this.state = { status: 'error', error: errorMessage(error) }
            this.onChange()
          }
        })
        client.on('close', () => {
          clearTimeout(timer)
          if (!ready) reject(new Error('设备关闭了连接，请检查密码和设备指纹'))
          if (this.client === client) {
            this.client = undefined
            if (this.state.status !== 'error') this.state = { status: 'disconnected' }
            this.onChange()
          }
        })
        client.connect({
          host: config.host,
          port: config.port,
          username: config.username,
          password,
          hostVerifier: (key: Buffer) => {
            const actual = fingerprintOf(key)
            if (actual !== expected) {
              reject(new Error(`设备指纹不匹配，已停止连接。实际 SHA256:${actual}`))
              return false
            }
            return true
          },
          readyTimeout: 10_000,
          keepaliveInterval: 10_000,
          keepaliveCountMax: 3,
        })
      })
      this.state = { status: 'connected' }
      return await this.refresh()
    } catch (error) {
      if (this.client === client) {
        this.client = undefined
        client.end()
        this.state = { status: 'error', error: errorMessage(error) }
        this.onChange()
      }
      throw error
    }
  }
  disconnect(): void {
    const old = this.client
    this.client = undefined
    old?.end()
    this.state = { status: 'disconnected' }
    this.onChange()
  }
  private execute(
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
    onChunk?: (output: string) => void,
  ): Promise<string> {
    const client = this.client
    if (!client || this.state.status !== 'connected')
      return Promise.reject(new Error('请先在「设备管理」连接 RK 设备'))
    return new Promise((resolve, reject) => {
      let channel: ClientChannel | undefined,
        output = '',
        stderr = '',
        settled = false
      const finish = (error?: Error, result = output) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        error ? reject(error) : resolve(result)
      }
      const abort = () => {
        channel?.signal('TERM')
        channel?.close()
        finish(new DOMException('操作已取消', 'AbortError'))
      }
      const timer = setTimeout(() => {
        channel?.signal('TERM')
        channel?.close()
        finish(new Error('设备响应超时，请检查设备状态'))
      }, timeoutMs)
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      client.exec(command, (error, stream) => {
        if (error) {
          finish(error)
          return
        }
        channel = stream
        if (settled) {
          stream.signal('TERM')
          stream.close()
          return
        }
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
          output += chunk
          if (output.length > 2_000_000) {
            stream.close()
            finish(new Error('设备输出过大'))
          } else onChunk?.(output)
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString('utf8')).slice(-2000)
        })
        stream.once('error', (error: Error) => finish(error))
        stream.once('close', (code: number | undefined) =>
          finish(
            code !== 0
              ? new Error(
                  code === 75
                    ? '设备已有 Qwen 推理任务，请稍后重试'
                    : `设备命令退出 (${code ?? '连接中断'})：${stderr || '请检查板端程序'}`,
                )
              : undefined,
          ),
        )
      })
    })
  }
  async refresh(): Promise<DeviceState> {
    const started = Date.now()
    const encoded = Buffer.from(healthScript).toString('base64')
    try {
      const result = await this.execute(
        `python3 -c "import base64; exec(base64.b64decode('${encoded}'))"`,
        10_000,
      )
      const data = healthSchema.parse(JSON.parse(result.trim()))
      this.state = {
        ...data,
        status: 'connected',
        updatedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
      }
      this.onChange()
      return this.state
    } catch (error) {
      this.disconnect()
      this.state = { status: 'error', error: errorMessage(error) }
      this.onChange()
      throw error
    }
  }
  async generate(
    prompt: string,
    context: string,
    signal: AbortSignal,
    onText: (answer: string) => void,
  ): Promise<string> {
    if (!this.state.qwenReady) throw new Error('板端 Qwen3.5-9B 文件不完整，请先完成 RK 项目部署')
    const text = context ? `${prompt}\n参考文本：\n${context}` : prompt
    if (text.length > 3000)
      throw new Error('端侧模型上下文有限，请将任务与参考文本缩短至 3000 字以内')
    const command = `timeout --signal=TERM --kill-after=5s 180s bash "$HOME/rk-edge-ai/qwen35/run.sh" --tokens 256 --context 2048 --prompt ${shellQuote(text)}`
    const extract = (raw: string) => {
      const start = raw.indexOf('Answer: ')
      return start >= 0
        ? raw
            .slice(start + 8)
            .split(/\nTURN_SECONDS=/)[0]
            .replace(/\u001b\[[0-9;]*m/g, '')
            .trim()
        : ''
    }
    const raw = await this.execute(command, 190_000, signal, (output) => {
      const answer = extract(output)
      if (answer) onText(answer)
    })
    const answer = extract(raw)
    if (!answer) throw new Error('端侧模型未返回可识别的回答，请查看 RK 项目运行日志')
    return answer
  }
}
