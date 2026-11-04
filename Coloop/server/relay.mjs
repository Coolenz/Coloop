import { createServer } from 'node:http'
import { createHash, randomUUID, timingSafeEqual, scryptSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const paths = new Set(['/v1/remote/hello', '/v1/remote/pair', '/v1/remote/rpc'])
const release = '2026.10.31.1'
const rejection = {
  ok: false,
  error: { code: 'RELAY_UNAVAILABLE', message: 'Connection unavailable.' },
}
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k))

function validFrame(v, response = false) {
  return (
    exact(v, ['version', 'hostId', 'epoch', 'actorId', 'requestId', 'sequence', 'nonce', 'data']) &&
    v.version === 1 &&
    ['hostId', 'epoch', 'actorId', 'requestId'].every(
      (k) => typeof v[k] === 'string' && uuid.test(v[k]),
    ) &&
    Number.isSafeInteger(v.sequence) &&
    v.sequence > 0 &&
    typeof v.nonce === 'string' &&
    /^[A-Za-z0-9_-]{16}$/.test(v.nonce) &&
    typeof v.data === 'string' &&
    v.data.length >= 22 &&
    v.data.length <= (response ? 350000 : 90000) &&
    /^[A-Za-z0-9_-]+$/.test(v.data)
  )
}
function validHello(v) {
  return (
    exact(v, ['version', 'hostId', 'epoch', 'serverTime']) &&
    v.version === 1 &&
    uuid.test(v.hostId) &&
    uuid.test(v.epoch) &&
    Number.isSafeInteger(v.serverTime) &&
    v.serverTime > 0
  )
}
async function body(req, limit) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') ||
    req.headers['content-encoding'] ||
    Number(req.headers['content-length'] || 0) > limit
  )
    throw Error('INVALID_BODY')
  let size = 0
  const chunks = []
  const timer = setTimeout(() => req.destroy(), 5000)
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length
      if (size > limit) {
        req.resume()
        throw Error('INVALID_BODY')
      }
      chunks.push(chunk)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } finally {
    clearTimeout(timer)
  }
}
function send(res, status, value) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-coloop-relay-version': release,
  })
  res.end(JSON.stringify(value))
}

