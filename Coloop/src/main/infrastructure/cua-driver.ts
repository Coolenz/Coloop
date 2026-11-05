import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/** The agent never receives a general-purpose Cua tool dispatcher. */
const allowedTools = new Set([
  'list_apps',
  'list_windows',
  'get_window_state',
  'get_desktop_state',
  'get_accessibility_tree',
  'get_cursor_position',
  'get_screen_size',
  'check_permissions',
  'zoom',
  'click',
  'double_click',
  'right_click',
  'scroll',
  'move_cursor',
])

export interface CuaToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export type CuaContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface CuaToolResult {
  content: CuaContent[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface CuaDriverOptions {
  executable: string
  stateDirectory?: string
  timeoutMs?: number
  maxResponseBytes?: number
}

/** dispatched means a tools/call may have reached Driver, NOT that input succeeded. */
export class CuaDriverError extends Error {
  constructor(
    public readonly code: string,
    public readonly dispatched = false,
    public readonly tool?: string,
  ) {
    super(code)
    this.name = code === 'CUA_DRIVER_ABORTED' ? 'AbortError' : 'CuaDriverError'
  }
}

type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
  dispatched: boolean
  tool?: string
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Private, persistent newline-delimited MCP stdio connection. Protocol follows
 * trycua/cua cua-driver-rs-v0.38.0 proxy.rs and core/protocol.rs: legacy
 * initialize (2025-06-18), notifications/initialized, tools/list, tools/call.
 * No shell, HTTP endpoint, model credentials, implicit retries or fallback.
 * A failed/cancelled connection is terminal; replace the client only after the
 * caller has reconciled any dispatched input and obtained a new observation.
 */
export class CuaDriverClient {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<number, Pending>()
  private nextId = 0
  private failure?: string
  private busy = false
  private tools?: CuaToolDefinition[]
  private output = ''
  private decoder = new StringDecoder('utf8')
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number

  constructor(private readonly options: CuaDriverOptions) {
    if (!isAbsolute(options.executable) || options.executable.includes('\0'))
      throw new CuaDriverError('CUA_DRIVER_EXECUTABLE_INVALID')
    if (options.stateDirectory && !isAbsolute(options.stateDirectory))
      throw new CuaDriverError('CUA_DRIVER_STATE_DIRECTORY_INVALID')
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000)
      throw new CuaDriverError('CUA_DRIVER_TIMEOUT_INVALID')
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 256 ||
      this.maxResponseBytes > 64 * 1024 * 1024
    )
      throw new CuaDriverError('CUA_DRIVER_RESPONSE_LIMIT_INVALID')
  }

