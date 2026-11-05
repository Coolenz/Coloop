// Opt-in real Windows input. Run only while this script owns the desktop.
// Script/executor acceptance, NOT model autonomy or packaged-app/RK acceptance.
// node tests/cua-native-live.mjs [--driver <exe>] [--ocr-workspace D:/RK]
// No paid/model APIs are imported; input is limited to a new ActionTaskLab process.
import { _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const options = {
  driver: resolve(root, '.cache/cua-driver/cua-driver.exe'),
  'ocr-workspace': 'D:/RK',
  output: resolve(root, '.qa', `cua-native-live-${Date.now()}-${randomUUID().slice(0, 8)}`),
}
for (let at = 0; at < args.length; at++) {
  if (args[at] === '--help') {
    console.log(
      'Windows desktop test: node tests/cua-native-live.mjs [--driver <exe>] [--ocr-workspace <RK directory>] [--output <new directory>]\nRuns checkbox click, double click, scroll, journal replay and post-stop rejection. Uses source-bundled production modules, not a packaged Coloop application. No model calls or RK input. Requires exclusive desktop use.',
    )
    process.exit(0)
  }
  const key = args[at].replace(/^--/, '')
  assert.ok(Object.hasOwn(options, key) && args[at].startsWith('--'), `Unknown option: ${args[at]}`)
  assert.ok(args[at + 1] && !args[at + 1].startsWith('--'), `Missing value: ${args[at]}`)
  options[key] = resolve(args[++at])
}
assert.equal(process.platform, 'win32', 'Windows is required')
const output = resolve(options.output)
// Never reuse prior receipts or overwrite another acceptance run.
await mkdir(dirname(output), { recursive: true })
await mkdir(output)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fingerprint = async (path) => ({ path, sha256: sha256(await readFile(path)) })
const save = (file, value) => writeFile(resolve(output, file), JSON.stringify(value, null, 2))
const run = promisify(execFile)
const env = {}
for (const name of [
  'SystemRoot',
  'WINDIR',
  'PATH',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMSPEC',
  'PATHEXT',
  'LANG',
]) {
  if (process.env[name] !== undefined) env[name] = process.env[name]
}
Object.assign(env, {
  CUA_DRIVER_RS_HOME: resolve(output, 'driver-home'),
  CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
  CUA_TELEMETRY_ENABLED: '0',
  CUA_DRIVER_RS_UPDATE_CHECK: 'false',
})

// This function is serialized into Electron's main process. Keeping it as parsed
// JavaScript also lets `node --check` validate the generated harness body.
async function harnessMain(config) {
  const { app, net, session } = require('electron')
  const fs = require('node:fs/promises')
  const path = require('node:path')
  const assert = require('node:assert/strict')
  const { spawn } = require('node:child_process')
  const { createHash } = require('node:crypto')
  const { WindowsObservationCapture } = require('./capture.cjs')
  const { OcrEngine } = require('./ocr.cjs')
  const { CuaDriverClient } = require('./driver.cjs')
  const { CuaDesktop } = require('./desktop.cjs')
  const { CuaExecution } = require('./execution.cjs')
  const delay = (ms) => new Promise((done) => setTimeout(done, ms))
  const networkAttempts = []
  const deny = (kind) => () => {
    networkAttempts.push({ kind, at: Date.now() })
    throw new Error('LIVE_TEST_NETWORK_FORBIDDEN')
  }
  // This is a no-cloud harness, not a machine-wide packet capture. The local
  // stdio Driver/OCR subprocesses retain their production implementations.
  global.fetch = deny('fetch')
  global.WebSocket = deny('WebSocket')
  for (const module of ['node:http', 'node:https']) {
    require(module).request = deny(module + '.request')
    require(module).get = deny(module + '.get')
  }
  net.request = deny('electron.net.request')
  net.fetch = deny('electron.net.fetch')
  app.commandLine.appendSwitch('disable-background-networking')
  app.setPath('userData', path.join(config.output, 'electron-profile'))
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => {
      networkAttempts.push({ kind: 'electron.webRequest', at: Date.now() })
      callback({ cancel: true })
    },
  )
  let fixture, identity, executor, client, desktop
  let ocrCalls = 0
  let active = false
  const fallbackCalls = { connect: 0, begin: 0, execute: 0, stop: 0, dispose: 0 }
  const captureChecks = []
  const driverCalls = []
  const captureDiagnostics = (response, expectedRect) => {
    let data = response.structuredContent
    if (!data) {
      for (const block of response.content || []) {
        if (block.type !== 'text') continue
        try {
          data = JSON.parse(block.text)
          break
        } catch {
          /* Do not save text. */
        }
      }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {}
    const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
    const bounds = data.window_bounds || {}
    const rect = [number(bounds.x), number(bounds.y), number(bounds.width), number(bounds.height)]
    const allowedKeys = [
      'pid',
      'window_id',
      'window_bounds',
      'screenshot_width',
      'screenshot_height',
      'screenshot_frame_valid',
      'capture_id',
      'snapshot_id',
      'elements',
      'truncated',
    ]
    const pngHeaders = []
    let imageCount = 0
    for (const block of response.content || []) {
      if (block.type !== 'image') continue
      imageCount++
      if (block.mimeType !== 'image/png' || typeof block.data !== 'string') continue
      // Only decode the fixed IHDR prefix; never store image bytes or base64.
      const bytes = Buffer.from(block.data.slice(0, 48), 'base64')
      const valid =
        bytes.length >= 33 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.readUInt32BE(8) === 13 &&
        bytes.toString('ascii', 12, 16) === 'IHDR'
      if (pngHeaders.length < 8)
        pngHeaders.push(
          valid
            ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
            : { invalid: true },
        )
    }
    const mismatch = []
    const validBounds = rect.every(Number.isSafeInteger) && rect[2] > 0 && rect[3] > 0
    const boundsMatch =
      !!expectedRect &&
      validBounds &&
      [rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]].join() === expectedRect.join()
    const boundsInside =
      !!expectedRect &&
      validBounds &&
      rect[0] >= expectedRect[0] &&
      rect[1] >= expectedRect[1] &&
      rect[0] + rect[2] <= expectedRect[2] &&
      rect[1] + rect[3] <= expectedRect[3]
    const nativeSize = (width, height) =>
      width > 0 &&
      height > 0 &&
      data.screenshot_width === width &&
      data.screenshot_height === height &&
      pngHeaders.some((header) => header.width === width && header.height === height)
    const geometryMode =
      boundsInside && nativeSize(rect[2] - 2, rect[3] - 2)
        ? 'dwm_inset_1px'
        : boundsMatch && nativeSize(rect[2], rect[3])
          ? 'full_window'
          : 'unconfirmed'
    if (data.pid !== identity.pid || String(data.window_id) !== identity.window_id)
      mismatch.push('WINDOW_IDENTITY_MISMATCH')
    if (!boundsInside) mismatch.push('WINDOW_BOUNDS_OUTSIDE_OBSERVATION')
    if (geometryMode === 'unconfirmed') mismatch.push('NATIVE_FRAME_UNCONFIRMED')
    if (
      !pngHeaders.some(
        (header) =>
          header.width === data.screenshot_width && header.height === data.screenshot_height,
      )
    )
      mismatch.push('PNG_IHDR_DIMENSIONS_UNCONFIRMED')
    if (typeof data.capture_id !== 'string' || !data.capture_id) mismatch.push('CAPTURE_ID_MISSING')
    if (data.screenshot_frame_valid === false) mismatch.push('SCREENSHOT_FRAME_INVALID')
    return {
      keys: allowedKeys.filter((key) => Object.hasOwn(data, key)),
      otherKeyCount: Object.keys(data).filter((key) => !allowedKeys.includes(key)).length,
      pid: number(data.pid),
      window_id: /^(0|[1-9]\d*)$/.test(String(data.window_id)) ? String(data.window_id) : null,
      window_bounds: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] },
      expected_window_rect: expectedRect || null,
      screenshot_width: number(data.screenshot_width),
      screenshot_height: number(data.screenshot_height),
      screenshot_frame_valid:
        typeof data.screenshot_frame_valid === 'boolean' ? data.screenshot_frame_valid : null,
      capture_id_present: typeof data.capture_id === 'string' && !!data.capture_id,
      capture_id_sha256:
        typeof data.capture_id === 'string'
          ? createHash('sha256').update(data.capture_id).digest('hex')
          : null,
      imageCount,
      pngHeaders,
      geometryMode,
      bounds_differ_from_win32: !boundsMatch,
      mismatch,
    }
  }
  const ocr = new OcrEngine(
    () => config.ocrWorkspace,
    config.ocrBridge,
    () => {},
  )
  const capture = new WindowsObservationCapture({
    recognize: async (png, signal) => {
      ocrCalls++
      return ocr.recognize(png, signal)
    },
  })
  const assertOwned = (view) => {
    assert.ok(active && fixture && identity, 'No active fixture lease')
    assert.ok(
      fixture.exitCode === null && fixture.signalCode === null && !fixture.killed,
      'Fixture exited',
    )
    assert.equal(identity.pid, fixture.pid, 'Fixture PID is not the spawned child')
    assert.equal(view.process_id, identity.pid, 'Foreground belongs to another process')
    assert.equal(view.window_id, identity.window_id, 'Foreground belongs to another window')
  }
  const ownedMetadata = async () => {
    const meta = await capture.metadata()
    assertOwned(meta)
    return meta
  }
  const assertLease = () => {
    assert.ok(
      active &&
        fixture &&
        identity &&
        fixture.exitCode === null &&
        fixture.signalCode === null &&
        !fixture.killed,
      'Fixture lease expired',
    )
    assert.equal(identity.pid, fixture.pid)
  }
  const validate = async (view, action) => {
    assertOwned(view)
    await ownedMetadata()
    const result = await capture.validate(view, action)
    captureChecks.push({
      kind: 'validate',
      observation_id: view.observation_id,
      action: action.action,
      ...result,
    })
    return result
  }
  const guard = async (view, action) => {
    assertOwned(view)
    await ownedMetadata()
    const result = await capture.guard(view, action)
    captureChecks.push({
      kind: 'guard',
      observation_id: view.observation_id,
      action: action.action,
      ...result,
    })
    return result
  }
  const makeExecutor = (directory) =>
    new CuaExecution({
      // Explicit lifecycle-only stub: it never opens RK/HID or sends any input.
      fallback: {
        connect: async () => {
          fallbackCalls.connect++
        },
        begin: async () => {
          fallbackCalls.begin++
          return { ok: true, test_lifecycle_stub: true }
        },
        execute: async () => {
          fallbackCalls.execute++
          throw new Error('RK_FALLBACK_FORBIDDEN')
        },
        stop: async () => {
          fallbackCalls.stop++
          return { ok: true, neutral: true, test_lifecycle_stub: true }
        },
        dispose: async () => {
          fallbackCalls.dispose++
        },
      },
      journalDirectory: directory,
      mouse: desktop,
      prepareInput: ownedMetadata,
      validate,
      guard,
    })
  const readState = async (folder) =>
    JSON.parse(await fs.readFile(path.join(folder, 'state.json'), 'utf8'))
  const effectState = (state) => ({
    checked: state.checked,
    mouse_down_count: state.mouse_down_count,
    mouse_up_count: state.mouse_up_count,
    click_count: state.click_count,
    doubleclick_count: state.doubleclick_count,
    scroll: state.scroll,
  })
  const observe = async (folder, label, enrich) => {
    await ownedMetadata()
    const frame = await capture.captureFrame()
    assert.ok(frame, 'No screen frame')
    assertOwned(frame)
    const observed = await capture.recognize(frame)
    assertOwned(observed)
    assert.ok(observed.ocr_items.length, 'Real OCR returned no text')
    // Save only an already identity-checked frame from our synthetic fixture.
    await fs.writeFile(path.join(folder, label + '.png'), frame.png)
    const result = enrich ? await desktop.enrich(observed) : observed
    assertOwned(result)
    if (enrich) assert.equal(result.cua?.status, 'ready', 'Cua observation enrichment unavailable')
    await fs.writeFile(path.join(folder, label + '.json'), JSON.stringify(result, null, 2))
    return result
  }
  const closeFixture = async () => {
    active = false
    await executor?.dispose()
    executor = undefined
    client?.dispose()
    client = undefined
    desktop = undefined
    const owned = fixture
    fixture = undefined
    identity = undefined
    if (owned && owned.pid && owned.exitCode === null && owned.signalCode === null) {
      const exited = new Promise((done) => owned.once('exit', () => done(true)))
      owned.kill()
      const stopped = await Promise.race([exited, delay(3000).then(() => false)])
      assert.equal(stopped, true, 'Fixture failed to exit; do not continue desktop tests')
    }
  }
  global.cuaLiveCleanup = async () => {
    try {
      await closeFixture()
    } finally {
      capture.dispose()
      ocr.dispose()
    }
  }
  app.on('before-quit', () => {
    active = false
    fixture?.kill()
    client?.dispose()
    capture.dispose()
    ocr.dispose()
  })
  global.cuaLiveRunCase = async (task) => {
    assert.ok(['checkbox', 'double_click', 'scroll'].includes(task))
    assert.equal(fixture, undefined, 'Another fixture still owns the desktop')
    const folder = path.join(config.output, task)
    await fs.mkdir(folder)
    const report = { task, scope: 'script_executor_real_native_input', passed: false }
    const checkStart = captureChecks.length
    const callStart = driverCalls.length
    const ocrStart = ocrCalls
    try {
      const title = 'Coloop Cua isolated ' + task + ' ' + config.runId
      fixture = spawn(config.fixture, [folder, task, title], {
        windowsHide: false,
        stdio: 'ignore',
      })
      let spawnError
      fixture.once('error', (error) => {
        spawnError = error
      })
      for (let attempt = 0; attempt < 100; attempt++) {
        if (spawnError) throw spawnError
        if (fixture.exitCode !== null) throw new Error('FIXTURE_EXITED_BEFORE_IDENTITY')
        try {
          identity = JSON.parse(await fs.readFile(path.join(folder, 'identity.json'), 'utf8'))
          break
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        await delay(50)
      }
      assert.ok(identity, 'Fixture identity missing')
      assert.equal(identity.pid, fixture.pid)
      assert.equal(identity.task_id, task)
      assert.equal(identity.title, title)
      report.identity = identity
      active = true
      // Pass BOTH HWND and PID. Never activate any pre-existing/user window.
      await capture.focusTaskWindow(identity.window_id, identity.pid)
      await ownedMetadata()
      client = new CuaDriverClient({ executable: config.driver, stateDirectory: config.driverHome })
      const tools = await client.listTools()
      const kind = task === 'checkbox' ? 'click' : task
      for (const name of ['get_window_state', kind])
        assert.ok(
          tools.some((tool) => tool.name === name),
          'Missing Cua tool: ' + name,
        )
      desktop = new CuaDesktop({
        client: {
          call: async (name, value, signal) => {
            assertLease()
            assert.equal(value.pid, identity.pid)
            assert.equal(String(value.window_id), identity.window_id)
            // Observe the real transport without replacing its behavior/results.
            const row = {
              tool: name,
              pid: value.pid,
              window_id: value.window_id,
              delivery_mode: value.delivery_mode,
              at: Date.now(),
            }
            driverCalls.push(row)
            try {
              const response = await client.call(name, value, signal)
              row.completed = true
              row.isError = response.isError === true
              if (name === 'get_window_state' && value.include_screenshot === true)
                row.capture = captureDiagnostics(response, report.observedWindowRect)
              return response
            } catch (error) {
              row.error = error.code || error.message
              throw error
            }
          },
        },
        metadata: ownedMetadata,
        assertAllowed: assertLease,
        guard,
      })
      const journal = path.join(folder, 'journal')
      executor = makeExecutor(journal)
      const taskSession = { task_id: config.runId + ':' + task, generation: '1' }
      await executor.begin(taskSession)
      const observed = await observe(folder, 'before', true)
      report.observedWindowRect = observed.window_rect.slice()
      const target =
        task === 'scroll'
          ? observed.targets.find((item) => item.name === 'Scroll list') ||
            observed.targets.find((item) => ['Edit', 'Document'].includes(item.type))
          : observed.targets.find(
              (item) =>
                item.name === (task === 'checkbox' ? 'Enable feature' : 'Double click target'),
            )
      assert.ok(target, 'Observed fixture control missing')
      report.target = target
      report.cua = observed.cua
      const before = await readState(folder)
      report.before = before
      if (task === 'checkbox') assert.equal(before.checked, false)
      if (task === 'double_click') assert.equal(before.doubleclick_count, 0)
      if (task === 'scroll') assert.equal(before.scroll.first_visible_line, 0)
      const command = {
        ...taskSession,
        command_id: config.runId + ':' + task + ':input',
        observation: observed,
        action: {
          action: kind,
          target_id: target.id,
          ...(task === 'scroll' ? { steps: -12 } : {}),
        },
      }
      // No retries of physical input, even when the receipt is uncertain/no-op.
      report.receipt = await executor.execute(command)
      assert.equal(report.receipt.ok, true, JSON.stringify(report.receipt))
      assert.equal(report.receipt.receipt.channel, 'cua_driver')
      assert.equal(report.receipt.receipt.outcome, 'input_sent')
      assert.equal(report.receipt.receipt.release_confirmed, true)
      const changed = (state) =>
        task === 'checkbox'
          ? state.checked === true
          : task === 'double_click'
            ? state.doubleclick_count === 1
            : state.scroll.first_visible_line > before.scroll.first_visible_line &&
              state.scroll.native_scroll_count > before.scroll.native_scroll_count
      let after
      for (let attempt = 0; attempt < 40; attempt++) {
        after = await readState(folder)
        if (changed(after)) break
        await delay(50)
      }
      assert.ok(changed(after), 'Independent native fixture did not confirm the intended effect')
      await observe(folder, 'after', false)
      // All queued native scroll events must settle before proving that replay
      // produces no additional effect; never send a second physical action.
      await delay(250)
      after = await readState(folder)
      assert.ok(changed(after), 'Native effect changed before verification completed')
      report.after = after
      report.replay = await executor.execute(command)
      assert.equal(report.replay.deduplicated, true)
      assert.deepEqual(report.replay.receipt, report.receipt.receipt)
      await delay(250)
      assert.deepEqual(
        effectState(await readState(folder)),
        effectState(after),
        'Same-process replay caused input',
      )
      // Reconstruct the executor to prove disk journal replay, not just memory.
      await executor.dispose()
      executor = makeExecutor(journal)
      await executor.begin(taskSession)
      report.restartReplay = await executor.execute(command)
      assert.equal(report.restartReplay.deduplicated, true)
      assert.deepEqual(report.restartReplay.receipt, report.receipt.receipt)
      await delay(250)
      assert.deepEqual(
        effectState(await readState(folder)),
        effectState(after),
        'Restart replay caused input',
      )
      report.stop = await executor.stop(taskSession)
      assert.equal(report.stop.neutral, true)
      report.afterStop = await executor.execute({
        ...command,
        command_id: command.command_id + ':after-stop',
      })
      assert.equal(report.afterStop.ok, false)
      assert.equal(report.afterStop.receipt.outcome, 'not_sent')
      assert.equal(report.afterStop.receipt.error, 'CUA_EXECUTOR_STALE_TASK')
      await delay(250)
      report.final = await readState(folder)
      assert.deepEqual(
        effectState(report.final),
        effectState(after),
        'Post-stop command caused input',
      )
      const key = createHash('sha256').update(command.command_id).digest('hex')
      const files = (await fs.readdir(journal)).sort()
      assert.deepEqual(files, [key + '.dispatch.json', key + '.receipt.json'].sort())
      const dispatchRecord = JSON.parse(
        await fs.readFile(path.join(journal, key + '.dispatch.json'), 'utf8'),
      )
      const receiptRecord = JSON.parse(
        await fs.readFile(path.join(journal, key + '.receipt.json'), 'utf8'),
      )
      assert.equal(dispatchRecord.receipt.outcome, 'unknown')
      assert.equal(dispatchRecord.receipt.release_confirmed, false)
      assert.equal(dispatchRecord.digest, receiptRecord.digest)
      assert.deepEqual(receiptRecord.receipt, report.receipt.receipt)
      report.journal = { files, digest: dispatchRecord.digest, durable_replay: true }
      const physicalCalls = driverCalls
        .slice(callStart)
        .filter((call) => ['click', 'double_click', 'scroll'].includes(call.tool))
      assert.equal(physicalCalls.length, 1, 'Expected exactly one input transport call')
      assert.equal(fallbackCalls.execute, 0, 'RK fallback unexpectedly used')
      assert.equal(networkAttempts.length, 0, 'Harness attempted network access')
      report.passed = true
    } catch (error) {
      report.error = String(error.stack || error)
      report.lastState = await readState(folder).catch(() => null)
      throw error
    } finally {
      report.captureChecks = captureChecks.slice(checkStart)
      report.driverCalls = driverCalls.slice(callStart)
      report.realOcrCalls = ocrCalls - ocrStart
      report.fallbackCalls = { ...fallbackCalls }
      report.networkAttempts = networkAttempts.slice()
      report.stopScope =
        'Completed gesture, persisted replay and rejection after stop; no mid-gesture cancellation or RK/HID neutral-state verification.'
      try {
        await closeFixture()
      } catch (error) {
        report.passed = false
        report.cleanupError = String(error)
        throw error
      } finally {
        await fs.writeFile(path.join(folder, 'report.json'), JSON.stringify(report, null, 2))
      }
    }
    return report
  }
  global.cuaLiveReady = { electron: process.versions.electron, node: process.versions.node }
}

