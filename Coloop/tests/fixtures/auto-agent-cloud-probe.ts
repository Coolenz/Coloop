import { app, BrowserWindow, net, safeStorage } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { AppStore } from '../../src/main/infrastructure/store'
import { ModelUsageLedger } from '../../src/main/infrastructure/model-usage'
import { testDecisionModel } from '../../src/main/infrastructure/decision-model-probe'
import { AutoAgentPlanner } from '../../src/main/services/auto-agent-planner'
import type { AutoAgentTask } from '../../src/shared/auto-agent-work'

const root = process.env.COLOOP_CLOUD_SMOKE_ROOT!
const cache = process.env.COLOOP_CLOUD_SMOKE_CACHE!
const reportPath = process.env.COLOOP_CLOUD_SMOKE_REPORT!
const production = process.env.COLOOP_CLOUD_SMOKE_DATA!
const parentId = process.env.COLOOP_CLOUD_SMOKE_ID!
const screenshotOnly = process.env.COLOOP_CLOUD_SMOKE_SCREENSHOT_ONLY === '1'
const started = Date.now()
const report: Record<string, any> = { passed: false, scope: 'real-cloud-official-dsh-with-synthetic-task-evidence', mode: screenshotOnly ? 'screenshot_only' : 'baseline', cases: [] }
// Electron's Windows encryption key is bound to the existing Local State.
// Reuse that persistent key store without copying it; Chromium session/cache
// data and all test inputs still live in the workspace. No Coloop UI is opened.
app.setName('Coloop')
app.setPath('userData', production)
app.commandLine.appendSwitch('disk-cache-dir', join(cache, 'electron-session-cache'))
app.commandLine.appendSwitch('disable-http-cache')
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => { /* The probe writes its report before app.exit(). */ })
let exit = 1
let usage: ModelUsageLedger | undefined
let before: ReturnType<ModelUsageLedger['snapshot']> | undefined
void (async () => {
try {
  report.stage = 'electron_ready'
  await app.whenReady()
  if (!safeStorage.isEncryptionAvailable()) throw Error('SAFE_STORAGE_UNAVAILABLE')
  const stateBefore = createHash('sha256').update(await readFile(join(production, 'state.json'))).digest('hex')
  report.stage = 'read_store'
  const store = new AppStore(production, {
    encrypt() { throw Error('PRODUCTION_WRITE_FORBIDDEN') },
    decrypt(value) { return safeStorage.decryptString(Buffer.from(value, 'base64')) },
  }, { readOnly: true })
  report.stage = 'decrypt_configured_route'
  const route = store.decisionModel()
  report.model = route.provider.model
  report.role = route.role
  usage = new ModelUsageLedger(production, () => store.config.modelLimits)
  before = usage.snapshot()
  const signal = AbortSignal.timeout(5 * 60_000)
  const settings = { workspace: cache, cacheDirectory: join(cache, 'capability'), nodePath: process.env.COLOOP_CLOUD_SMOKE_NODE!, runtimeResources: join(root, 'resources', 'harness'), usage, fetch: net.fetch as typeof fetch, signal }
  if (!screenshotOnly) {
    report.stage = 'model_capability'
    report.capability = await testDecisionModel(route, settings)
    route.provider.imageInput = report.capability.image
  }

  const fixtureDirectory = join(cache, 'fixture')
  await mkdir(fixtureDirectory, { recursive: true })
  const acceptance = ['合成验收报告的测试结果为通过', '合成验收报告的安装核验结果为通过']
  const makeTask = (name: string, text: string): AutoAgentTask => ({
    id: randomUUID(), version: 1, costTaskId: parentId, goal: '验收此合成测试任务；有遗漏则给执行 Agent 具体推进指令，全部要求满足才完成。',
    authorization: '只准备当前绑定合成任务的推进决定；允许执行 Agent 在该合成任务内补做测试和安装核验。不进行实际部署。',
    acceptance, supplements: [], state: 'watching', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastEvaluatedRevision: -1,
    session: { id: name, source: 'chatgpt-desktop', instanceId: 'synthetic-instance', sessionId: name, title: name, workspace: fixtureDirectory, revision: 1, state: 'idle', lastSeenAt: new Date().toISOString(), capabilities: { events: 'verified', nativeContinue: 'verified', reply: 'unknown', stop: 'unknown', desktopWrite: 'unknown' } },
    events: [{ id: name + '-event', sessionId: name, instanceId: 'synthetic-instance', revision: 1, type: 'stopped', at: new Date().toISOString(), origin: 'agent', text }],
    decisions: [], actions: [], feedback: [], memory: { status: 'unavailable', references: [], version: 1, error: 'SYNTHETIC_MEMORY_UNAVAILABLE' },
  })
  if (screenshotOnly) {
    report.stage = 'synthetic_window_screenshot'
    // This run tests the image tool route directly after the separately reported
    // capability probe. It never saves this opt-in as a production capability.
    route.provider.imageInput = 'supported'
    report.imageRoute = 'test_only_opt_in; fresh random screenshot challenge is required to pass'
    const challenge = 'JOB-' + randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()
    const screenshotPath = reportPath.replace(/\.json$/, '-screenshot.png')
    const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
      *{box-sizing:border-box}body{margin:0;background:#f4f5f6;color:#20242b;font:20px 'Microsoft YaHei UI','Segoe UI',sans-serif;padding:42px}main{max-width:900px;margin:auto;background:white;padding:34px 40px;border:1px solid #ccd1d7}h1{font-size:29px;margin:0 0 10px}.code{font:24px Consolas,monospace;margin:14px 0 26px}p{margin:18px 0;line-height:1.7}.row{border-top:1px solid #d7dbe0;padding:18px 0;font-size:23px}.option{padding:17px 20px;border:2px solid #3e4b59;margin:14px 0;font-size:23px}small{font-size:16px;color:#526070}</style><main>
      <h1>任务正在等待你的选择</h1><small>无隐私的合成 Agent 验收界面</small><div class="code">工单码：${challenge}</div>
      <div class="row">测试结果：已通过</div><div class="row">安装核验：尚未执行</div>
      <p>请选择下一步，并在回复中带上上方工单码：</p>
      <div class="option">A　继续完成安装核验，再报告实际结果</div><div class="option">B　立即结束任务，跳过安装核验</div>
      </main></html>`
    const window = new BrowserWindow({ width: 1060, height: 860, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
    const observedModes: string[] = []
    let screenshotBytes = 0
    try {
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      await window.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))')
      if (window.isVisible()) throw Error('SYNTHETIC_WINDOW_MUST_STAY_HIDDEN')
      const planner = new AutoAgentPlanner({ ...settings, model: () => route, observe: async (_task, mode, observeSignal) => {
        observeSignal.throwIfAborted()
        observedModes.push(mode)
        if (mode !== 'image') throw Error('SCREENSHOT_CASE_REQUIRES_IMAGE')
        const screenshot = await window.webContents.capturePage()
        if (screenshot.isEmpty()) throw Error('EMPTY_SYNTHETIC_SCREENSHOT')
        const png = screenshot.toPNG()
        screenshotBytes = png.length
        if (screenshotBytes < 1000) throw Error('INVALID_SYNTHETIC_SCREENSHOT')
        await writeFile(screenshotPath, png)
        // No UI text, option labels or challenge code travel in the text channel.
        return { id: 'captured-agent-window', source: 'electron_capturePage_synthetic_window', text: '', dataUrl: screenshot.toDataURL() }
      } })
      const task = makeTask('screenshot-question', '当前 Agent 的问题只显示在图像里。原生事件不含问题正文或工单码；使用 image 观察后再回答，禁止猜测。')
      task.goal = '读取当前任务界面并回答业务选择，使未完成的必要验收继续推进。回复必须包含图像里的选项字母和完整工单码。该界面只提供 image 观察，不提供控件文本或 OCR。'
      task.session.state = 'awaiting_input'
      const at = Date.now(), result = await planner.decide(task, signal)
      const message = result.output.message ?? ''
      const plainMessage = message.replaceAll('*', '')
      const correctOption = /(?:选择|选项|选|回复|回答)[：:\s“"']*A\b|^\s*A\b|\bA\s*[：:、，-]\s*继续/i.test(plainMessage)
      const passed = observedModes.includes('image') && ['reply', 'continue'].includes(result.output.action) && correctOption && message.includes(challenge)
      report.cases.push({ name: 'real-screenshot-question', passed, elapsedMs: Date.now() - at, observedModes, screenshotPath, screenshotBytes, hiddenWindow: !window.isVisible(), textChannelContainsUiText: false, challengeReadCorrectly: message.includes(challenge), correctOption, decision: result.output })
    } finally { window.destroy() }
  } else {
  const observedModes: string[] = []
  const planner = new AutoAgentPlanner({ ...settings, model: () => route,
    observe: async (_task, mode) => { observedModes.push(mode); return { id: 'ocr-observed-question', source: 'synthetic_ocr_fixture', text: 'Agent 当前问题：测试已通过，但安装核验未进行。选择 A：继续完成安装核验；选择 B：现在结束任务。' } },
  })
  for (const [name, installed] of [['complete', true], ['missing-install', false]] as const) {
    await writeFile(join(fixtureDirectory, 'acceptance-report.json'), JSON.stringify({ syntheticFixture: true, tests: 'passed', installationVerification: installed ? 'passed' : 'not_run' }))
    const task = makeTask(name, '执行轮次已结束。请独立读取绑定工作区内 acceptance-report.json，并依据其中真实字段逐项判断完成条件。')
    const at = Date.now(), result = await planner.decide(task, signal)
    const passed = installed ? result.output.action === 'complete' && result.output.acceptance?.verdict === 'pass'
      : ['continue', 'reply'].includes(result.output.action) && !!result.output.message
    report.cases.push({ name, passed, elapsedMs: Date.now() - at, decision: result.output })
  }
  const ocrTask = makeTask('ocr-question', '当前问题只显示在界面，原生消息没有正文；必须通过 OCR 读取当前问题再决定。')
  ocrTask.goal = '当前合成 Agent 正等待选择。请明确使用 OCR 读取问题，并在原任务授权内回答正确选项，推进尚未完成的安装核验。'
  const at = Date.now(), ocr = await planner.decide(ocrTask, signal)
  report.cases.push({ name: 'ocr-question', passed: observedModes.includes('ocr') && ['reply', 'continue'].includes(ocr.output.action) && !!ocr.output.message,
    elapsedMs: Date.now() - at, observedModes, decision: ocr.output })
  }
  report.usage = usage.taskSnapshot(parentId)
  const after = usage.snapshot()
  report.totalUsageIncludingProbe = { requests: after.requests - before.requests, tokenUnits: after.tokenUnits - before.tokenUnits, estimatedCostYuan: after.estimatedCostYuan - before.estimatedCostYuan, unpricedRequests: after.unpricedRequests - before.unpricedRequests }
  report.productionStateUnchanged = stateBefore === createHash('sha256').update(await readFile(join(production, 'state.json'))).digest('hex')
  report.passed = report.cases.every((entry: any) => entry.passed) && report.productionStateUnchanged
  exit = report.passed ? 0 : 1
} catch (error) {
  report.error = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'CLOUD_SMOKE_FAILED'
  report.errorKind = error instanceof Error ? error.name : 'unknown'
  if (error instanceof Error && /decrypt/i.test(error.message)) report.error = 'MODEL_KEY_DECRYPT_FAILED'
} finally {
  if (usage && before) {
    const after = usage.snapshot()
    report.usage = usage.taskSnapshot(parentId)
    report.totalUsageIncludingProbe = { requests: after.requests - before.requests, tokenUnits: after.tokenUnits - before.tokenUnits, estimatedCostYuan: after.estimatedCostYuan - before.estimatedCostYuan, unpricedRequests: after.unpricedRequests - before.unpricedRequests }
  }
  report.elapsedMs = Date.now() - started
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  app.exit(exit)
}
})()
