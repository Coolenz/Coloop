import { _electron as electron } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', `control-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const profile = resolve(output, 'profile')
await mkdir(output, { recursive: true })
const checks = []
const pageErrors = []
let app
let page
let overlay
let connection
let mainId
let failure
const report = {
  startedAt: new Date().toISOString(),
  scope: 'Real Electron windows and authenticated HTTP source fixture; no real AI or RK execution.',
  checks,
}

async function until(read, predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`Timed out: ${label}; last value: ${JSON.stringify(value)}`)
}
function passed(check, details) {
  checks.push({ check, passed: true, ...(details ? { details } : {}) })
}
async function snapshot() {
  const result = await page.evaluate(() => window.coloop.snapshot())
  assert.equal(result.ok, true, result.error)
  return result.value
}
async function post(path, body, status = 200, authorization = connection.token) {
  const response = await fetch(connection.url + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${authorization}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const value = await response.json()
  assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`)
  return value
}
async function windows() {
  return app.evaluate(({ BrowserWindow, screen }) => ({
    focusedId: BrowserWindow.getFocusedWindow()?.id,
    primary: screen.getPrimaryDisplay().bounds,
    workArea: screen.getPrimaryDisplay().workArea,
    windows: BrowserWindow.getAllWindows().map((window) => ({
      id: window.id,
      webContentsId: window.webContents.id,
      parentId: window.getParentWindow()?.id ?? null,
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      focused: window.isFocused(),
      focusable: window.isFocusable(),
      top: window.isAlwaysOnTop(),
      bounds: window.getBounds(),
      url: window.webContents.getURL(),
    })),
  }))
}
async function indicatorVisible() {
  const state = await windows()
  return state.windows.find((window) => window.url.includes('surface=control'))?.visible ?? false
}
async function waitOverlay() {
  return until(
    async () => app.windows().find((item) => item.url().includes('surface=control')),
    Boolean,
    'control surface created',
  )
}
async function brandedIndicator(expectedDetail) {
  const surface = overlay.getByRole('main', { name: 'Coloop control status', exact: true })
  const visibleText = await surface.innerText()
  const title = await surface.locator('.control-title').innerText()
  const detail = await surface.locator('.control-detail').innerText()
  assert.equal(title, 'Coloop')
  assert.ok(
    [
      'Controlling your computer',
      'Stopping control…',
      'Waiting for stop confirmation',
      'Control status unconfirmed',
      'Preview · No actions running',
    ].includes(detail),
    `Unexpected indicator status or project label: ${detail}`,
  )
  if (expectedDetail) assert.equal(detail, expectedDetail)
  assert.doesNotMatch(visibleText, /OpenCode|[\u3400-\u4dbf\u4e00-\u9fff]/u)
  assert.ok(!visibleText.includes(root), 'The control notice must not display a workspace path')
  return { title, detail, visibleText }
}

try {
  app = await electron.launch({
    executablePath: process.env.COLOOP_EXECUTABLE || undefined,
    args: process.env.COLOOP_EXECUTABLE ? [] : [root],
    cwd: root,
    env: { ...process.env, COLOOP_DATA_DIR: profile, ELECTRON_RENDERER_URL: '' },
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForSelector('.workspace-content')
  mainId = (await windows()).windows[0].id
  let state = await snapshot()
  assert.equal(state.sessionControl.controlActive, false)
  assert.equal(state.sessionControl.sessions.length, 0)
  assert.equal((await windows()).windows.length, 1)
  assert.equal(await page.evaluate(() => typeof window.coloopControl), 'undefined')
  passed(
    'Startup has one main window, no fabricated control, and no indicator API in main renderer',
  )

  const connectionPath = state.coordinator.connectionPath
  assert.ok(connectionPath)
  connection = JSON.parse(await readFile(connectionPath, 'utf8'))
  const source = {
    version: 1,
    source: 'opencode',
    sourceId: `qa-source-${randomUUID()}`,
    instanceId: `qa-instance-${randomUUID()}`,
    sessionId: `qa-session-${randomUUID()}`,
  }
  const registration = {
    ...source,
    workspace: root,
    title: '验收用 Windows OpenCode 会话',
    host: 'windows',
    capabilities: ['send_message', 'abort_turn'],
    state: 'idle',
  }
  const pollInput = {
    version: 1,
    source: source.source,
    sourceId: source.sourceId,
    instanceId: source.instanceId,
  }

  await post('/v1/control/register', registration, 401, 'invalid-qa-token')
  passed('Control source HTTP rejects an invalid token')

  // Temporarily attach the real restricted preload to the main frame to issue a real IPC call.
  const probeId = await app.evaluate(
    ({ session }, filePath) =>
      session.defaultSession.registerPreloadScript({ type: 'frame', filePath }),
    resolve(root, 'out/preload/control.cjs'),
  )
  await page.reload()
  await page.waitForSelector('.workspace-content')
  const forbidden = await page.evaluate(() => window.coloopControl.snapshot())
  assert.equal(forbidden.ok, false)
  assert.match(forbidden.error, /调用来源无效/)
  await app.evaluate(
    ({ session }, id) => session.defaultSession.unregisterPreloadScript(id),
    probeId,
  )
  await page.reload()
  await page.waitForSelector('.workspace-content')
  assert.equal(await page.evaluate(() => typeof window.coloopControl), 'undefined')
  passed('A real indicator IPC from the main window is rejected by sender/frame/URL checks')

  const qaPreload = resolve(output, 'surface-probe.cjs')
  await writeFile(
    qaPreload,
    "const { contextBridge } = require('electron'); contextBridge.exposeInMainWorld('coloopQaSurface', { sandboxed: process.sandboxed, contextIsolated: process.contextIsolated });",
  )
  await app.evaluate(
    ({ session }, filePath) =>
      session
        .fromPartition('coloop-control-indicator')
        .registerPreloadScript({ type: 'frame', filePath }),
    qaPreload,
  )
  await app.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id)
    window.show()
    window.focus()
  }, mainId)
  await until(
    windows,
    (value) => value.focusedId === mainId,
    'main window focused before preview',
    5000,
  )
  const preview = await page.evaluate(() => window.coloop.previewControlIndicator())
  assert.equal(preview.ok, true, preview.error)
  overlay = await waitOverlay()
  overlay.on('pageerror', (error) => pageErrors.push(error.message))
  await overlay.getByText('Preview · No actions running', { exact: true }).waitFor()
  await brandedIndicator('Preview · No actions running')
  const native = await windows()
  const controlWindow = native.windows.find((item) => item.url.includes('surface=control'))
  assert.ok(controlWindow.visible)
  assert.ok(controlWindow.top)
  assert.equal(controlWindow.focused, false)
  assert.equal(controlWindow.focusable, false)
  assert.equal(native.focusedId, mainId)
  // Windows may round one DIP when restoring native bounds on a scaled display.
  assert.ok(
    Math.abs(controlWindow.bounds.width - Math.max(1, Math.min(373, native.primary.width - 16))) <=
      1,
  )
  assert.ok(controlWindow.bounds.height <= 76)
  assert.ok(
    Math.abs(
      controlWindow.bounds.x +
        controlWindow.bounds.width / 2 -
        (native.primary.x + native.primary.width / 2),
    ) <= 1,
  )
  assert.ok(Math.abs(controlWindow.bounds.y - (native.primary.y + 8)) <= 1)
  const isolated = await overlay.evaluate(() => ({
    probe: window.coloopQaSurface,
    desktopApi: typeof window.coloop,
    nodeRequire: typeof window.require,
    nodeProcess: typeof window.process,
    controlApi: Object.keys(window.coloopControl).sort(),
  }))
  assert.equal(isolated.probe.sandboxed, true)
  assert.equal(isolated.probe.contextIsolated, true)
  assert.equal(isolated.desktopApi, 'undefined')
  assert.equal(isolated.nodeRequire, 'undefined')
  assert.equal(isolated.nodeProcess, 'undefined')
  assert.deepEqual(isolated.controlApi, [
    'closePreview',
    'onSnapshot',
    'openMain',
    'snapshot',
    'stop',
  ])
  await overlay.screenshot({
    path: resolve(output, 'preview.png'),
    omitBackground: true,
    animations: 'disabled',
  })
  passed(
    'Preview is a separate top-centered, always-on-top sandbox window and preserves main focus',
    {
      bounds: controlWindow.bounds,
      sandboxed: true,
      contextIsolated: true,
      focusPreserved: true,
      restrictedApi: isolated.controlApi,
    },
  )
  const previewState = await snapshot()
  assert.equal(previewState.sessionControl.controlActive, false)
  assert.equal(previewState.tasks.length, 0)
  await overlay.getByRole('button', { name: 'Close preview', exact: true }).click()
  await until(indicatorVisible, (value) => !value, 'preview explicitly closes')
  passed('Preview performs no task and can be explicitly closed')

  await overlay.evaluate(() => {
    window.__controlPaintObserved = []
    const observe = () => {
      const mode = document.querySelector('.control-indicator')?.getAttribute('data-mode')
      if (mode === 'controlling')
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            window.__controlPaintObserved.push(Date.now())
          }),
        )
    }
    new MutationObserver(observe).observe(document.body, {
      subtree: true,
      attributes: true,
      childList: true,
      attributeFilter: ['data-mode'],
    })
  })

  const registered = await post('/v1/control/register', registration)
  const handle = registered.sessionHandle
  assert.ok(handle)
  await page.getByRole('button', { name: 'Agent 协调', exact: true }).click()
  await page
    .getByRole('option', { name: registration.title, exact: true })
    .waitFor({ state: 'attached' })
  await page.getByLabel('目标会话', { exact: true }).selectOption(handle)
  const privateMarker = `QA-PRIVATE-TASK-${randomUUID()}`
  await page
    .getByLabel('追加要求', { exact: true })
    .fill(`协议验收 ${privateMarker}，不执行真实操作。`)
  await page.getByRole('button', { name: '发送要求', exact: true }).click()
  state = await until(
    snapshot,
    (value) => value.sessionControl.commands.some((command) => command.action === 'send_message'),
    'UI enqueues command',
  )
  const first = state.sessionControl.commands.find((command) => command.action === 'send_message')
  const delivery = await post('/v1/control/poll', pollInput)
  const receivedAt = Date.now()
  assert.equal(delivery.commands.length, 1)
  const wire = delivery.commands[0]
  assert.equal(wire.commandId, first.commandId)
  assert.equal(wire.action, 'send_message')
  assert.ok(wire.text.includes(privateMarker))
  assert.equal(wire.sessionId, source.sessionId)
  assert.equal(wire.instanceId, source.instanceId)
  assert.ok(wire.messageId)
  await overlay.locator('[data-mode="controlling"]').waitFor()
  assert.equal(await indicatorVisible(), true)
  await brandedIndicator('Controlling your computer')
  if (controlWindow.bounds.width >= 373) {
    assert.equal(await overlay.locator('.control-timer').isVisible(), true)
    assert.match(await overlay.locator('.control-timer').innerText(), /^\d{2,}:\d{2}$/)
  }
  const paints = await overlay.evaluate(() => window.__controlPaintObserved)
  assert.ok(
    paints.length && paints[0] <= receivedAt,
    'Actual control was painted before a write command left the outbox',
  )
  const controlView = await overlay.evaluate(() => window.coloopControl.snapshot())
  assert.equal(controlView.ok, true)
  assert.equal(JSON.stringify(controlView.value).includes(privateMarker), false)
  assert.equal(JSON.stringify(controlView.value).includes(connection.token), false)
  assert.equal(JSON.stringify(controlView.value).includes(source.sessionId), false)
  assert.equal(await overlay.getByRole('button', { name: 'Close preview', exact: true }).count(), 0)
  assert.equal((await overlay.evaluate(() => window.coloopControl.closePreview())).ok, false)
  const secondPoll = await post('/v1/control/poll', pollInput)
  assert.deepEqual(secondPoll.commands, [])
  await overlay.screenshot({
    path: resolve(output, 'control-active.png'),
    omitBackground: true,
    animations: 'disabled',
  })
  const activeWindows = await windows()
  const separateControl = activeWindows.windows.find((item) => item.id === controlWindow.id)
  const mainBeforeMove = activeWindows.windows.find((item) => item.id === mainId)
  assert.notEqual(separateControl.id, mainBeforeMove.id)
  assert.notEqual(separateControl.webContentsId, mainBeforeMove.webContentsId)
  assert.equal(separateControl.parentId, null)
  const movedMainBounds = {
    x: activeWindows.primary.x + 100,
    y: activeWindows.primary.y + 170,
    width: 1060,
    height: 720,
  }
  await app.evaluate(
    ({ BrowserWindow }, { id, bounds }) => {
      const main = BrowserWindow.fromId(id)
      if (main.isMaximized()) main.unmaximize()
      main.setBounds(bounds, false)
    },
    { id: mainId, bounds: movedMainBounds },
  )
  const afterMove = await until(
    windows,
    (value) => {
      const main = value.windows.find((item) => item.id === mainId)
      return Object.entries(movedMainBounds).every(
        // Native frame/minimum-size rounding can add a few DIP to the main window.
        ([key, target]) =>
          Math.abs(main.bounds[key] - target) <= (key === 'x' || key === 'y' ? 1 : 4),
      )
    },
    'main window moves and shrinks independently of the screen-top control notice',
  )
  assert.deepEqual(
    afterMove.windows.find((item) => item.id === controlWindow.id).bounds,
    separateControl.bounds,
  )
  assert.equal(await indicatorVisible(), true)
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).minimize(), mainId)
  const whileMinimized = await until(
    windows,
    (value) => value.windows.find((item) => item.id === mainId)?.minimized,
    'main window minimizes while control remains on the display',
  )
  const minimizedControl = whileMinimized.windows.find((item) => item.id === controlWindow.id)
  assert.equal(minimizedControl.visible, true)
  assert.equal(minimizedControl.top, true)
  assert.deepEqual(minimizedControl.bounds, separateControl.bounds)
  assert.equal((await snapshot()).sessionControl.controlActive, true)
  await app.evaluate(({ BrowserWindow }, id) => {
    const main = BrowserWindow.fromId(id)
    main.restore()
    main.show()
    main.focus()
    main.moveTop()
  }, mainId)
  const restoredWindows = await until(
    windows,
    (value) => {
      const main = value.windows.find((item) => item.id === mainId)
      return !main.minimized && main.visible
    },
    'main window restores without relocating or ending the control notice',
  )
  assert.deepEqual(
    restoredWindows.windows.find((item) => item.id === controlWindow.id).bounds,
    separateControl.bounds,
  )
  assert.equal((await snapshot()).sessionControl.controlActive, true)
  await brandedIndicator('Controlling your computer')
  // Capture the actual display, including the independently positioned main
  // window, instead of using the indicator's own cropped page screenshot.
  // Raise only this test's main window for the screenshot; the indicator uses
  // the higher screen-saver level. Restore the ordinary main-window level immediately.
  await app.evaluate(({ BrowserWindow }, id) => {
    const main = BrowserWindow.fromId(id)
    main.setAlwaysOnTop(true, 'floating')
    main.showInactive()
    main.moveTop()
  }, mainId)
  let screenCapture
  try {
    await page.waitForTimeout(350)
    screenCapture = await app.evaluate(async ({ desktopCapturer, screen }) => {
      const primary = screen.getPrimaryDisplay()
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(primary.bounds.width * primary.scaleFactor),
          height: Math.round(primary.bounds.height * primary.scaleFactor),
        },
      })
      const source = sources.find((item) => item.display_id === String(primary.id))
      if (!source || source.thumbnail.isEmpty()) throw new Error('Primary screen capture is empty')
      return {
        png: source.thumbnail.toPNG().toString('base64'),
        displayId: primary.id,
        bounds: primary.bounds,
        imageSize: source.thumbnail.getSize(),
      }
    })
  } finally {
    await app.evaluate(({ BrowserWindow }, id) => {
      const main = BrowserWindow.fromId(id)
      if (main && !main.isDestroyed()) main.setAlwaysOnTop(false)
    }, mainId)
  }
  await writeFile(resolve(output, 'screen-top.png'), Buffer.from(screenCapture.png, 'base64'))
  passed(
    'The independent always-on-top notice stays centered 8 DIP below the display edge while the main window moves, shrinks, minimizes and restores',
    {
      displayBounds: activeWindows.primary,
      workArea: activeWindows.workArea,
      indicatorWindowId: separateControl.id,
      indicatorWebContentsId: separateControl.webContentsId,
      indicatorBounds: separateControl.bounds,
      mainWindowId: mainBeforeMove.id,
      mainWebContentsId: mainBeforeMove.webContentsId,
      mainBounds: restoredWindows.windows.find((item) => item.id === mainId).bounds,
      visibleWhileMainMinimized: minimizedControl.visible,
      mainRaisedOnlyForScreenCapture: true,
      fullScreenCapture: { displayId: screenCapture.displayId, imageSize: screenCapture.imageSize },
    },
  )
  await page.getByText('Coloop 正在控制', { exact: true }).waitFor()
  await page.screenshot({
    path: resolve(output, 'session-control-ui.png'),
    fullPage: true,
    animations: 'disabled',
  })
  passed(
    'UI-selected Windows source receives one targeted command only after actual indicator paint; sensitive payload stays out of the indicator',
  )
  passed(
    'The 373px control notice shows only Coloop branding and English status copy, keeps its timer visible, and omits the AI provider and workspace label',
  )

  const sourceReport = async (command, status) =>
    post('/v1/control/report', {
      ...source,
      commandId: command.commandId,
      status,
      ...(command.messageId ? { messageId: command.messageId } : {}),
    })
  await sourceReport(wire, 'accepted')
  state = await snapshot()
  assert.equal(
    state.sessionControl.commands.find((command) => command.commandId === wire.commandId).status,
    'accepted',
  )
  assert.equal(state.sessionControl.controlActive, true)
  await sourceReport(wire, 'confirmed')
  state = await snapshot()
  assert.equal(
    state.sessionControl.commands.find((command) => command.commandId === wire.commandId).status,
    'confirmed',
  )
  assert.equal(state.sessionControl.controlActive, true)
  assert.equal(state.tasks.length, 0)
  assert.equal(await indicatorVisible(), true)
  await page
    .getByText('消息确认表示要求已进入源会话；任务是否完成，仍以源执行结果为准。', { exact: true })
    .waitFor()
  passed(
    'Accepted and confirmed receipts do not complete the task or hide the active control notice',
  )

  let sequence = 0
  const hook = (kind, payload) =>
    post('/v1/hooks', {
      ...source,
      eventId: randomUUID(),
      taskId: wire.messageId,
      sequence: ++sequence,
      kind,
      workspace: root,
      payload,
    })
  await hook('message', {
    role: 'user',
    messageId: wire.messageId,
    partId: 'qa-part',
    text: '协议验收用消息',
  })
  await hook('status', { state: 'busy' })
  await until(
    snapshot,
    (value) => value.sessionControl.sessions[0].state === 'running',
    'owned turn running',
  )
  await hook('status', { state: 'idle' })
  await until(
    snapshot,
    (value) => !value.sessionControl.controlActive,
    'owned busy-to-idle ends control',
  )
  await until(indicatorVisible, (value) => !value, 'completed turn hides indicator')
  passed('A matching native turn busy-to-idle transition ends control and hides the notice')

  // Leave a second message queued: stopping must revoke it before any source poll.
  const queuedId = randomUUID()
  const queued = await page.evaluate((input) => window.coloop.controlSession(input), {
    commandId: queuedId,
    sessionHandle: handle,
    action: 'send_message',
    text: '仅验证停止撤销；此消息不应下发给源。',
  })
  assert.equal(queued.ok, true, queued.error)
  await overlay.locator('[data-mode="controlling"]').waitFor()
  // A click dispatches immediately; the fixture can reply while onStop awaits confirmation.
  await overlay.getByRole('button', { name: 'Stop', exact: true }).click()
  state = await until(
    snapshot,
    (value) =>
      value.sessionControl.stopped &&
      value.sessionControl.commands.find((command) => command.commandId === queuedId)?.status ===
        'cancelled',
    'stop revokes queued message',
  )
  assert.equal(state.sessionControl.controlActive, true)
  const aborts = await post('/v1/control/poll', pollInput)
  assert.equal(aborts.commands.length, 1)
  assert.equal(aborts.commands[0].action, 'abort_turn')
  assert.equal(
    aborts.commands.some((command) => command.commandId === queuedId),
    false,
  )
  assert.equal(await indicatorVisible(), true)
  await overlay.locator('[data-mode="stopping"]').waitFor()
  await brandedIndicator()
  await overlay.getByRole('button', { name: 'Stopping', exact: true }).waitFor()
  await overlay.screenshot({
    path: resolve(output, 'control-stopping.png'),
    omitBackground: true,
    animations: 'disabled',
  })
  await sourceReport(aborts.commands[0], 'confirmed')
  state = await until(
    snapshot,
    (value) => !value.sessionControl.controlActive && value.sessionControl.stopped,
    'source stop confirmation and latch',
  )
  await until(indicatorVisible, (value) => !value, 'confirmed stop hides indicator')
  const latched = await page.evaluate((input) => window.coloop.controlSession(input), {
    commandId: randomUUID(),
    sessionHandle: handle,
    action: 'send_message',
    text: '停止锁存时必须拒绝的新消息',
  })
  assert.equal(latched.ok, false)
  assert.match(latched.error, /控制已停止/)
  assert.deepEqual((await post('/v1/control/poll', pollInput)).commands, [])
  passed(
    'Stop revokes queued sends, delivers a source abort, stays visible until confirmation, and latches future sends',
  )

  const resumed = await page.evaluate(() => window.coloop.resumeSessionControl())
  assert.equal(resumed.ok, true, resumed.error)
  assert.equal((await snapshot()).sessionControl.stopped, false)
  assert.deepEqual((await post('/v1/control/poll', pollInput)).commands, [])
  passed('Explicitly resuming permits new controls without replaying the revoked message')

  const crashCommand = await page.evaluate((input) => window.coloop.controlSession(input), {
    commandId: randomUUID(),
    sessionHandle: handle,
    action: 'send_message',
    text: '仅用于验证提示进程崩溃后的停止协议。',
  })
  assert.equal(crashCommand.ok, true, crashCommand.error)
  const crashDelivery = await post('/v1/control/poll', pollInput)
  assert.equal(crashDelivery.commands.length, 1)
  await sourceReport(crashDelivery.commands[0], 'accepted')
  const crashedId = (await windows()).windows.find((item) =>
    item.url.includes('surface=control'),
  ).id
  const recoveredWindow = app.waitForEvent('window', { timeout: 15_000 })
  await app.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.forcefullyCrashRenderer(),
    crashedId,
  )
  await until(
    snapshot,
    (value) => value.sessionControl.stopped,
    'renderer loss automatically latches control stop',
  )
  overlay = await recoveredWindow
  overlay.on('pageerror', (error) => pageErrors.push(error.message))
  await overlay.locator('.control-indicator').waitFor()
  const crashAbort = await post('/v1/control/poll', pollInput)
  assert.equal(crashAbort.commands.length, 1)
  assert.equal(crashAbort.commands[0].action, 'abort_turn')
  assert.equal(await indicatorVisible(), true)
  await overlay.locator('[data-mode="unconfirmed"]').waitFor()
  await brandedIndicator('Control status unconfirmed')
  await overlay.screenshot({
    path: resolve(output, 'control-unconfirmed.png'),
    omitBackground: true,
    animations: 'disabled',
  })
  await sourceReport(crashAbort.commands[0], 'confirmed')
  await until(
    snapshot,
    (value) => !value.sessionControl.controlActive,
    'crash recovery source stop confirmation',
  )
  await until(
    indicatorVisible,
    (value) => !value,
    'crash recovery only hides after confirmed abort',
  )
  passed(
    'Indicator renderer loss automatically stops admission, recovers a visible notice, and aborts the controlled source',
  )

  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), mainId)
  await until(
    windows,
    (value) => value.windows.some((window) => window.id === mainId && !window.visible),
    'main close hides to tray',
  )
  const alive = await fetch(connection.url + '/health', {
    headers: { authorization: `Bearer ${connection.token}` },
  })
  assert.equal(alive.status, 200)
  const health = await alive.json()
  assert.equal(health.ready, true)
  await app.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id)
    window.show()
    window.focus()
  }, mainId)
  await page
    .getByText('控制已停止。待发要求已撤销，重新允许后也不会补发旧指令。', { exact: true })
    .waitFor()
  await page.screenshot({
    path: resolve(output, 'session-control-stopped.png'),
    fullPage: true,
    animations: 'disabled',
  })
  passed(
    'Closing the main window retains the application and authenticated source service in the tray',
  )
  const changedRoot = resolve(output, 'new-trusted-workspace')
  await mkdir(changedRoot, { recursive: true })
  const oldSession = (await snapshot()).sessionControl.sessions.find(
    (item) => item.host === 'windows',
  )
  const changed = await page.evaluate(async (ocrWorkspace) => {
    const state = (await window.coloop.snapshot()).value
    return window.coloop.saveSettings({ ...state.settings, ocrWorkspace })
  }, changedRoot)
  assert.equal(changed.ok, true, changed.error)
  assert.equal(
    (await snapshot()).sessionControl.sessions.find((item) => item.handle === oldSession.handle)
      .connected,
    false,
  )
  const obsolete = await page.evaluate(
    (sessionHandle) =>
      window.coloop.controlSession({
        commandId: crypto.randomUUID(),
        sessionHandle,
        action: 'send_message',
        text: 'must not reach the former workspace',
      }),
    oldSession.handle,
  )
  assert.equal(obsolete.ok, false)
  await post(
    '/v1/control/register',
    {
      ...source,
      sessionId: 'former-workspace',
      workspace: root,
      host: 'windows',
      capabilities: ['send_message', 'abort_turn'],
      state: 'idle',
    },
    403,
  )
  passed(
    'Changing trusted workspace disconnects old sessions and rejects controls or re-registration from the former root',
  )
  assert.deepEqual(pageErrors, [])
  passed('Main and indicator renderers report no runtime errors')
  report.passed = true
} catch (error) {
  failure = error
  report.passed = false
  report.failure = { message: error.message, stack: error.stack }
  if (page && !page.isClosed())
    await page
      .screenshot({ path: resolve(output, 'failure-main.png'), fullPage: true })
      .catch(() => {})
  if (overlay && !overlay.isClosed())
    await overlay
      .screenshot({ path: resolve(output, 'failure-control.png'), omitBackground: true })
      .catch(() => {})
} finally {
  report.finishedAt = new Date().toISOString()
  report.pageErrors = pageErrors
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
  await app?.close().catch(() => {})
  console.log(
    JSON.stringify(
      { passed: report.passed, output, checks: checks.length, failure: report.failure?.message },
      null,
      2,
    ),
  )
}
if (failure) throw failure
