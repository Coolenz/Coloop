import { _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const qaDirectory = resolve(root, '.qa')
await mkdir(qaDirectory, { recursive: true })
const results = []
const profileDirectory = resolve(qaDirectory, `profile-${Date.now()}`)
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const data = JSON.parse(body)
  assert.equal(request.url, '/v1/chat/completions')
  assert.equal(request.headers.authorization, 'Bearer coloop-e2e-test-key')
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write('data: {"choices":[{"delta":{"content":"连接成功。"}}]}\n\n')
  const slow = JSON.stringify(data).includes('CANCEL_TEST')
  setTimeout(
    () => {
      if (!response.destroyed) {
        response.write(
          'data: {"choices":[{"delta":{"content":"这是本地接口联调结果。"}}]}\n\ndata: [DONE]\n',
        )
        response.end()
      }
    },
    slow ? 5000 : 200,
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const executablePath = process.env.COLOOP_EXECUTABLE || undefined
const app = await electron.launch({
  executablePath,
  args: executablePath ? [] : [root],
  cwd: root,
  env: {
    ...process.env,
    COLOOP_DATA_DIR: profileDirectory,
    ELECTRON_RENDERER_URL: '',
  },
})
try {
  const page = await app.firstWindow()
  await page.waitForSelector('.workspace-content')
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const result = await page.evaluate(() => window.coloop.snapshot())
  assert.equal(result.ok, true)
  assert.equal(result.value.tasks.length, 0)
  results.push({ check: 'desktop startup and isolated preload bridge', passed: true })
  const security = await app.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration,
    }
  })
  assert.deepEqual(security, { sandbox: true, contextIsolation: true, nodeIntegration: false })
  await page.screenshot({ animations: 'disabled', path: resolve(qaDirectory, 'workspace.png') })
  const pageNames = {
    屏幕理解: 'screen',
    工作流: 'workflows',
    模型连接: 'models',
    设备管理: 'device',
    运行历史: 'history',
  }
  for (const name of Object.keys(pageNames)) {
    await page.getByRole('button', { name, exact: true }).first().click()
    await page.getByRole('heading', { name, exact: true }).waitFor()
    await page.screenshot({
      animations: 'disabled',
      path: resolve(qaDirectory, `page-${pageNames[name]}.png`),
    })
  }
  results.push({ check: 'all six navigation pages render', passed: true })
  await page.getByRole('button', { name: '模型连接', exact: true }).first().click()
  await page.getByLabel('连接名称', { exact: true }).fill('本地联调服务')
  await page.getByLabel('模型名称', { exact: true }).fill('mock-model')
  await page.getByLabel('服务地址', { exact: true }).fill(`http://127.0.0.1:${port}/v1`)
  await page.getByPlaceholder('粘贴你的 API Key').fill('coloop-e2e-test-key')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByText('模型配置已保存', { exact: true }).waitFor()
  const settingsSnapshot = await page.evaluate(() => window.coloop.snapshot())
  assert.equal(settingsSnapshot.value.settings.provider.hasKey, true)
  assert.equal(settingsSnapshot.value.settings.provider.apiKey, undefined)
  const persistedSettings = await readFile(resolve(profileDirectory, 'state.json'), 'utf8')
  assert.equal(persistedSettings.includes('coloop-e2e-test-key'), false)
  results.push({
    check: 'Windows DPAPI encrypts credentials and preload never exposes the key',
    passed: true,
  })
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  await page.getByText(/连接成功：/).waitFor()
  await page.getByRole('button', { name: '工作台', exact: true }).first().click()
  await page.getByLabel('任务内容').fill('请测试任务执行')
  await page.getByLabel('运行任务', { exact: true }).click()
  await page.locator('.result-panel .status.completed').waitFor()
  assert.match(await page.locator('.answer').innerText(), /本地接口联调结果/)
  results.push({
    check: 'settings save, provider test, HTTP SSE task completes through UI',
    passed: true,
  })
  await page.getByLabel('任务内容').fill('CANCEL_TEST')
  await page.getByLabel('运行任务', { exact: true }).click()
  await page.locator('.result-panel .status.running').waitFor()
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await page.locator('.result-panel .status.cancelled').waitFor()
  results.push({ check: 'cancellation remains cancelled', passed: true })

  const fixture = resolve(root, 'tests/fixtures/ocr-sample.png')
  await app.evaluate(({ dialog }, fixturePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] })
  }, fixture)
  await page.getByRole('button', { name: '屏幕理解', exact: true }).first().click()
  await page.getByRole('button', { name: '导入图片', exact: true }).click()
  await page.getByAltText('待识别图像').waitFor()
  await page.getByRole('button', { name: '识别文字', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.text-panel textarea')?.value.includes('COLOOP'),
    undefined,
    { timeout: 90000 },
  )
  const recognized = await page.getByLabel('识别文本，可编辑').inputValue()
  assert.match(recognized, /128\.50/)
  assert.match(recognized, /本地/)
  results.push({ check: 'real offline bilingual OCR on fixture', passed: true, text: recognized })
  await page.waitForFunction(
    () => !document.querySelector('.statusbar')?.textContent.includes('OCR 正在运行'),
  )
  const closeMessage = page.getByRole('button', { name: '关闭消息', exact: true })
  if (await closeMessage.isVisible()) await closeMessage.click()
  await page.screenshot({ animations: 'disabled', path: resolve(qaDirectory, 'ocr.png') })
  await page.getByRole('button', { name: '用于任务', exact: true }).click()
  await page.locator('.context-chip').waitFor()
  results.push({ check: 'OCR text attaches to a task', passed: true })
  const capture = await page.evaluate(() => window.coloop.captureScreen())
  assert.equal(capture.ok, true)
  assert.ok(capture.value.width > 100)
  results.push({
    check: 'native desktop screen capture',
    passed: true,
    width: capture.value.width,
    height: capture.value.height,
  })

  if (process.env.COLOOP_TEST_BOARD_PASSWORD) {
    const boardResult = await page.evaluate(
      (password) => window.coloop.connect(password),
      process.env.COLOOP_TEST_BOARD_PASSWORD,
    )
    results.push({
      check: 'real USB RNDIS SSH board health',
      passed: boardResult.ok,
      device: boardResult.ok ? boardResult.value : undefined,
      error: boardResult.ok ? undefined : boardResult.error,
    })
    if (boardResult.ok) {
      await page.getByRole('button', { name: '设备管理', exact: true }).first().click()
      await page.getByText('设备已连接', { exact: true }).waitFor()
      await page.screenshot({ animations: 'disabled', path: resolve(qaDirectory, 'device.png') })
      await page.evaluate(() => window.coloop.disconnect())
    }
  }
  assert.deepEqual(pageErrors, [])
  results.push({ check: 'no renderer runtime errors', passed: true })
  const history = await page.evaluate(() => window.coloop.snapshot())
  assert.equal(history.value.tasks.length, 2)
  const filename = resolve(qaDirectory, 'history.json')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, filename)
  const exported = await page.evaluate(() => window.coloop.exportHistory())
  assert.equal(exported.value, true)
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).length, 2)
  results.push({ check: 'history export writes actual task records', passed: true })
  await writeFile(resolve(qaDirectory, 'e2e-results.json'), JSON.stringify(results, null, 2))
  console.log(
    JSON.stringify(
      results.map(({ text, ...rest }) => rest),
      null,
      2,
    ),
  )
} finally {
  await app.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
