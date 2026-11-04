import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRelay } from '../server/relay.mjs'
import { RemoteRelay, relayJson } from '../src/main/infrastructure/remote-relay'
import { RemoteRelayConfig } from '../src/main/infrastructure/remote-relay-config'
import { RemoteGatewayService } from '../src/main/services/remote-gateway'
import { relayConfigurationSchema } from '../src/shared/relay'
import type { RemoteFrame } from '../src/shared/remote'

const resources: (() => Promise<unknown>)[] = []
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'coloop-relay-'))
})
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close()
  await rm(directory, { recursive: true, force: true })
})
async function broker(options: { timeoutMs?: number; pollMs?: number; onlineMs?: number } = {}) {
  const channelId = randomUUID(),
    token = randomBytes(32).toString('base64url')
  const accessKey = 'fixture-access-key',
    accessKeySalt = randomBytes(16).toString('hex')
  const relay = createRelay({
    channels: [{ channelId, tokenHash: createHash('sha256').update(token).digest('hex') }],
    accessKeySalt,
    accessKeyHash: scryptSync(accessKey, accessKeySalt, 32).toString('hex'),
    ...options,
  })
  await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve))
  resources.push(() => relay.close())
  const address = relay.server.address() as { port: number }
  const base = `http://127.0.0.1:${address.port}`
  const endpoint = `${base}/h/${channelId}`
  const call = (action: string, value: unknown, credential = token) =>
    relayJson(new URL(`${base}/v1/hosts/${channelId}/${action}`), value, { token: credential })
  const phone = (path: string, value?: unknown) =>
    relayJson(new URL(`${endpoint}${path}`), value, { accessKey })
  return { channelId, token, base, endpoint, call, accessKey, phone, server: relay.server }
}
function encrypt(identity: any, key: Buffer, payload: unknown, sequence = 1): RemoteFrame {
  const frame = {
    version: 1 as const,
    hostId: identity.hostId,
    epoch: identity.epoch,
    actorId: identity.actorId,
    requestId: randomUUID(),
    sequence,
    nonce: randomBytes(12).toString('base64url'),
    data: '',
  }
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(frame.nonce, 'base64url'))
  cipher.setAAD(
    Buffer.from(
      `coloop.remote.v1|request|${frame.hostId}|${frame.epoch}|${frame.actorId}|${frame.requestId}|${frame.sequence}`,
    ),
  )
  frame.data = Buffer.concat([
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64url')
  return frame
}
function decrypt(key: Buffer, frame: RemoteFrame) {
  const data = Buffer.from(frame.data, 'base64url')
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(frame.nonce, 'base64url'))
  cipher.setAAD(
    Buffer.from(
      `coloop.remote.v1|response|${frame.hostId}|${frame.epoch}|${frame.actorId}|${frame.requestId}|${frame.sequence}`,
    ),
  )
  cipher.setAuthTag(data.subarray(-16))
  return JSON.parse(
    Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]).toString(),
  )
}
const hello = () => ({
  version: 1,
  hostId: randomUUID(),
  epoch: randomUUID(),
  serverTime: Date.now(),
})

