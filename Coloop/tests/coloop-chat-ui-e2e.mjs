import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
const output = resolve(process.env.COLOOP_VIOLOOP_QA_DIR || '.qa/coloop-chat-ui')
process.env.COLOOP_ANDROID_QA_DIR = output
const ui = await import('../scripts/android-phone-qa.mjs')
const adb = resolve('.cache/android-toolchain/sdk/platform-tools/adb.exe')
const reviews = resolve(process.env.COLOOP_REVIEW_DIR || '.impeccable/review')
mkdirSync(reviews, { recursive: true })
const command = (args) =>
  execFileSync(adb, ['-s', 'emulator-5554', ...args], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000,
  })
const rotation =
  process.env.COLOOP_QA_LANDSCAPE === '1'
    ? {
        auto: command(['shell', 'settings', 'get', 'system', 'accelerometer_rotation']).trim(),
        user: command(['shell', 'settings', 'get', 'system', 'user_rotation']).trim(),
      }
    : null
const report = {
  scope: 'Actual Android 0.5.0 UI and encrypted protocol, explicit simulated RK/HID for UI states.',
  checks: [],
  captures: [],
}
const state = () => JSON.parse(readFileSync(join(output, 'state.json'), 'utf8'))
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
function capture(name) {
  const file = ui.screenshot(name)
  copyFileSync(file, join(reviews, name + '.png'))
  report.captures.push(join(reviews, name + '.png'))
}
async function send(text) {
  ui.inputAscii(text, true)
  command(['shell', 'input', 'keyevent', '4'])
  await ui.tapText('发送消息')
}
async function setGate(gate) {
  writeFileSync(join(output, 'request.txt'), gate)
  await pause(2500)
}
try {
  ui.setDisplay({ fontScale: 1, night: 'no' })
  command(['shell', 'am', 'start', '-n', 'ai.coloop.mobile/.MainActivity'])
  await ui.waitForText('想让电脑做什么')
  capture('phone-unpaired-light')
  ui.inputAscii('Keep my first task after pairing', true)
  command(['shell', 'input', 'keyevent', '4'])
  ui.openPairing(join(output, 'pairing.txt'))
  await ui.tapText('连接电脑')
  await ui.waitForText('电脑与 RK 已就绪', 60000)
  capture('phone-ready-light')
  assert.ok(
    ui
      .hierarchy()
      .some(
        (n) =>
          n.class === 'android.widget.EditText' && n.text === 'Keep my first task after pairing',
      ),
  )
  report.checks.push('First pairing preserves the unsent chat draft without submitting it')
  await send('Hello Coloop')
  await ui.waitForText('你好，我是 Coloop')
  capture('phone-chat-light')
  assert.equal(state().started, 0)
  report.checks.push(
    'Direct chat opens after pairing; Hello receives a Coloop reply with zero HID input',
  )
  await setGate('connecting')
  await ui.waitForText('正在启动 RK 本地模型')
  capture('phone-rk-connecting-light')
  await send('Keep this draft while reconnecting')
  await ui.waitForText('RK 已连接，正在启动本地模型')
  capture('phone-send-blocked-light')
  assert.ok(
    ui
      .hierarchy()
      .some((n) => n.class === 'android.widget.EditText' && n.text?.includes('Keep this draft')),
  )
  assert.equal(state().started, 0)
  report.checks.push(
    'Sender remains actionable and explains an unready RK; draft is preserved and nothing is submitted',
  )
  await ui.tapText('重试')
  await ui.waitForText('电脑与 RK 已就绪')
  report.checks.push('Connection repair returns to ready without submitting the retained draft')
  await setGate('old')
  await ui.waitForText('电脑端需要更新')
  capture('phone-old-companion-light')
  await setGate('ready')
  await ui.waitForText('电脑与 RK 已就绪')
  ui.inputAscii('A long message remains editable while the connection changes. '.repeat(10), true)
  capture('phone-keyboard-long-draft')
  command(['shell', 'input', 'keyevent', '4'])
  await send('Synthetic task in Coloop QA Lab. Fill Input and Apply. Completion Applied: 1234')
  await ui.waitForText('正在执行')
  capture('phone-running-light')
  await ui.waitForText('结果已验证', 60000)
  capture('phone-completed-light')
  assert.equal(state().started, 1)
  report.checks.push(
    'Conversation displays receiving, execution and verified result with a visible Stop control',
  )
  ui.setDisplay({ night: 'yes', fontScale: 1.3 })
  await ui.waitForText('Coloop')
  capture('phone-dark-font-1.3')
  report.checks.push('Native dark theme and font scaling remain functional')
  await send('STOP test in Coloop QA Lab. Fill Input and Apply. Completion Applied: 1234')
  await ui.waitForText('停止任务')
  if (rotation) {
    command(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'])
    command(['shell', 'settings', 'put', 'system', 'user_rotation', '1'])
    await pause(1200)
    ui.inputAscii('Next task draft', true)
    await pause(500)
    capture('phone-landscape-active-keyboard')
    assert.ok(ui.hierarchy().some((n) => n['content-desc'] === '停止任务'))
  }
  await ui.tapText('停止任务')
  if (rotation) {
    command(['shell', 'input', 'keyevent', '4'])
    command(['shell', 'settings', 'put', 'system', 'user_rotation', '0'])
    await pause(1000)
  }
  await ui.waitForText('恢复接收新任务')
  if (rotation) {
    assert.ok(
      ui
        .hierarchy()
        .some((n) => n.class === 'android.widget.EditText' && n.text === 'Next task draft'),
    )
    report.checks.push(
      'Landscape keyboard keeps Stop reachable and retains the next draft after cancelling the active task',
    )
  }
  capture('phone-stopped-dark-font-1.3')
  report.checks.push('Stop remains reachable at large font and requires explicit resume')
  await setGate('stop')
  await ui.waitForText('电脑已离线', 60000)
  await send('This draft must remain while offline')
  await ui.waitForText('消息会保留')
  capture('phone-offline-dark-font-1.3')
  report.checks.push('Offline send gives an actionable error and retains the message')
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.message
  ui.screenshot('chat-ui-failure')
  throw error
} finally {
  ui.restoreDisplaySettings()
  if (rotation)
    for (const [key, value] of Object.entries(rotation)) {
      const name = key === 'auto' ? 'accelerometer_rotation' : 'user_rotation'
      command([
        'shell',
        'settings',
        value === 'null' ? 'delete' : 'put',
        'system',
        name,
        ...(value === 'null' ? [] : [value]),
      ])
    }
  writeFileSync(join(output, 'verification.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      passed: report.passed,
      checks: report.checks.length,
      output,
      error: report.error,
    }),
  )
}
