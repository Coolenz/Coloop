import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RemoteGatewayService,
  type RemoteGatewayOptions,
} from '../src/main/services/remote-gateway'
import type { CommandSnapshot } from '../src/shared/sessions'
import type { RemoteFrame, RemoteMobileSnapshot } from '../src/shared/remote'

let directory: string
let now: number
const services: RemoteGatewayService[] = []
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'coloop-remote-'))
  now = Date.now()
})
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  await rm(directory, { recursive: true, force: true })
})
function commandResult(commandId = randomUUID(), sessionHandle = randomUUID()): CommandSnapshot {
  return {
    commandId,
    sessionHandle,
    action: 'send_message',
    status: 'unknown',
    messageId: 'native-message-id-must-stay-local',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }
}
function mobileSnapshot(): RemoteMobileSnapshot {
  return {
    hostName: 'Fixture PC',
    sessionControl: {
      stopped: false,
      controlActive: false,
      unconfirmedCount: 0,
      sessions: [],
      commands: [],
    },
    progress: [],
  }
}
async function create(overrides: Partial<RemoteGatewayOptions> = {}) {
  const command = vi.fn(async (input) => commandResult(input.commandId, input.sessionHandle))
  const stop = vi.fn(async () => {})
  const resume = vi.fn(async () => {})
  const encrypt = vi.fn((text: string) => `protected:${Buffer.from(text).toString('base64')}`)
  const decrypt = vi.fn((text: string) => {
    if (!text.startsWith('protected:')) throw new Error('invalid protected value')
    return Buffer.from(text.slice(10), 'base64').toString('utf8')
  })
  const service = new RemoteGatewayService({
    directory,
    encrypt,
    decrypt,
    onChange: vi.fn(),
    getSnapshot: mobileSnapshot,
    command,
    stop,
    resume,
    hostName: 'Fixture PC',
    now: () => now,
    ...overrides,
  })
  services.push(service)
  const { url } = await service.start()
  return { service, url, command, stop, resume, encrypt, decrypt }
}
async function hello(url: string) {
  const response = await nativeRequest(url + '/v1/remote/hello')
  expect(response.status).toBe(200)
  return response.body as {
    version: number
    hostId: string
    epoch: string
    serverTime: number
  }
}
function nativeRequest(url: string, body?: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any; headers: Headers }>((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.once('error', reject)
        response.once('end', () => {
          const responseHeaders = new Headers()
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined)
              responseHeaders.set(name, Array.isArray(value) ? value.join(',') : value)
          try {
            resolve({
              status: response.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              headers: responseHeaders,
            })
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    request.once('error', reject)
    request.end(body)
  })
}
function associated(direction: string, frame: RemoteFrame) {
  return Buffer.from(
    `coloop.remote.v1|${direction}|${frame.hostId}|${frame.epoch}|${frame.actorId}|${frame.requestId}|${frame.sequence}`,
    'utf8',
  )
}
function frame(
  identity: { hostId: string; epoch: string; actorId: string },
  key: Buffer,
  payload: unknown,
  sequence = 1,
  direction = 'request',
): RemoteFrame {
  const result: RemoteFrame = {
    version: 1,
    hostId: identity.hostId,
    epoch: identity.epoch,
    actorId: identity.actorId,
    requestId: randomUUID(),
    sequence,
    nonce: '',
    data: '',
  }
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(associated(direction, result))
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return { ...result, nonce: nonce.toString('base64url'), data: ciphertext.toString('base64url') }
}
function open(key: Buffer, response: RemoteFrame) {
  const data = Buffer.from(response.data, 'base64url')
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(response.nonce, 'base64url'))
  cipher.setAAD(associated('response', response))
  cipher.setAuthTag(data.subarray(-16))
  return JSON.parse(
    Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]).toString('utf8'),
  )
}
async function post(
  url: string,
  path: 'pair' | 'rpc',
  body: unknown,
  headers: Record<string, string> = {},
) {
  return nativeRequest(
    `${url}/v1/remote/${path}`,
    typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  )
}
async function paired(service: RemoteGatewayService, url: string, name = 'Fixture phone') {
  const invitation = service.createPairing('https://fixture.trycloudflare.com')
  const info = await hello(url)
  const pairingKey = Buffer.from(invitation.payload.secret, 'base64url')
  const request = frame({ ...info, actorId: invitation.payload.pairingId }, pairingKey, {
    deviceName: name,
  })
  const response = await post(url, 'pair', request)
  expect(response.status).toBe(200)
  const plain = open(pairingKey, response.body)
  expect(plain.ok).toBe(true)
  const key = Buffer.from(plain.value.secret, 'base64url')
  return {
    key,
    identity: { hostId: info.hostId, epoch: info.epoch, actorId: plain.value.deviceId as string },
    request,
    response,
    pairingKey,
    invitation,
  }
}
function rpc(operation = 'snapshot', payload: unknown = {}, expiresAt = now + 60_000) {
  return { operation, payload, expiresAt }
}
function command() {
  return {
    commandId: randomUUID(),
    sessionHandle: randomUUID(),
    action: 'send_message',
    text: 'Continue the authorized synthetic task.',
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Expected condition was not observed')
}

describe('remote encrypted pairing and storage', () => {
  it('binds a random loopback port and exposes only stable identity, new epoch and server time', async () => {
    const { service, url } = await create()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const first = await hello(url)
    expect(Object.keys(first).sort()).toEqual(['epoch', 'hostId', 'serverTime', 'version'])
    expect(first.serverTime).toBe(now)
    await service.stopServer()
    const restarted = await service.start()
    const second = await hello(restarted.url)
    expect(second.hostId).toBe(first.hostId)
    expect(second.epoch).not.toBe(first.epoch)
  })
  it('returns pairing material only from an explicit local invitation and uses exact deeplink encoding', async () => {
    const { service } = await create()
    const invitation = service.createPairing('https://fixture.trycloudflare.com/')
    expect(invitation.payload.endpoint).toBe('https://fixture.trycloudflare.com')
    expect(Buffer.from(invitation.payload.secret, 'base64url')).toHaveLength(32)
    expect(Date.parse(invitation.payload.expiresAt)).toBe(now + 300_000)
    const parsed = new URL(invitation.uri)
    expect(parsed.protocol).toBe('coloop:')
    expect(parsed.hostname).toBe('pair')
    expect(
      JSON.parse(Buffer.from(parsed.searchParams.get('data')!, 'base64url').toString('utf8')),
    ).toEqual(invitation.payload)
    expect(JSON.stringify(service.snapshot())).not.toContain(invitation.payload.secret)
    expect(await readFile(join(directory, 'remote-devices.json'), 'utf8')).not.toContain(
      invitation.payload.secret,
    )
    for (const endpoint of [
      'http://example.com',
      'https://name:password@example.com',
      'https://example.com/path',
      'https://example.com/?key=secret',
    ])
      expect(() => service.createPairing(endpoint)).toThrow('REMOTE_INVALID_ENDPOINT')
  })
  it('pairs once through genuine AES-GCM, caches identical ciphertext retries and rejects different reuse', async () => {
    const { service, url, encrypt } = await create()
    const phone = await paired(service, url)
    expect(phone.key).toHaveLength(32)
    expect(service.snapshot().devices).toHaveLength(1)
    const repeated = await post(url, 'pair', phone.request)
    expect(repeated.body).toEqual(phone.response.body)
    const different = frame(
      { ...phone.identity, actorId: phone.invitation.payload.pairingId },
      phone.pairingKey,
      { deviceName: 'Other phone' },
      2,
    )
    expect((await post(url, 'pair', different)).status).toBe(400)
    expect(encrypt).toHaveBeenCalledTimes(1)
    const raw = await readFile(join(directory, 'remote-devices.json'), 'utf8')
    expect(raw).toContain('encryptedSecret')
    expect(raw).not.toContain(phone.key.toString('base64url'))
    expect(JSON.stringify(service.snapshot())).not.toContain(phone.key.toString('base64url'))
    // Issuing another invitation does not lose an already committed pair's retry receipt.
    service.createPairing('https://other.trycloudflare.com')
    expect((await post(url, 'pair', phone.request)).body).toEqual(phone.response.body)
  })
  it('rejects expired pairing keys including formerly successful retry frames', async () => {
    const { service, url } = await create()
    const phone = await paired(service, url)
    now += 300_000
    const expired = await post(url, 'pair', phone.request)
    expect(expired.status).toBe(400)
    expect(expired.body).toEqual({
      ok: false,
      error: { code: 'REMOTE_REQUEST_REJECTED', message: 'Request rejected.' },
    })
  })
  it('limits paired phones to eight and persists keys through the supplied secret codec', async () => {
    const { service, url } = await create()
    for (let index = 0; index < 8; index++) await paired(service, url, `Phone ${index}`)
    expect(service.snapshot().devices).toHaveLength(8)
    expect(() => service.createPairing('https://fixture.trycloudflare.com')).toThrow(
      'REMOTE_DEVICE_LIMIT',
    )
    service.revoke(service.snapshot().devices[0].id)
    await paired(service, url, 'Replacement')
    expect(service.snapshot().devices).toHaveLength(8)
  })
  it('restores the same host and device key but invalidates every old-epoch request', async () => {
    const original = await create()
    const phone = await paired(original.service, original.url)
    const old = frame(phone.identity, phone.key, rpc('command', command()))
    await original.service.dispose()
    const restored = await create()
    const info = await hello(restored.url)
    expect(info.hostId).toBe(phone.identity.hostId)
    expect(info.epoch).not.toBe(phone.identity.epoch)
    expect(restored.service.snapshot().devices[0].id).toBe(phone.identity.actorId)
    expect((await post(restored.url, 'rpc', old)).status).toBe(400)
    expect(restored.command).not.toHaveBeenCalled()
    const fresh = frame({ ...phone.identity, epoch: info.epoch }, phone.key, rpc())
    expect(open(phone.key, (await post(restored.url, 'rpc', fresh)).body).ok).toBe(true)
  })
  it('preserves damaged credential files and disables the gateway without replacing host identity', async () => {
    const path = join(directory, 'remote-devices.json')
    await writeFile(path, '{preserve-damaged-credentials')
    await expect(create()).rejects.toThrow('REMOTE_STORAGE_UNAVAILABLE')
    expect(services[0].snapshot()).toMatchObject({
      status: 'error',
      error: 'REMOTE_STORAGE_UNAVAILABLE',
    })
    expect(await readFile(path, 'utf8')).toBe('{preserve-damaged-credentials')
  })
})

describe('authenticated remote RPC boundaries', () => {
  it('projects connection readiness and admits a paired reconnect without desktop input', async () => {
    const reconnect = vi.fn()
    const connection = {
      rk: 'connecting' as const,
      message: 'RK is reconnecting',
      autoConnect: true,
    }
    const f = await create({ reconnect, getSnapshot: () => ({ ...mobileSnapshot(), connection }) })
    const phone = await paired(f.service, f.url)
    const projected = open(
      phone.key,
      (await post(f.url, 'rpc', frame(phone.identity, phone.key, rpc()))).body,
    )
    expect(projected.value.connection).toEqual(connection)
    const response = await post(f.url, 'rpc', frame(phone.identity, phone.key, rpc('reconnect'), 2))
    expect(open(phone.key, response.body)).toEqual({ ok: true, value: { reconnecting: true } })
    expect(reconnect).toHaveBeenCalledOnce()
    expect(f.command).not.toHaveBeenCalled()
    const invalid = await post(
      f.url,
      'rpc',
      frame(phone.identity, phone.key, rpc('reconnect', { password: 'forbidden' }), 3),
    )
    expect(open(phone.key, invalid.body).ok).toBe(false)
    expect(reconnect).toHaveBeenCalledOnce()
  })
  it('admits a Violoop task through encrypted RPC and projects its lifecycle separately from session messages', async () => {
    const payload = {
      commandId: randomUUID(),
      text: 'Fill the observed code in Lab',
      authorizeInput: true,
    }
    const task = {
      id: payload.commandId,
      text: payload.text,
      state: 'understanding' as const,
      message: 'RK is reading the task',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }
    const violoopMessage = vi.fn(() => task)
    const snapshot = {
      ...mobileSnapshot(),
      violoop: { available: true, active: true, tasks: [task] },
    }
    const f = await create({ violoopMessage, getSnapshot: () => snapshot })
    const phone = await paired(f.service, f.url)
    const request = frame(phone.identity, phone.key, rpc('violoop_message', payload))
    const response = await post(f.url, 'rpc', request)
    expect(open(phone.key, response.body)).toEqual({ ok: true, value: task })
    expect(violoopMessage).toHaveBeenCalledWith(payload, phone.identity.actorId)
    expect(f.command).not.toHaveBeenCalled()
    await post(f.url, 'rpc', request)
    expect(violoopMessage).toHaveBeenCalledOnce()
    const projected = open(
      phone.key,
      (await post(f.url, 'rpc', frame(phone.identity, phone.key, rpc(), 2))).body,
    )
    expect(projected.value.violoop.tasks[0].id).toBe(payload.commandId)
    expect(JSON.stringify(response.body)).not.toContain(payload.text)
  })
  it('rejects expired and unauthorized Violoop payloads before task admission', async () => {
    const violoopMessage = vi.fn()
    const f = await create({ violoopMessage })
    const phone = await paired(f.service, f.url)
    const payload = { commandId: randomUUID(), text: 'Task', authorizeInput: true }
    for (const [index, data] of [
      rpc('violoop_message', payload, now - 1),
      rpc('violoop_message', { ...payload, authorizeInput: false }),
      rpc('violoop_message', { ...payload, shell: 'not-allowed' }),
    ].entries()) {
      const response = await post(f.url, 'rpc', frame(phone.identity, phone.key, data, index + 1))
      expect(open(phone.key, response.body).ok).toBe(false)
    }
    expect(violoopMessage).not.toHaveBeenCalled()
  })
  it('uses no-store ciphertext and projects only the allowed snapshot fields', async () => {
    const result = commandResult()
    const data = { ...mobileSnapshot(), settings: { apiKey: 'secret-settings-must-stay-local' } }
    data.sessionControl.commands = [result]
    Object.assign(data.sessionControl, { nativeSessionId: 'private-native-session' })
    const { service, url } = await create({ getSnapshot: () => data })
    const phone = await paired(service, url)
    const response = await post(url, 'rpc', frame(phone.identity, phone.key, rpc()))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.body.data).not.toContain('Fixture PC')
    const value = open(phone.key, response.body)
    expect(value.ok).toBe(true)
    expect(value.value.hostName).toBe('Fixture PC')
    expect(JSON.stringify(value)).not.toContain('secret-settings-must-stay-local')
    expect(JSON.stringify(value)).not.toContain('private-native-session')
    expect(JSON.stringify(value)).not.toContain('native-message-id-must-stay-local')
  })
  it('executes an ambiguous command once and returns the exact cached encrypted response on retry', async () => {
    const { service, url, command: invoke } = await create()
    const phone = await paired(service, url)
    const request = frame(phone.identity, phone.key, rpc('command', command()))
    const first = await post(url, 'rpc', request)
    expect(open(phone.key, first.body)).toMatchObject({ ok: true, value: { status: 'unknown' } })
    expect(open(phone.key, first.body).value).not.toHaveProperty('messageId')
    expect((await post(url, 'rpc', request)).body).toEqual(first.body)
    expect(invoke).toHaveBeenCalledTimes(1)
    const replacement = frame(phone.identity, phone.key, rpc('command', command()))
    expect(open(phone.key, (await post(url, 'rpc', replacement)).body).error.code).toBe(
      'REPLAY_REJECTED',
    )
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('coalesces simultaneous identical frames while the original command is still pending', async () => {
    const gate = deferred<CommandSnapshot>()
    const invoke = vi.fn(() => gate.promise)
    const { service, url } = await create({ command: invoke })
    const phone = await paired(service, url)
    const request = frame(phone.identity, phone.key, rpc('command', command()))
    const first = post(url, 'rpc', request)
    await eventually(() => invoke.mock.calls.length === 1)
    const repeated = post(url, 'rpc', request)
    gate.resolve(commandResult())
    const [a, b] = await Promise.all([first, repeated])
    expect(a.body).toEqual(b.body)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('keeps a bounded retry cache and rejects an old sequence after its receipt is evicted', async () => {
    const { service, url, command: invoke } = await create()
    const phone = await paired(service, url)
    const original = frame(phone.identity, phone.key, rpc('command', command()))
    await post(url, 'rpc', original)
    for (let sequence = 2; sequence <= 34; sequence++)
      expect(
        open(
          phone.key,
          (await post(url, 'rpc', frame(phone.identity, phone.key, rpc(), sequence))).body,
        ).ok,
      ).toBe(true)
    expect(open(phone.key, (await post(url, 'rpc', original)).body).error.code).toBe(
      'REPLAY_REJECTED',
    )
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('validates expiry against server time before any action, including the 120 second future bound', async () => {
    const { service, url, command: invoke } = await create()
    const phone = await paired(service, url)
    for (const [sequence, expires] of [
      [1, now - 1],
      [2, now + 120_001],
    ]) {
      const result = await post(
        url,
        'rpc',
        frame(phone.identity, phone.key, rpc('command', command(), expires), sequence),
      )
      expect(open(phone.key, result.body).error.code).toBe('REQUEST_EXPIRED')
    }
    expect(invoke).not.toHaveBeenCalled()
    const accepted = await post(
      url,
      'rpc',
      frame(phone.identity, phone.key, rpc('command', command(), now + 120_000), 3),
    )
    expect(open(phone.key, accepted.body).ok).toBe(true)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('rechecks a queued request expiry after the preceding authenticated action completes', async () => {
    const gate = deferred<CommandSnapshot>()
    const invoke = vi.fn(() => gate.promise)
    const { service, url } = await create({ command: invoke })
    const phone = await paired(service, url)
    const first = post(url, 'rpc', frame(phone.identity, phone.key, rpc('command', command())))
    await eventually(() => invoke.mock.calls.length === 1)
    const second = post(url, 'rpc', frame(phone.identity, phone.key, rpc('command', command()), 2))
    now += 60_001
    gate.resolve(commandResult())
    await first
    expect(open(phone.key, (await second).body).error.code).toBe('REQUEST_EXPIRED')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('rejects extra/unknown payloads, missing expiry, native abort, and oversized text before dispatch', async () => {
    const { service, url, command: invoke, stop, resume } = await create()
    const phone = await paired(service, url)
    const cases = [
      { operation: 'snapshot', payload: {} },
      { ...rpc(), arbitraryIPC: true },
      rpc('shell', { command: 'anything' }),
      rpc('snapshot', { settings: true }),
      rpc('command', { ...command(), action: 'abort_turn', text: undefined }),
      rpc('command', { ...command(), text: '中'.repeat(2800) }),
    ]
    for (const [index, payload] of cases.entries()) {
      const response = await post(url, 'rpc', frame(phone.identity, phone.key, payload, index + 1))
      expect(open(phone.key, response.body).error.code).toBe('INVALID_PAYLOAD')
    }
    expect(invoke).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })
  it('encrypts stop failures using a fixed message, and resume remains an explicit serialized action', async () => {
    const stop = vi.fn(async () => {
      throw new Error('password=untrusted-upstream-secret')
    })
    const { service, url, resume } = await create({ stop })
    const phone = await paired(service, url)
    const request = frame(phone.identity, phone.key, rpc('stop'))
    const result = await post(url, 'rpc', request)
    expect(open(phone.key, result.body)).toMatchObject({
      ok: false,
      error: { code: 'STOP_UNCONFIRMED' },
    })
    expect(JSON.stringify(open(phone.key, result.body))).not.toContain('untrusted-upstream-secret')
    expect((await post(url, 'rpc', request)).body).toEqual(result.body)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
    const resumed = await post(url, 'rpc', frame(phone.identity, phone.key, rpc('resume'), 2))
    expect(open(phone.key, resumed.body)).toEqual({ ok: true, value: { stopped: false } })
    expect(resume).toHaveBeenCalledTimes(1)
  })
})

describe('remote authentication, immediate revocation and lifecycle', () => {
  it('uses one public rejection for invalid tags, AAD identities, wrong direction, bad JSON and browser origins', async () => {
    const { service, url, command: invoke } = await create()
    const phone = await paired(service, url)
    const request = frame(phone.identity, phone.key, rpc('command', command()))
    const changedTag = Buffer.from(request.data, 'base64url')
    changedTag[changedTag.length - 1] ^= 1
    const invalid = [
      { ...request, data: changedTag.toString('base64url') },
      { ...request, epoch: randomUUID() },
      { ...request, hostId: randomUUID() },
      { ...request, actorId: randomUUID() },
      { ...request, requestId: randomUUID() },
      { ...request, sequence: 0 },
      { ...request, nonce: request.nonce + '=' },
      { ...request, extra: true },
      frame(phone.identity, phone.key, rpc(), 1, 'response'),
      frame(phone.identity, randomBytes(32), rpc()),
      '{malformed',
      '{"version":1,"version":1}',
    ]
    const expected = {
      ok: false,
      error: { code: 'REMOTE_REQUEST_REJECTED', message: 'Request rejected.' },
    }
    for (const body of invalid) {
      const response = await post(url, 'rpc', body)
      expect(response.status).toBe(400)
      expect(response.body).toEqual(expected)
    }
    const browserHeaders: Record<string, string>[] = [
      { origin: 'https://foreign.example' },
      { 'sec-fetch-mode': 'cors' },
    ]
    for (const headers of browserHeaders) {
      const response = await post(url, 'rpc', request, headers)
      expect(response.status).toBe(400)
      expect(response.body).toEqual(expected)
    }
    const oversized = await post(url, 'rpc', 'x'.repeat(65_537))
    expect(oversized.status).toBe(400)
    expect(oversized.body).toEqual(expected)
    expect(invoke).not.toHaveBeenCalled()
  })
  it('revokes a phone immediately and persists removal without exposing its prior cached results', async () => {
    const { service, url, command: invoke } = await create()
    const phone = await paired(service, url)
    const request = frame(phone.identity, phone.key, rpc('command', command()))
    await post(url, 'rpc', request)
    service.revoke(phone.identity.actorId)
    expect(service.snapshot().devices).toEqual([])
    expect(
      JSON.parse(await readFile(join(directory, 'remote-devices.json'), 'utf8')).devices,
    ).toEqual([])
    expect((await post(url, 'rpc', request)).status).toBe(400)
    expect((await post(url, 'pair', phone.request)).status).toBe(400)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('rechecks revocation after awaits and rejects a queued write without executing it', async () => {
    const gate = deferred<CommandSnapshot>()
    const invoke = vi.fn(() => gate.promise)
    const { service, url } = await create({ command: invoke })
    const phone = await paired(service, url)
    const first = post(url, 'rpc', frame(phone.identity, phone.key, rpc('command', command())))
    await eventually(() => invoke.mock.calls.length === 1)
    const second = post(url, 'rpc', frame(phone.identity, phone.key, rpc('command', command()), 2))
    await new Promise((resolve) => setTimeout(resolve, 10))
    service.revoke(phone.identity.actorId)
    gate.resolve(commandResult())
    expect((await first).status).toBe(400)
    expect((await second).status).toBe(400)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('unpairs through authenticated RPC and safely replays only its keyless revocation receipt', async () => {
    const { service, url } = await create()
    const phone = await paired(service, url)
    const request = frame(phone.identity, phone.key, rpc('unpair'))
    const first = await post(url, 'rpc', request)
    expect(open(phone.key, first.body)).toEqual({ ok: true, value: { revoked: true } })
    expect(service.snapshot().devices).toEqual([])
    expect((await post(url, 'rpc', request)).body).toEqual(first.body)
    const afterUnpair = await post(url, 'rpc', frame(phone.identity, phone.key, rpc(), 2))
    expect(afterUnpair.status).toBe(400)
  })
  it('stops the public gateway without publishing private native routes or leaving a pairing usable', async () => {
    const { service, url } = await create()
    for (const path of ['/v1/hooks', '/v1/control/poll', '/v1/review', '/v1/remote/rpc?extra=1']) {
      const response = await nativeRequest(url + path, '{}')
      expect(response.status).toBe(400)
    }
    const oldPair = service.createPairing('https://fixture.trycloudflare.com')
    await service.stopServer()
    expect(service.snapshot().status).toBe('stopped')
    expect(service.snapshot()).not.toHaveProperty('url')
    expect(() => service.createPairing('https://fixture.trycloudflare.com')).toThrow(
      'REMOTE_NOT_RUNNING',
    )
    const restarted = await service.start()
    const fresh = await hello(restarted.url)
    const oldKeyRequest = frame(
      { ...fresh, actorId: oldPair.payload.pairingId },
      Buffer.from(oldPair.payload.secret, 'base64url'),
      { deviceName: 'Old invitation' },
    )
    expect((await post(restarted.url, 'pair', oldKeyRequest)).status).toBe(400)
  })
  it('does not resurrect a listener when stop races an unfinished start', async () => {
    const { service } = await create()
    await service.stopServer()
    const starting = service.start()
    await service.stopServer()
    await expect(starting).rejects.toThrow('REMOTE_NOT_RUNNING')
    expect(service.snapshot().status).toBe('stopped')
    expect(service.snapshot()).not.toHaveProperty('url')
    const restarted = await service.start()
    expect((await hello(restarted.url)).hostId).toBe(service.snapshot().hostId)
  })
})
