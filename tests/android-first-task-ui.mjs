import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
const dir = resolve('.impeccable/review/android-0.6.0')
process.env.COLOOP_ANDROID_QA_DIR = dir
const u = await import('../scripts/android-phone-qa.mjs')
const adb = resolve('.cache/android-toolchain/sdk/platform-tools/adb.exe')
const cmd = (a) =>
  execFileSync(adb, ['-s', 'emulator-5554', ...a], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const back = () => cmd(['shell', 'input', 'keyevent', '4'])
const field = () => u.hierarchy().find((n) => n.class === 'android.widget.EditText')
const host = () => JSON.parse(readFileSync('.qa/android-first-complete-060/state.json', 'utf8'))
const report = {
  scope:
    'First-run and synthetic execution acceptance, dedicated emulator data reset only; no real RK/HID',
  checks: [],
}
try {
  cmd(['shell', 'pm', 'clear', 'ai.coloop.mobile'])
  cmd(['shell', 'am', 'start', '-n', 'ai.coloop.mobile/.MainActivity'])
  await u.waitForText('连接我的电脑')
  u.screenshot('first-run')
  u.inputAscii('Hello retained first draft', true)
  back()
  await pause(800)
  await u.tapText('发送消息')
  await u.tapText('连接电脑')
  await u.waitForText('扫描配对码')
  u.screenshot('first-pair-guide')
  back()
  await u.waitForText('你的电脑')
  back()
  assert.equal(field().text, 'Hello retained first draft')
  report.checks.push(
    'Unpaired send offers direct connection recovery and Back preserves the first draft',
  )
  u.openPairing('.qa/android-first-complete-060/pairing.txt')
  await u.tapText('连接电脑')
  await u.waitForText('电脑与 RK 已就绪', 60000)
  assert.equal(field().text, 'Hello retained first draft')
  await u.tapText('发送消息')
  await u.waitForText('已回复')
  report.checks.push(
    'First pairing retains the first draft until explicit send and gets an encrypted task receipt',
  )
  u.inputAscii('Fill code in Coloop QA Lab and Apply', true)
  back()
  await pause(900)
  await u.tapText('发送消息')
  await u.waitForText('需要你的补充')
  await u.tapText('补充信息')
  await pause(1200)
  u.inputAscii('Completion Applied: 1234', true)
  back()
  await pause(800)
  await u.tapText('发送消息')
  await u.waitForText('当前任务')
  u.screenshot('active-task-banner')
  await u.tapText('查看任务')
  await u.waitForText('正在执行')
  u.screenshot('execution-progress')
  await u.waitForText('结果已验证', 60000)
  u.screenshot('completed-followup')
  assert.equal(host().started, 1)
  report.checks.push(
    'Task with missing completion condition is clarified, supplemented explicitly, located during synthetic execution and returns verified result with next action',
  )
  report.passed = true
} catch (e) {
  report.passed = false
  report.error = e.message
  u.screenshot('first-run-failure')
  process.exitCode = 1
} finally {
  writeFileSync(join(dir, 'first-run-verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
