import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CuaDriverClient } from '../src/main/infrastructure/cua-driver'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

type Rpc = { id?: number; method: string; params?: Record<string, unknown> }
let child: EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}
let messages: Rpc[]
let onCall: (request: Rpc) => void
let client: CuaDriverClient
const tools = [
  'list_windows',
  'get_window_state',
  'click',
  'move_cursor',
  'scroll',
  'shell_execute',
].map((name) => ({ name, inputSchema: { type: 'object' } }))
const respond = (request: Rpc, result: unknown) =>
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')

beforeEach(() => {
  child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
  messages = []
  onCall = (request) =>
    respond(request, { content: [{ type: 'text', text: '完成' }], structuredContent: { ok: true } })
  child.stdin.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      const request = JSON.parse(line) as Rpc
      messages.push(request)
      if (request.method === 'initialize')
        respond(request, {
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'cua-driver', version: '0.38.0' },
        })
      else if (request.method === 'tools/list') respond(request, { tools })
      else if (request.method === 'tools/call') onCall(request)
    }
  })
  mocks.spawn.mockReset().mockReturnValue(child)
  client = new CuaDriverClient({
    executable: resolve('.cache/cua-driver/cua-driver.exe'),
    stateDirectory: resolve('.qa/cua-test'),
    timeoutMs: 1000,
  })
})

afterEach(() => {
  client.dispose()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

it('negotiates legacy MCP once and reuses a private pipe with data-only arguments', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'never-forward')
  vi.stubEnv('CUA_DRIVER_PERMISSION_MODE', 'unrestricted')
  vi.stubEnv('CUA_DRIVER_SOCKET', 'untrusted-daemon')
  const args = {
    target: { kind: 'window', pid: 12, window_id: '123' },
    query: '中文 "Save" $(touch nope)',
  }
  expect(await client.call('get_window_state', args)).toMatchObject({
    structuredContent: { ok: true },
  })
  await client.call('click', { target: args.target, element_token: 's123:4' })
  expect(messages.map((m) => m.method)).toEqual([
    'initialize',
    'notifications/initialized',
    'tools/list',
    'tools/call',
    'tools/call',
  ])
  expect(messages[3].params).toEqual({ name: 'get_window_state', arguments: args })
  expect(mocks.spawn).toHaveBeenCalledTimes(1)
  const [, spawnArgs, options] = mocks.spawn.mock.calls[0]
  expect(spawnArgs).toEqual(['mcp', '--direct'])
  expect(options).toMatchObject({
    shell: false,
    windowsHide: true,
    env: {
      CUA_DRIVER_PERMISSION_MODE: 'standard',
      CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
      CUA_TELEMETRY_ENABLED: '0',
    },
  })
  expect(options.env.OPENAI_API_KEY).toBeUndefined()
  expect(options.env.CUA_DRIVER_SOCKET).toBeUndefined()
})

it('filters discovery and denies unrelated tools before spawning', async () => {
  await expect(client.call('shell_execute', { command: 'anything' })).rejects.toMatchObject({
    code: 'CUA_DRIVER_TOOL_DENIED',
    dispatched: false,
  })
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect((await client.listTools()).map((t) => t.name)).toEqual([
    'list_windows',
    'get_window_state',
    'click',
    'move_cursor',
    'scroll',
  ])
  await expect(client.call('zoom', {})).rejects.toMatchObject({
    code: 'CUA_DRIVER_TOOL_UNAVAILABLE',
    dispatched: false,
  })
  expect(messages.some((m) => m.method === 'tools/call')).toBe(false)
})

it('preserves structured refusals and image blocks without interpreting success', async () => {
  onCall = (request) =>
    respond(request, {
      content: [
        { type: 'text', text: 'unavailable' },
        { type: 'image', mimeType: 'image/png', data: 'YQ==' },
      ],
      isError: true,
      structuredContent: { code: 'background_unavailable' },
    })
  expect(await client.call('get_window_state', {})).toEqual({
    content: [
      { type: 'text', text: 'unavailable' },
      { type: 'image', mimeType: 'image/png', data: 'YQ==' },
    ],
    isError: true,
    structuredContent: { code: 'background_unavailable' },
  })
})

it('decodes fragmented UTF-8 and ignores notifications', async () => {
  onCall = (request) => {
    child.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { data: 'notice' },
      }) + '\n',
    )
    const bytes = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text: '中文窗口' }] },
      }) + '\n',
    )
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]))
  }
  expect(await client.call('get_window_state', {})).toEqual({
    content: [{ type: 'text', text: '中文窗口' }],
  })
})

it('reports cancellation before dispatch without starting a process', async () => {
  const abort = new AbortController()
  abort.abort()
  await expect(client.call('click', {}, abort.signal)).rejects.toMatchObject({
    name: 'AbortError',
    dispatched: false,
  })
  expect(mocks.spawn).not.toHaveBeenCalled()
})

