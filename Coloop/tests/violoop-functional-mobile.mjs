// A simulated handset connected to the real production gateway, never an IPC fixture.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'

function nativeRequest(url, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : {},
        timeout: 20000,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            })
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error('Mobile request timed out')))
    request.end(body ? JSON.stringify(body) : undefined)
  })
}

const aad = (direction, frame) =>
  Buffer.from(
    `coloop.remote.v1|${direction}|${frame.hostId}|${frame.epoch}|${frame.actorId}|${frame.requestId}|${frame.sequence}`,
  )

function seal(secret, identity, payload) {
  const frame = { version: 1, ...identity, nonce: randomBytes(12).toString('base64url') }
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(secret, 'base64url'),
    Buffer.from(frame.nonce, 'base64url'),
  )
  cipher.setAAD(aad('request', frame))
  frame.data = Buffer.concat([
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64url')
  return frame
}

function open(secret, frame) {
  const data = Buffer.from(frame.data, 'base64url')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(secret, 'base64url'),
    Buffer.from(frame.nonce, 'base64url'),
  )
  decipher.setAAD(aad('response', frame))
  decipher.setAuthTag(data.subarray(-16))
  return JSON.parse(
    Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8'),
  )
}

export async function connectSimulatedPhone(
  page,
  deviceName = 'Violoop acceptance simulated phone',
) {
  const state = (await page.evaluate(() => window.coloop.snapshot())).value
  let endpoint = state.mobile?.gateway?.url
  if (!endpoint) throw new Error('Production mobile gateway is not listening')
  const helloResponse = await nativeRequest(endpoint + '/v1/remote/hello')
  if (helloResponse.status !== 200 || !helloResponse.body.epoch)
    throw new Error('Mobile discovery rejected')
  const hello = helloResponse.body
  const invitation = await page.evaluate(() => window.coloop.createMobilePairing())
  if (!invitation.ok) throw new Error(invitation.error)
  const pairing = JSON.parse(
    Buffer.from(new URL(invitation.value.uri).searchParams.get('data'), 'base64url').toString(),
  )
  const identity = { hostId: hello.hostId, epoch: hello.epoch }
  async function post(path, frame) {
    const response = await nativeRequest(endpoint + '/v1/remote/' + path, frame)
    const wire = response.body
    if (response.status !== 200) throw new Error(`Mobile ${path} HTTP ${response.status}`)
    return wire
  }
  const pairFrame = seal(
    pairing.secret,
    {
      ...identity,
      actorId: pairing.pairingId,
      requestId: randomUUID(),
      sequence: 1,
    },
    { deviceName },
  )
  const paired = open(pairing.secret, await post('pair', pairFrame))
  if (!paired.ok) throw new Error('Mobile pairing rejected')
  const device = paired.value
  let sequence = 0
  async function rpc(operation, payload = {}) {
    const frame = seal(
      device.secret,
      {
        ...identity,
        actorId: device.deviceId,
        requestId: randomUUID(),
        sequence: ++sequence,
      },
      { operation, payload, expiresAt: Date.now() + 60000 },
    )
    const wire = await post('rpc', frame)
    return { result: open(device.secret, wire), frame, wire }
  }
  return {
    transport: 'real production loopback encrypted gateway',
    identity: { hostId: identity.hostId, deviceId: device.deviceId },
    rpc,
    replay: (frame) => post('rpc', frame),
    reconnect: async (currentPage) => {
      const current = (await currentPage.evaluate(() => window.coloop.snapshot())).value
      const nextEndpoint = current.mobile?.gateway?.url
      if (!nextEndpoint) throw new Error('Production mobile gateway is not listening')
      const response = await nativeRequest(nextEndpoint + '/v1/remote/hello')
      if (
        response.status !== 200 ||
        response.body.hostId !== identity.hostId ||
        !response.body.epoch
      )
        throw new Error('Mobile reconnect host identity mismatch')
      const changed = identity.epoch !== response.body.epoch
      endpoint = nextEndpoint
      identity.epoch = response.body.epoch
      if (changed) sequence = 0
      return { hostId: identity.hostId, deviceId: device.deviceId, epochChanged: changed }
    },
    close: () => rpc('unpair'),
  }
}
