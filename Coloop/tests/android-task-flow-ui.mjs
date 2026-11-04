import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
const dir = resolve('.impeccable/review/android-0.6.0')
mkdirSync(dir, { recursive: true })
process.env.COLOOP_ANDROID_QA_DIR = dir
const u = await import('../scripts/android-phone-qa.mjs')
const adb = resolve('.cache/android-toolchain/sdk/platform-tools/adb.exe')
const cmd = (a) =>
  execFileSync(adb, ['-s', 'emulator-5554', ...a], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  })
const back = () => cmd(['shell', 'input', 'keyevent', '4'])
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const host = () => JSON.parse(readFileSync('.qa/android-task-flow-060/state.json', 'utf8'))
const field = () =>
  u
    .hierarchy()
    .find((n) => n.class === 'android.widget.EditText' && n.package === 'ai.coloop.mobile')
const report = {
  scope: 'Actual Android/encrypted gateway with explicitly synthetic model/HID',
  checks: [],
}
async function send(text) {
  await u.waitForText('电脑与 RK 已就绪', 60000)
  const count = host().violoop.tasks.length
  u.inputAscii(text, true)
  back()
  await pause(1000)
  await u.tapText('发送消息')
  const end = Date.now() + 30000
  while (Date.now() < end) {
    if (host().violoop.tasks.length > count) return
    await pause(500)
  }
  throw Error('No task admission for QA message')
}
try {
  u.setDisplay({ night: 'no', fontScale: 1 })
  cmd(['shell', 'am', 'start', '-n', 'ai.coloop.mobile/.MainActivity'])
  await u.waitForText('发送消息')
  await pause(1500)
  await send('Hello task journey')
  await u.waitForText('已回复')
  u.screenshot('reply-next-action')
  u.inputAscii('Keep my draft', true)
  back()
  await pause(900)
  const before = host().violoop.tasks.length
  await u.tapText('编辑为新任务')
  await u.waitForText('替换当前草稿')
  u.screenshot('replace-draft-confirm')
  await u.tapText('保留草稿')
  assert.equal(field().text, 'Keep my draft')
  report.checks.push(
    'Editing a historic task asks before replacing an unsent draft, and Keep preserves it',
  )
  await u.tapText('编辑为新任务')
  await u.tapText('替换草稿')
  await pause(1500)
  assert.equal(field().text, 'Hello task journey')
  assert.equal(host().violoop.tasks.length, before)
  u.screenshot('reuse-editable-draft')
  back()
  report.checks.push(
    'Confirmed reuse fills an editable draft and never submits a task automatically',
  )
  await send('QQ clarify journey')
  await u.waitForText('需要你的补充')
  await u.tapText('补充信息')
  await pause(1500)
  await u.waitForText('补充原任务')
  assert.ok(u.hierarchy().some((n) => n.text === 'QQ clarify journey'))
  u.screenshot('supplement-context-keyboard')
  back()
  await u.tapText('取消补充')
  assert.equal(
    u.hierarchy().some((n) => n.text === '补充原任务'),
    false,
  )
  report.checks.push(
    'Supplement identifies the original task, opens the keyboard and can be cancelled',
  )
  await u.tapText('补充信息')
  u.inputAscii('More details', true)
  back()
  await pause(900)
  const count = host().violoop.tasks.length
  await u.tapText('发送消息')
  const until = Date.now() + 20000
  while (host().violoop.tasks.length === count && Date.now() < until) await pause(500)
  assert.ok(host().violoop.tasks.some((t) => t.text.includes('补充：More details')))
  report.checks.push(
    'Sending supplement creates a receipt containing the original goal plus added information',
  )
  await send('FAIL recover journey')
  await u.waitForText('未完成')
  u.screenshot('failed-next-action')
  await u.tapText('最近任务')
  await u.waitForText('全部')
  u.screenshot('history-light')
  await u.tapText('未完成')
  await u.waitForText('FAIL recover journey')
  u.screenshot('history-failed-filter')
  await u.tapText('FAIL recover journey')
  await u.waitForText('编辑为新任务')
  report.checks.push(
    'Recent tasks filter incomplete results and locate the selected task in its conversation',
  )
  await u.tapText('编辑为新任务')
  await pause(1200)
  assert.equal(field().text, 'FAIL recover journey')
  back()
  report.checks.push(
    'Failure recovery returns the original goal to editable draft without automatic replay',
  )
  u.setDisplay({ night: 'yes', fontScale: 1.3 })
  await pause(1500)
  await u.tapText('最近任务')
  await u.waitForText('回到聊天')
  u.screenshot('history-dark-font-1.3')
  await u.tapText('回到聊天')
  report.checks.push('Recent tasks remain readable and dismissible in dark/font1.3')
  u.setDisplay({ night: 'no', fontScale: 1 })
  cmd(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'])
  cmd(['shell', 'settings', 'put', 'system', 'user_rotation', '1'])
  await pause(1200)
  await u.tapText('最近任务')
  await u.waitForText('回到聊天')
  u.screenshot('history-landscape')
  await u.tapText('回到聊天')
  cmd(['shell', 'settings', 'put', 'system', 'user_rotation', '0'])
  await pause(1000)
  writeFileSync('.qa/android-task-flow-060/request.txt', 'stop')
  await u.waitForText('电脑已离线', 60000)
  u.inputAscii('Offline journey draft', true)
  back()
  await pause(900)
  await u.tapText('发送消息')
  await u.waitForText('重试连接')
  assert.equal(field().text, 'Offline journey draft')
  u.screenshot('offline-recovery')
  report.checks.push(
    'Landscape history closes normally; offline blocked send preserves draft and presents in-place recovery',
  )
  report.passed = true
} catch (e) {
  report.passed = false
  report.error = e.message
  u.screenshot('failure')
  process.exitCode = 1
} finally {
  u.restoreDisplaySettings()
  cmd(['shell', 'settings', 'put', 'system', 'user_rotation', '0'])
  writeFileSync(join(dir, 'verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
