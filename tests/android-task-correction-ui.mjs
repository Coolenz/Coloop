import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
const dir = resolve('.impeccable/review/android-0.6.0')
process.env.COLOOP_ANDROID_QA_DIR = dir
const u = await import('../scripts/android-phone-qa.mjs')
const adb = resolve('.cache/android-toolchain/sdk/platform-tools/adb.exe')
const cmd = (a) =>
  execFileSync(adb, ['-s', 'emulator-5554', ...a], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000,
  })
const back = () => cmd(['shell', 'input', 'keyevent', '4'])
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const data = () => JSON.parse(readFileSync('.qa/android-uncertain-final-060/state.json', 'utf8'))
const cap = (n) => u.screenshot(n)
const pending = '已检查电脑，结束上条消息核对'
const confirm = '已核对，结束核对'
const report = {
  scope:
    'Final APK review corrections; real Android/AES-GCM with explicitly synthetic uncertain submission and snapshot faults; no HID/model task from uncertainty',
  checks: [],
}
async function gate(v) {
  writeFileSync('.qa/android-uncertain-final-060/request.txt', v)
  for (let i = 0; i < 30; i++) {
    if (data().gate === v) return
    await pause(150)
  }
  throw Error('QA gate not applied')
}
async function injectConfirm(v) {
  const n = u.hierarchy().find((n) => n.text === confirm)
  assert.ok(n?.clickTarget)
  await gate(v)
  cmd(['shell', 'input', 'tap', ...n.clickTarget.map(String)])
  await pause(1000)
}
async function closeIfOpen() {
  if (u.hierarchy().some((n) => n.text === '继续核对')) await u.tapText('继续核对')
}
async function send(t) {
  await u.waitForText('电脑与 RK 已就绪', 60000)
  u.inputAscii(t, true)
  back()
  await pause(900)
  await u.tapText('发送消息')
  await pause(1500)
}
try {
  u.setDisplay({ night: 'no', fontScale: 1 })
  u.openPairing('.qa/android-uncertain-final-060/pairing.txt')
  await u.tapText('连接电脑')
  await u.waitForText('电脑与 RK 已就绪', 60000)
  await send('UNCERTAIN do not replay')
  await u.waitForText(pending)
  await u.waitForText('电脑已离线')
  cap('pending-refresh-unavailable')
  await u.tapText(pending)
  assert.equal(
    u.hierarchy().some((n) => n.text === '已核对电脑上的结果？'),
    false,
  )
  assert.equal(data().uncertainSubmissions, 1)
  report.checks.push(
    'Cached idle plus failed post-submission snapshots cannot open reconciliation; pending is preserved without replay',
  )
  await gate('ready')
  await u.waitForText('电脑与 RK 已就绪', 60000)
  await u.tapText(pending)
  await u.waitForText(confirm)
  cap('pending-confirmation')
  await injectConfirm('snapshot-active')
  await pause(1800)
  await closeIfOpen()
  await u.waitForText('正在核对上一条消息')
  cap('pending-new-active')
  assert.equal(data().uncertainSubmissions, 1)
  report.checks.push('A newly active computer snapshot prevents clearing pending admission')
  await gate('ready')
  await u.waitForText('电脑与 RK 已就绪', 60000)
  await pause(2200)
  await u.tapText(pending)
  await u.waitForText(confirm)
  await injectConfirm('snapshot-fail')
  await pause(1200)
  await closeIfOpen()
  await u.waitForText(pending)
  cap('pending-confirm-refresh-failed')
  report.checks.push('A failed snapshot during confirmation keeps the uncertain receipt')
  await gate('ready')
  await u.waitForText('电脑与 RK 已就绪', 60000)
  await pause(2200)
  await u.tapText(pending)
  await u.waitForText(confirm)
  const snapshots = data().snapshots
  await u.tapText(confirm)
  await pause(2200)
  assert.equal(
    u.hierarchy().some((n) => n.text === pending),
    false,
  )
  assert.ok(data().snapshots > snapshots)
  assert.equal(data().uncertainSubmissions, 1)
  cap('pending-resolved-idle')
  report.checks.push(
    'Only fresh idle confirmation clears pending, with exactly one original submission and no automatic replay',
  )
  await send('Hello completed filter')
  await u.waitForText('已回复')
  await send('QQ filtered supplement')
  await u.waitForText('需要你的补充')
  await send('FAIL filtered result')
  await u.waitForText('未完成')
  await u.tapText('最近任务')
  await u.waitForText('全部')
  cap('history-light')
  await u.tapText('未完成')
  await u.waitForText('QQ filtered supplement')
  let ns = u.hierarchy()
  assert.ok(ns.some((n) => n.text === 'FAIL filtered result'))
  assert.equal(
    ns.some((n) => n.text === 'Hello completed filter'),
    false,
  )
  cap('history-failed-filter')
  await u.tapText('QQ filtered supplement')
  await u.tapText('补充信息')
  await u.waitForText('补充原任务')
  cap('history-filter-to-supplement')
  report.checks.push(
    'Unfinished filter includes awaiting-input plus failed records, excludes answered and locates the awaiting reply for supplement',
  )
  report.passed = true
} catch (e) {
  report.passed = false
  report.error = e.message
  cap('correction-failure')
  process.exitCode = 1
} finally {
  u.restoreDisplaySettings()
  writeFileSync(join(dir, 'correction-verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