/** Application message broker only. No TCP, arbitrary URL, port or filesystem forwarding. */
export function createRelay({
  channels,
  accessKeySalt,
  accessKeyHash,
  timeoutMs = 35000,
  pollMs = 20000,
  onlineMs = 30000,
  trustProxy = false,
}) {
  if (!/^[a-f0-9]{32}$/.test(accessKeySalt || '') || !/^[a-f0-9]{64}$/.test(accessKeyHash || ''))
    throw Error('ACCESS_KEY_REQUIRED')
  const accessDigest = Buffer.from(accessKeyHash, 'hex')
  if (!Array.isArray(channels) || !channels.length || channels.length > 32)
    throw Error('INVALID_CHANNELS')
  const hosts = new Map()
  for (const entry of channels) {
    if (
      !exact(entry, ['channelId', 'tokenHash']) ||
      !uuid.test(entry.channelId) ||
      !/^[a-f0-9]{64}$/.test(entry.tokenHash) ||
      hosts.has(entry.channelId)
    )
      throw Error('INVALID_CHANNEL')
    hosts.set(entry.channelId, {
      tokenHash: Buffer.from(entry.tokenHash, 'hex'),
      generation: '',
      hello: undefined,
      connectedAt: 0,
      lastSeen: 0,
      pending: new Map(),
      poll: undefined,
      leaseTimer: undefined,
    })
  }
  let pendingCount = 0
  let closing = false
  const rates = new Map()
  const clean = setInterval(() => {
    const now = Date.now()
    for (const [key, value] of rates) if (now - value.start > 60000) rates.delete(key)
  }, 30000)
  clean.unref()
  function permitted(req) {
    const key = trustProxy
      ? req.headers['x-real-ip'] || req.socket.remoteAddress
      : req.socket.remoteAddress
    const now = Date.now()
    let rate = rates.get(key)
    if (!rate || now - rate.start > 60000) {
      if (rates.size >= 4096 && !rate) return false
      rate = { start: now, count: 0 }
      rates.set(key, rate)
    }
    return ++rate.count <= 360
  }
  function settle(host, job, status, result) {
    if (!host.pending.delete(job.id)) return
    pendingCount--
    clearTimeout(job.timer)
    send(job.response, status, result)
  }
  function disconnect(host) {
    clearTimeout(host.leaseTimer)
    for (const job of [...host.pending.values()]) settle(host, job, 503, rejection)
    if (host.poll) {
      clearTimeout(host.poll.timer)
      send(host.poll.res, 409, rejection)
      host.poll = undefined
    }
  }
  function expire(host) {
    disconnect(host)
    host.hello = undefined
    host.generation = ''
    host.lastSeen = 0
  }
  function online(host) {
    if (!host?.hello) return false
    if (Date.now() - host.lastSeen >= onlineMs) {
      expire(host)
      return false
    }
    return true
  }
  function touch(host) {
    host.lastSeen = Date.now()
    clearTimeout(host.leaseTimer)
    touchDeadline(host)
  }
  function touchDeadline(host) {
    host.leaseTimer = setTimeout(
      () => {
        if (online(host)) touchDeadline(host)
      },
      Math.max(1, onlineMs - (Date.now() - host.lastSeen)),
    )
    host.leaseTimer.unref()
  }
  function deliver(host) {
    if (!host.poll) return
    const jobs = [...host.pending.values()].filter((job) => !job.delivered).slice(0, 8)
    if (!jobs.length) return
    const waiting = host.poll
    host.poll = undefined
    clearTimeout(waiting.timer)
    for (const job of jobs) job.delivered = true
    send(waiting.res, 200, { jobs: jobs.map(({ id, path, frame }) => ({ id, path, frame })) })
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => send(res, 400, rejection))
  })
  server.headersTimeout = 10000
  server.requestTimeout = 10000
  server.keepAliveTimeout = 5000
  server.maxConnections = 256
  server.on('clientError', (_error, socket) => socket.destroy())
  async function handle(req, res) {
    if (closing) return send(res, 503, rejection)
    if (req.headers.origin || req.headers['sec-fetch-site'] || req.url?.includes('?'))
      return send(res, 400, rejection)
    if (!permitted(req)) return send(res, 429, rejection)
    const hostRoute = /^\/v1\/hosts\/([^/]+)\/(connect|poll|reply|disconnect|status)$/.exec(
      req.url || '',
    )
    if (hostRoute) {
      const host = hosts.get(hostRoute[1])
      const auth = req.headers.authorization || ''
      if (!host || !/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) return send(res, 401, rejection)
      const digest = createHash('sha256').update(auth.slice(7)).digest()
      if (!timingSafeEqual(digest, host.tokenHash)) return send(res, 401, rejection)
      const action = hostRoute[2]
      if (action === 'status' && req.method === 'GET') {
        const connected = online(host)
        return send(res, 200, {
          service: 'coloop',
          version: 1,
          release,
          online: connected,
          pendingRequests: host.pending.size,
          deliveredRequests: [...host.pending.values()].filter((job) => job.delivered).length,
          polling: !!host.poll,
          leaseRemainingMs: connected ? Math.max(0, onlineMs - (Date.now() - host.lastSeen)) : 0,
        })
      }
      if (req.method !== 'POST' || action === 'status') return send(res, 405, rejection)
      const value = await body(req, 409600)
      if (closing) return send(res, 503, rejection)
      if (action === 'connect') {
        if (!exact(value, ['hello']) || !validHello(value.hello)) return send(res, 400, rejection)
        disconnect(host)
        host.generation = randomUUID()
        host.hello = value.hello
        host.connectedAt = Date.now()
        touch(host)
        return send(res, 200, { generation: host.generation })
      }
      if (!online(host) || !value || value.generation !== host.generation || !host.generation)
        return send(res, 409, rejection)
      if (action === 'disconnect') {
        if (!exact(value, ['generation'])) return send(res, 400, rejection)
        expire(host)
        return send(res, 200, { disconnected: true })
      }
      if (action === 'poll') {
        if (!exact(value, ['generation']) || host.poll) return send(res, 409, rejection)
        touch(host)
        const waiting = {
          res,
          timer: setTimeout(() => {
            if (host.poll === waiting) host.poll = undefined
            send(res, 200, { jobs: [] })
          }, pollMs),
        }
        host.poll = waiting
        res.once('close', () => {
          clearTimeout(waiting.timer)
          if (host.poll === waiting) host.poll = undefined
        })
        deliver(host)
        return
      }
      if (!exact(value, ['generation', 'id', 'status', 'body']) || !uuid.test(value.id))
        return send(res, 400, rejection)
      const job = host.pending.get(value.id)
      if (!job || !job.delivered) return send(res, 410, rejection)
      if (value.status === 200) {
        const answer = value.body,
          original = job.frame
        if (
          !validFrame(answer, true) ||
          ['hostId', 'epoch', 'actorId', 'requestId', 'sequence'].some(
            (k) => answer[k] !== original[k],
          )
        )
          return send(res, 400, rejection)
        settle(host, job, 200, answer)
      } else if (value.status === 400) settle(host, job, 400, rejection)
      else return send(res, 400, rejection)
      touch(host)
      return send(res, 200, { accepted: true })
    }
    const accessKey = req.headers['x-coloop-access-key']
    if (
      typeof accessKey !== 'string' ||
      accessKey.length < 6 ||
      accessKey.length > 128 ||
      !timingSafeEqual(scryptSync(accessKey, accessKeySalt, 32), accessDigest)
    )
      return send(res, 401, rejection)
    if (req.method === 'GET' && req.url === '/healthz')
      return send(res, 200, { service: 'coloop', version: 1 })
    const phoneRoute = /^\/h\/([^/]+)(\/v1\/remote\/(?:hello|pair|rpc))$/.exec(req.url || '')
    if (!phoneRoute) return send(res, 404, rejection)
    const host = hosts.get(phoneRoute[1]),
      path = phoneRoute[2]
    if (!online(host)) return send(res, 503, rejection)
    if (path === '/v1/remote/hello' && req.method === 'GET')
      return send(res, 200, {
        ...host.hello,
        serverTime: host.hello.serverTime + Date.now() - host.connectedAt,
      })
    if (req.method !== 'POST' || !paths.has(path) || path === '/v1/remote/hello')
      return send(res, 400, rejection)
    const generation = host.generation
    const frame = await body(req, 65536)
    // Uploading a body yields: disconnect, reconnect or shutdown may happen meanwhile.
    if (closing || !online(host) || generation !== host.generation) return send(res, 503, rejection)
    if (
      !validFrame(frame) ||
      frame.hostId !== host.hello.hostId ||
      frame.epoch !== host.hello.epoch
    )
      return send(res, 400, rejection)
    if (
      [...host.pending.values()].some(
        (job) => job.frame.actorId === frame.actorId && job.frame.requestId === frame.requestId,
      )
    )
      return send(res, 409, rejection)
    if (host.pending.size >= 16 || pendingCount >= 128) return send(res, 429, rejection)
    const job = { id: randomUUID(), path, frame, response: res, delivered: false }
    job.timer = setTimeout(() => settle(host, job, 504, rejection), timeoutMs)
    host.pending.set(job.id, job)
    pendingCount++
    res.once('close', () => {
      if (host.pending.delete(job.id)) {
        pendingCount--
        clearTimeout(job.timer)
      }
    })
    deliver(host)
  }
  return {
    server,
    async close() {
      closing = true
      clearInterval(clean)
      for (const host of hosts.values()) expire(host)
      const closed = new Promise((resolve) => server.close(resolve))
      server.closeAllConnections()
      await closed
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(
    readFileSync(process.env.COLOOP_RELAY_CONFIG || '/etc/coloop/relay.json', 'utf8'),
  )
  const relay = createRelay({
    channels: config.channels,
    accessKeyHash: config.accessKeyHash,
    accessKeySalt: config.accessKeySalt,
    trustProxy: true,
  })
  relay.server.listen(8787, '127.0.0.1', () =>
    console.log('Coloop application broker listening on loopback.'),
  )
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => void relay.close().then(() => process.exit(0)))
}
