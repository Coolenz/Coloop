// Explicit hardware test. Synthetic credentials only; no cloud model or real login account.
import { _electron as electron } from '@playwright/test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from 'ssh2'

const root = resolve(import.meta.dirname, '..')
if (!process.env.RK_BOARD_PASSWORD) throw new Error('Set RK_BOARD_PASSWORD for hardware acceptance')
const password = process.env.RK_BOARD_PASSWORD
const { RK_BOARD_PASSWORD: _secret, ...childEnvironment } = process.env
const output = resolve(root, '.qa', `credential-vault-${Date.now()}`)
const profile = resolve(output, 'profile')
await mkdir(output, { recursive: true })
const report = {
  passed: false,
  realUsbHid: true,
  realCloudUsed: false,
  realNpuUsed: false,
  fixture: 'in-process HTTPS protocol fixture in an isolated real Chromium WebContentsView',
  checks: [],
}
const cfg = JSON.parse(await readFile('D:/RK/config/board.json', 'utf8'))
const ssh = new Client()
await new Promise((resolve, reject) => {
  ssh
    .once('ready', resolve)
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
    })
})
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const remote = (script) =>
  new Promise((resolve, reject) => {
    ssh.exec('python3 -c ' + quote(script), (error, channel) => {
      if (error) return reject(error)
      let text = ''
      channel.on('data', (chunk) => {
        text += chunk
      })
      channel.stderr.resume()
      channel.once('close', (code) =>
        code === 0 ? resolve(JSON.parse(text)) : reject(new Error('Metadata check failed')),
      )
    })
  })
