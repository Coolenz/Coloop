import { _electron as electron } from '@playwright/test'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', `mobile-${Date.now()}`)
await mkdir(output, { recursive: true })
const checks = []
const ownedServer = process.env.COLOOP_SERVER_CONFIG
  ? JSON.parse(await readFile(process.env.COLOOP_SERVER_CONFIG, 'utf8')) : undefined
let app, page, connection, failure
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
function request(url, body, accessKey = ownedServer?.accessKey) {
  return new Promise((resolveRequest, reject) => {
    const native = url.startsWith('https:') ? httpsRequest : httpRequest
    const req = native(
      url,
      {
        method: body ? 'POST' : 'GET',
        headers: { ...(body ? { 'content-type': 'application/json' } : {}),
          ...(accessKey ? { 'x-coloop-access-key': accessKey } : {}) },
        timeout: 20_000,
      },
      (response) => {
        let raw = ''
        response.on('data', (chunk) => {
          raw += chunk
          if (raw.length > 1_000_000) req.destroy(new Error('Response limit'))
        })
        response.on('end', () => {
          try {
            resolveRequest({ status: response.statusCode, body: JSON.parse(raw) })
          } catch {
            reject(new Error(`Non-JSON remote response (${response.statusCode})`))
          }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('Remote request timeout')))
    req.end(body ? JSON.stringify(body) : undefined)
  })
}
async function until(read, label, timeout = 20_000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      const value = await read()
      if (value) return value
    } catch (error) {
      last = error
    }
    await wait(100)
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`)
}
function aad(direction, frame) {
  return Buffer.from(
    `coloop.remote.v1|${direction}|${frame.hostId}|${frame.epoch}|${frame.actorId}|${frame.requestId}|${frame.sequence}`,
  )
}
function encrypt(key, identity, payload) {
  const frame = { version: 1, ...identity, nonce: randomBytes(12).toString('base64url') }
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'base64url'),
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
function decrypt(key, frame) {
  const data = Buffer.from(frame.data, 'base64url')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'base64url'),
    Buffer.from(frame.nonce, 'base64url'),
  )
  decipher.setAAD(aad('response', frame))
  decipher.setAuthTag(data.subarray(-16))
  return JSON.parse(
    Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString(),
  )
}
const snapshot = async () => (await page.evaluate(() => window.coloop.snapshot())).value
const source = {
  version: 1,
  source: 'opencode',
  sourceId: randomUUID(),
  instanceId: randomUUID(),
  sessionId: randomUUID(),
}
let sequence = 0
async function sourcePost(path, payload) {
  // This private native-source channel is separate from the public encrypted gateway.
  const response = await fetch(connection.url + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  return body
}
async function hook(taskId, kind, payload) {
  return sourcePost('/v1/hooks', {
    ...source,
    taskId,
    sequence: ++sequence,
    eventId: randomUUID(),
    workspace: root,
    kind,
    payload,
  })
}
try {
  app = await electron.launch({
    executablePath: process.env.COLOOP_EXECUTABLE || undefined,
    args: process.env.COLOOP_EXECUTABLE ? [] : [root],
    cwd: root,
    env: { ...process.env, COLOOP_DATA_DIR: resolve(output, 'profile'), ELECTRON_RENDERER_URL: '' },
  })
  page = await app.firstWindow()
  await page.waitForSelector('.workspace-content')
  connection = JSON.parse(await readFile((await snapshot()).coordinator.connectionPath, 'utf8'))
  assert.equal((await snapshot()).mobile.tunnel.status, 'stopped')
  if (ownedServer) {
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, process.env.COLOOP_SERVER_CONFIG)
    assert.equal((await page.evaluate(() => window.coloop.importMobileServer())).ok, true)
  }
  const enabled = page.evaluate(() => window.coloop.enableMobile())
  await until(
    async () => (await snapshot()).mobile.tunnel.status === 'starting',
    'public tunnel starting',
  )
  const result = await enabled
  assert.equal(result.ok, true, result.error)
  const endpoint = result.value.tunnel.endpoint
  if (ownedServer) {
    assert.equal(endpoint, ownedServer.endpoint)
    assert.equal((await request(endpoint + '/v1/remote/hello', undefined, '')).status, 401)
    assert.equal((await request(endpoint + '/v1/remote/hello', undefined, 'incorrect-key')).status, 401)
  } else assert.match(endpoint, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/)
  const hello = await until(async () => {
    const response = await request(endpoint + '/v1/remote/hello')
    return response.status === 200 && response.body.epoch ? response.body : false
  }, 'public HTTPS gateway hello')
  checks.push({
    check:
      ownedServer ? 'Real owned server HTTPS requires the access key before discovery' : 'Real Cloudflare Quick Tunnel provides an external HTTPS path to the dedicated remote gateway',
    passed: true,
  })
  const invitation = await page.evaluate(() => window.coloop.createMobilePairing())
  assert.equal(invitation.ok, true, invitation.error)
  const pairing = JSON.parse(
    Buffer.from(new URL(invitation.value.uri).searchParams.get('data'), 'base64url').toString(),
  )
  const frame = encrypt(
    pairing.secret,
    {
      hostId: hello.hostId,
      epoch: hello.epoch,
      actorId: pairing.pairingId,
      requestId: randomUUID(),
      sequence: 1,
    },
    { deviceName: 'QA encrypted Android protocol' },
  )
  const pairedWire = await request(endpoint + '/v1/remote/pair', frame)
  assert.equal(pairedWire.status, 200)
  const paired = decrypt(pairing.secret, pairedWire.body)
  assert.equal(paired.ok, true)
  const device = paired.value
  assert.equal(JSON.stringify(await snapshot()).includes(pairing.secret), false)
  assert.equal(JSON.stringify(await snapshot()).includes(device.secret), false)
  if (ownedServer) assert.equal(JSON.stringify(await snapshot()).includes(ownedServer.accessKey), false)
  let counter = 0
  async function rpc(operation, payload = {}) {
    const requestFrame = encrypt(
      device.secret,
      {
        hostId: hello.hostId,
        epoch: hello.epoch,
        actorId: device.deviceId,
        requestId: randomUUID(),
        sequence: ++counter,
      },
      { operation, payload, expiresAt: hello.serverTime + (Date.now() - localHelloAt) + 60_000 },
    )
    const response = await request(endpoint + '/v1/remote/rpc', requestFrame)
    assert.equal(response.status, 200)
    return {
      frame: requestFrame,
      wire: response.body,
      result: decrypt(device.secret, response.body),
    }
  }
  const localHelloAt = Date.now()
  checks.push({
    check:
      'Public pairing uses out-of-band QR secret; paired device keys stay out of ordinary desktop snapshots',
    passed: true,
  })
  const registered = await sourcePost('/v1/control/register', {
    ...source,
    workspace: root,
    title: 'Mobile QA source',
    host: 'windows',
    capabilities: ['send_message', 'abort_turn'],
    state: 'idle',
  })
  const phoneSnapshot = await rpc('snapshot')
  assert.equal(phoneSnapshot.result.ok, true)
  assert.equal(
    phoneSnapshot.result.value.sessionControl.sessions[0].handle,
    registered.sessionHandle,
  )
  assert.equal(phoneSnapshot.result.value.settings, undefined)
  const commandId = randomUUID(),
    text = `MOBILE_PUBLIC_${randomUUID()}`
  const sent = await rpc('command', {
    commandId,
    sessionHandle: registered.sessionHandle,
    action: 'send_message',
    text,
  })
  assert.equal(sent.result.ok, true)
  const pollInput = {
    version: 1,
    source: source.source,
    sourceId: source.sourceId,
    instanceId: source.instanceId,
  }
  const dispatched = (await sourcePost('/v1/control/poll', pollInput)).commands
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].text, text)
  const overlay = await until(
    async () => app.windows().find((window) => window.url().includes('surface=control')),
    'visible control notice',
  )
  assert.equal(
    (await overlay.evaluate(() => window.coloopControl.snapshot())).value.mode,
    'controlling',
  )
  await hook(dispatched[0].messageId, 'message', {
    role: 'user',
    messageId: dispatched[0].messageId,
    partId: randomUUID(),
    text,
  })
  await hook(dispatched[0].messageId, 'status', { state: 'busy' })
  await hook(dispatched[0].messageId, 'message', {
    role: 'assistant',
    messageId: 'qa-assistant',
    partId: randomUUID(),
    text: 'Public encrypted session progress fixture.',
  })
  const progress = await rpc('snapshot')
  assert.equal(
    progress.result.value.progress[0].text.includes('Public encrypted session progress'),
    true,
  )
  const duplicate = await request(endpoint + '/v1/remote/rpc', sent.frame)
  assert.deepEqual(duplicate.body, sent.wire)
  assert.equal((await sourcePost('/v1/control/poll', pollInput)).commands.length, 0)
  checks.push({
    check:
      'Encrypted public command reaches only the selected source once, displays the system notice, and returns sanitized progress',
    passed: true,
  })
  const stopping = rpc('stop')
  const abort = await until(
    async () =>
      (await sourcePost('/v1/control/poll', pollInput)).commands.find(
        (item) => item.action === 'abort_turn',
      ),
    'native source abort',
  )
  await sourcePost('/v1/control/report', {
    ...source,
    commandId: abort.commandId,
    status: 'confirmed',
  })
  assert.equal((await stopping).result.ok, true)
  assert.equal((await rpc('snapshot')).result.value.sessionControl.stopped, true)
  checks.push({
    check: 'Encrypted remote stop waits for original source confirmation and latches future writes',
    passed: true,
  })
  const revoked = await page.evaluate((id) => window.coloop.revokeMobileDevice(id), device.deviceId)
  assert.equal(revoked.ok, true)
  const revokedFrame = encrypt(
    device.secret,
    {
      hostId: hello.hostId,
      epoch: hello.epoch,
      actorId: device.deviceId,
      requestId: randomUUID(),
      sequence: ++counter,
    },
    { operation: 'snapshot', payload: {}, expiresAt: Date.now() + 60_000 },
  )
  assert.notEqual((await request(endpoint + '/v1/remote/rpc', revokedFrame)).status, 200)
  await page.getByRole('button', { name: 'Agent 协调', exact: true }).first().click()
  await page.screenshot({ path: resolve(output, 'mobile-desktop.png'), fullPage: true })
  checks.push({
    check: 'Desktop device revocation immediately rejects that phone through the public tunnel',
    passed: true,
  })
  if (!ownedServer) {
    const interrupted = await app.evaluate(() => {
    const child = process
      ._getActiveHandles()
      .find(
        (handle) =>
          typeof handle.spawnfile === 'string' && /cloudflared\.exe$/i.test(handle.spawnfile),
      )
    if (!child) return false
    child.kill()
    return true
  })
  assert.equal(interrupted, true)
  await until(
    async () => (await snapshot()).mobile.tunnel.status === 'error',
    'interrupted tunnel status',
  )
  assert.equal((await snapshot()).mobile.gateway.status, 'listening')
  const reconnected = await page.evaluate(() => window.coloop.enableMobile())
  assert.equal(reconnected.ok, true, reconnected.error)
  assert.equal(reconnected.value.gateway.hostId, hello.hostId)
    checks.push({
    check:
      'A crashed tunnel can reconnect while preserving the existing authenticated gateway and host identity',
    passed: true,
  })
  }
  const disabled = await page.evaluate(() => window.coloop.disableMobile())
  assert.equal(disabled.ok, true)
  assert.equal((await snapshot()).mobile.tunnel.status, 'stopped')
  const cancelled = await page.evaluate(async () => {
    const pending = window.coloop.enableMobile()
    await window.coloop.disableMobile()
    return { pending: await pending, state: (await window.coloop.snapshot()).value.mobile }
  })
  assert.equal(cancelled.state.tunnel.status, 'stopped')
  assert.equal(cancelled.state.gateway.status, 'stopped')
  checks.push({
    check: 'Disabling a pending connection cannot be overtaken by asynchronous startup',
    passed: true,
  })
} catch (error) {
  failure = error
} finally {
  await app?.close().catch(() => {})
  await writeFile(
    resolve(output, 'results.json'),
    JSON.stringify(
      {
        passed: !failure,
        checks,
        error: failure?.message,
        scope:
          ownedServer ? 'Real Electron + owned server authenticated HTTPS; controlled native source fixture, no real model' : 'Real Electron + actual public encrypted HTTPS tunnel; controlled native source fixture, no real model',
        output,
      },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify({ passed: !failure, checks: checks.length, error: failure?.message, output }),
  )
}
if (failure) throw failure
