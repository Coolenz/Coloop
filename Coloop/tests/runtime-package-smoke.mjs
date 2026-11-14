// Scripted package-runtime verification with local synthetic model responses.
// This is not an autonomous model business acceptance test.
import { build } from 'esbuild'
import { spawn, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const strictEnv = process.argv.includes('--strict-env')
const nativeKnownFolders = process.argv.includes('--native-known-folders')
const environmentMode = strictEnv
  ? nativeKnownFolders
    ? 'strict-native-folders'
    : 'strict-whitelist'
  : 'windows-no-credentials'
const target = resolve(
  root,
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ??
    join(process.env.LOCALAPPDATA, 'Programs', 'Coloop'),
)
const resources = join(target, 'resources')
const app = join(resources, 'app')
const output = join(root, '.qa', `runtime-package-${environmentMode}-` + Date.now())
const node = join(resources, 'runtime', 'node', 'node.exe')
const python = join(resources, 'runtime', 'docling', '.venv', 'Scripts', 'python.exe')
const probe = join(app, `.runtime-package-probe-${process.pid}.mjs`)
await mkdir(output, { recursive: true })
assert.ok(existsSync(node), 'Packaged standard Node must exist')
assert.ok(existsSync(python), 'Packaged embedded Python must exist')
assert.ok(existsSync(join(app, 'package.json')), 'Expected unpacked application directory')
assert.ok(
  existsSync(join(resources, 'harness', 'coloop-compaction.mjs')),
  'Packaged local compaction extension must exist',
)
assert.ok(probe.startsWith(app + sep), 'Temporary probe must remain inside app')

const profile = join(output, 'profile')
const temporary = join(output, 'temp')
await Promise.all(
  [profile, temporary, join(profile, 'Local'), join(profile, 'Roaming')].map((directory) =>
    mkdir(directory, { recursive: true }),
  ),
)
const blockedEnvironment =
  /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PROXY|NODE_PATH|NODE_OPTIONS|PYTHONPATH|PYTHONHOME|COLOOP_|DSH_|STAGEHAND_|ELECTRON_RUN_AS_NODE/i
const env = {
  ...(strictEnv
    ? {}
    : Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !blockedEnvironment.test(name)),
      )),
  PATH: dirname(node) + ';' + join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
  ...(strictEnv
    ? nativeKnownFolders
      ? {
          USERPROFILE: process.env.USERPROFILE,
          LOCALAPPDATA: process.env.LOCALAPPDATA,
          APPDATA: process.env.APPDATA,
        }
      : {
          USERPROFILE: profile,
          LOCALAPPDATA: join(profile, 'Local'),
          APPDATA: join(profile, 'Roaming'),
        }
    : {}),
  TEMP: temporary,
  TMP: temporary,
  HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
  HF_HUB_DISABLE_TELEMETRY: '1',
  STAGEHAND_CDP_LOG_FILE: join(output, 'stagehand-cdp.log'),
}
for (const name of [
  'SystemRoot',
  'SystemDrive',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'ALLUSERSPROFILE',
  'CHROME_PATH',
])
  if (process.env[name]) env[name] = process.env[name]
assert.ok(
  !Object.keys(env).some((name) => /API.?KEY|TOKEN|SECRET|PROXY|NODE_PATH|PYTHONPATH/i.test(name)),
)
await writeFile(
  join(output, 'environment.json'),
  JSON.stringify(
    {
      mode: environmentMode,
      retainedNames: Object.keys(env),
      browserProfile: 'SDK-owned fresh temporary user-data-dir',
      applicationState: output,
    },
    null,
    2,
  ),
)

try {
  const uiaProbe = await new Promise((resolveProbe, reject) => {
    const child = spawn(join(resources, 'auto-work-uia', 'Coloop.AutoWork.Uia.exe'), ['--probe'], {
      cwd: output,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = '',
      errors = ''
    const deadline = setTimeout(() => {
      child.kill()
      reject(new Error('Packaged FlaUI probe timeout'))
    }, 10000)
    child.stdout.on('data', (part) => {
      text += part
    })
    child.stderr.on('data', (part) => {
      errors += part
    })
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(deadline)
      code === 0 ? resolveProbe(JSON.parse(text.trim())) : reject(new Error(errors || text))
    })
  })
  assert.equal(uiaProbe.ready, true)
  assert.equal(uiaProbe.backend, 'FlaUI.UIA3')
  assert.equal(uiaProbe.readOnly, true)
  await writeFile(join(output, 'auto-work-uia-probe.json'), JSON.stringify(uiaProbe, null, 2))
  const schedulerProbe = await new Promise((resolveProbe, reject) => {
    const child = fork(join(resources, 'harness', 'coloop-scheduler.mjs'), [], {
      execPath: node, execArgv: [], cwd: output, windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...env, COLOOP_SCHEDULER_MANIFEST: join(app, 'package.json'), COLOOP_SCHEDULER_HOME: join(output, 'native-schedules') },
    })
    let errors = '', result
    const deadline = setTimeout(() => { child.kill(); reject(new Error('Native scheduler probe timeout')) }, 30000)
    child.stderr.on('data', chunk => { errors += chunk })
    child.on('message', message => {
      try {
        if (message.error) throw new Error(message.error)
        if (message.event === 'ready') {
          assert.ok(message.modules.every(path => resolve(path).startsWith(app + sep)), 'Scheduler dependencies must resolve inside the package')
          result = { modules: message.modules, delivered: false }
          child.send({ id: 1, method: 'create', sessionId: randomUUID(), request: { title: 'Package probe', prompt: 'Synthetic delivery', after_seconds: 1 } })
        } else if (message.event === 'due') {
          result.delivered = true
          child.send({ reply: message.id })
          child.send({ id: 2, method: 'catalog' })
        } else if (message.id === 2) {
          if (message.value[0].status === 'active') {
            setTimeout(() => child.send({ id: 2, method: 'catalog' }), 100)
            return
          }
          assert.equal(message.value[0].status, 'inactive')
          result.catalog = message.value
          child.send({ id: 3, method: 'close' })
        }
      } catch (error) { child.kill(); reject(error) }
    })
    child.once('error', reject)
    child.once('exit', code => {
      clearTimeout(deadline)
      if (code === 0 && result?.delivered) resolveProbe(result)
      else reject(new Error(errors || 'Native scheduler failed'))
    })
  })
  await writeFile(join(output, 'native-scheduler-probe.json'), JSON.stringify(schedulerProbe, null, 2))
  await build({
    entryPoints: [join(root, 'tests', 'fixtures', 'runtime-package-probe.ts')],
    outfile: probe,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'silent',
  })
  let stdout = '',
    stderr = ''
  const child = spawn(node, [probe, resources, output], {
    cwd: output,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (part) => {
    stdout += part
    process.stdout.write(part)
  })
  child.stderr.on('data', (part) => {
    stderr += part
  })
  const exit = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolveExit({ code, signal }))
  })
  await Promise.all([
    writeFile(join(output, 'stdout.log'), stdout),
    writeFile(join(output, 'stderr.log'), stderr),
  ])
  assert.equal(exit.code, 0, `Package probe failed: ${stderr.slice(-6000)}`)
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  assert.equal(report.ok, true)
  console.log(JSON.stringify({ ok: true, output, target, scope: report.scope }))
} finally {
  await rm(probe, { force: true })
  for (const name of [
    'profile',
    'temp',
    'authorized-files',
    'harness-home',
    'local-harness-home',
    'native-schedules',
    'docling-cache',
    '归档',
    '结果.zip',
    '中文隔离验收.docx',
  ])
    await rm(join(output, name), { recursive: true, force: true })
}
