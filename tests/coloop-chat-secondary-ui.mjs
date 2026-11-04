import { execFileSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
process.env.COLOOP_ANDROID_QA_DIR = process.env.COLOOP_VIOLOOP_QA_DIR || '.qa/coloop-chat-ui-r4'
const u = await import('../scripts/android-phone-qa.mjs')
const adb = resolve('.cache/android-toolchain/sdk/platform-tools/adb.exe')
const cmd = (args) => execFileSync(adb, ['-s', 'emulator-5554', ...args], { windowsHide: true })
const back = () => cmd(['shell', 'input', 'keyevent', '4'])
const cap = (n) =>
  copyFileSync(
    u.screenshot(n),
    resolve(process.env.COLOOP_REVIEW_DIR || '.impeccable/review', n + '.png'),
  )
const scrollSheet = () => {
  const node = u
    .hierarchy()
    .filter((n) => n.scrollable === 'true' && n.class !== 'android.widget.EditText')
    .at(-1)
  if (!node) return
  const b = node.bounds
    .match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    .slice(1)
    .map(Number)
  cmd([
    'shell',
    'input',
    'swipe',
    String(node.center[0]),
    String(Math.round(b[1] + 0.8 * (b[3] - b[1]))),
    String(node.center[0]),
    String(Math.round(b[1] + 0.2 * (b[3] - b[1]))),
    '350',
  ])
}
try {
  u.setDisplay({ night: 'no', fontScale: 1 })
  await u.tapText('任务选项')
  await u.waitForText('窗口标题（可选）')
  cap('phone-task-options-light')
  u.setDisplay({ fontScale: 1.3 })
  u.inputAscii('Coloop QA Lab', true)
  cap('phone-task-options-keyboard-font-1.3')
  back()
  await new Promise((r) => setTimeout(r, 800))
  scrollSheet()
  const second = u.hierarchy().filter((n) => n.class === 'android.widget.EditText')[1]
  if (!second?.center) throw Error('Second task option is not reachable')
  cmd(['shell', 'input', 'tap', ...second.center.map(String)])
  cmd(['shell', 'input', 'text', 'Applied:%s1234'])
  cap('phone-task-options-result-keyboard-font-1.3')
  back()
  await new Promise((r) => setTimeout(r, 800))
  scrollSheet()
  cap('phone-task-options-completion-font-1.3')
  const done = u.hierarchy().find((n) => n.text === '完成')
  console.log(JSON.stringify({ doneBounds: done?.bounds, doneTarget: done?.clickTarget }))
  await u.tapText('完成')
  await u.waitForText('发送消息')
  cap('phone-task-options-returned-chat-font-1.3')
  u.setDisplay({ fontScale: 1 })
  await u.tapText('连接设置')
  await u.waitForText('更新远程地址')
  cap('phone-connection-settings-light')
  await u.tapText('更新远程地址')
  await u.waitForText('验证并更新')
  cap('phone-connection-address-light')
  await u.tapText('返回')
  await u.tapText('关闭')
  await u.tapText('打开设备与连接')
  await u.waitForText('你的电脑')
  cap('phone-devices-light')
  back()
  console.log('Task sheet safe-area, keyboard/font scaling, settings and devices verified')
} finally {
  u.restoreDisplaySettings()
}
