import { _electron as electron } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

// Owned live QA host for the actual Android emulator. No paid model or user
// session is used; the source is an explicit structured-protocol fixture.
const root = resolve(import.meta.dirname, '..')
const output = resolve(process.env.COLOOP_ANDROID_QA_DIR || resolve(root, '.qa/android-live'))
await mkdir(output, { recursive: true })
const app = await electron.launch({
  executablePath: process.env.COLOOP_EXECUTABLE || undefined,
  args: process.env.COLOOP_EXECUTABLE ? [] : [root],
  cwd: root,
  env: {
    ...process.env,
    COLOOP_DATA_DIR: process.env.COLOOP_ANDROID_PROFILE || resolve(output, `profile-${Date.now()}`),
    ELECTRON_RENDERER_URL: '',
  },
})
const page = await app.firstWindow()
await page.waitForSelector('.workspace-content')
const snapshot = async () => (await page.evaluate(() => window.coloop.snapshot())).value
const connection = JSON.parse(await readFile((await snapshot()).coordinator.connectionPath, 'utf8'))
const identity = {
  version: 1,
  source: 'opencode',
  sourceId: randomUUID(),
  instanceId: randomUUID(),
  sessionId: randomUUID(),
}
const owner = {
  version: 1,
  source: identity.source,
  sourceId: identity.sourceId,
  instanceId: identity.instanceId,
}
let sequence = 0,
  activeTask,
  ticking = false,
  closing = false
const timers = new Set(),
  deliveries = []
async function post(path, body) {
  const response = await fetch(connection.url + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const value = await response.json()
  assert.equal(response.status, 200, JSON.stringify(value))
  return value
}
async function hook(taskId, kind, payload) {
  await post('/v1/hooks', {
    ...identity,
    taskId,
    sequence: ++sequence,
    eventId: randomUUID(),
    kind,
    workspace: root,
    payload,
  })
}
await post('/v1/control/register', {
  ...identity,
  workspace: root,
  title: '安卓公网验收会话',
  host: 'windows',
  capabilities: ['send_message', 'abort_turn'],
  state: 'idle',
})
await hook('initial-task', 'message', {
  role: 'assistant',
  messageId: 'qa-initial',
  partId: 'qa-part',
  text: '已连接电脑，等待安卓端发送要求。此会话为验收数据。',
})
if (process.env.COLOOP_SERVER_CONFIG) {
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, process.env.COLOOP_SERVER_CONFIG)
  assert.equal((await page.evaluate(() => window.coloop.importMobileServer())).ok, true)
}
const enabled = await page.evaluate(() => window.coloop.enableMobile())
assert.equal(enabled.ok, true, enabled.error)
await page.getByRole('button', { name: 'Agent 协调', exact: true }).first().click()
async function pairing() {
  const response = await page.evaluate(() => window.coloop.createMobilePairing())
  assert.equal(response.ok, true, response.error)
  await writeFile(resolve(output, 'pairing.txt'), response.value.uri, { mode: 0o600 })
  await writeFile(
    resolve(output, 'connection-info.json'),
    JSON.stringify(
      { endpoint: response.value.endpoint, expiresAt: response.value.expiresAt },
      null,
      2,
    ),
  )
}
async function save() {
  const state = await snapshot()
  await writeFile(
    resolve(output, 'state.json'),
    JSON.stringify(
      {
        mobile: state.mobile,
        sessionControl: state.sessionControl,
        deliveries,
        scope:
          'Actual Android + public HTTPS encrypted gateway; explicit source fixture, no real model.',
      },
      null,
      2,
    ),
  )
}
await pairing()
console.log('ANDROID_LIVE_READY: .qa/android-live/pairing.txt (short-lived private QA invitation)')
const interval = setInterval(async () => {
  if (ticking || closing) return
  ticking = true
  try {
    const requested = await readFile(resolve(output, 'request.txt'), 'utf8').catch(() => '')
    if (requested.trim()) {
      await writeFile(resolve(output, 'request.txt'), '')
      if (requested.trim() === 'pair') await pairing()
      if (requested.trim() === 'stop') {
        closing = true
        return
      }
    }
    const commands = (await post('/v1/control/poll', owner)).commands
    for (const command of commands) {
      deliveries.push({
        commandId: command.commandId,
        action: command.action,
        at: new Date().toISOString(),
        textSha256: command.text
          ? createHash('sha256').update(command.text).digest('hex')
          : undefined,
      })
      if (command.action === 'send_message') {
        activeTask = command.messageId
        await hook(activeTask, 'message', {
          role: 'user',
          messageId: activeTask,
          partId: randomUUID(),
          text: command.text,
        })
        await hook(activeTask, 'status', { state: 'busy' })
        await hook(activeTask, 'message', {
          role: 'assistant',
          messageId: randomUUID(),
          partId: randomUUID(),
          text: '已收到手机要求，正在通过公网加密链路验证会话控制。',
        })
        const task = activeTask
        const timer = setTimeout(
          async () => {
            timers.delete(timer)
            if (closing || activeTask !== task) return
            await hook(task, 'message', {
              role: 'assistant',
              messageId: randomUUID(),
              partId: randomUUID(),
              text: '安卓端要求已完成，回执和会话状态已同步。此为合成验收结果。',
            }).catch(() => {})
            await hook(task, 'status', { state: 'idle' }).catch(() => {})
            activeTask = undefined
          },
          command.text?.includes('ANDROID_STOP') ? 60_000 : 5000,
        )
        timers.add(timer)
      } else {
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
        if (activeTask) await hook(activeTask, 'status', { state: 'idle' })
        activeTask = undefined
        await post('/v1/control/report', {
          ...identity,
          commandId: command.commandId,
          status: 'confirmed',
        })
      }
    }
    await save()
  } catch (error) {
    await writeFile(resolve(output, 'fixture-error.txt'), error.message)
  } finally {
    ticking = false
    if (closing) {
      clearInterval(interval)
      for (const timer of timers) clearTimeout(timer)
      await save().catch(() => {})
      await app.close()
      console.log('ANDROID_LIVE_STOPPED')
    }
  }
}, 500)
process.on('SIGINT', () => {
  closing = true
})
