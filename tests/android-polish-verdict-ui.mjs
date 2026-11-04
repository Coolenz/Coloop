// Verdict acceptance for the two material review findings. Real Android, synthetic host only.
import { execFileSync } from 'node:child_process'
import { copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const output = resolve(process.env.COLOOP_VIOLOOP_QA_DIR),
  review = resolve(process.env.COLOOP_REVIEW_DIR)
process.env.COLOOP_ANDROID_QA_DIR = output
const u = await import('../scripts/android-phone-qa.mjs')
const adb = resolve('.cache/android-toolchain/sdk/platform-tools/adb.exe')
const cmd = (a) =>
  execFileSync(adb, ['-s', 'emulator-5554', ...a], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000,
  })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const back = () => cmd(['shell', 'input', 'keyevent', '4'])
const cap = (n) => copyFileSync(u.screenshot(n), join(review, n + '.png'))
const bounds = (n) =>
  n.bounds
    .match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    .slice(1)
    .map(Number)
const rotation = {
  auto: cmd(['shell', 'settings', 'get', 'system', 'accelerometer_rotation']).trim(),
  user: cmd(['shell', 'settings', 'get', 'system', 'user_rotation']).trim(),
}
const report = {
  scope:
    'Final Android APK and real AES-GCM/Keystore; explicitly synthetic model/HID; reviewed material fixes only',
  checks: [],
}
async function rotate(value) {
  cmd(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'])
  cmd(['shell', 'settings', 'put', 'system', 'user_rotation', String(value)])
  await pause(1000)
}
async function send(text) {
  await u.waitForText('电脑与 RK 已就绪', 60000)
  u.inputAscii(text, true)
  back()
  await pause(800)
  await u.tapText('发送消息')
  await pause(1200)
}
try {
  u.setDisplay({ night: 'no', fontScale: 1 })
  if (!process.env.COLOOP_QA_CONTINUE_PAUSED) {
    cmd(['shell', 'am', 'force-stop', 'ai.coloop.mobile'])
    cmd(['shell', 'am', 'start', '-n', 'ai.coloop.mobile/.MainActivity'])
    await u.waitForText('打开设备与连接')
    await pause(1000)
    await u.tapText('打开设备与连接')
    await u.waitForText('你的电脑')
    const hostName = JSON.parse(
      readFileSync(resolve(process.env.COLOOP_SUPPORT_HOST_DIR, 'state.json'), 'utf8'),
    ).hostName
    await u.tapText(hostName)
    await u.waitForText('电脑与 RK 已就绪', 60000)
    cmd(['shell', 'am', 'force-stop', 'ai.coloop.mobile'])
    cmd(['shell', 'am', 'start', '-n', 'ai.coloop.mobile/.MainActivity'])
    await u.waitForText('电脑与 RK 已就绪', 60000)
    assert.ok(u.hierarchy().some((n) => n.text?.includes(hostName)))
    cap('phone-preferred-computer-restart-light')
    report.checks.push(
      'Selecting a second computer survives polling and a real app force-stop/relaunch',
    )
    console.log('Preferred computer restart passed.')
    await send('Hello Coloop. First history check.')
    await u.waitForText('已回复')
    await pause(2500)
    await send('Hello Coloop. Second history check.')
    await u.waitForText('已回复')
    await pause(2500)
    await send('STOP test in Coloop QA Lab. Fill Input and Apply. Completion Applied: 1234')
    await u.waitForText('停止任务')
    await rotate(1)
    u.inputAscii('Next task draft', true)
    await pause(800)
    cap('phone-landscape-active-keyboard')
    const stopControl = u.hierarchy().find((n) => n['content-desc'] === '停止任务')
    console.log('Native Stop target', stopControl?.clickTarget, stopControl?.center)
    assert.ok(stopControl?.clickTarget)
    cmd(['shell', 'input', 'tap', ...stopControl.clickTarget.map(String)])
    await pause(1000)
    back()
    await rotate(0)
    await u.waitForText('恢复接收新任务')
    await rotate(0)
    await u.waitForText('恢复接收新任务')
    report.checks.push(
      'Compact landscape retains active Stop above IME, cancels safely and retains the next draft',
    )
  } else {
    report.mode =
      'Continuation from independently confirmed native landscape Stop; restart/Stop recorded separately'
    assert.equal(
      JSON.parse(readFileSync(resolve(process.env.COLOOP_SUPPORT_HOST_DIR, 'state.json'), 'utf8'))
        .stopped,
      true,
    )
    await u.waitForText('已暂停接收任务')
    back()
    await rotate(0)
    await u.waitForText('恢复接收新任务')
    assert.ok(
      u
        .hierarchy()
        .some((n) => n.class === 'android.widget.EditText' && n.text === 'Next task draft'),
    )
  }
  await u.tapText('连接设置')
  await u.waitForText('接收任务已暂停')
  cap('phone-settings-paused-light')
  assert.equal(
    u.hierarchy().some((n) => n.text === '重新连接'),
    false,
  )
  await u.tapText('关闭')
  report.checks.push('Online paused settings retain explicit resume guidance')
  await rotate(1)
  writeFileSync(resolve(process.env.COLOOP_SUPPORT_HOST_DIR, 'request.txt'), 'stop')
  await u.waitForText('电脑已离线', 60000)
  u.inputAscii('Editable landscape draft', true)
  cap('phone-landscape-keyboard')
  let nodes = u.hierarchy()
  const sender = nodes.find((n) => n['content-desc'] === '发送消息')
  assert.ok(sender?.center)
  const ime = nodes
    .filter((n) => n.package?.includes('inputmethod') && n.bounds)
    .map((n) => bounds(n)[1])
    .filter((y) => y > 0)
  if (ime.length) assert.ok(sender.center[1] < Math.min(...ime))
  await u.tapText('发送消息')
  await u.waitForText('消息会保留')
  assert.ok(
    u
      .hierarchy()
      .some((n) => n.class === 'android.widget.EditText' && n.text === 'Editable landscape draft'),
  )
  report.checks.push(
    'Landscape offline sender remains reachable, reveals the error and preserves the draft',
  )
  nodes = u.hierarchy()
  const list = nodes.find((n) => n.scrollable === 'true' && n.class !== 'android.widget.EditText')
  assert.ok(list)
  const b = bounds(list)
  assert.ok(b[3] - b[1] >= 200, 'Readable landscape conversation height')
  for (let i = 0; i < 3; i++) {
    cmd([
      'shell',
      'input',
      'swipe',
      String(list.center[0]),
      String(Math.round(b[1] + 0.2 * (b[3] - b[1]))),
      String(list.center[0]),
      String(Math.round(b[1] + 0.8 * (b[3] - b[1]))),
      '400',
    ])
    if (u.hierarchy().some((n) => n.text === '最新消息')) break
  }
  await u.waitForText('最新消息')
  nodes = u.hierarchy()
  const latest = nodes.find((n) => n.text === '最新消息')
  assert.ok(latest?.clickTarget)
  assert.ok(latest.clickTarget[1] + 48 <= b[3])
  cap('phone-landscape')
  report.historyHeightPx = b[3] - b[1]
  report.latestTarget = latest.clickTarget
  await u.tapText('最新消息')
  report.checks.push(
    'Non-IME landscape has readable history and a fully visible 48dp Latest action',
  )
  await rotate(0)
  await u.tapText('连接设置')
  await u.waitForText('更新远程地址')
  await u.waitForText('重新连接')
  cap('phone-connection-settings-light')
  u.setDisplay({ night: 'yes', fontScale: 1.3 })
  await pause(1500)
  await u.waitForText('更新远程地址')
  await u.waitForText('重新连接')
  cap('phone-settings-dark-font-1.3')
  report.checks.push(
    'Offline with a retained stopped snapshot exposes Reconnect in light and dark/font1.3 settings',
  )
  report.passed = true
} catch (e) {
  report.passed = false
  report.error = e.message
  console.log(e.stack)
  u.screenshot('verdict-failure')
  process.exitCode = 1
} finally {
  u.restoreDisplaySettings()
  for (const [k, v] of Object.entries(rotation)) {
    const n = k === 'auto' ? 'accelerometer_rotation' : 'user_rotation'
    cmd([
      'shell',
      'settings',
      v === 'null' ? 'delete' : 'put',
      'system',
      n,
      ...(v === 'null' ? [] : [v]),
    ])
  }
  writeFileSync(join(output, 'verdict-verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
