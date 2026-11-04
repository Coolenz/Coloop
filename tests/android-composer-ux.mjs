import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
const dir = resolve('.impeccable/review/android-0.5.1')
mkdirSync(dir, { recursive: true })
process.env.COLOOP_ANDROID_QA_DIR = dir
const u = await import('../scripts/android-phone-qa.mjs')
const adb = resolve('.cache/android-toolchain/sdk/platform-tools/adb.exe')
const cmd = (a) =>
  execFileSync(adb, ['-s', 'emulator-5554', ...a], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000,
  })
const pause = (ms) => new Promise((r) => setTimeout(r, ms)),
  back = () => cmd(['shell', 'input', 'keyevent', '4'])
const field = () =>
  u
    .hierarchy()
    .find((n) => n.class === 'android.widget.EditText' && n.package === 'ai.coloop.mobile')
async function longInput(letter) {
  u.inputAscii(letter, true)
  await pause(400)
  assert.equal(field().text.length, 1)
  for (let i = 0; i < 25; i++) {
    cmd(['shell', 'input', 'text', letter.repeat(80)])
    await pause(250)
  }
  for (let i = 0; i < 8; i++) {
    const current = field().text.length
    if (current === 2001) return
    if (current > 2001) throw new Error('Long input fixture exceeded intended length')
    cmd(['shell', 'input', 'text', letter.repeat(Math.min(80, 2001 - current))])
    await pause(400)
  }
  assert.equal(field().text.length, 2001)
}
const report = {
  scope: 'Native Android emulator; local composer/options only; no model or HID task',
  checks: [],
}
const rotation = {
  auto: cmd(['shell', 'settings', 'get', 'system', 'accelerometer_rotation']).trim(),
  user: cmd(['shell', 'settings', 'get', 'system', 'user_rotation']).trim(),
}
try {
  u.setDisplay({ night: 'no', fontScale: 1 })
  cmd(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'])
  cmd(['shell', 'settings', 'put', 'system', 'user_rotation', '0'])
  cmd(['shell', 'am', 'force-stop', 'ai.coloop.mobile'])
  cmd(['shell', 'am', 'start', '-n', 'ai.coloop.mobile/.MainActivity'])
  await u.waitForText('发送消息')
  await pause(1500)
  await u.tapText('任务选项')
  await u.waitForText('窗口标题')
  u.inputAscii('W'.repeat(251), true)
  back()
  await pause(700)
  await u.waitForText('251 / 250')
  assert.equal(field().text.length, 251)
  u.screenshot('options-overlimit-light')
  report.checks.push('Over-limit window stays intact with validation instead of truncation')
  await u.tapText('取消')
  await u.tapText('任务选项')
  assert.equal(field().text, '')
  report.checks.push('Cancel discards unapplied options')
  u.inputAscii('Focus Window', true)
  back()
  await pause(700)
  await u.tapText('完成')
  await u.waitForText('窗口：Focus Window')
  report.checks.push('Done applies options and shows removable chip')
  await u.tapText('任务选项')
  u.inputAscii('Unapplied edit', true)
  back()
  await pause(700)
  back()
  await u.waitForText('窗口：Focus Window')
  await u.tapText('任务选项')
  assert.equal(field().text, 'Focus Window')
  u.screenshot('options-light')
  await u.tapText('取消')
  report.checks.push('System Back discards sheet edits, retaining applied values')
  await u.tapText('清除窗口限制')
  await longInput('A')
  back()
  await pause(1000)
  assert.equal(field().text.length, 2001)
  await u.waitForText('2001 / 2000')
  u.screenshot('long-message-light')
  await u.tapText('发送消息')
  await u.waitForText('消息超过 2000 字')
  assert.equal(field().text.length, 2001)
  report.checks.push('Over-limit input retains all 2001 characters and explains blocked send')
  u.setDisplay({ night: 'yes', fontScale: 1.3 })
  await pause(1500)
  await u.waitForText('2001 / 2000')
  u.screenshot('long-message-dark-font-1.3')
  report.checks.push('Over-limit feedback reflows in dark theme and font1.3')
  u.setDisplay({ night: 'no', fontScale: 1 })
  cmd(['shell', 'settings', 'put', 'system', 'user_rotation', '1'])
  await pause(1500)
  await longInput('B')
  await pause(2000)
  u.screenshot('landscape-keyboard')
  await u.tapText('发送消息')
  await u.waitForText('消息超过 2000 字')
  assert.equal(field().text.length, 2001)
  u.screenshot('landscape-error')
  report.checks.push('Landscape IME blocked send reveals explanation and retains the full draft')
  cmd(['shell', 'settings', 'put', 'system', 'user_rotation', '0'])
  await pause(1000)
  u.inputAscii('Short draft', true)
  back()
  await pause(700)
  assert.equal(
    u.hierarchy().some((n) => n.text?.includes('消息超过 2000 字')),
    false,
  )
  u.screenshot('recovered-composer')
  report.checks.push('Editing back within limit clears stale error and retains editable message')
  report.passed = true
} catch (e) {
  report.passed = false
  report.error = e.message
  u.screenshot('failure')
  process.exitCode = 1
} finally {
  u.restoreDisplaySettings()
  for (const [k, v] of Object.entries(rotation))
    cmd([
      'shell',
      'settings',
      v === 'null' ? 'delete' : 'put',
      'system',
      k === 'auto' ? 'accelerometer_rotation' : 'user_rotation',
      ...(v === 'null' ? [] : [v]),
    ])
  writeFileSync(join(dir, 'verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