  private start() {
    if (this.failure) throw new CuaDriverError(this.failure)
    if (this.child) return
    // Intentionally do not inherit cloud provider keys or arbitrary Driver
    // grants, daemon sockets, policy overrides and auto-update configuration.
    const env: NodeJS.ProcessEnv = {}
    for (const key of [
      'SystemRoot',
      'WINDIR',
      'PATH',
      'TEMP',
      'TMP',
      'USERPROFILE',
      'LOCALAPPDATA',
      'APPDATA',
      'PROGRAMDATA',
      'PROGRAMFILES',
      'PROGRAMFILES(X86)',
      'HOME',
      'LANG',
      'DISPLAY',
      'WAYLAND_DISPLAY',
      'XDG_RUNTIME_DIR',
      'DBUS_SESSION_BUS_ADDRESS',
    ]) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    env.CUA_DRIVER_RS_TELEMETRY_ENABLED = '0'
    env.CUA_TELEMETRY_ENABLED = '0'
    env.CUA_DRIVER_RS_UPDATE_CHECK = 'false'
    env.CUA_DRIVER_PERMISSION_MODE = 'standard'
    if (this.options.stateDirectory) env.CUA_DRIVER_RS_HOME = this.options.stateDirectory
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.options.executable, ['mcp', '--direct'], {
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      })
    } catch {
      this.failure = 'CUA_DRIVER_START_FAILED'
      throw new CuaDriverError(this.failure)
    }
    this.child = child
    child.stdout.on('data', (data: Buffer) => this.receive(data))
    // Never persist or reflect diagnostics: they can contain screen content.
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => this.fail('CUA_DRIVER_PIPE_FAILED'))
    child.on('error', () => this.fail('CUA_DRIVER_START_FAILED'))
    child.once('close', () => this.fail('CUA_DRIVER_CLOSED'))
  }

  private receive(data: Buffer) {
    if (this.failure) return
    this.output += this.decoder.write(data)
    if (Buffer.byteLength(this.output) > this.maxResponseBytes) {
      this.fail('CUA_DRIVER_RESPONSE_TOO_LARGE')
      return
    }
    let end: number
    while ((end = this.output.indexOf('\n')) >= 0) {
      const line = this.output.slice(0, end).trim()
      this.output = this.output.slice(end + 1)
      if (!line) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        this.fail('CUA_DRIVER_INVALID_JSON')
        return
      }
      if (!object(message) || message.jsonrpc !== '2.0') {
        this.fail('CUA_DRIVER_INVALID_RPC')
        return
      }
      // Notifications are not tool results and do not authorize actions.
      if (!('id' in message) && typeof message.method === 'string') continue
      if (typeof message.id !== 'number' || !this.pending.has(message.id)) {
        this.fail('CUA_DRIVER_UNEXPECTED_RESPONSE')
        return
      }
      const pending = this.pending.get(message.id)!
      this.pending.delete(message.id)
      pending.cleanup()
      if ('error' in message) {
        pending.reject(new CuaDriverError('CUA_DRIVER_RPC_ERROR', pending.dispatched, pending.tool))
      } else if ('result' in message) {
        pending.resolve(message.result)
      } else {
        pending.reject(
          new CuaDriverError('CUA_DRIVER_INVALID_RPC', pending.dispatched, pending.tool),
        )
        this.fail('CUA_DRIVER_INVALID_RPC')
        return
      }
    }
  }

  private fail(code: string) {
    if (this.failure) return
    this.failure = code
    const child = this.child
    this.child = undefined
    this.output = ''
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(new CuaDriverError(code, pending.dispatched, pending.tool))
    }
    this.pending.clear()
    child?.stdin.destroy()
    child?.kill()
  }

  private rpc(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    tool?: string,
  ): Promise<unknown> {
    if (signal?.aborted)
      return Promise.reject(new CuaDriverError('CUA_DRIVER_ABORTED', false, tool))
    if (this.failure) return Promise.reject(new CuaDriverError(this.failure, false, tool))
    const message = JSON.stringify({ jsonrpc: '2.0', id: ++this.nextId, method, params }) + '\n'
    if (Buffer.byteLength(message) > 128 * 1024)
      return Promise.reject(new CuaDriverError('CUA_DRIVER_REQUEST_TOO_LARGE', false, tool))
    const id = this.nextId
    return new Promise((resolve, reject) => {
      const stop = () => this.fail('CUA_DRIVER_ABORTED')
      const timer = setTimeout(() => this.fail('CUA_DRIVER_TIMEOUT'), this.timeoutMs)
      const pending: Pending = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', stop)
        },
        dispatched: false,
        tool,
      }
      this.pending.set(id, pending)
      signal?.addEventListener('abort', stop, { once: true })
      if (signal?.aborted) return stop()
      try {
        // Once handed to the OS pipe, absence of a response cannot prove that
        // the action did not execute. Mark before write, including pipe errors.
        pending.dispatched = method === 'tools/call'
        this.child!.stdin.write(message)
      } catch {
        this.fail('CUA_DRIVER_PIPE_FAILED')
      }
    })
  }

  private async ready(signal?: AbortSignal) {
    if (signal?.aborted) throw new CuaDriverError('CUA_DRIVER_ABORTED')
    if (this.failure) throw new CuaDriverError(this.failure)
    if (this.tools) return
    this.start()
    const initialized = await this.rpc(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'coloop-cua', version: '1.0.0' },
      },
      signal,
    )
    if (
      !object(initialized) ||
      initialized.protocolVersion !== '2025-06-18' ||
      !object(initialized.serverInfo) ||
      initialized.serverInfo.name !== 'cua-driver'
    ) {
      this.fail('CUA_DRIVER_PROTOCOL_MISMATCH')
      throw new CuaDriverError('CUA_DRIVER_PROTOCOL_MISMATCH')
    }
    this.child!.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    )
    const listed = await this.rpc('tools/list', {}, signal)
    if (!object(listed) || !Array.isArray(listed.tools) || listed.tools.length > 512) {
      this.fail('CUA_DRIVER_INVALID_TOOL_LIST')
      throw new CuaDriverError('CUA_DRIVER_INVALID_TOOL_LIST')
    }
    this.tools = listed.tools
      .filter(
        (tool): tool is CuaToolDefinition =>
          object(tool) &&
          typeof tool.name === 'string' &&
          allowedTools.has(tool.name) &&
          object(tool.inputSchema),
      )
      .map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      }))
  }

  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy) throw new CuaDriverError('CUA_DRIVER_BUSY')
    this.busy = true
    try {
      return await run()
    } finally {
      this.busy = false
    }
  }

  listTools(signal?: AbortSignal): Promise<CuaToolDefinition[]> {
    return this.exclusive(async () => {
      await this.ready(signal)
      return structuredClone(this.tools!)
    })
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CuaToolResult> {
    if (!allowedTools.has(tool)) throw new CuaDriverError('CUA_DRIVER_TOOL_DENIED', false, tool)
    if (!object(args) || Object.keys(args).some((key) => key.startsWith('_')))
      throw new CuaDriverError('CUA_DRIVER_ARGUMENTS_INVALID', false, tool)
    // Snapshot caller-owned arguments before any await, preventing mutation of
    // the guarded target while startup or discovery is still in progress.
    let argumentsCopy: Record<string, unknown>
    try {
      argumentsCopy = JSON.parse(JSON.stringify(args))
    } catch {
      throw new CuaDriverError('CUA_DRIVER_ARGUMENTS_INVALID', false, tool)
    }
    if (!object(argumentsCopy))
      throw new CuaDriverError('CUA_DRIVER_ARGUMENTS_INVALID', false, tool)
    return this.exclusive(async () => {
      await this.ready(signal)
      if (!this.tools!.some((entry) => entry.name === tool))
        throw new CuaDriverError('CUA_DRIVER_TOOL_UNAVAILABLE', false, tool)
      const raw = await this.rpc(
        'tools/call',
        { name: tool, arguments: argumentsCopy },
        signal,
        tool,
      )
      if (
        !object(raw) ||
        !Array.isArray(raw.content) ||
        (raw.isError !== undefined && typeof raw.isError !== 'boolean') ||
        (raw.structuredContent !== undefined && !object(raw.structuredContent))
      )
        throw new CuaDriverError('CUA_DRIVER_INVALID_RESULT', true, tool)
      const content: CuaContent[] = []
      for (const item of raw.content) {
        if (!object(item)) throw new CuaDriverError('CUA_DRIVER_INVALID_RESULT', true, tool)
        if (item.type === 'text' && typeof item.text === 'string')
          content.push({ type: 'text', text: item.text })
        else if (
          item.type === 'image' &&
          typeof item.data === 'string' &&
          typeof item.mimeType === 'string' &&
          /^image\/(png|jpeg|webp)$/.test(item.mimeType) &&
          item.data.length % 4 === 0 &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(item.data)
        )
          content.push({ type: 'image', data: item.data, mimeType: item.mimeType })
        else throw new CuaDriverError('CUA_DRIVER_INVALID_RESULT', true, tool)
      }
      return {
        content,
        ...(raw.structuredContent ? { structuredContent: raw.structuredContent } : {}),
        ...(raw.isError !== undefined ? { isError: raw.isError } : {}),
      }
    })
  }

  dispose(): void {
    this.fail('CUA_DRIVER_DISPOSED')
  }
}
