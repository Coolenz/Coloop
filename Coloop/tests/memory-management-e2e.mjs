// Real SSH + Mem0 + protected credential provider; synthetic records only.
import { _electron as electron } from '@playwright/test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Client } from 'ssh2'

const root = resolve(import.meta.dirname, '..')
const password = process.env.RK_BOARD_PASSWORD
if (!password) throw new Error('RK_BOARD_PASSWORD required for explicit board acceptance')
const { RK_BOARD_PASSWORD: _secret, ...environment } = process.env
const output = resolve(root, '.qa', `memory-management-${Date.now()}`)
await mkdir(output, { recursive: true })
const report = {
  passed: false,
  realMem0: true,
  realBoard: true,
  realCloudUsed: false,
  realNpuUsed: false,
  realHidUsed: false,
  checks: [],
  screenshots: [],
}
const cfg = JSON.parse(await readFile('D:/RK/config/board.json', 'utf8'))
const ssh = new Client()
await new Promise((accept, reject) =>
  ssh
    .once('ready', accept)
    .once('error', reject)
    .connect({
      host: cfg.host,
      port: cfg.ssh_port,
      username: cfg.user,
      password,
      readyTimeout: 10_000,
      hostVerifier: (key) =>
        createHash('sha256').update(key).digest('base64').replace(/=+$/, '') ===
        cfg.host_key_sha256,
    }),
)
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const remote = (script, input = {}) =>
  new Promise((accept, reject) => {
    ssh.exec('python3 -c ' + quote(script), (error, channel) => {
      if (error) return reject(error)
      let text = ''
      channel.on('data', (chunk) => {
        text += chunk
      })
      channel.stderr.resume()
      channel.once('close', (code) =>
        code === 0 ? accept(JSON.parse(text)) : reject(new Error('Board metadata probe failed')),
      )
      channel.end(JSON.stringify(input))
    })
  })
const probe = async (secrets = []) =>
  remote(
    `import json,sys,urllib.request
from pathlib import Path
root=Path('/home/cat/rk-opencode')
values=json.load(sys.stdin)['secrets']
key=(root/'.runtime/memory-key').read_text().strip()
r=urllib.request.Request('http://127.0.0.1:8092/call',data=b'{"op":"status"}',headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
with urllib.request.urlopen(r,timeout=5) as f: status=json.load(f)
config=json.loads((root/'.runtime/memory-config.json').read_text())
folder=root/Path(config['data_dir'])
files=[p for p in folder.rglob('*') if p.is_file()]
assert files, 'No memory files found for byte scan'
clean=all(not any(v.encode() in p.read_bytes() for v in values) for p in files)
print(json.dumps({'status':status,'noSecretInMem0Files':clean,'scannedFiles':len(files),'logs':{n:(root/'logs'/n).stat().st_size if (root/'logs'/n).exists() else 0 for n in ('requests.jsonl','worker.log')}}))`,
    { secrets },
  )
const before = await probe()
assert.equal(
  before.status.jobs?.pending ?? 0,
  0,
  'Refuse to cancel another task pending extraction',
)
const executablePath = process.env.COLOOP_EXECUTABLE || undefined
const app = await electron.launch({
  executablePath,
  args: executablePath ? [] : [root],
  cwd: root,
  env: {
    ...environment,
    COLOOP_DATA_DIR: resolve(output, 'profile'),
    ELECTRON_RENDERER_URL: '',
    COLOOP_TEST_NO_HOOKS: '1',
  },
})
const marker = 'memui-' + randomBytes(6).toString('hex')
const origin = `https://${marker}.invalid`
const username = 'USER_' + randomBytes(12).toString('hex')
const secret = ' PWD_' + randomBytes(12).toString('hex') + '! '
let main, ordinaryId, privateId
const ok = (reply) => {
  assert.equal(reply.ok, true, reply.error)
  return reply.value
}
const check = (name, value = true) => {
  assert.ok(value, name)
  report.checks.push(name)
}
const browse = (input = {}) =>
  main.evaluate((input) => window.coloop.browseMemories(input), input).then(ok)