const metadata = () =>
  remote(`import json,os,urllib.request
from pathlib import Path
root=Path('/home/cat/rk-opencode')
key=(root/'.runtime/memory-key').read_text().strip()
r=urllib.request.Request('http://127.0.0.1:8092/call',data=b'{"op":"status"}',headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
with urllib.request.urlopen(r,timeout=5) as f: memory=json.load(f)
print(json.dumps({'memory':memory,'logs':{n:(root/'logs'/n).stat().st_size if (root/'logs'/n).exists() else 0 for n in ('requests.jsonl','worker.log')},'privateFilesReadable':any(os.access('/var/lib/rk-credential-vault/'+n,os.R_OK) for n in ('master.key','vault.sqlite3'))}))`)
const before = await metadata()
const app = await electron.launch({
  args: [root],
  cwd: root,
  env: {
    ...childEnvironment,
    COLOOP_DATA_DIR: profile,
    ELECTRON_RENDERER_URL: '',
    COLOOP_TEST_NO_HOOKS: '1',
  },
})
const fixtureOrigin = 'https://coloop-credential-test.invalid'
const username = 'vault_' + randomBytes(7).toString('hex') + '@example.invalid'
const credential = ' A!z9_"\\' + randomBytes(9).toString('hex') + ' '
let recordId
const fixture = `<!doctype html><meta charset="utf-8"><title>Synthetic login fixture</title>
<style>body{font:16px 'Segoe UI',sans-serif;margin:48px;color:#26282c}label{display:block;margin:22px 0}input{display:block;width:360px;padding:12px;font-size:18px;margin-top:8px}button{padding:12px 20px}p{color:#666}</style>
<h1>合成登录验收页面</h1><p>仅验证真实 USB 键盘输入，不提交到网站。</p>
<label>账号<input id="username" type="text" autocomplete="off"></label><label>密码<input id="password" type="password" autocomplete="off"></label><button type="button">登录（本测试不提交）</button>`
try {
  const main = await app.firstWindow()
  main.setDefaultTimeout(12_000)
  await main.waitForSelector('.workspace-content')
  const errors = []
  main.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(
    ({ app, net }, { fixtureOrigin, fixture }) => {
      globalThis.__vaultCloudCalls = 0
      const originalFetch = net.fetch
      net.fetch = (...args) => {
        globalThis.__vaultCloudCalls++
        return originalFetch(...args)
      }
      app.on('session-created', (isolated) => {
        void isolated.protocol.handle('https', (request) => {
          if (new URL(request.url).origin !== fixtureOrigin)
            return new Response('Blocked test destination', { status: 403 })
          return new Response(fixture, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        })
      })
    },
    { fixtureOrigin, fixture },
  )
  assert.equal((await main.evaluate(() => window.coloop.importRk())).ok, true)
  assert.equal((await main.evaluate((value) => window.coloop.connect(value), password)).ok, true)
  await main.getByRole('button', { name: '私密凭据', exact: true }).click()
  await main.getByText('截图与 OCR 已暂停', { exact: true }).waitFor()
  console.log('private entry protected')
  await main.getByLabel('允许的网站', { exact: true }).fill(fixtureOrigin)
  await main.getByLabel('账号', { exact: true }).fill(username)
  await main.getByLabel('密码', { exact: true }).fill(credential)
  await main.getByRole('button', { name: '保存到 RK', exact: true }).click()
  await main.getByText('已保存到 RK。账号和密码不会显示在列表中。', { exact: true }).waitFor()
  const records = await main.evaluate(() => window.coloop.listCredentials())
  assert.equal(records.ok, true)
  const record = records.value.find((item) => item.origin === fixtureOrigin)
  assert.ok(record)
  recordId = record.id
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'id', 'origin'])
  assert.equal(JSON.stringify(records).includes(username), false)
  assert.equal(JSON.stringify(records).includes(credential), false)
  report.checks.push('save/list exposes metadata only; entry fields cleared')
  console.log('synthetic record saved')
  assert.equal(await main.getByLabel('密码', { exact: true }).inputValue(), '')
  await main.screenshot({ animations: 'disabled', path: resolve(output, 'credentials.png') })
  for (const operation of ['capture', 'ocr', 'task', 'control']) {
    const result = await main.evaluate((op) => {
      const api = window.coloop
      if (op === 'capture') return api.captureScreen()
      if (op === 'ocr') return api.recognize(crypto.randomUUID())
      if (op === 'control') return api.controlSession({})
      return api.runTask({
        prompt: 'Synthetic forbidden task',
        source: 'text',
        target: 'rk',
        context: '',
      })
    }, operation)
    assert.equal(result.ok, false)
    assert.match(result.error, /私密凭据/)
  }
  report.checks.push('capture/OCR/model task/session command fail closed during private entry')
  const newWindow = app.waitForEvent('window')
  await main.getByRole('button', { name: '打开登录窗口', exact: true }).first().click()
  const login = await newWindow
  login.setDefaultTimeout(12_000)
  await login.getByRole('button', { name: '填入账号', exact: true }).waitFor()
  for (let attempt = 0; attempt < 40; attempt++) {
    if (
      await app.evaluate(
        ({ webContents }, origin) =>
          webContents
            .getAllWebContents()
            .some((w) => w.getURL().startsWith(origin) && !w.isLoading()),
        fixtureOrigin,
      )
    )
      break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const meta = await app.evaluate(({ BrowserWindow, webContents }, fixtureOrigin) => {
    const host = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('surface=credential-login'),
    )
    const target = webContents.getAllWebContents().find((w) => w.getURL().startsWith(fixtureOrigin))
    if (!target || !host) throw new Error('Login fixture not loaded')
    return {
      hwnd: String(host.getNativeWindowHandle().readBigUInt64LE()),
      sandbox: target.getLastWebPreferences().sandbox,
      node: target.getLastWebPreferences().nodeIntegration,
      hasPreload: !!target.getLastWebPreferences().preload,
    }
  }, fixtureOrigin)
  assert.equal(meta.sandbox, true)
  assert.equal(meta.node, false)
  assert.equal(meta.hasPreload, false)
  console.log('isolated login fixture loaded')
  // Test-only input-language request scoped to this temporary application's native window.
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class VaultTestLayout { [DllImport("user32.dll")] public static extern IntPtr LoadKeyboardLayout(string x,uint y); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); }';
$layout=[VaultTestLayout]::LoadKeyboardLayout('00000409',0); [VaultTestLayout]::PostMessage([IntPtr]::new(${meta.hwnd}),0x50,[IntPtr]::Zero,$layout) | Out-Null
`,
    ],
    { windowsHide: true, stdio: 'pipe' },
  )
  if (process.env.COLOOP_CREDENTIAL_PAUSE === '1') {
    await writeFile(
      resolve(output, 'awaiting-native-focus.json'),
      JSON.stringify({ hwnd: meta.hwnd }),
    )
    console.log('Awaiting native foreground activation: ' + output)
    for (let attempt = 0; attempt < 600; attempt++) {
      try {
        await access(resolve(output, 'continue'))
        break
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (attempt === 599) throw new Error('Native focus activation was not completed')
    }
  }
  const focus = (id) =>
    app.evaluate(
      async ({ BrowserWindow, webContents }, { origin, id }) => {
        const host = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('surface=credential-login'),
        )
        const target = webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin))
        host.show()
        host.focus()
        target.focus()
        await target.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).focus()`)
      },
      { origin: fixtureOrigin, id },
    )
  const fieldEquals = (id, expected) =>
    app.evaluate(
      async ({ webContents }, { origin, id, expected }) => {
        const target = webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin))
        return target.executeJavaScript(
          `document.getElementById(${JSON.stringify(id)}).value === ${JSON.stringify(expected)}`,
        )
      },
      { origin: fixtureOrigin, id, expected },
    )
  for (const [id, label, expected] of [
    ['username', '填入账号', username],
    ['password', '填入密码', credential],
  ]) {
    await focus(id)
    await login.getByRole('button', { name: label, exact: true }).click()
    try {
      await login.getByText(/已发送键盘输入/).waitFor({ timeout: 7_000 })
    } catch (error) {
      const state = await login.evaluate(() => window.coloopPrivateLogin.state())
      console.log(JSON.stringify({ loginState: state }))
      const focusState = await app.evaluate(async ({ BrowserWindow, webContents }, origin) => {
        const host = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('surface=credential-login'),
        )
        const target = webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin))
        return {
          hostFocused: host.isFocused(),
          targetFocused: target.isFocused(),
          dom: await target.executeJavaScript(
            '({focused:document.hasFocus(),tag:document.activeElement.tagName,type:document.activeElement.type})',
          ),
        }
      }, fixtureOrigin)
      console.log(JSON.stringify({ focusState }))
      console.log(
        'native probe: ' +
          execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              resolve(root, 'resources/private-login-focus.ps1'),
              '-WindowHandle',
              meta.hwnd,
            ],
            { input: 'initial\n', windowsHide: true, encoding: 'utf8' },
          ).trim(),
      )
      console.log(
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class VaultFocusDebug { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint t); [DllImport("user32.dll")] public static extern short GetKeyState(int k); [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k); }';
$fg=[VaultFocusDebug]::GetForegroundWindow(); $owner=[uint32]0; $thread=[VaultFocusDebug]::GetWindowThreadProcessId($fg,[ref]$owner); @{foreground=$fg.ToInt64();expected=${meta.hwnd};layout=[VaultFocusDebug]::GetKeyboardLayout($thread).ToInt64().ToString('x');caps=[VaultFocusDebug]::GetKeyState(20);modifiers=@(16,17,18,91,92) | ForEach-Object { [VaultFocusDebug]::GetAsyncKeyState($_) }} | ConvertTo-Json -Compress
`,
          ],
          { windowsHide: true, encoding: 'utf8' },
        ).trim(),
      )
      throw error
    }
    assert.equal(await fieldEquals(id, expected), true, `${id} must exactly match actual HID input`)
    console.log('HID field verified: ' + id)
  }
  report.checks.push(
    'real USB HID exactly enters synthetic username/password, including spaces and shifted punctuation',
  )
  const isolated = await app.evaluate(async ({ webContents }, origin) => {
    const target = webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin))
    return target.executeJavaScript(
      `({ bridge: typeof window.coloop, node: typeof require, loginBridge: typeof window.coloopPrivateLogin })`,
    )
  }, fixtureOrigin)
  assert.deepEqual(isolated, { bridge: 'undefined', node: 'undefined', loginBridge: 'undefined' })
  report.checks.push('login site cannot access either privileged preload bridge or Node')
  // Attempt cross-origin top-level navigation. The trusted origin stays unchanged.
  await app.evaluate(async ({ webContents }, origin) => {
    const target = webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin))
    await target.executeJavaScript(`location.href='https://other-credential-test.invalid/'`)
  }, fixtureOrigin)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(
    await app.evaluate(
      ({ webContents }, origin) =>
        webContents.getAllWebContents().some((w) => w.getURL().startsWith(origin)),
      fixtureOrigin,
    ),
    true,
  )
  report.checks.push('cross-origin navigation blocked')
  await app.evaluate(async ({ webContents }, origin) => {
    const target = webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin))
    await target.executeJavaScript("document.getElementById('password').value=''")
  }, fixtureOrigin)
  await focus('password')
  await login.getByRole('button', { name: '填入密码', exact: true }).click()
  await new Promise((resolve) => setTimeout(resolve, 280))
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(
      (w) => !w.webContents.getURL().includes('surface='),
    )
    main.show()
    main.focus()
  })
  await login.getByText(/填入未完成或结果不确定/).waitFor({ timeout: 6_000 })
  const length = () =>
    app.evaluate(async ({ webContents }, origin) => {
      const target = webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin))
      return target.executeJavaScript("document.getElementById('password').value.length")
    }, fixtureOrigin)
  const partial = await length()
  assert.ok(partial > 0 && partial < credential.length)
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(await length(), partial)
  report.checks.push(
    'real mid-input focus loss stops further HID reports and reports unknown outcome',
  )
  await login.getByRole('button', { name: '关闭登录窗口', exact: true }).click()
  await main.getByRole('button', { name: '私密凭据', exact: true }).click()
  assert.equal((await main.evaluate((id) => window.coloop.deleteCredential(id), recordId)).ok, true)
  recordId = undefined
  await main.getByRole('button', { name: '运行历史', exact: true }).click()
  await main.waitForTimeout(100)
  const state = await main.evaluate(() => window.coloop.snapshot())
  assert.equal(state.value.credentials.protected, false)
  assert.equal(state.value.tasks.length, 0)
  assert.equal(await app.evaluate(() => globalThis.__vaultCloudCalls), 0)
  const after = await metadata()
  assert.deepEqual(after.memory, before.memory)
  assert.deepEqual(after.logs, before.logs)
  assert.equal(before.privateFilesReadable, false)
  assert.equal(after.privateFilesReadable, false)
  report.checks.push(
    'no model/cloud request, no Mem0 change, no new model log bytes; ordinary cat cannot read vault files',
  )
  for (const file of await readdir(profile)) {
    if (!file.endsWith('.json')) continue
    const saved = await readFile(resolve(profile, file), 'utf8')
    assert.equal(saved.includes(username), false)
    assert.equal(saved.includes(credential), false)
  }
  assert.deepEqual(errors, [])
  report.passed = true
} finally {
  if (recordId) {
    await app
      .evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .filter((w) => w.webContents.getURL().includes('surface=credential-login'))
          .forEach((w) => w.close())
      })
      .catch(() => {})
    const main = (await app.windows()).find((w) => !w.url().includes('surface='))
    if (main)
      await main.evaluate((id) => window.coloop.deleteCredential(id), recordId).catch(() => {})
  }
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
  await app.close()
  ssh.end()
  console.log(JSON.stringify({ output, passed: report.passed, checks: report.checks.length }))
}
