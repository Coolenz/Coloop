// Renderer-only motion fixtures. No board, model, cloud or HID is connected.
import { _electron as electron } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', `island-motion-${Date.now()}`)
await mkdir(output, { recursive: true })
const harness = resolve(output, 'harness.cjs')
await writeFile(
  harness,
  `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{new BrowserWindow({width:480,height:344,frame:false,webPreferences:{contextIsolation:true}}).loadURL('about:blank')});app.on('window-all-closed',()=>app.quit());`,
)
const app = await electron.launch({ args: [harness], cwd: root })
const checks = []
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(() => {
    let current = {
      mode: 'suggestion',
      revision: 1,
      suggestionId: 'motion-suggestion',
      title: '整理今天的工作记录',
      detail: '已找到可以继续的工作',
      content: '将记录整理为已完成、进行中和下一步三部分。\n\n确认后可继续处理当前窗口。',
    }
    const listeners = []
    window.fixture = () => current
    window.setFixture = (next) => {
      current = { ...next, revision: current.revision + 1 }
      listeners.forEach((listener) => listener(current))
    }
    window.motionCalls = []
    window.detailStarts = 0
    window.failClose = true
    document.addEventListener('animationstart', (event) => {
      if (event.target.classList?.contains('control-detail')) window.detailStarts++
    })
    const ok = async () => ({ ok: true })
    window.coloopControl = {
      snapshot: async () => ({ ok: true, value: current }),
      onSnapshot: (listener) => {
        listeners.push(listener)
        return () => {}
      },
      stop: ok,
      openMain: ok,
      close: async () => {
        window.motionCalls.push({
          action: 'close',
          mode: current.mode,
          opacity: Number(getComputedStyle(document.querySelector('main')).opacity),
        })
        if (window.failClose) return { ok: false, error: '测试：关闭未确认，请重试' }
        window.setFixture({ mode: 'hidden' })
        return { ok: true }
      },
      closePreview: ok,
      acceptSuggestion: ok,
      dismissSuggestion: ok,
      dismissResult: ok,
      answerQuestion: ok,
      beginAnswer: ok,
      endAnswer: ok,
      beginTask: ok,
      startTask: ok,
      pauseObservation: ok,
      setExpanded: async (expanded) => {
        window.setFixture({ ...current, expanded })
        return { ok: true }
      },
      setRevealed: async (revealed, reducedMotion) => {
        window.motionCalls.push({ action: 'reveal', revealed, reducedMotion })
        return { ok: true }
      },
    }
  })
  await page.goto(pathToFileURL(resolve(root, 'out/renderer/index.html')).href + '?surface=control')
  const main = page.locator('main')
  const command = page.locator('#island-goal')
  const settle = () =>
    page.evaluate(async () => {
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      )
    })
  await main.waitFor()
  await main.dispatchEvent('mouseover')
  await page.waitForFunction(() => document.querySelector('main')?.dataset.revealed === 'true')
  await settle()
  await page.screenshot({ path: resolve(output, 'expanded-details.png') })

  // A new status should animate once; identical polling snapshots must not flash again.
  await page.evaluate(() => window.setFixture({ ...window.fixture(), detail: '工作记录已准备好' }))
  await page.getByText('工作记录已准备好', { exact: true }).waitFor()
  await settle()
  const starts = await page.evaluate(() => {
    window.previousDetail = document.querySelector('.control-detail')
    return window.detailStarts
  })
  assert.ok(starts > 0, 'status updates have visible animation feedback')
  await page.evaluate(() => window.setFixture({ ...window.fixture() }))
  await settle()
  assert.equal(await page.evaluate(() => window.detailStarts), starts, 'same status never replays')
  assert.equal(
    await page.evaluate(() => window.previousDetail === document.querySelector('.control-detail')),
    true,
  )
  checks.push('same-status refresh does not restart feedback')

  // Keep the exit frame visible, but remove its controls from keyboard/pointer interaction.
  await page.evaluate(() => document.querySelector('[aria-label="收起灵动岛"]').click())
  await page.waitForFunction(() => document.querySelector('main')?.dataset.revealed === 'false')
  const exiting = await page.evaluate(() => {
    const form = document.querySelector('.island-command')
    const panel = document.querySelector('.island-panel')
    const actions = document.querySelector('.island-header-actions')
    document.querySelector('#island-goal').focus()
    return {
      inert: [form, panel, actions].every((element) => element.inert),
      hidden: [form, panel, actions].every(
        (element) => element.getAttribute('aria-hidden') === 'true',
      ),
      focusedHiddenInput: document.activeElement.id === 'island-goal',
      opacity: Number(getComputedStyle(form).opacity),
    }
  })
  assert.equal(exiting.inert, true)
  assert.equal(exiting.hidden, true)
  assert.equal(exiting.focusedHiddenInput, false)
  assert.ok(exiting.opacity > 0, 'content remains painted during its exit transition')
  checks.push('exiting content is immediately inert and removed from accessibility navigation')
  await main.dispatchEvent('mouseover')
  await page.waitForFunction(() => document.querySelector('main')?.dataset.revealed === 'true')
  await settle()
  assert.equal(await command.evaluate((element) => element.closest('form').inert), false)
  assert.equal(
    await command.evaluate((element) => getComputedStyle(element.closest('form')).opacity),
    '1',
  )
  await command.fill('保留动画期间输入的草稿')
  checks.push('reversing collapse restores visible interactive content')

  // This changes the live media query rather than only testing the preference at launch.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForFunction(() =>
    window.motionCalls.some(
      (call) => call.action === 'reveal' && call.revealed === true && call.reducedMotion === true,
    ),
  )
  await page.evaluate(() => document.querySelector('[aria-label="收起灵动岛"]').click())
  await page.waitForFunction(() => document.querySelector('main')?.dataset.revealed === 'false')
  const reduced = await page.locator('.island-command').evaluate((element) => {
    const style = getComputedStyle(element)
    return { transform: style.transform, opacity: style.opacity, visibility: style.visibility }
  })
  assert.deepEqual(reduced, { transform: 'none', opacity: '0', visibility: 'hidden' })
  await main.dispatchEvent('mouseover')
  await page.waitForFunction(() => document.querySelector('main')?.dataset.revealed === 'true')
  await settle()
  await page.screenshot({ path: resolve(output, 'reduced-motion-details.png') })
  checks.push('live reduced-motion preference removes spatial transitions')

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForFunction(() => window.motionCalls.at(-1)?.reducedMotion === false)
  await page.getByRole('button', { name: '关闭灵动岛', exact: true }).click()
  await page.getByText('测试：关闭未确认，请重试', { exact: true }).waitFor()
  await settle()
  assert.equal(await main.evaluate((element) => getComputedStyle(element).opacity), '1')
  assert.equal(await command.inputValue(), '保留动画期间输入的草稿')
  assert.equal(await command.isEditable(), true)
  const failedClose = await page.evaluate(() =>
    window.motionCalls.find((call) => call.action === 'close'),
  )
  assert.ok(failedClose.opacity < 0.01, 'idle close animates out before fixture IPC')
  await command.fill('关闭失败后仍能继续输入')
  checks.push('close failure restores opacity, editability and draft')

  await page.evaluate(() => window.setFixture({ mode: 'controlling' }))
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭灵动岛', exact: true }).click()
  await page.getByText('测试：关闭未确认，请重试', { exact: true }).waitFor()
  const activeClose = await page.evaluate(() =>
    window.motionCalls.filter((call) => call.action === 'close').at(-1),
  )
  assert.equal(activeClose.mode, 'controlling')
  assert.equal(activeClose.opacity, 1, 'active close does not wait for decorative exit')
  checks.push('active close reaches IPC without hiding control feedback')

  assert.deepEqual(errors, [])
  await writeFile(
    resolve(output, 'verification.json'),
    JSON.stringify(
      {
        scope: 'renderer-only Electron fixtures; no native resize, board, model, cloud or HID',
        passed: checks.length,
        checks,
        errors,
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ passed: checks.length, output }))
} finally {
  await app.close()
}
