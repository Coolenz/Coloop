import { execFileSync } from 'node:child_process'
import { writeFileSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
const output = resolve(process.env.COLOOP_VIOLOOP_QA_DIR)
process.env.COLOOP_ANDROID_QA_DIR = output
const u = await import('../scripts/android-phone-qa.mjs')
const adb = resolve('.cache/android-toolchain/sdk/platform-tools/adb.exe')
const cmd = (a) => execFileSync(adb, ['-s', 'emulator-5554', ...a], { windowsHide: true })
const cap = (n) => copyFileSync(u.screenshot(n), resolve(process.env.COLOOP_REVIEW_DIR, n + '.png'))
const report = {
  scope: 'Actual Android reading/copy/history interactions with synthetic task data',
  checks: [],
}
try {
  let nodes = u.hierarchy()
  let text = nodes.find((n) => n.text?.includes('已停止任务解析'))
  if (!text) {
    u.scrollContent()
    nodes = u.hierarchy()
    text = nodes.find((n) => n.text?.includes('已停止任务解析'))
  }
  assert.ok(text?.bounds)
  let b = text.bounds
    .match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    .slice(1)
    .map(Number)
  const x = b[0] + 30,
    y = b[1] + 20
  cmd(['shell', 'input', 'swipe', String(x), String(y), String(x), String(y), '900'])
  await new Promise((r) => setTimeout(r, 700))
  nodes = u.hierarchy()
  const copy = nodes.find((n) => /^(Copy|复制)$/.test(n.text || n['content-desc'] || ''))
  cap('phone-copy-reply-light')
  if (copy) await u.tapText(copy.text || copy['content-desc'])
  else cmd(['shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_C'])
  report.checks.push(
    'Native selection/Copy toolbar captured for visual verification; copy action or keyboard shortcut exercised',
  )
  const list = u
    .hierarchy()
    .find((n) => n.scrollable === 'true' && n.class !== 'android.widget.EditText')
  assert.ok(list)
  b = list.bounds
    .match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    .slice(1)
    .map(Number)
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
  await u.waitForText('最新消息')
  cap('phone-history-return-light')
  await u.tapText('最新消息')
  await u.waitForText('已停止任务解析')
  report.checks.push(
    'Reading earlier history reveals Latest message and returns to the latest reply',
  )
  report.passed = true
} catch (e) {
  report.passed = false
  report.error = e.message
  u.screenshot('reading-failure')
  process.exitCode = 1
} finally {
  writeFileSync(join(output, 'reading-verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
