import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { canonicalJson } from '../../shared/coordinator'
import { parseStrictJson } from '../domain/strict-json'
import {
  remoteFrameSchema,
  remotePairRequestSchema,
  remoteRpcSchema,
  type RemoteFrame,
  type RemoteGatewaySnapshot,
  type RemoteMobileSnapshot,
  type RemotePairingInvitation,
  type RemoteResult,
  type RemoteRpcRequest,
} from '../../shared/remote'
import type { CommandSnapshot, SessionCommandInput } from '../../shared/sessions'
import { isRemoteEndpoint } from '../../shared/relay'
import { remoteConnectionSchema } from '../../shared/connection'
import {
  violoopSnapshotSchema,
  violoopTaskSchema,
  type VioloopMessage,
  type VioloopTask,
} from '../../shared/violoop'

const PAIR_TTL = 300_000
const MAX_DEVICES = 8
const MAX_BODY = 65_536
const MAX_RESPONSE = 262_144
const CACHE_SIZE = 32
const PUBLIC_REJECTION = {
  ok: false,
  error: { code: 'REMOTE_REQUEST_REJECTED', message: 'Request rejected.' },
}
const date = z.string().datetime({ offset: true })
const uuid = z.string().uuid()
const safeCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)
const commandSchema = z.object({
  commandId: uuid,
  sessionHandle: uuid,
  action: z.enum(['send_message', 'abort_turn']),
  status: z.enum([
    'queued',
    'dispatched',
    'accepted',
    'confirmed',
    'failed',
    'unknown',
    'cancelled',
    'expired',
  ]),
  errorCode: safeCode.optional(),
  createdAt: date,
  expiresAt: date,
  updatedAt: date,
  controlResolved: z.boolean().optional(),
})
const mobileSchema = z.object({
  connection: remoteConnectionSchema.optional(),
  violoop: violoopSnapshotSchema.optional(),
  hostName: z.string().min(1).max(160),
  sessionControl: z.object({
    stopped: z.boolean(),
    controlActive: z.boolean(),
    unconfirmedCount: z.number().int().min(0).max(10_064),
    sessions: z
      .array(
        z.object({
          handle: uuid,
          source: z.literal('opencode'),
          sourceId: z.string().max(128),
          host: z.enum(['windows', 'rk', 'other']),
          title: z.string().max(160),
          workspace: z.string().max(1024),
          state: z.enum(['idle', 'running', 'awaiting_input', 'error', 'closed']),
          connected: z.boolean(),
          capabilities: z.array(z.enum(['send_message', 'abort_turn'])).max(2),
          controlActive: z.boolean(),
          controlStartedAt: date.optional(),
          stopping: z.boolean(),
          lastSeenAt: date,
        }),
      )
      .max(64),
    commands: z.array(commandSchema).max(200),
    journalError: safeCode.optional(),
  }),
  progress: z
    .array(z.object({ sessionHandle: uuid, text: z.string().max(2000), at: date }))
    .max(64),
})
const storageSchema = z
  .object({
    version: z.literal(1),
    hostId: uuid,
    devices: z
      .array(
        z
          .object({
            id: uuid,
            name: z.string().min(1).max(80),
            createdAt: date,
            lastSeenAt: date,
            encryptedSecret: z.string().min(1).max(65_536),
          })
          .strict(),
      )
      .max(MAX_DEVICES),
  })
  .strict()