let application
const report = {
  version: 1,
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  status: 'preflight',
  scope:
    'Source-bundled production Cua + native observer/OCR, script-selected actions in isolated ActionTaskLab; not a packaged-app or model-autonomy test.',
  notTested: [
    'RK/HID input and release',
    'mid-gesture stop',
    'model autonomous planning',
    'packaged Coloop integration',
    'machine-wide network traffic',
  ],
  cases: [],
}
try {
  const entries = {
    capture: 'src/main/infrastructure/foreground-observation.ts',
    ocr: 'src/main/infrastructure/ocr.ts',
    driver: 'src/main/infrastructure/cua-driver.ts',
    desktop: 'src/main/infrastructure/cua-desktop.ts',
    execution: 'src/main/infrastructure/cua-execution.ts',
  }
  const ownedSources = [...Object.values(entries), 'src/main/domain/suggestion-ocr.ts']
  report.sources = await Promise.all(ownedSources.map((file) => fingerprint(resolve(root, file))))
  report.script = await fingerprint(import.meta.filename)
  report.fixtureSource = await fingerprint(resolve(root, 'tests/ActionTaskLab.cs'))
  report.ocrBridge = await fingerprint(resolve(root, 'resources/rapidocr-worker.py'))
  const python = resolve(options['ocr-workspace'], 'deployment/screen-ocr/.venv/Scripts/python.exe')
  assert.ok((await stat(python)).isFile(), 'RapidOCR Python is missing')
  report.ocrModule = await fingerprint(resolve(options['ocr-workspace'], 'tools/screen_ocr.py'))
  report.driver = await fingerprint(options.driver)
  const version = (
    await run(options.driver, ['--version'], { windowsHide: true, timeout: 15000, env })
  ).stdout.trim()
  assert.equal(version, 'cua-driver 0.38.0', 'Only the pinned Cua Driver contract is supported')
  report.driver.version = version
  report.driver.companions = await Promise.all(
    ['cua-driver-uia.exe', 'cua-cursor-theme.exe'].map((name) =>
      fingerprint(resolve(dirname(options.driver), name)),
    ),
  )
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [key, resolve(root, value)]),
    ),
    outdir: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
    external: ['electron'],
    metafile: true,
  })
  const applicationInputs = Object.keys(bundle.metafile.inputs).filter((file) =>
    relative(root, resolve(root, file)).replaceAll('\\', '/').startsWith('src/'),
  )
  assert.deepEqual(
    applicationInputs
      .map((file) => relative(root, resolve(root, file)).replaceAll('\\', '/'))
      .sort(),
    ownedSources.slice().sort(),
    'Unexpected production import: audit model/network paths before live testing',
  )
  report.buildInputs = Object.keys(bundle.metafile.inputs)
  for (const source of report.sources)
    assert.deepEqual(await fingerprint(source.path), source, 'Source changed during bundling')
  report.bundles = await Promise.all(
    Object.keys(entries).map((key) => fingerprint(resolve(output, key + '.cjs'))),
  )
  const fixture = resolve(output, 'ActionTaskLab.exe')
  await run(
    resolve(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    [
      '/nologo',
      '/target:winexe',
      '/out:' + fixture,
      '/reference:System.Windows.Forms.dll',
      '/reference:System.Drawing.dll',
      '/reference:System.Web.Extensions.dll',
      report.fixtureSource.path,
    ],
    { windowsHide: true, timeout: 30000, env },
  )
  assert.deepEqual(
    await fingerprint(report.fixtureSource.path),
    report.fixtureSource,
    'Fixture changed during compilation',
  )
  report.fixtureBinary = await fingerprint(fixture)
  const harness = resolve(output, 'harness.cjs')
  await writeFile(
    harness,
    `(${harnessMain.toString()})(${JSON.stringify({
      output,
      runId: report.runId,
      fixture,
      driver: options.driver,
      driverHome: resolve(output, 'driver-home'),
      ocrWorkspace: resolve(options['ocr-workspace']),
      ocrBridge: report.ocrBridge.path,
    })}).catch(error => { console.error(error); process.exitCode = 1; require('electron').app.exit(1); });\n`,
  )
  report.harness = await fingerprint(harness)
  report.cloudPreflight = {
    modelModulesImported: false,
    applicationImportAllowlist: ownedSources,
    credentialsInherited: false,
    mainProcessNetworkPolicy:
      'Deny fetch/WebSocket/HTTP(S)/Electron network; record attempted calls.',
    driverTransport: 'Production private MCP stdio, telemetry/update checks disabled.',
    fallbackPolicy: 'Lifecycle-only stub; execute throws without RK/HID input.',
  }
  report.status = 'running'
  await save('verification.json', report)
  application = await electron.launch({ args: [harness], cwd: root, env, timeout: 30000 })
  report.runtime = await application.evaluate(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (global.cuaLiveReady) return global.cuaLiveReady
      await new Promise((done) => setTimeout(done, 50))
    }
    throw new Error('CUA_LIVE_HARNESS_NOT_READY')
  })
  for (const task of ['checkbox', 'double_click', 'scroll']) {
    console.log('Cua live fixture: ' + task)
    const result = await application.evaluate(
      async (_app, name) => global.cuaLiveRunCase(name),
      task,
    )
    report.cases.push({
      task,
      passed: result.passed,
      receipt: result.receipt.receipt,
      realOcrCalls: result.realOcrCalls,
      evidence: resolve(output, task, 'report.json'),
    })
    await save('verification.json', report)
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = String(error.stack || error)
  process.exitCode = 1
} finally {
  if (application) {
    try {
      await application.evaluate(async () => global.cuaLiveCleanup?.())
    } catch (error) {
      report.cleanupError = String(error)
      report.status = 'failed'
      process.exitCode = 1
    }
    await application.close().catch((error) => {
      report.closeError = String(error)
      report.status = 'failed'
      process.exitCode = 1
    })
  }
  report.finishedAt = new Date().toISOString()
  await save('verification.json', report)
  console.log(
    JSON.stringify({
      status: report.status,
      passed: report.cases.filter((item) => item.passed).length,
      output,
    }),
  )
}
