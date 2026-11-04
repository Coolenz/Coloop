import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

export class DesktopPipeError extends Error {
  constructor(readonly code: string) {
    super('目标窗口、焦点或观察已变化，请检查后重新开始')
  }
}

/** Bounded JSON lines on a private child-process/SSH channel; never opens a port. */
export class DesktopPipe extends EventEmitter {
  readonly ready: Promise<unknown>
  private readyResolve!: (value: unknown) => void
  private readyReject!: (error: Error) => void
  private buffer = ''
  private closed = false
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private readyTimer: ReturnType<typeof setTimeout>

  constructor(
    input: Readable,
    private output: Writable,
    private terminate: () => void,
  ) {
    super()
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // An early process failure can precede its owner's await.
    void this.ready.catch(() => {})
    this.readyTimer = setTimeout(() => this.fail(), 45_000)
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => {
      if (this.closed) return
      this.buffer += chunk
      if (Buffer.byteLength(this.buffer, 'utf8') > 1_000_000) return this.fail()
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        try {
          const packet = JSON.parse(line)
          if (packet.type === 'ready') {
            clearTimeout(this.readyTimer)
            this.readyResolve(packet.value)
          } else if (packet.type === 'reply') {
            const waiter = this.pending.get(packet.id)
            if (!waiter) continue
            clearTimeout(waiter.timer)
            this.pending.delete(packet.id)
            if (packet.error)
              waiter.reject(
                new DesktopPipeError(
                  [
                    'DESKTOP_WINDOW_NOT_FOUND',
                    'DESKTOP_WINDOW_AMBIGUOUS',
                    'DESKTOP_TARGET_CHANGED',
                    'DESKTOP_TARGET_UNAVAILABLE',
                    'DESKTOP_FOCUS_CHANGED',
                    'DESKTOP_WINDOW_NOT_FOREGROUND',
                  ].includes(packet.error) || /^(RELAY|CLIPBOARD)_[A-Z_]{1,80}$/.test(packet.error)
                    ? packet.error
                    : 'DESKTOP_WINDOW_CHANGED',
                ),
              )
            else waiter.resolve(packet.value)
          } else this.emit('packet', packet)
        } catch {
          this.fail()
          return
        }
      }
    })
    input.on('end', () => this.fail())
    input.on('close', () => this.fail())
    input.on('error', () => this.fail())
    output.on('error', () => this.fail())
  }

  send(value: unknown) {
    if (this.closed) throw new Error('电脑操作通道已断开')
    const line = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(line, 'utf8') > 131072) throw new Error('电脑操作上下文过长')
    this.output.write(line)
  }

  request(op: string, value?: unknown): Promise<unknown> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('电脑观察超时'))
      }, 25_000)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ type: 'request', id, op, value })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }

  close() {
    this.fail()
  }
  private fail() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.readyTimer)
    const error = new Error('电脑操作通道已断开；请检查设备和目标窗口')
    this.readyReject(error)
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
    this.terminate()
    this.emit('closed')
  }
}