const noSecrets = (data) => ![username, secret].some((s) => JSON.stringify(data).includes(s))
try {
  main = await app.firstWindow()
  main.setDefaultTimeout(15_000)
  const errors = []
  main.on('pageerror', (e) => errors.push(e.message))
  await main.waitForSelector('.workspace-content')
  await app.evaluate(({ app, net }, origin) => {
    globalThis.__memoryCloudCalls = 0
    const original = net.fetch
    net.fetch = (...args) => {
      globalThis.__memoryCloudCalls++
      return original(...args)
    }
    app.on('session-created', (session) => {
      void session.protocol.handle('https', (request) =>
        new URL(request.url).origin === origin
          ? new Response(
              '<title>合成登录页面</title><label>账号<input type="text"></label><label>密码<input type="password"></label>',
              { headers: { 'Content-Type': 'text/html;charset=utf-8' } },
            )
          : new Response('Blocked', { status: 403 }),
      )
    })
  }, origin)
  const settings = ok(await main.evaluate(() => window.coloop.importRk()))
  if (executablePath) {
    // Keep packaged connect from reinstalling unrelated OpenCode hooks on the shared board.
    ok(
      await main.evaluate((settings) => window.coloop.saveSettings(settings), {
        ...settings,
        ocrWorkspace: resolve(output, 'no-hook-sources'),
      }),
    )
  }
  ok(await main.evaluate((value) => window.coloop.connect(value), password))
  assert.equal(await main.getByRole('button', { name: '私密凭据', exact: true }).count(), 0)
  await main.getByRole('button', { name: '记忆', exact: true }).click()
  await main.getByText('记忆管理中 · 截图与 OCR 已暂停', { exact: true }).waitFor()
  await browse()
  check('one Memory navigation entry protects the unified management page')

  await main.getByLabel('搜索记忆').fill(marker)
  await main.getByRole('button', { name: '搜索', exact: true }).click()
  await main.getByRole('button', { name: '新建记忆', exact: true }).click()
  await main.getByLabel('记忆名称', { exact: true }).fill(marker)
  await main.getByLabel('记忆内容', { exact: true }).fill(marker + ' 合成普通记忆，默认使用中文。')
  await main.getByRole('button', { name: '保存记忆', exact: true }).click()
  await main.getByText('普通记忆已保存，可参与后续召回。', { exact: true }).waitFor()
  const original = await browse({ query: marker })
  ordinaryId = original.items.find((e) => e.category === 'ordinary' && e.key === marker)?.id
  assert.ok(ordinaryId)
  check('ordinary creation reaches the existing real Mem0 store')

  await main.getByRole('button', { name: '新建记忆', exact: true }).click()
  await main.getByLabel('记忆类型', { exact: true }).selectOption('private')
  await main.getByRole('button', { name: '打开私密填写窗口', exact: true }).click()
  const privateEntry = app.windows().find((page) => page.url().includes('surface=credential-entry'))
  assert.ok(privateEntry)
  await privateEntry.getByLabel('允许的网站').fill(origin)
  await privateEntry.getByLabel('账号', { exact: true }).fill(username)
  await privateEntry.getByLabel('密码', { exact: true }).fill(secret)
  await privateEntry.getByRole('button', { name: '保存私密记忆', exact: true }).click()
  await privateEntry.getByText('私密记忆已保存，统一目录已同步。', { exact: true }).waitFor()
  await privateEntry.getByRole('button', { name: '完成并关闭', exact: true }).click()
  await main.getByText('私密记忆已保存，统一目录已同步。', { exact: true }).waitFor()
  const both = await browse({ query: marker })
  assert.equal(both.mode, 'literal')
  assert.equal(both.total, 2)
  privateId = both.items.find((e) => e.category === 'private')?.recordId
  assert.ok(privateId)
  assert.equal(both.items.find((e) => e.category === 'private').locator, 'rk-vault://' + privateId)
  check('ordinary and private records share one searchable Mem0 directory')
  check(
    'catalog and rendered page contain no private plaintext',
    noSecrets(both) && noSecrets(await main.locator('body').innerText()),
  )
  assert.equal(await main.getByLabel('密码', { exact: true }).count(), 0)
  for (const category of ['ordinary', 'private']) {
    const label = category === 'ordinary' ? '普通记忆' : '私密记忆'
    await main.getByRole('tab', { name: label, exact: true }).click()
    await main.waitForFunction(
      (c) =>
        document.querySelectorAll(`[data-memory-category="${c}"]`).length === 1 &&
        document.querySelectorAll('[data-memory-category]').length === 1,
      category,
    )
    assert.equal((await browse({ query: marker, category })).total, 1)
  }
  await main.getByRole('tab', { name: '全部', exact: true }).click()
  await main.waitForFunction(() => document.querySelectorAll('[data-memory-category]').length === 2)
  check('one search and category filters work across both kinds')
  await main
    .locator('[data-memory-category="ordinary"]')
    .getByRole('button', { name: '编辑', exact: true })
    .click()
  await main.getByLabel('记忆内容', { exact: true }).fill(marker + ' 更新后的合成内容。')
  await main.getByRole('button', { name: '保存记忆', exact: true }).click()
  await main.getByText('普通记忆已更新，历史版本保留。', { exact: true }).waitFor()
  const revised = (await browse({ query: marker, category: 'ordinary' })).items[0]
  assert.notEqual(revised.id, ordinaryId)
  ordinaryId = revised.id
  assert.equal(revised.text, marker + ' 更新后的合成内容。')
  assert.equal(revised.verified, false)
  check('ordinary editing creates a current version and marks it unverified')

  for (const operation of ['capture', 'ocr', 'task']) {
    const result = await main.evaluate(
      (op) =>
        op === 'capture'
          ? window.coloop.captureScreen()
          : op === 'ocr'
            ? window.coloop.recognize(crypto.randomUUID())
            : window.coloop.runTask({
                prompt: 'Blocked synthetic task',
                source: 'text',
                target: 'rk',
                context: '',
              }),
      operation,
    )
    assert.equal(result.ok, false)
  }
  check('capture OCR and model tasks stay blocked during unified management')
  for (const [width, height] of [
    [1440, 940],
    [1060, 720],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, { width, height }) => {
        const main = BrowserWindow.getAllWindows().find(
          (w) => !w.webContents.getURL().includes('surface='),
        )
        main.setSize(width, height)
      },
      { width, height },
    )
    await main.waitForTimeout(100)
    const overflow = await main.evaluate(() =>
      [...document.querySelectorAll('.memory-content,.sidebar')].some(
        (e) => e.scrollWidth > e.clientWidth + 1,
      ),
    )
    const path = resolve(output, `memory-${width}x${height}.png`)
    await main.screenshot({ path, animations: 'disabled' })
    report.screenshots.push(path)
    assert.equal(overflow, false)
  }
  check('unified directory fits both supported desktop sizes')

  const windowReady = app.waitForEvent('window')
  await main.getByRole('button', { name: '本地使用', exact: true }).click()
  const login = await windowReady
  await login.waitForLoadState('domcontentloaded')
  assert.equal(ok(await main.evaluate(() => window.coloop.snapshot())).credentials.loginOpen, true)
  await login.close()
  await main.waitForFunction(
    async () => !(await window.coloop.snapshot()).value.credentials.loginOpen,
  )
  check('private record opens the existing protected dedicated login window')

  const after = await probe([username, secret])
  check(
    'no synthetic plaintext in real Mem0 files',
    after.scannedFiles > 0 && after.noSecretInMem0Files,
  )
  report.scannedMem0Files = after.scannedFiles
  // Other tasks may run concurrently: the exact log delta is evidence, not an app-wide guarantee.
  report.modelLogByteDelta = Object.fromEntries(
    Object.keys(before.logs).map((n) => [n, after.logs[n] - before.logs[n]]),
  )
  assert.equal(after.status.jobs?.pending ?? 0, 0, 'Preserve another task pending extraction')
  for (const category of ['ordinary', 'private']) {
    const row = main.locator(`[data-memory-category="${category}"]`)
    await row.getByRole('button', { name: /^删除记忆 / }).click()
    await row.getByRole('button', { name: '确认删除', exact: true }).click()
    await main.waitForFunction(
      (c) => !document.querySelector(`[data-memory-category="${c}"]`),
      category,
    )
    if (category === 'ordinary') ordinaryId = undefined
    else privateId = undefined
  }
  const remaining = await browse({ query: '', category: 'all' })
  assert.equal(
    remaining.items.some((e) =>
      e.category === 'ordinary' ? e.key === marker : e.origin === origin,
    ),
    false,
  )
  check('unified delete removes both synthetic records without restoring older ordinary versions')
  const final = await probe()
  check(
    'existing ordinary facts and extraction queue remain unchanged',
    ['active_facts', 'archived_versions', 'capsules', 'jobs'].every(
      (k) => JSON.stringify(before.status[k]) === JSON.stringify(final.status[k]),
    ),
  )
  const state = ok(await main.evaluate(() => window.coloop.snapshot()))
  check(
    'no private plaintext in snapshot or task history',
    noSecrets(state) && state.tasks.length === 0,
  )
  assert.equal(await app.evaluate(() => globalThis.__memoryCloudCalls), 0)
  check('management makes no cloud calls and creates no model tasks')
  assert.deepEqual(errors, [])
  await main.getByRole('button', { name: '运行历史', exact: true }).click()
  await main.waitForFunction(
    async () => !(await window.coloop.snapshot()).value.credentials.protected,
  )
  check('leaving management releases observation protection')
  report.passed = true
} catch (error) {
  report.error = error.message
  throw error
} finally {
  if (main && (privateId || ordinaryId)) {
    // Only this run's synthetic IDs; never delete somebody else's pending extraction.
    const state = await probe().catch(() => undefined)
    if (privateId)
      await main
        .evaluate(
          (recordId) => window.coloop.removeMemory({ category: 'private', recordId }),
          privateId,
        )
        .catch(() => {})
    if (ordinaryId && state && (state.status.jobs?.pending ?? 0) === 0)
      await main
        .evaluate((id) => window.coloop.removeMemory({ category: 'ordinary', id }), ordinaryId)
        .catch(() => {})
  }
  await app.close()
  ssh.end()
  async function scan(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = resolve(folder, entry.name)
      if (entry.isDirectory()) await scan(file)
      else if (entry.isFile())
        assert.equal(
          [username, secret].some((s) =>
            (readFiles.get(file) ?? Buffer.alloc(0)).includes(Buffer.from(s)),
          ),
          false,
        )
    }
  }
  // Inspect actual persisted profile bytes after Chromium has closed its databases.
  const readFiles = new Map()
  async function readProfile(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = resolve(folder, entry.name)
      if (entry.isDirectory()) await readProfile(file)
      else if (entry.isFile()) readFiles.set(file, await readFile(file))
    }
  }
  try {
    await readProfile(resolve(output, 'profile'))
    await scan(resolve(output, 'profile'))
    check('no synthetic private plaintext in persisted Coloop profile')
    report.scannedProfileFiles = readFiles.size
  } catch (error) {
    report.passed = false
    report.profileScanError = error.message
  }
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ output, passed: report.passed, checks: report.checks.length }))
if (!report.passed) process.exitCode = 1
