import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const output = resolve(process.env.COLOOP_VIOLOOP_QA_DIR || '.qa/violoop-android')
process.env.COLOOP_ANDROID_QA_DIR = output
const ui = await import('../scripts/android-phone-qa.mjs')
const adb = join(root, '.cache/android-toolchain/sdk/platform-tools/adb.exe')
const serial = process.env.COLOOP_ANDROID_SERIAL || 'emulator-5554'
function command(args) {
  return execFileSync(adb, ['-s', serial, ...args], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000,
  })
}
const report = {
  scope:
    'Actual Android emulator and encrypted loopback transport. RK model/HID explicitly simulated. No real email sent.',
  checks: [],
}
const check = (text) => {
  report.checks.push(text)
  console.log(text)
}
const state = () => JSON.parse(readFileSync(join(output, 'state.json'), 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function selectHost() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const label = ui.hierarchy().find((node) => node.text === state().hostName)
    if (label?.center && label.center[1] < 1250) {
      command(['shell', 'input', 'tap', ...label.center.map(String)])
      return
    }
    ui.scrollContent()
  }
  throw new Error('QA host was not visible in the paired computer list')
}
async function send(text) {
  ui.inputAscii(text, true)
  command(['shell', 'input', 'keyevent', '4'])
  await ui.tapText('发送给 Violoop')
}
try {
  ui.setDisplay({ fontScale: 1, night: 'no' })
  ui.openPairing(join(output, 'pairing.txt'))
  await ui.tapText('连接电脑')
  await ui.waitForText('给 Violoop 发任务')
  await ui.tapText('给 Violoop 发任务')
  await ui.waitForText('让电脑完成任务')
  ui.screenshot('violoop-empty-light')
  check('Native Violoop entry and paired encrypted connection render without an OpenCode session')
  await send('Synthetic task: In Violoop QA Lab fill 1234 and Apply. Expected Applied: 1234')
  await ui.waitForText('正在执行')
  ui.screenshot('violoop-running-light')
  await sleep(15500)
  await ui.waitForText('结果已验证')
  assert.equal(state().started, 1)
  check(
    'Task receipt progresses to the simulated executor result; received is distinct from completion',
  )
  command(['shell', 'am', 'force-stop', 'ai.coloop.mobile'])
  command(['shell', 'am', 'start', '-n', 'ai.coloop.mobile/.MainActivity'])
  await selectHost()
  await ui.tapText('给 Violoop 发任务')
  await ui.waitForText('结果已验证', 60000)
  assert.equal(state().started, 1)
  check(
    'Android process restart restores pairing and task receipts without executing the task again',
  )
  await send('STOP synthetic understanding task')
  await ui.waitForText('RK 正在理解任务')
  await ui.tapText('停止全部控制')
  await ui.waitForText('已停止')
  assert.equal(state().started, 1)
  ui.screenshot('violoop-stop-confirmed')
  check(
    'Stop reaches a pending inference immediately and no desktop task starts from the late result',
  )
  await ui.tapText('明确恢复控制')
  await send('Open QQ Mail and send email')
  await ui.waitForText('需要补充')
  assert.equal(state().started, 1)
  ui.screenshot('violoop-clarify-light')
  await ui.tapText('补充这项任务')
  await ui.waitForText('正在补充原任务')
  await ui.tapText('改为新任务')
  check(
    'Unsupported email flow returns an explicit explanation and can be followed by a supplementary message',
  )
  ui.setDisplay({ fontScale: 1.3, night: 'yes' })
  await ui.waitForText('发送给 Violoop')
  ui.screenshot('violoop-dark-font-1.3')
  check('Task view, composer and fixed stop area remain usable in dark theme with font scale 1.3')
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.message
  ui.screenshot('violoop-failure')
  throw error
} finally {
  ui.restoreDisplaySettings()
  writeFileSync(join(output, 'verification.json'), JSON.stringify(report, null, 2))
}
