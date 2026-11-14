import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer, request, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChatGPTDesktopAdapter,
  type ChatGPTDesktopEvent,
  type NativeAutoWorkPayload,
} from '../src/main/services/chatgpt-desktop-adapter'
import { AutoAgentWorkHooks } from '../src/main/services/auto-agent-work-hooks'

let root: string
const adapters: ChatGPTDesktopAdapter[] = []
const transportServers: Server[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'coloop-auto-work-hooks-'))
})
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()))
  await Promise.all(
    transportServers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClosed, reject) => {
          server.close((error) => (error ? reject(error) : resolveClosed()))
          server.closeAllConnections()
        }),
    ),
  )
  // root is the exact mkdtemp path created by this test; no user data is stored here.
  expect(root.startsWith(tmpdir())).toBe(true)
  await rm(root, { recursive: true, force: true })
})
function event(
  kind: NativeAutoWorkPayload['hook_event_name'],
  extra: Partial<NativeAutoWorkPayload> = {},
) {
  return {
    version: 1,
    invocationId: randomUUID(),
    emittedAt: Date.now(),
    payload: {
      session_id: 'native-session',
      cwd: root,
      hook_event_name: kind,
      turn_id: 'turn-1',
      ...extra,
    },
  }
}
function setup() {
  const events: ChatGPTDesktopEvent[] = []
  const claim = vi.fn(() => true)
  const receipts = vi.fn()
  const adapter = new ChatGPTDesktopAdapter({
    workspaceRoots: () => [root],
    onEvent: (value) => events.push(value),
    claimContinuation: claim,
    onNativeContinuation: receipts,
  })
  adapters.push(adapter)
  return { adapter, events, claim, receipts }
}
function prepare(adapter: ChatGPTDesktopAdapter) {
  const session = adapter.snapshot().sessions[0]
  return adapter.prepareContinuation({
    actionId: randomUUID(),
    sessionId: session.id,
    turnId: session.turnId!,
    taskVersion: 1,
    eventRevision: session.revision,
    reason: '核验测试结果，然后完成尚未完成的要求。',
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
  })
}
function httpStatus(url: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolveStatus, reject) => {
    const req = request(url, { method: 'POST', headers }, (response) => {
      response.resume()
      resolveStatus(response.statusCode!)
    })
    req.on('error', reject)
    req.end()
  })
}
async function runStdinHook(connectionPath: string, input: string) {
  const child = spawn(
    process.execPath,
    [resolve('resources/auto-agent-work-hook.mjs'), '--connection', connectionPath],
    { windowsHide: true, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let stdout = '',
    stderr = '',
    writtenBytes = 0
  const stdinErrors: string[] = []
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  child.stdin.on('error', (error: NodeJS.ErrnoException) =>
    stdinErrors.push(error.code ?? error.message),
  )
  const closed = new Promise<number | null>((resolveClosed, reject) => {
    child.on('error', reject)
    child.on('close', resolveClosed)
  })
  const bytes = Buffer.from(input)
  // Await actual pipe writes, rather than enqueueing one oversized end(). An
  // early hook exit must be visible to the upstream writer as a failed write.
  const write = async () => {
    try {
      for (let offset = 0; offset < bytes.length; offset += 16_384) {
        const chunk = bytes.subarray(offset, offset + 16_384)
        await new Promise<void>((resolveWrite, reject) => {
          child.stdin.write(chunk, (error) => (error ? reject(error) : resolveWrite()))
        })
        writtenBytes += chunk.length
      }
      child.stdin.end()
    } catch (error) {
      stdinErrors.push((error as NodeJS.ErrnoException).code ?? String(error))
    }
  }
  const [code] = await Promise.all([closed, write()])
  return { code, stdout, stderr, writtenBytes, stdinErrors }
}
async function transportResponse(output: unknown, onRequest?: () => void) {
  const server = createServer((incoming, response) => {
    onRequest?.()
    incoming.resume()
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
    response.end(JSON.stringify({ version: 1, output }))
  })
  transportServers.push(server)
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListening)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS')
  const connectionPath = join(root, 'transport-connection.json')
  await writeFile(
    connectionPath,
    JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token: 'test-only-'.repeat(8) }),
  )
  return connectionPath
}