interface Cached {
  hash: string
  pending: Promise<RemoteFrame>
  finished: boolean
}
interface Device {
  id: string
  name: string
  key: Buffer
  encryptedSecret: string
  createdAt: string
  lastSeenAt: string
  maxSequence: number
  cache: Map<number, Cached>
  chain: Promise<void>
}
interface Pairing {
  id: string
  key: Buffer
  expires: number
  epoch: string
  usedHash?: string
  response?: RemoteFrame
  deviceId?: string
}
export interface RemoteGatewayOptions {
  directory: string
  encrypt: (value: string) => string
  decrypt: (value: string) => string
  onChange: () => void
  getSnapshot: () => RemoteMobileSnapshot
  command: (input: SessionCommandInput) => Promise<CommandSnapshot>
  violoopMessage?: (input: VioloopMessage, deviceId: string) => VioloopTask | Promise<VioloopTask>
  stop: () => Promise<void>
  resume: () => Promise<void>
  reconnect?: () => void | Promise<void>
  hostName?: string
  now?: () => number
}
export class RemoteGatewayError extends Error {
  constructor(public readonly reasonCode: string) {
    super(reasonCode)
  }
}
function failure(code: string, message: string): RemoteResult {
  return { ok: false, error: { code, message } }
}
function aad(direction: 'request' | 'response', frame: RemoteFrame) {
  return Buffer.from(
    `coloop.remote.v1|${direction}|${frame.hostId}|${frame.epoch}|${frame.actorId}|${frame.requestId}|${frame.sequence}`,
    'utf8',
  )
}
function decode(value: string, length?: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('INVALID_BASE64')
  const decoded = Buffer.from(value, 'base64url')
  if (
    decoded.toString('base64url') !== value ||
    (length !== undefined && decoded.length !== length)
  )
    throw new Error('INVALID_BASE64')
  return decoded
}