describe('owned application broker', () => {
  it('rejects unauthenticated hosts, offline phones and arbitrary forwarding routes', async () => {
    const service = await broker()
    expect(
      (await service.call('connect', { hello: hello() }, randomBytes(32).toString('base64url')))
        .status,
    ).toBe(401)
    expect((await service.phone('/v1/remote/hello')).status).toBe(503)
    expect(
      (
        await relayJson(new URL(`${service.base}/proxy/http://127.0.0.1:22`), undefined, {
          accessKey: service.accessKey,
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await relayJson(new URL(`${service.base}/healthz`), undefined, {
          accessKey: service.accessKey,
        })
      ).body,
    ).toEqual({
      service: 'coloop',
      version: 1,
    })
  })
  it('does not redeliver timed-out commands or retain them across reconnects', async () => {
    const service = await broker({ timeoutMs: 60, pollMs: 15 })
    const identity = hello()
    let generation = (await service.call('connect', { hello: identity })).body as any
    const frame = encrypt({ ...identity, actorId: randomUUID() }, randomBytes(32), {
      secret: 'ciphertext only',
    })
    const waiting = service.phone('/v1/remote/rpc', frame)
    const first = await service.call('poll', generation)
    expect((first.body as any).jobs).toHaveLength(1)
    expect((await waiting).status).toBe(504)
    expect((await service.call('poll', generation)).body).toEqual({ jobs: [] })
    const expired = await service.call('reply', {
      ...generation,
      id: (first.body as any).jobs[0].id,
      status: 400,
      body: {},
    })
    expect(expired.status).toBe(410)
    const old = generation
    generation = (await service.call('connect', { hello: identity })).body as any
    expect((await service.call('poll', old)).status).toBe(409)
    expect((await service.call('poll', generation)).body).toEqual({ jobs: [] })
  })
  it('completes actual encrypted pair and snapshot requests through an outbound desktop worker', async () => {
    const service = await broker()
    const gateway = new RemoteGatewayService({
      directory,
      encrypt: (value) => value,
      decrypt: (value) => value,
      onChange: vi.fn(),
      command: vi.fn(),
      stop: vi.fn(),
      resume: vi.fn(),
      getSnapshot: () => ({
        hostName: 'real fixture desktop',
        progress: [],
        sessionControl: {
          stopped: false,
          controlActive: false,
          unconfirmedCount: 0,
          sessions: [],
          commands: [],
        },
      }),
    })
    const local = await gateway.start()
    resources.push(() => gateway.dispose())
    // The test substitutes only TLS transport for a real loopback HTTP socket.
    let networkAvailable = true
    const worker = new RemoteRelay(
      vi.fn(),
      (url, value, options) => {
        if (url.hostname === 'relay.test' && !networkAvailable)
          return Promise.reject(new Error('fixture network outage'))
        return relayJson(
          url.hostname === 'relay.test' ? new URL(url.pathname, service.base) : url,
          value,
          options,
        )
      },
      { baseMs: 10, maxMs: 30 },
    )
    resources.push(() => worker.stop())
    const publicEndpoint = `https://relay.test/h/${service.channelId}`
    await worker.start(local.url, {
      version: 1,
      endpoint: publicEndpoint,
      token: service.token,
      accessKey: service.accessKey,
    })
    expect(worker.snapshot().status).toBe('online')
    const info = (await service.phone('/v1/remote/hello')).body as any
    const invite = gateway.createPairing(publicEndpoint)
    expect(invite.payload.endpoint).toBe(publicEndpoint)
    const pairKey = Buffer.from(invite.payload.secret, 'base64url')
    const pair = encrypt({ ...info, actorId: invite.payload.pairingId }, pairKey, {
      deviceName: 'test phone',
    })
    const paired = await service.phone('/v1/remote/pair', pair)
    expect(paired.status).toBe(200)
    const device = decrypt(pairKey, paired.body as RemoteFrame).value
    const frame = encrypt(
      { ...info, actorId: device.deviceId },
      Buffer.from(device.secret, 'base64url'),
      { operation: 'snapshot', payload: {}, expiresAt: Date.now() + 60000 },
    )
    const snapshot = await service.phone('/v1/remote/rpc', frame)
    expect(
      decrypt(Buffer.from(device.secret, 'base64url'), snapshot.body as RemoteFrame).value.hostName,
    ).toBe('real fixture desktop')
    // An outage lasts longer than the old three-attempt retry budget.
    networkAvailable = false
    await vi.waitFor(() => expect(worker.snapshot().status).toBe('starting'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    // Simulate a server restart losing its generation; the worker must register again.
    await service.call('connect', { hello: hello() })
    networkAvailable = true
    await vi.waitFor(() => expect(worker.snapshot().status).toBe('online'))
    const restored = (await service.phone('/v1/remote/hello')).body as any
    expect(restored.hostId).toBe(info.hostId)
    expect(restored.epoch).toBe(info.epoch)
    const afterReconnect = encrypt(
      { ...restored, actorId: device.deviceId },
      Buffer.from(device.secret, 'base64url'),
      { operation: 'snapshot', payload: {}, expiresAt: Date.now() + 60000 },
      2,
    )
    const resumed = await service.phone('/v1/remote/rpc', afterReconnect)
    expect(resumed.status).toBe(200)
    expect(
      decrypt(Buffer.from(device.secret, 'base64url'), resumed.body as RemoteFrame).value.hostName,
    ).toBe('real fixture desktop')
    gateway.revoke(device.deviceId)
    expect((await service.phone('/v1/remote/rpc', frame)).status).toBe(400)
    await worker.stop()
    expect((await service.phone('/v1/remote/hello')).status).toBe(503)
  })
  it('expires disconnected hosts, releases queued commands and does not renew leases on status reads', async () => {
    const service = await broker({ onlineMs: 250, timeoutMs: 3000, pollMs: 30 })
    const identity = hello()
    const generation = (await service.call('connect', { hello: identity })).body as any
    const pending = service.phone(
      '/v1/remote/rpc',
      encrypt({ ...identity, actorId: randomUUID() }, randomBytes(32), { test: 'lease' }),
    )
    const statusUrl = new URL(`${service.base}/v1/hosts/${service.channelId}/status`)
    const status = () => relayJson(statusUrl, undefined, { token: service.token })
    await vi.waitFor(async () => {
      expect((await status()).body).toMatchObject({ online: true, pendingRequests: 1 })
    })
    expect((await pending).status).toBe(503)
    expect((await status()).body).toEqual({
      service: 'coloop',
      version: 1,
      online: false,
      release: '2026.10.31.1',
      pendingRequests: 0,
      deliveredRequests: 0,
      polling: false,
      leaseRemainingMs: 0,
    })
    expect((await service.call('poll', generation)).status).toBe(409)
    expect((await service.phone('/v1/remote/hello')).status).toBe(503)
    expect((await relayJson(statusUrl, undefined, { accessKey: service.accessKey })).status).toBe(
      401,
    )
  })
  it('rejects an upload completed after reconnection rather than delivering it into a new generation', async () => {
    const service = await broker({ pollMs: 20 })
    const identity = hello()
    await service.call('connect', { hello: identity })
    const frame = encrypt({ ...identity, actorId: randomUUID() }, randomBytes(32), {
      test: 'upload',
    })
    const raw = JSON.stringify(frame)
    let finishUpload!: () => void
    const received = new Promise<void>((resolve) => service.server.once('request', () => resolve()))
    const response = new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${service.endpoint}/v1/remote/rpc`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-coloop-access-key': service.accessKey },
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode!))
        },
      )
      req.on('error', reject)
      req.write(raw.slice(0, 20))
      finishUpload = () => req.end(raw.slice(20))
    })
    await received
    const generation = (await service.call('connect', { hello: identity })).body
    finishUpload()
    expect(await response).toBe(503)
    expect((await service.call('poll', generation)).body).toEqual({ jobs: [] })
  })
  it('rejects duplicate in-flight requests without delivering or consuming the original twice', async () => {
    const service = await broker({ pollMs: 20 })
    const identity = hello()
    const generation = (await service.call('connect', { hello: identity })).body as any
    const frame = encrypt({ ...identity, actorId: randomUUID() }, randomBytes(32), {
      test: 'duplicate',
    })
    const original = service.phone('/v1/remote/rpc', frame)
    const jobs = (await service.call('poll', generation)).body as any
    expect(jobs.jobs).toHaveLength(1)
    expect((await service.phone('/v1/remote/rpc', frame)).status).toBe(409)
    expect((await service.call('poll', generation)).body).toEqual({ jobs: [] })
    expect(
      (await service.call('reply', { ...generation, id: jobs.jobs[0].id, status: 400, body: {} }))
        .status,
    ).toBe(200)
    expect((await original).status).toBe(400)
  })
  it('cancels reconnect backoff promptly and never reconnects after the user disables it', async () => {
    const service = await broker({ pollMs: 20 })
    let offline = false
    let connects = 0
    const request: typeof relayJson = async (url, value, options) => {
      if (url.hostname === '127.0.0.1' && url.pathname === '/v1/remote/hello')
        return { status: 200, body: hello() }
      if (url.pathname.endsWith('/connect')) connects++
      if (offline) throw Error('network unavailable')
      return relayJson(new URL(url.pathname, service.base), value, options)
    }
    const worker = new RemoteRelay(vi.fn(), request, { baseMs: 30000, maxMs: 30000 })
    resources.push(() => worker.stop())
    await worker.start('http://127.0.0.1:12345/', {
      version: 1,
      endpoint: `https://relay.test/h/${service.channelId}`,
      token: service.token,
      accessKey: service.accessKey,
    })
    offline = true
    await vi.waitFor(() => expect(worker.snapshot().status).toBe('starting'))
    await worker.stop()
    expect(worker.snapshot().status).toBe('stopped')
    offline = false
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(connects).toBe(1)
    expect(worker.snapshot().status).toBe('stopped')
  })
  it('stops retrying a revoked desktop credential instead of reconnecting indefinitely', async () => {
    let authenticated = true
    let polls = 0
    const request: typeof relayJson = async (url) => {
      if (url.pathname === '/v1/remote/hello') return { status: 200, body: hello() }
      if (url.pathname.endsWith('/connect'))
        return { status: 200, body: { generation: randomUUID() } }
      polls++
      if (!authenticated) return { status: 401, body: {} }
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { status: 200, body: { jobs: [] } }
    }
    const worker = new RemoteRelay(vi.fn(), request, { baseMs: 10, maxMs: 20 })
    resources.push(() => worker.stop())
    await worker.start('http://127.0.0.1:12345/', {
      version: 1,
      endpoint: `https://relay.test/h/${randomUUID()}`,
      token: randomBytes(32).toString('base64url'),
      accessKey: 'fixture-access-key',
    })
    authenticated = false
    await vi.waitFor(() => expect(worker.snapshot().status).toBe('error'))
    const stoppedPolls = polls
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(polls).toBe(stoppedPolls)
  })
  it('protects configuration tokens and forbids credential/query/arbitrary path endpoints', async () => {
    const config = {
      version: 1 as const,
      endpoint: `https://relay.test/h/${randomUUID()}`,
      token: randomBytes(32).toString('base64url'),
      accessKey: 'fixture-access-key',
    }
    const codec = {
      encrypt: (v: string) => Buffer.from(v).toString('hex'),
      decrypt: (v: string) => Buffer.from(v, 'hex').toString(),
    }
    const store = new RemoteRelayConfig(directory, codec)
    store.import(JSON.stringify(config))
    expect(await readFile(join(directory, 'mobile-server.json'), 'utf8')).not.toContain(
      config.token,
    )
    expect(new RemoteRelayConfig(directory, codec).current()).toEqual(config)
    for (const endpoint of [
      'http://relay.test',
      'https://user:pass@relay.test',
      'https://relay.test/path',
      config.endpoint + '?token=x',
    ])
      expect(relayConfigurationSchema.safeParse({ ...config, endpoint }).success).toBe(false)
  })
  it('requires the access key even for discovery and health, and a host token cannot be replaced by it', async () => {
    const service = await broker()
    await service.call('connect', { hello: hello() })
    for (const path of ['/healthz', `/h/${service.channelId}/v1/remote/hello`]) {
      expect((await relayJson(new URL(service.base + path), undefined)).status).toBe(401)
      expect(
        (await relayJson(new URL(service.base + path), undefined, { accessKey: 'incorrect-key' }))
          .status,
      ).toBe(401)
    }
    expect((await service.phone('/v1/remote/hello')).status).toBe(200)
    expect(
      (
        await relayJson(
          new URL(`${service.base}/v1/hosts/${service.channelId}/connect`),
          { hello: hello() },
          { accessKey: service.accessKey },
        )
      ).status,
    ).toBe(401)
  })
})