describe('native desktop hook adapter', () => {
  it('acknowledges false only after an expired Stop offer is definitively unclaimed', async () => {
    let now = Date.now()
    let ack: Promise<boolean> | undefined
    let adapter: ChatGPTDesktopAdapter
    const claim = vi.fn(() => true)
    adapter = new ChatGPTDesktopAdapter({
      workspaceRoots: () => [root],
      now: () => now,
      claimContinuation: claim,
      onEvent: (value, session) => {
        if (value.type !== 'stopped') return
        ack = adapter.prepareAndWaitContinuation({
          actionId: randomUUID(),
          sessionId: session.id,
          turnId: session.turnId!,
          taskVersion: 1,
          eventRevision: session.revision,
          reason: '继续核验尚未完成项',
          expiresAt: new Date(now + 10000).toISOString(),
        })
        // The offer was valid when registered, but the Stop flush missed its short deadline.
        now += 300
      },
    })
    adapters.push(adapter)
    await adapter.receive(event('PreModelRequest'))
    expect(await adapter.receive(event('Stop'))).toEqual({})
    expect(await ack).toBe(false)
    expect(claim).not.toHaveBeenCalled()
  })
  it.each(['submitted', 'unknown'] as const)(
    'never permits fallback after a %s native claim',
    async (result) => {
      let now = Date.now()
      let ack: Promise<boolean> | undefined
      let adapter: ChatGPTDesktopAdapter
      const receipts = vi.fn()
      adapter = new ChatGPTDesktopAdapter({
        workspaceRoots: () => [root],
        now: () => now,
        claimContinuation: () => {
          if (result === 'unknown') now += 500
          return true
        },
        onNativeContinuation: receipts,
        onEvent: (value, session) => {
          if (value.type !== 'stopped') return
          ack = adapter.prepareAndWaitContinuation({
            actionId: randomUUID(),
            sessionId: session.id,
            turnId: session.turnId!,
            taskVersion: 1,
            eventRevision: session.revision,
            reason: '继续核验尚未完成项',
            expiresAt: new Date(now + 10000).toISOString(),
          })
        },
      })
      adapters.push(adapter)
      await adapter.receive(event('PreModelRequest'))
      const output = await adapter.receive(event('Stop'))
      expect(await ack).toBe(true)
      expect(receipts.mock.calls.at(-1)?.[0].status).toBe(result)
      expect(output).toEqual(
        result === 'submitted' ? { decision: 'block', reason: '继续核验尚未完成项' } : {},
      )
    },
  )
  it('accepts a decision prepared from the current Stop within the bounded handoff window', async () => {
    let adapter: ChatGPTDesktopAdapter
    adapter = new ChatGPTDesktopAdapter({
      workspaceRoots: () => [root],
      claimContinuation: () => true,
      onEvent: (value, session) => {
        if (value.type === 'stopped')
          setTimeout(() => {
            expect(adapter.hasPendingStop(session.id)).toBe(true)
            expect(prepare(adapter)).toBe(true)
          }, 20)
      },
    })
    adapters.push(adapter)
    await adapter.receive(event('PreModelRequest'))
    expect(await adapter.receive(event('Stop'))).toHaveProperty('decision', 'block')
    expect(adapter.hasPendingStop(adapter.snapshot().sessions[0].id)).toBe(false)
  })
  it('human input revokes a pending Stop before it leaves the ingress queue', async () => {
    const { adapter, claim } = setup()
    await adapter.receive(event('PreModelRequest'))
    const stopping = adapter.receive(event('Stop'))
    await new Promise((resolve) => setTimeout(resolve, 15))
    const human = adapter.receive(
      event('UserPromptSubmit', { prompt: '停止自动推进', turn_id: 'turn-2' }),
    )
    expect(await stopping).toEqual({})
    await human
    expect(claim).not.toHaveBeenCalled()
  })
  it('binds a source handle without claiming desktop or send capability', async () => {
    const { adapter, events } = setup()
    await adapter.receive(event('SessionStart'))
    const session = adapter.snapshot().sessions[0]
    expect(session.sessionId).toBe('native-session')
    expect(session.id).toContain('chatgpt-desktop:')
    expect(session.capabilities.nativeContinue).toBe('unknown')
    expect(session.desktopVerified).toBe(false)
    expect(events[0].sessionId).toBe(session.id)
  })
  it('claims Stop once before replying and confirms only a matching prompt', async () => {
    const { adapter, claim, receipts, events } = setup()
    await adapter.receive(event('PreModelRequest'))
    expect(prepare(adapter)).toBe(true)
    const stop = event('Stop', { last_assistant_message: '尚有未完成项' })
    const response = await adapter.receive(stop)
    expect(response).toEqual({
      decision: 'block',
      reason: '核验测试结果，然后完成尚未完成的要求。',
    })
    expect(claim).toHaveBeenCalledTimes(1)
    expect(receipts.mock.calls[0][0].status).toBe('submitted')
    expect(await adapter.receive(stop)).toEqual({})
    await adapter.receive(event('UserPromptSubmit', { turn_id: 'turn-2', prompt: response.reason }))
    expect(receipts.mock.calls[1][0].status).toBe('confirmed')
    expect(events.at(-1)?.origin).toBe('coloop')
    expect(adapter.snapshot().sessions[0].capabilities.nativeContinue).toBe('verified')
  })
  it('invalidates a prepared decision after another event or human input', async () => {
    const { adapter, claim } = setup()
    await adapter.receive(event('PreModelRequest'))
    expect(prepare(adapter)).toBe(true)
    await adapter.receive(
      event('PostToolUse', { tool_name: 'Bash', tool_response: 'changed result' }),
    )
    expect(await adapter.receive(event('Stop'))).toEqual({})
    expect(claim).not.toHaveBeenCalled()
    await adapter.receive(event('UserPromptSubmit', { prompt: '暂停' }))
    expect(await adapter.receive(event('Stop'))).toEqual({})
  })
  it('recognizes the native same-turn continuation without requiring UserPromptSubmit', async () => {
    const { adapter, receipts } = setup()
    await adapter.receive(event('PreModelRequest'))
    expect(prepare(adapter)).toBe(true)
    await adapter.receive(event('Stop', { stop_hook_active: false }))
    await adapter.receive(event('PreModelRequest'))
    await adapter.receive(event('Stop', { stop_hook_active: true }))
    expect(receipts.mock.calls.at(-1)?.[0].status).toBe('confirmed')
    expect(adapter.events(adapter.snapshot().sessions[0].id).at(-1)?.actionId).toBeTruthy()
    expect(adapter.events(adapter.snapshot().sessions[0].id).at(-1)).not.toHaveProperty('payload')
  })
  it('attributes externally submitted text only to its registered unique action', async () => {
    const { adapter, events } = setup()
    await adapter.receive(event('Stop'))
    const session = adapter.snapshot().sessions[0]
    const actionId = randomUUID()
    const reason = `[Coloop Auto Agent Work:${actionId}]\n请核验结果。`
    expect(
      adapter.expectExternalMessage({
        actionId,
        sessionId: session.id,
        turnId: 'turn-1',
        taskVersion: 1,
        eventRevision: session.revision,
        reason,
        expiresAt: new Date(Date.now() + 10000).toISOString(),
      }),
    ).toBe(true)
    adapter.forgetExternalMessage(actionId)
    await adapter.receive(event('UserPromptSubmit', { prompt: reason, turn_id: 'turn-2' }))
    expect(events.at(-1)?.origin).toBe('user')
  })
  it.each(['', '\n'])('confirms the full desktop draft with platform suffix %j', async (suffix) => {
    const { adapter, events, receipts } = setup()
    await adapter.receive(event('SessionStart'))
    const session = adapter.snapshot().sessions[0],
      actionId = randomUUID()
    const reason = `[Coloop Auto Agent Work:${actionId}]\n中文第一行\nSecond line  `
    expect(
      adapter.expectExternalMessage({
        actionId,
        sessionId: session.id,
        turnId: 'turn-1',
        taskVersion: 7,
        eventRevision: session.revision,
        reason,
        expiresAt: new Date(Date.now() + 10000).toISOString(),
      }),
    ).toBe(true)
    await adapter.receive(event('UserPromptSubmit', { prompt: reason + suffix, turn_id: 'turn-2' }))
    expect(events.at(-1)).toMatchObject({
      type: 'receipt',
      origin: 'coloop',
      actionId,
      sessionId: session.id,
    })
    expect(receipts).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: 'confirmed',
        actionId,
        taskVersion: 7,
        reason,
      }),
    )
    expect(adapter.snapshot().sessions[0].capabilities.desktopWrite).toBe('verified')
  })
  it.each([
    ['two appended LFs', (reason: string) => reason + '\n\n'],
    ['unobserved CRLF suffix', (reason: string) => reason + '\r\n'],
    ['internal line ending change', (reason: string) => reason.replace('\n', '\r\n') + '\n'],
    [
      'internal whitespace change',
      (reason: string) => reason.replace('Second line', 'Second  line') + '\n',
    ],
    ['trailing draft spaces removed', (reason: string) => reason.trimEnd() + '\n'],
    ['leading newline', (reason: string) => '\n' + reason],
    [
      'different action UUID',
      (reason: string) => reason.replace(/Work:[^\]]+/, `Work:${randomUUID()}`) + '\n',
    ],
  ] as const)('rejects changed owned prompt: %s', async (_name, change) => {
    const { adapter, events, receipts } = setup()
    await adapter.receive(event('SessionStart'))
    const session = adapter.snapshot().sessions[0],
      actionId = randomUUID()
    const reason = `[Coloop Auto Agent Work:${actionId}]\n中文第一行\nSecond line  `
    expect(
      adapter.expectExternalMessage({
        actionId,
        sessionId: session.id,
        turnId: 'turn-1',
        taskVersion: 7,
        eventRevision: session.revision,
        reason,
        expiresAt: new Date(Date.now() + 10000).toISOString(),
      }),
    ).toBe(true)
    await adapter.receive(event('UserPromptSubmit', { prompt: change(reason), turn_id: 'turn-2' }))
    expect(events.at(-1)).toMatchObject({ type: 'user_input', origin: 'user' })
    expect(events.at(-1)?.actionId).toBeUndefined()
    expect(receipts).not.toHaveBeenCalled()
  })
  it('does not let a terminal LF bypass session ownership or expiry', async () => {
    let now = Date.now()
    const events: ChatGPTDesktopEvent[] = [],
      receipts = vi.fn()
    const adapter = new ChatGPTDesktopAdapter({
      workspaceRoots: () => [root],
      now: () => now,
      onEvent: (value) => events.push(value),
      onNativeContinuation: receipts,
    })
    adapters.push(adapter)
    await adapter.receive(event('SessionStart'))
    const session = adapter.snapshot().sessions[0],
      actionId = randomUUID()
    const reason = `[Coloop Auto Agent Work:${actionId}]\nFull original draft`
    expect(
      adapter.expectExternalMessage({
        actionId,
        sessionId: session.id,
        turnId: 'turn-1',
        taskVersion: 1,
        eventRevision: session.revision,
        reason,
        expiresAt: new Date(now + 1000).toISOString(),
      }),
    ).toBe(true)
    await adapter.receive(
      event('UserPromptSubmit', { session_id: 'other-session', prompt: reason + '\n' }),
    )
    expect(events.at(-1)).toMatchObject({ origin: 'user', type: 'user_input' })
    now += 2000
    await adapter.receive(event('UserPromptSubmit', { prompt: reason + '\n', turn_id: 'turn-2' }))
    expect(events.at(-1)).toMatchObject({ origin: 'user', type: 'user_input' })
    expect(receipts).not.toHaveBeenCalled()
  })
  it.each(['completed', 'failed'])(
    'keeps the session idle when PostModelRequest(%s) follows Stop',
    async (status) => {
      const { adapter, events } = setup()
      await adapter.receive(event('PreModelRequest'))
      await adapter.receive(event('Stop', { last_assistant_message: 'Finished.' }))
      const stopped = adapter.snapshot().sessions[0]
      await adapter.receive(event('PostModelRequest', { status }))
      expect(adapter.snapshot().sessions[0]).toMatchObject({
        state: 'idle',
        turnId: stopped.turnId,
        revision: stopped.revision + 1,
      })
      expect(events.at(-1)?.nativeName).toBe('PostModelRequest')
    },
  )
  it('renews only the same owned draft, native session and exact message before native confirmation', async () => {
    const { adapter, events, receipts } = setup()
    await adapter.receive(event('Stop'))
    const session = adapter.snapshot().sessions[0]
    const actionId = randomUUID()
    const original = { nativeSessionId: session.sessionId, workspace: session.workspace }
    const action = {
      actionId,
      sessionId: session.id,
      turnId: 'turn-1',
      taskVersion: 1,
      eventRevision: session.revision,
      reason: `[Coloop Auto Agent Work:${actionId}]\n原草稿`,
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    }
    expect(adapter.expectExternalMessage(action)).toBe(true)
    for (const changed of [
      { ...action, actionId: randomUUID() },
      { ...action, reason: action.reason + '改写' },
      { ...action, turnId: 'other' },
      { ...action, taskVersion: 0 },
      { ...action, eventRevision: session.revision + 1 },
      { ...action, expiresAt: 'invalid' },
    ])
      expect(adapter.renewExternalMessage(changed, original)).toBe(false)
    expect(adapter.renewExternalMessage(action, { ...original, nativeSessionId: 'other' })).toBe(
      false,
    )
    expect(adapter.renewExternalMessage(action, { ...original, workspace: root + '/other' })).toBe(
      false,
    )
    expect(adapter.renewExternalMessage({ ...action, taskVersion: 2 }, original)).toBe(true)
    await adapter.receive(event('UserPromptSubmit', { prompt: action.reason, turn_id: 'turn-2' }))
    expect(events.at(-1)).toMatchObject({ origin: 'coloop', actionId })
    expect(receipts.mock.calls.at(-1)?.[0]).toMatchObject({
      actionId,
      taskVersion: 2,
      status: 'confirmed',
    })
  })
  it('can register the proven original action after restart under its new native-session handle', async () => {
    const { adapter, events } = setup()
    await adapter.receive(event('Stop'))
    const session = adapter.snapshot().sessions[0],
      actionId = randomUUID()
    const reason = `[Coloop Auto Agent Work:${actionId}]\n已有草稿`
    const action = {
      actionId,
      sessionId: session.id,
      turnId: 'turn-1',
      taskVersion: 4,
      eventRevision: session.revision,
      reason,
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    }
    expect(
      adapter.renewExternalMessage(action, { nativeSessionId: 'native-session', workspace: root }),
    ).toBe(true)
    await adapter.receive(event('UserPromptSubmit', { prompt: reason, turn_id: 'turn-2' }))
    expect(events.at(-1)).toMatchObject({ origin: 'coloop', actionId })
  })
  it('does not let subagent events close or replace the parent turn', async () => {
    const { adapter } = setup()
    await adapter.receive(event('PreModelRequest'))
    await adapter.receive(event('SubagentStop', { agent_id: 'child-1', turn_id: 'child-turn' }))
    expect(adapter.snapshot().sessions[0]).toMatchObject({ state: 'running', turnId: 'turn-1' })
  })
  it('never approves PermissionRequest and rejects stale or untrusted events', async () => {
    const { adapter } = setup()
    expect(await adapter.receive(event('PermissionRequest', { tool_name: 'Bash' }))).toEqual({})
    await expect(
      adapter.receive({ ...event('Stop'), emittedAt: Date.now() - 16_000 }),
    ).rejects.toThrow('STALE')
    await expect(adapter.receive(event('Stop', { cwd: resolve(root, '..') }))).rejects.toThrow(
      'UNTRUSTED',
    )
  })
  it('authenticates its sole ingress route and forwards a real stdin hook process', async () => {
    const { adapter, events } = setup()
    const { url, connectionPath } = await adapter.start({
      connectionDirectory: join(root, 'connection'),
    })
    const credentials = JSON.parse(await readFile(connectionPath, 'utf8'))
    expect(await httpStatus(url + '/v1/auto-work/hooks')).toBe(401)
    expect(await httpStatus(url + '/shell', { authorization: `Bearer ${credentials.token}` })).toBe(
      404,
    )
    expect(
      await httpStatus(url + '/v1/auto-work/hooks', {
        authorization: `Bearer ${credentials.token}`,
        origin: 'http://localhost',
      }),
    ).toBe(403)
    const output = await runStdinHook(connectionPath, JSON.stringify(event('Stop').payload))
    expect(output).toMatchObject({ code: 0, stdout: '{}\n', stderr: '', stdinErrors: [] })
    expect(events.at(-1)?.nativeName).toBe('Stop')
  })
  it('drains oversized stdin without EPIPE, forwarding it, or emitting more than one JSON line', async () => {
    const forwarded = vi.fn()
    const connectionPath = await transportResponse({}, forwarded)
    const input = JSON.stringify(
      event('Stop', { last_assistant_message: 'x'.repeat(2 * 1024 * 1024) }).payload,
    )
    const output = await runStdinHook(connectionPath, input)
    expect(output).toEqual({
      code: 0,
      stdout: '{}\n',
      stderr: '',
      writtenBytes: Buffer.byteLength(input),
      stdinErrors: [],
    })
    expect(forwarded).not.toHaveBeenCalled()
  })
  it.each([
    {
      name: 'validated Stop continuation strips permission and tool-input fields',
      kind: 'Stop' as const,
      output: {
        decision: 'block',
        reason: '继续检查\n缺失结果',
        permissionDecision: 'allow',
        updatedInput: { command: 'ignored' },
      },
      expected: { decision: 'block', reason: '继续检查\n缺失结果' },
    },
    {
      name: 'blank Stop reason',
      kind: 'Stop' as const,
      output: { decision: 'block', reason: ' \n\t' },
      expected: {},
    },
    {
      name: 'Stop response using an unrecognized decision',
      kind: 'Stop' as const,
      output: { decision: 'approve', reason: 'continue' },
      expected: {},
    },
    {
      name: 'non-string Stop reason',
      kind: 'Stop' as const,
      output: { decision: 'block', reason: 1 },
      expected: {},
    },
    {
      name: 'Stop reason exceeding the UTF-8 byte limit',
      kind: 'Stop' as const,
      output: { decision: 'block', reason: '界'.repeat(3000) },
      expected: {},
    },
    {
      name: 'non-Stop permission response cannot pass through',
      kind: 'PermissionRequest' as const,
      output: {
        decision: 'block',
        reason: 'continue',
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
        permissionDecision: 'allow',
      },
      expected: {},
    },
  ])('writes one JSON line for $name', async ({ kind, output, expected }) => {
    const connectionPath = await transportResponse(output)
    const result = await runStdinHook(connectionPath, JSON.stringify(event(kind).payload))
    expect(result).toMatchObject({
      code: 0,
      stdout: JSON.stringify(expected) + '\n',
      stderr: '',
      stdinErrors: [],
    })
  })
})