/** The public tunnel carries authenticated ciphertext only; no Electron/native API is exposed. */
export class RemoteGatewayService {
  private hostId = randomUUID() as string
  private epoch = ''
  private server?: Server
  private url?: string
  private devices = new Map<string, Device>()
  private pairing?: Pairing
  private error?: string
  private disposed = false
  private starting = false
  private lifecycle = 0
  private revokedReplies = new Map<
    string,
    { actorId: string; expires: number; frame: RemoteFrame }
  >()
  private pairReplies = new Map<
    string,
    { hash: string; expires: number; frame: RemoteFrame; deviceId?: string }
  >()
  constructor(private options: RemoteGatewayOptions) {
    this.restore()
  }
  private now() {
    return this.options.now?.() ?? Date.now()
  }
  private iso() {
    return new Date(this.now()).toISOString()
  }
  private notify() {
    try {
      this.options.onChange()
    } catch {
      // A display notification cannot change a committed authorization result.
    }
  }
  private storePath() {
    return join(this.options.directory, 'remote-devices.json')
  }
  private restore() {
    const path = this.storePath()
    try {
      if (!existsSync(path)) {
        this.save()
        return
      }
      if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 600_000)
        throw new Error('INVALID_STORAGE')
      const stored = storageSchema.parse(parseStrictJson(readFileSync(path, 'utf8')))
      this.hostId = stored.hostId
      for (const row of stored.devices) {
        if (this.devices.has(row.id)) throw new Error('DUPLICATE_DEVICE')
        const key = decode(this.options.decrypt(row.encryptedSecret), 32)
        this.devices.set(row.id, {
          ...row,
          key,
          maxSequence: 0,
          cache: new Map(),
          chain: Promise.resolve(),
        })
      }
    } catch {
      this.error = 'REMOTE_STORAGE_UNAVAILABLE'
      for (const device of this.devices.values()) device.key.fill(0)
      this.devices.clear()
    }
  }
  private save() {
    if (this.error) throw new RemoteGatewayError(this.error)
    const path = this.storePath(),
      temporary = `${path}.${randomUUID()}.pending`
    let fd: number | undefined
    try {
      mkdirSync(this.options.directory, { recursive: true, mode: 0o700 })
      if (
        lstatSync(this.options.directory).isSymbolicLink() ||
        (existsSync(path) && lstatSync(path).isSymbolicLink())
      )
        throw new Error('INVALID_STORAGE')
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(
        fd,
        JSON.stringify({
          version: 1,
          hostId: this.hostId,
          devices: [...this.devices.values()].map(
            ({ id, name, createdAt, lastSeenAt, encryptedSecret }) => ({
              id,
              name,
              createdAt,
              lastSeenAt,
              encryptedSecret,
            }),
          ),
        }),
        'utf8',
      )
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, path)
    } catch {
      this.error = 'REMOTE_STORAGE_UNAVAILABLE'
      throw new RemoteGatewayError(this.error)
    } finally {
      if (fd !== undefined) closeSync(fd)
      try {
        unlinkSync(temporary)
      } catch {
        /* The atomic rename removes the temporary file. */
      }
    }
  }
  async start(): Promise<{ url: string }> {
    if (this.error) throw new RemoteGatewayError(this.error)
    if (this.disposed || this.server || this.starting)
      throw new RemoteGatewayError('REMOTE_ALREADY_STARTED_OR_STOPPED')
    this.starting = true
    const lifecycle = ++this.lifecycle
    this.epoch = randomUUID()
    this.clearPairing()
    this.revokedReplies.clear()
    this.pairReplies.clear()
    for (const device of this.devices.values()) {
      device.maxSequence = 0
      device.cache.clear()
      device.chain = Promise.resolve()
    }
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => this.reply(response, PUBLIC_REJECTION, 400))
    })
    server.headersTimeout = 5000
    server.requestTimeout = 10_000
    server.keepAliveTimeout = 1000
    server.maxConnections = 16
    server.on('clientError', (_error, socket) => socket.destroy())
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      if (lifecycle !== this.lifecycle || this.disposed)
        throw new RemoteGatewayError('REMOTE_NOT_RUNNING')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('INVALID_LISTEN')
      this.server = server
      this.url = `http://127.0.0.1:${address.port}`
      server.on('error', () => {
        this.error = 'REMOTE_SERVER_UNAVAILABLE'
        this.notify()
      })
      this.notify()
      return { url: this.url }
    } catch (error) {
      if (server.listening) {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()))
        server.closeAllConnections()
        await closed
      }
      if (error instanceof RemoteGatewayError) throw error
      throw new RemoteGatewayError('REMOTE_SERVER_UNAVAILABLE')
    } finally {
      this.starting = false
    }
  }
  private clearPairing() {
    this.pairing?.key.fill(0)
    this.pairing = undefined
  }
  createPairing(endpoint: string, accessKey?: string): RemotePairingInvitation {
    if (this.error) throw new RemoteGatewayError(this.error)
    if (!this.server || !this.url || this.disposed)
      throw new RemoteGatewayError('REMOTE_NOT_RUNNING')
    let parsed: URL
    try {
      parsed = new URL(endpoint)
      if (!isRemoteEndpoint(parsed)) throw new Error('INVALID_ENDPOINT')
    } catch {
      throw new RemoteGatewayError('REMOTE_INVALID_ENDPOINT')
    }
    if (this.devices.size >= MAX_DEVICES) throw new RemoteGatewayError('REMOTE_DEVICE_LIMIT')
    this.clearPairing()
    const pairing: Pairing = {
      id: randomUUID(),
      key: randomBytes(32),
      expires: this.now() + PAIR_TTL,
      epoch: this.epoch,
    }
    this.pairing = pairing
    const payload = {
      version: 1 as const,
      endpoint: parsed.pathname === '/' ? parsed.origin : `${parsed.origin}${parsed.pathname}`,
      hostId: this.hostId,
      pairingId: pairing.id,
      secret: pairing.key.toString('base64url'),
      expiresAt: new Date(pairing.expires).toISOString(),
      ...(accessKey ? { accessKey } : {}),
    }
    return {
      payload,
      uri: `coloop://pair?data=${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`,
    }
  }
  snapshot(): RemoteGatewaySnapshot {
    return {
      status: this.error ? 'error' : this.server ? 'listening' : 'stopped',
      ...(this.url ? { url: this.url } : {}),
      hostId: this.hostId,
      devices: [...this.devices.values()].map(({ id, name, createdAt, lastSeenAt }) => ({
        id,
        name,
        createdAt,
        lastSeenAt,
      })),
      ...(this.error ? { error: this.error } : {}),
    }
  }
  revoke(id: string): void {
    if (!uuid.safeParse(id).success) throw new RemoteGatewayError('REMOTE_INVALID_DEVICE')
    const device = this.devices.get(id)
    if (!device) return
    this.devices.delete(id)
    device.key.fill(0)
    device.cache.clear()
    if (this.pairing?.deviceId === id) this.clearPairing()
    for (const [hash, cached] of this.revokedReplies)
      if (cached.actorId === id) this.revokedReplies.delete(hash)
    for (const [actorId, cached] of this.pairReplies)
      if (cached.deviceId === id) this.pairReplies.delete(actorId)
    try {
      this.save()
    } finally {
      this.notify()
    }
  }
  private reply(response: ServerResponse, value: unknown, status = 200) {
    if (response.destroyed || response.writableEnded) return
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      connection: 'close',
    })
    response.end(JSON.stringify(value))
  }
  private encrypt(key: Buffer, request: RemoteFrame, result: RemoteResult): RemoteFrame {
    let plain = Buffer.from(JSON.stringify(result), 'utf8')
    if (plain.length > MAX_RESPONSE)
      plain = Buffer.from(
        JSON.stringify(failure('RESPONSE_TOO_LARGE', 'The response is too large.')),
      )
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad('response', request))
    const data = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
    return { ...request, nonce: nonce.toString('base64url'), data: data.toString('base64url') }
  }
  private decrypt(key: Buffer, frame: RemoteFrame) {
    const nonce = decode(frame.nonce, 12),
      data = decode(frame.data)
    if (data.length < 16) throw new Error('INVALID_TAG')
    const cipher = createDecipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad('request', frame))
    cipher.setAuthTag(data.subarray(-16))
    const plain = Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()])
    return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(plain))
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    if (
      !this.server ||
      this.error ||
      request.headers.origin !== undefined ||
      Object.keys(request.headers).some((key) => key.startsWith('sec-fetch-'))
    ) {
      this.reply(response, PUBLIC_REJECTION, 400)
      return
    }
    if (request.method === 'GET' && request.url === '/v1/remote/hello') {
      this.reply(response, {
        version: 1,
        hostId: this.hostId,
        epoch: this.epoch,
        serverTime: this.now(),
      })
      return
    }
    if (
      request.method !== 'POST' ||
      !['/v1/remote/pair', '/v1/remote/rpc'].includes(request.url ?? '') ||
      !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '') ||
      request.headers['content-encoding'] ||
      Number(request.headers['content-length'] ?? 0) > MAX_BODY
    ) {
      this.reply(response, PUBLIC_REJECTION, 400)
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    const timer = setTimeout(() => request.destroy(), 5000)
    try {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length
        if (bytes > MAX_BODY) {
          request.resume()
          this.reply(response, PUBLIC_REJECTION, 400)
          return
        }
        chunks.push(chunk)
      }
    } finally {
      clearTimeout(timer)
    }
    let frame: RemoteFrame
    try {
      frame = remoteFrameSchema.parse(
        parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
      )
    } catch {
      this.reply(response, PUBLIC_REJECTION, 400)
      return
    }
    if (frame.hostId !== this.hostId || frame.epoch !== this.epoch) {
      this.reply(response, PUBLIC_REJECTION, 400)
      return
    }
    const hash = createHash('sha256').update(canonicalJson(frame)).digest('hex')
    if (request.url === '/v1/remote/pair') {
      this.reply(response, this.pair(frame, hash))
      return
    }
    for (const [id, cached] of this.revokedReplies)
      if (cached.expires <= this.now()) this.revokedReplies.delete(id)
    const revoked = this.revokedReplies.get(hash)
    if (revoked) {
      this.reply(response, revoked.frame)
      return
    }
    const device = this.devices.get(frame.actorId)
    if (!device) {
      this.reply(response, PUBLIC_REJECTION, 400)
      return
    }
    let payload: unknown
    try {
      payload = this.decrypt(device.key, frame)
    } catch {
      this.reply(response, PUBLIC_REJECTION, 400)
      return
    }
    const existing = device.cache.get(frame.sequence)
    if (existing) {
      if (existing.hash !== hash)
        this.reply(
          response,
          this.encrypt(
            device.key,
            frame,
            failure('REPLAY_REJECTED', 'This request cannot be replayed.'),
          ),
        )
      else this.reply(response, await existing.pending)
      return
    }
    if (frame.sequence <= device.maxSequence) {
      this.reply(
        response,
        this.encrypt(
          device.key,
          frame,
          failure('REPLAY_REJECTED', 'This request cannot be replayed.'),
        ),
      )
      return
    }
    while (device.cache.size >= CACHE_SIZE) {
      const oldest = [...device.cache].find(([, cached]) => cached.finished)
      if (!oldest) {
        this.reply(
          response,
          this.encrypt(device.key, frame, failure('REMOTE_BUSY', 'The remote connection is busy.')),
        )
        return
      }
      device.cache.delete(oldest[0])
    }
    device.maxSequence = frame.sequence
    const key = Buffer.from(device.key)
    const cached: Cached = { hash, pending: Promise.resolve({} as RemoteFrame), finished: false }
    const work = device.chain
      .then(async () => {
        if (!this.authorized(device, frame)) throw new Error('REVOKED_OR_STOPPED')
        const parsed = remoteRpcSchema.safeParse(payload)
        let result: RemoteResult
        if (
          !parsed.success ||
          (parsed.data.operation === 'command' && parsed.data.payload.action !== 'send_message')
        )
          result = failure('INVALID_PAYLOAD', 'The request is invalid.')
        else if (
          parsed.data.expiresAt <= this.now() ||
          parsed.data.expiresAt > this.now() + 120_000
        )
          result = failure(
            'REQUEST_EXPIRED',
            'The request has expired. Refresh the connection and try again.',
          )
        else result = await this.execute(device, frame, parsed.data)
        const unpaired = parsed.success && parsed.data.operation === 'unpair' && result.ok
        if (!unpaired && !this.authorized(device, frame)) throw new Error('REVOKED_OR_STOPPED')
        const encrypted = this.encrypt(key, frame, result)
        if (unpaired) {
          if (this.revokedReplies.size >= CACHE_SIZE)
            this.revokedReplies.delete(this.revokedReplies.keys().next().value!)
          this.revokedReplies.set(hash, {
            actorId: device.id,
            expires: this.now() + 60_000,
            frame: encrypted,
          })
        }
        return encrypted
      })
      .finally(() => {
        cached.finished = true
        key.fill(0)
      })
    cached.pending = work
    device.cache.set(frame.sequence, cached)
    device.chain = work.then(
      () => {},
      () => {},
    )
    this.reply(response, await work)
  }
  private authorized(device: Device, frame: RemoteFrame) {
    return (
      !!this.server &&
      !this.disposed &&
      !this.error &&
      this.epoch === frame.epoch &&
      this.devices.get(device.id) === device
    )
  }
  private pair(frame: RemoteFrame, hash: string): RemoteFrame {
    for (const [id, cached] of this.pairReplies)
      if (cached.expires <= this.now()) this.pairReplies.delete(id)
    const previous = this.pairReplies.get(frame.actorId)
    if (previous) {
      if (previous.hash === hash) return previous.frame
      throw new Error('PAIRING_CONSUMED')
    }
    const pairing = this.pairing
    if (
      !pairing ||
      pairing.id !== frame.actorId ||
      pairing.epoch !== frame.epoch ||
      pairing.expires <= this.now()
    )
      throw new Error('INVALID_PAIRING')
    if (pairing.usedHash) {
      if (pairing.usedHash === hash && pairing.response) return pairing.response
      throw new Error('PAIRING_CONSUMED')
    }
    const payload = this.decrypt(pairing.key, frame)
    const parsed = remotePairRequestSchema.safeParse(payload)
    pairing.usedHash = hash
    if (!parsed.success) {
      pairing.response = this.encrypt(
        pairing.key,
        frame,
        failure('INVALID_PAYLOAD', 'The pairing request is invalid.'),
      )
      this.cachePair(pairing, hash)
      return pairing.response
    }
    let result: RemoteResult
    if (this.devices.size >= MAX_DEVICES)
      result = failure('DEVICE_LIMIT', 'Remove a paired device before pairing another phone.')
    else {
      const key = randomBytes(32),
        id = randomUUID(),
        now = this.iso()
      try {
        const secret = key.toString('base64url')
        const encryptedSecret = this.options.encrypt(secret)
        if (
          typeof encryptedSecret !== 'string' ||
          !encryptedSecret ||
          encryptedSecret.length > 65_536
        )
          throw new Error('INVALID_CODEC')
        const device: Device = {
          id,
          name: parsed.data.deviceName,
          key,
          encryptedSecret,
          createdAt: now,
          lastSeenAt: now,
          maxSequence: 0,
          cache: new Map(),
          chain: Promise.resolve(),
        }
        this.devices.set(id, device)
        try {
          this.save()
        } catch (error) {
          this.devices.delete(id)
          throw error
        }
        pairing.deviceId = id
        result = {
          ok: true,
          value: { deviceId: id, secret, hostName: this.options.hostName ?? hostname() },
        }
        this.notify()
      } catch {
        key.fill(0)
        result = failure('REMOTE_STORAGE_UNAVAILABLE', 'The paired device could not be saved.')
      }
    }
    pairing.response = this.encrypt(pairing.key, frame, result)
    this.cachePair(pairing, hash)
    return pairing.response
  }
  private cachePair(pairing: Pairing, hash: string) {
    if (!pairing.response) return
    if (this.pairReplies.size >= CACHE_SIZE)
      this.pairReplies.delete(this.pairReplies.keys().next().value!)
    this.pairReplies.set(pairing.id, {
      hash,
      expires: pairing.expires,
      frame: pairing.response,
      deviceId: pairing.deviceId,
    })
  }
  private async execute(
    device: Device,
    frame: RemoteFrame,
    request: RemoteRpcRequest,
  ): Promise<RemoteResult> {
    if (!this.authorized(device, frame)) throw new Error('REVOKED_OR_STOPPED')
    device.lastSeenAt = this.iso()
    this.notify()
    try {
      switch (request.operation) {
        case 'reconnect':
          if (!this.options.reconnect)
            return failure(
              'VIOLOOP_UNAVAILABLE',
              'Connection recovery is not available on this host.',
            )
          await this.options.reconnect()
          return { ok: true, value: { reconnecting: true } }
        case 'violoop_message':
          if (!this.options.violoopMessage)
            return failure('VIOLOOP_UNAVAILABLE', 'Violoop is not available on this host.')
          return {
            ok: true,
            value: violoopTaskSchema.parse(
              await this.options.violoopMessage(request.payload, device.id),
            ),
          }
        case 'snapshot':
          return { ok: true, value: mobileSchema.parse(this.options.getSnapshot()) }
        case 'command':
          return {
            ok: true,
            value: commandSchema.parse(await this.options.command(request.payload)),
          }
        case 'stop':
          await this.options.stop()
          return { ok: true, value: { stopped: true } }
        case 'resume':
          await this.options.resume()
          return { ok: true, value: { stopped: false } }
        case 'unpair':
          this.revoke(device.id)
          return { ok: true, value: { revoked: true } }
      }
    } catch (error) {
      if (request.operation === 'violoop_message') {
        const code = error instanceof Error ? error.message : ''
        const allowed = [
          'VIOLOOP_CONFLICT',
          'VIOLOOP_BUSY',
          'VIOLOOP_JOURNAL_FULL',
          'VIOLOOP_REPLY_INVALID',
          'VIOLOOP_MESSAGE_TOO_LONG',
          'VIOLOOP_STORAGE_UNAVAILABLE',
          'CONTROL_STOPPED',
        ]
        return failure(
          allowed.includes(code) ? code : 'VIOLOOP_UNAVAILABLE',
          'Violoop could not accept this task. Refresh the computer status.',
        )
      }
      if (request.operation === 'stop')
        return failure(
          'STOP_UNCONFIRMED',
          'Stopping the source has not been confirmed. Check the desktop session.',
        )
      if (request.operation === 'snapshot')
        return failure('SNAPSHOT_UNAVAILABLE', 'Session progress is temporarily unavailable.')
      return failure(
        'REMOTE_ACTION_FAILED',
        'The requested action could not be confirmed. Check the desktop session before retrying.',
      )
    }
  }
  async stopServer(): Promise<void> {
    this.lifecycle++
    const server = this.server
    this.server = undefined
    this.url = undefined
    this.clearPairing()
    this.revokedReplies.clear()
    this.pairReplies.clear()
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    }
    this.notify()
  }
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stopServer()
    for (const device of this.devices.values()) {
      device.key.fill(0)
      device.cache.clear()
    }
    this.devices.clear()
  }
}
