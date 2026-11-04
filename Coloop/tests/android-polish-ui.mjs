// Extra native UI acceptance for the 0.5.0 polish. Synthetic host only.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const output = resolve(process.env.COLOOP_VIOLOOP_QA_DIR)
process.env.COLOOP_ANDROID_QA_DIR = output
const u = await import('../scripts/android-phone-qa.mjs')
const review = resolve(process.env.COLOOP_REVIEW_DIR)
const adb = resolve('.cache/android-toolchain/sdk/platform-tools/adb.exe')
const cmd = (args) =>
  execFileSync(adb, ['-s', 'emulator-5554', ...args], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000,
  })
const back = () => cmd(['shell', 'input', 'keyevent', '4'])
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const cap = (n) => copyFileSync(u.screenshot(n), join(review, n + '.png'))
const report = {
  scope: 'Actual Android 0.5.0 native UI; synthetic/offline host, no real computer task',
  checks: [],
}
const rotation = {
  auto: cmd(['shell', 'settings', 'get', 'system', 'accelerometer_rotation']).trim(),
  user: cmd(['shell', 'settings', 'get', 'system', 'user_rotation']).trim(),
}
try {
  await u.tapText('连接设置')
  await u.waitForText('更新远程地址')
  u.setDisplay({ night: 'yes', fontScale: 1.3 })
  await pause(1500)
  await u.waitForText('更新远程地址')
  cap('phone-settings-dark-font-1.3')
  u.setDisplay({ night: 'no', fontScale: 1 })
  await pause(1000)
  await u.tapText('解除配对或移除本机资料')
  await u.waitForText('移除本机连接资料')
  cap('phone-remove-confirm-light')
  await u.tapText('取消')
  await u.waitForText('更新远程地址')
  await u.tapText('关闭')
  report.checks.push(
    'Connection settings reflow at font1.3/dark, and removing a connection has a working non-destructive Cancel',
  )
  await u.tapText('打开设备与连接')
  await u.waitForText('你的电脑')
  await u.tapText('更多选项')
  cap('phone-devices-menu-light')
  back()
  await u.tapText('连接另一台电脑')
  await u.waitForText('扫描配对码')
  cap('phone-pair-guide-light')
  await u.tapText('使用配对地址')
  await u.waitForText('完整配对地址')
  cap('phone-pair-manual-light')
  u.inputAscii('invalid', true)
  back()
  await u.tapText('连接电脑')
  await u.waitForText('配对内容无效')
  cap('phone-pair-invalid-light')
  assert.ok(
    u.hierarchy().some((n) => n.class === 'android.widget.EditText' && n.text === 'invalid'),
  )
  back()
  await u.waitForText('你的电脑')
  back()
  await u.waitForText('发送消息')
  report.checks.push(
    'Pair guide, manual input, invalid-link explanation, retained input, and Back-to-Devices-to-chat work',
  )
  cmd(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'])
  cmd(['shell', 'settings', 'put', 'system', 'user_rotation', '1'])
  await pause(1500)
  u.inputAscii('Editable landscape draft', true)
  await pause(700)
  cap('phone-landscape-keyboard')
  const nodes = u.hierarchy()
  const send = nodes.find((n) => n['content-desc'] === '发送消息')
  const ime = nodes
    .filter((n) => n.package?.includes('inputmethod') && n.bounds)
    .map((n) => Number(n.bounds.match(/\[\d+,(\d+)\]/)?.[1]))
    .filter((n) => n > 0)
  assert.ok(send?.center)
  if (ime.length) assert.ok(send.center[1] < Math.min(...ime), 'Send must be above IME')
  back()
  await pause(700)
  cap('phone-landscape')
  report.checks.push('Landscape keeps the composer and Send reachable above the keyboard')
  cmd(['shell', 'settings', 'put', 'system', 'user_rotation', '0'])
  await pause(1000)
  u.setDisplay({ night: 'no', fontScale: 1 })
  if (process.env.COLOOP_SECOND_PAIR_FILE) {
    u.openPairing(process.env.COLOOP_SECOND_PAIR_FILE)
    await u.tapText('连接电脑')
    await u.waitForText('电脑与 RK 已就绪', 60000)
    const ns = u.hierarchy()
    assert.equal(
      ns.some((n) => n.text === '已设置完成条件'),
      false,
    )
    assert.equal(
      ns.some((n) => n['content-desc'] === '清除窗口限制'),
      false,
    )
    cap('phone-new-computer-clean-draft')
    await u.tapText('连接设置')
    await u.tapText('解除配对或移除本机资料')
    await u.waitForText('解除这台手机的配对')
    cap('phone-unpair-online-light')
    await u.tapText('只移除本机资料')
    await u.waitForText('移除本机连接资料')
    await u.tapText('取消')
    await u.tapText('关闭')
    report.checks.push(
      'Pairing a different computer clears previous task constraints; online unpair/local-only choice can be cancelled without revoking access',
    )
  }
  report.passed = true
} catch (e) {
  report.passed = false
  report.error = e.message
  u.screenshot('polish-extra-failure')
  process.exitCode = 1
} finally {
  u.restoreDisplaySettings()
  for (const [k, v] of Object.entries(rotation)) {
    const name = k === 'auto' ? 'accelerometer_rotation' : 'user_rotation'
    cmd([
      'shell',
      'settings',
      v === 'null' ? 'delete' : 'put',
      'system',
      name,
      ...(v === 'null' ? [] : [v]),
    ])
  }
  writeFileSync(join(output, 'polish-verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