describe('project hook ownership and trust', () => {
  it('preserves other hooks and config through install/uninstall without fabricating trust', async () => {
    await mkdir(join(root, '.codex'))
    const original = {
      description: 'my hooks',
      custom: { retain: true },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'my-independent-check' }] }],
      },
    }
    const configPath = join(root, '.codex', 'hooks.json')
    await writeFile(configPath, JSON.stringify(original))
    const connection = join(root, 'connection.json')
    await writeFile(connection, '{}')
    const hooks = new AutoAgentWorkHooks()
    const input = {
      workspace: root,
      nodePath: process.execPath,
      scriptPath: resolve('resources/auto-agent-work-hook.mjs'),
      connectionPath: connection,
    }
    expect((await hooks.install(input)).trust).toBe('review_required')
    await hooks.install(input)
    const installed = JSON.parse(await readFile(configPath, 'utf8'))
    expect(installed.hooks.Stop).toHaveLength(2)
    expect(installed.hooks.Stop[0]).toEqual(original.hooks.Stop[0])
    hooks.markObserved(root)
    expect((await hooks.status(root)).trust).toBe('observed')
    await hooks.uninstall(root)
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(original)
    expect((await hooks.status(root)).installed).toBe(false)
  })
  it('does not remove an owned hook edited by the user', async () => {
    const connection = join(root, 'connection.json')
    await writeFile(connection, '{}')
    const hooks = new AutoAgentWorkHooks()
    await hooks.install({
      workspace: root,
      nodePath: process.execPath,
      scriptPath: resolve('resources/auto-agent-work-hook.mjs'),
      connectionPath: connection,
    })
    const configPath = join(root, '.codex', 'hooks.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    config.hooks.Stop[0].hooks[0].command = 'user-edited'
    await writeFile(configPath, JSON.stringify(config))
    await hooks.uninstall(root)
    expect(JSON.parse(await readFile(configPath, 'utf8')).hooks.Stop[0].hooks[0].command).toBe(
      'user-edited',
    )
  })
})