it('cancels in-flight input and never accepts or retries a late success', async () => {
  await client.listTools()
  onCall = () => {}
  const abort = new AbortController()
  const call = client.call('click', { x: 20, y: 30 }, abort.signal)
  await Promise.resolve()
  abort.abort()
  respond(messages.at(-1)!, { content: [], structuredContent: { ok: true } })
  await expect(call).rejects.toMatchObject({
    code: 'CUA_DRIVER_ABORTED',
    name: 'AbortError',
    dispatched: true,
    tool: 'click',
  })
  await expect(client.call('click', {})).rejects.toMatchObject({ dispatched: false })
  expect(child.kill).toHaveBeenCalledTimes(1)
  expect(messages.filter((m) => m.method === 'tools/call')).toHaveLength(1)
})

it('marks timeout after dispatch as unknown and terminates its owned process', async () => {
  await client.listTools()
  vi.useFakeTimers()
  onCall = () => {}
  const call = client.call('click', {})
  const assertion = expect(call).rejects.toMatchObject({
    code: 'CUA_DRIVER_TIMEOUT',
    dispatched: true,
  })
  await vi.advanceTimersByTimeAsync(1001)
  await assertion
  expect(child.kill).toHaveBeenCalledTimes(1)
})

it('marks failures during initialization as not dispatched', async () => {
  child.stdin.removeAllListeners('data')
  vi.useFakeTimers()
  const call = client.call('click', {})
  const assertion = expect(call).rejects.toMatchObject({
    code: 'CUA_DRIVER_TIMEOUT',
    dispatched: false,
  })
  await vi.advanceTimersByTimeAsync(1001)
  await assertion
})

it('does not queue competing operations behind an input', async () => {
  await client.listTools()
  onCall = () => {}
  const first = client.call('click', {})
  await expect(client.call('click', {})).rejects.toMatchObject({
    code: 'CUA_DRIVER_BUSY',
    dispatched: false,
  })
  respond(messages.at(-1)!, { content: [] })
  await first
  expect(messages.filter((m) => m.method === 'tools/call')).toHaveLength(1)
})

it('kills oversized output even when no newline has arrived', async () => {
  client.dispose()
  client = new CuaDriverClient({ executable: resolve('cua-driver.exe'), maxResponseBytes: 2048 })
  onCall = () => child.stdout.write('x'.repeat(2049))
  await expect(client.call('get_window_state', {})).rejects.toMatchObject({
    code: 'CUA_DRIVER_RESPONSE_TOO_LARGE',
    dispatched: true,
  })
})

it('rejects malformed responses without exposing their raw payload', async () => {
  onCall = () => child.stdout.write('private not-json\n')
  await expect(client.call('click', {})).rejects.toMatchObject({
    message: 'CUA_DRIVER_INVALID_JSON',
    dispatched: true,
  })
})

it('marks closed transport after an action as dispatched', async () => {
  onCall = () => child.emit('close', 1)
  await expect(client.call('click', {})).rejects.toMatchObject({
    code: 'CUA_DRIVER_CLOSED',
    dispatched: true,
  })
})

it('rejects invalid result blocks without treating them as input success', async () => {
  onCall = (request) =>
    respond(request, { content: [{ type: 'image', mimeType: 'image/png', data: 'not base64!!' }] })
  await expect(client.call('click', {})).rejects.toMatchObject({
    code: 'CUA_DRIVER_INVALID_RESULT',
    dispatched: true,
  })
})

it('rejects reserved arguments and relative executables', async () => {
  expect(() => new CuaDriverClient({ executable: 'cua-driver.exe' })).toThrow(
    'CUA_DRIVER_EXECUTABLE_INVALID',
  )
  await expect(client.call('click', { _session_id: 'foreign' })).rejects.toMatchObject({
    code: 'CUA_DRIVER_ARGUMENTS_INVALID',
    dispatched: false,
  })
  expect(mocks.spawn).not.toHaveBeenCalled()
})

it('snapshots arguments before startup and exposes defensive tool schema copies', async () => {
  const args = { target: { kind: 'window', pid: 20 } }
  const call = client.call('click', args)
  args.target.pid = 99
  await call
  expect(messages.at(-1)?.params).toMatchObject({ arguments: { target: { pid: 20 } } })
  const listed = await client.listTools()
  listed[0].name = 'mutated'
  expect((await client.listTools())[0].name).toBe('list_windows')
})

it('dispose rejects pending calls, is idempotent and never restarts', async () => {
  await client.listTools()
  onCall = () => {}
  const call = client.call('click', {})
  await Promise.resolve()
  client.dispose()
  client.dispose()
  await expect(call).rejects.toMatchObject({ code: 'CUA_DRIVER_DISPOSED', dispatched: true })
  await expect(client.listTools()).rejects.toThrow('CUA_DRIVER_DISPOSED')
  expect(child.kill).toHaveBeenCalledTimes(1)
  expect(mocks.spawn).toHaveBeenCalledTimes(1)
})
