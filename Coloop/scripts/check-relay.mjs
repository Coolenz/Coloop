import { readFile } from 'node:fs/promises'
import { request } from 'node:https'

const file = process.argv[2]
if (!file)
  throw Error('Usage: node scripts/check-relay.mjs <private-server.json> [--require-online]')
const config = JSON.parse(await readFile(file, 'utf8'))
const endpoint = new URL(config.endpoint)
if (
  endpoint.protocol !== 'https:' ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash ||
  !/^\/h\/[a-f0-9-]{36}$/i.test(endpoint.pathname)
)
  throw Error('Invalid server endpoint')
const channelId = endpoint.pathname.slice(3)
function get(path, headers) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, endpoint), { headers }, (res) => {
      const authorized = res.socket.authorized
      const expiresAt = res.socket.getPeerCertificate().valid_to
      let raw = ''
      res.on('data', (part) => {
        raw += part
        if (raw.length > 32768) res.destroy(Error('Response too large'))
      })
      res.on('error', reject)
      res.on('end', () => {
        clearTimeout(timer)
        try {
          resolve({
            status: res.statusCode,
            authorized,
            expiresAt,
            release: res.headers['x-coloop-relay-version'],
            body: JSON.parse(raw),
          })
        } catch {
          reject(Error('Invalid service response'))
        }
      })
    })
    const timer = setTimeout(() => req.destroy(Error('Server timeout')), 12000)
    req.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    req.end()
  })
}
try {
  const [health, host] = await Promise.all([
    get('/healthz', { 'x-coloop-access-key': config.accessKey }),
    get(`/v1/hosts/${channelId}/status`, {
      authorization: `Bearer ${config.token}`,
      'x-coloop-access-key': config.accessKey,
    }),
  ])
  const healthy = health.status === 200 && health.authorized && health.body.service === 'coloop'
  const statusAvailable =
    host.status === 200 && host.authorized && typeof host.body.online === 'boolean'
  // Only the fixed status projection is printed, never config, headers or arbitrary response text.
  console.log(
    JSON.stringify(
      {
        server: endpoint.origin,
        healthy,
        release: health.release,
        certificateExpires: health.expiresAt,
        desktopStatusAvailable: statusAvailable,
        ...(statusAvailable
          ? {
              desktopOnline: host.body.online,
              pendingRequests: host.body.pendingRequests,
              deliveredRequests: host.body.deliveredRequests,
              polling: host.body.polling,
              leaseRemainingMs: host.body.leaseRemainingMs,
            }
          : { statusCode: host.status }),
      },
      null,
      2,
    ),
  )
  if (
    !healthy ||
    !statusAvailable ||
    (process.argv.includes('--require-online') && !host.body.online)
  )
    process.exitCode = 1
} catch {
  console.error(
    'Server check failed: connection, TLS validation or response unavailable. No credentials were printed.',
  )
  process.exitCode = 1
}
